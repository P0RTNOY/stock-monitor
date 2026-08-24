from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Callable

from analysis.contracts import (
    AnalysisReport,
    AnalysisRequest,
    Bar,
    ContractError,
    Evidence,
    StructureState,
    TimeframeAnalysis,
)
from analysis.features import (
    relative_volume,
    resample_completed_weeks,
    simple_moving_average,
    wilder_atr,
)
from analysis.levels import cluster_levels
from analysis.patterns.rectangle import detect_rectangle
from analysis.providers import validate_bar_sequence
from analysis.risk import build_rectangle_scenario
from analysis.rulesets import Ruleset, load_ruleset
from analysis.structure import classify_structure, find_confirmed_pivots


ENGINE_VERSION = "0.2.0"


def _data_hash(bars: tuple[Bar, ...]) -> str:
    canonical_bars = []
    for bar in bars:
        item = bar.to_dict()
        item["timestamp"] = bar.timestamp.astimezone(timezone.utc).isoformat()
        canonical_bars.append(item)
    payload = json.dumps(
        canonical_bars,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


class AnalysisEngine:
    def __init__(
        self,
        ruleset: Ruleset | None = None,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.ruleset = ruleset or load_ruleset()
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def analyze(
        self,
        request: AnalysisRequest,
        daily_bars: tuple[Bar, ...],
    ) -> AnalysisReport:
        if request.ruleset_version != self.ruleset.version:
            raise ContractError("request and engine ruleset versions do not match")
        if set(request.timeframes) - set(self.ruleset.timeframes):
            raise ContractError("request contains a timeframe disabled by the ruleset")
        daily_bars = validate_bar_sequence(daily_bars)
        if not daily_bars:
            return self._empty_report(request)
        if daily_bars[0].symbol != request.symbol:
            raise ContractError("request symbol does not match bar symbol")
        if daily_bars[0].timeframe != "1d":
            raise ContractError("engine input must be daily bars")
        if daily_bars[0].adjustment_mode != self.ruleset.adjustment_mode:
            raise ContractError("bar adjustment mode does not match the ruleset")

        complete = tuple(
            bar
            for bar in daily_bars
            if bar.is_complete and bar.completed_at <= request.as_of
        )
        warnings: list[str] = []
        split_indexes = [
            index
            for index, bar in enumerate(complete)
            if "split" in bar.corporate_action_flags
        ]
        latest_split_timestamp = (
            complete[split_indexes[-1]].timestamp if split_indexes else None
        )
        if split_indexes:
            complete = complete[split_indexes[-1] :]
            warnings.append(
                "Raw-price analysis was truncated at the latest stock split to avoid a false structural break."
            )

        bars_by_timeframe = {
            "1d": complete,
            "1wk": resample_completed_weeks(complete, request.as_of),
        }
        evidence: list[Evidence] = []
        timeframe_reports: dict[str, TimeframeAnalysis] = {}
        scenarios = ()
        has_insufficient_data = False

        requested_timeframes = tuple(
            timeframe
            for timeframe in self.ruleset.timeframes
            if timeframe in request.timeframes
        )
        for timeframe in requested_timeframes:
            bars = bars_by_timeframe[timeframe]
            minimum = self.ruleset.minimum_bars[timeframe]
            enough_bars = len(bars) >= minimum
            has_insufficient_data = has_insufficient_data or not enough_bars
            evidence.append(
                Evidence(
                    rule_id=f"data.minimum_bars.{timeframe}",
                    ruleset_version=self.ruleset.version,
                    category="data_quality",
                    status="passed" if enough_bars else "failed",
                    observed=len(bars),
                    threshold={"minimum": minimum},
                    bar_timestamps=(bars[-1].timestamp,) if bars else (),
                    explanation=(
                        f"{len(bars)} completed {timeframe} bars are available; "
                        f"the ruleset requires {minimum}."
                    ),
                    method_reference="PDF pp. 19–20, 68–69",
                )
            )
            timeframe_report, timeframe_evidence = self._analyze_timeframe(timeframe, bars)
            timeframe_reports[timeframe] = timeframe_report
            evidence.extend(timeframe_evidence)

        if not has_insufficient_data and "1d" in timeframe_reports:
            daily_report = timeframe_reports["1d"]
            atr_values = wilder_atr(complete, self.ruleset.features.atr_period)
            rvol_values = relative_volume(
                complete,
                self.ruleset.features.relative_volume_lookback,
            )
            rectangle_result = detect_rectangle(
                complete,
                daily_report.pivots,
                atr_values,
                rvol_values,
                self.ruleset.rectangles,
                ruleset_version=self.ruleset.version,
            )
            evidence.extend(rectangle_result.evidence)
            if rectangle_result.detection is not None:
                detection = rectangle_result.detection
                historical_levels = ()
                if detection.breakout_index is not None:
                    breakout_index = detection.breakout_index
                    historical_pivots = tuple(
                        pivot
                        for pivot in daily_report.pivots
                        if pivot.confirmation_index <= breakout_index
                    )
                    historical_levels = cluster_levels(
                        historical_pivots,
                        complete[: breakout_index + 1],
                        latest_atr=atr_values[breakout_index],
                        width_atr_multiple=self.ruleset.levels.width_atr_multiple,
                        minimum_width_percent=self.ruleset.levels.minimum_width_percent,
                        minimum_touches=self.ruleset.levels.minimum_touches,
                        maximum_zones=self.ruleset.levels.maximum_zones,
                    )
                scenario = build_rectangle_scenario(
                    detection,
                    complete,
                    request,
                    self.ruleset,
                    historical_levels=historical_levels,
                )
                scenarios = (scenario,)
                evidence.extend(self._scenario_evidence(scenario))

        if split_indexes:
            evidence.append(
                Evidence(
                    rule_id="data.raw_prices.recent_split",
                    ruleset_version=self.ruleset.version,
                    category="data_quality",
                    status="warning",
                    observed={"latest_split": latest_split_timestamp.isoformat()},
                    explanation=warnings[-1],
                    method_reference="PDF p. 20",
                )
            )

        status = (
            "insufficient_data"
            if has_insufficient_data
            else "scenario_detected"
            if scenarios
            else "no_setup"
        )
        summary = self._summary(status, timeframe_reports, scenarios)
        return AnalysisReport(
            symbol=request.symbol,
            as_of=request.as_of,
            generated_at=self._generated_at(),
            engine_version=ENGINE_VERSION,
            ruleset_version=self.ruleset.version,
            provider=daily_bars[0].provider,
            adjustment_mode=daily_bars[0].adjustment_mode,
            data_hash=_data_hash(complete),
            status=status,
            summary=summary,
            timeframes=timeframe_reports,
            scenarios=scenarios,
            evidence=tuple(evidence),
            warnings=tuple(warnings),
        )

    def _analyze_timeframe(
        self,
        timeframe: str,
        bars: tuple[Bar, ...],
    ) -> tuple[TimeframeAnalysis, tuple[Evidence, ...]]:
        atr_values = wilder_atr(bars, self.ruleset.features.atr_period)
        rvol_values = relative_volume(
            bars,
            self.ruleset.features.relative_volume_lookback,
        )
        moving_averages = {
            f"sma_{period}": simple_moving_average(bars, period)[-1] if bars else None
            for period in self.ruleset.features.moving_average_periods
        }
        pivots = find_confirmed_pivots(
            bars,
            left_bars=self.ruleset.swings.left_bars,
            right_bars=self.ruleset.swings.right_bars,
        )
        structure = classify_structure(pivots)
        latest_atr = atr_values[-1] if atr_values else None
        levels = cluster_levels(
            pivots,
            bars,
            latest_atr=latest_atr,
            width_atr_multiple=self.ruleset.levels.width_atr_multiple,
            minimum_width_percent=self.ruleset.levels.minimum_width_percent,
            minimum_touches=self.ruleset.levels.minimum_touches,
            maximum_zones=self.ruleset.levels.maximum_zones,
        )
        last_timestamp = (bars[-1].timestamp,) if bars else ()
        evidence = (
            Evidence(
                rule_id=f"structure.confirmed_swings.{timeframe}",
                ruleset_version=self.ruleset.version,
                category="structure",
                status="passed" if pivots else "unknown",
                observed={"confirmed_pivots": len(pivots)},
                threshold={
                    "left_bars": self.ruleset.swings.left_bars,
                    "right_bars": self.ruleset.swings.right_bars,
                },
                bar_timestamps=last_timestamp,
                explanation=(
                    "Pivots are exposed only after the configured right-side confirmation bars close."
                ),
                method_reference="PDF pp. 25–26",
            ),
            Evidence(
                rule_id=f"structure.classification.{timeframe}",
                ruleset_version=self.ruleset.version,
                category="structure",
                status="passed" if structure.trend != "insufficient_data" else "unknown",
                observed={"trend": structure.trend},
                bar_timestamps=last_timestamp,
                explanation=structure.reason,
                method_reference="PDF pp. 22–26",
            ),
            Evidence(
                rule_id=f"levels.volatility_zones.{timeframe}",
                ruleset_version=self.ruleset.version,
                category="level",
                status="passed" if levels else "unknown",
                observed={"zones": len(levels)},
                threshold={
                    "minimum_touches": self.ruleset.levels.minimum_touches,
                    "maximum_zones": self.ruleset.levels.maximum_zones,
                    "width_atr_multiple": self.ruleset.levels.width_atr_multiple,
                },
                bar_timestamps=last_timestamp,
                explanation=(
                    "Confirmed pivots are clustered into volatility-aware zones rather than exact lines."
                ),
                method_reference="PDF pp. 29–30",
            ),
        )
        report = TimeframeAnalysis(
            timeframe=timeframe,
            bar_count=len(bars),
            first_bar=bars[0].timestamp if bars else None,
            last_bar=bars[-1].timestamp if bars else None,
            atr=latest_atr,
            relative_volume=rvol_values[-1] if rvol_values else None,
            moving_averages=moving_averages,
            pivots=pivots,
            structure=structure,
            levels=levels,
        )
        return report, evidence

    def _empty_report(self, request: AnalysisRequest) -> AnalysisReport:
        evidence = Evidence(
            rule_id="data.daily.empty",
            ruleset_version=self.ruleset.version,
            category="data_quality",
            status="failed",
            observed=0,
            threshold={"minimum": self.ruleset.minimum_bars["1d"]},
            explanation="No normalized daily bars were supplied.",
            method_reference="PDF pp. 19–20",
        )
        return AnalysisReport(
            symbol=request.symbol,
            as_of=request.as_of,
            generated_at=self._generated_at(),
            engine_version=ENGINE_VERSION,
            ruleset_version=self.ruleset.version,
            provider=self.ruleset.provider,
            adjustment_mode=self.ruleset.adjustment_mode,
            data_hash=_data_hash(()),
            status="insufficient_data",
            summary="Insufficient completed market data for structural analysis.",
            timeframes={},
            evidence=(evidence,),
        )

    @staticmethod
    def _summary(
        status: str,
        timeframes: dict[str, TimeframeAnalysis],
        scenarios: tuple = (),
    ) -> str:
        if status == "insufficient_data":
            missing = ", ".join(
                timeframe
                for timeframe, report in timeframes.items()
                if report.bar_count == 0
            )
            suffix = f" Missing: {missing}." if missing else ""
            return f"Insufficient completed market data for the configured timeframes.{suffix}"
        structures = "; ".join(
            f"{timeframe}: {report.structure.trend}"
            for timeframe, report in timeframes.items()
        )
        if scenarios:
            scenario = scenarios[0]
            return (
                f"Rectangle scenario is {scenario.lifecycle_state} on completed daily bars "
                f"({structures}). This is descriptive scenario evidence, not a recommendation."
            )
        return f"Structural foundation complete ({structures}); no rectangle setup was detected."

    def _scenario_evidence(self, scenario) -> tuple[Evidence, ...]:
        target_status = "passed" if scenario.measured_target is not None else "not_applicable"
        risk_status = (
            "passed"
            if scenario.risk is not None
            else "unknown"
            if scenario.entry_assumption is not None
            else "not_applicable"
        )
        return (
            Evidence(
                rule_id="invalidation.rectangle.analytical.1d",
                ruleset_version=self.ruleset.version,
                category="invalidation",
                status="passed",
                observed={"condition": scenario.analytical_invalidation},
                explanation="Analytical invalidation is kept separate from an execution-stop assumption.",
                method_reference="PDF pp. 62, 64–67, 78–79",
            ),
            Evidence(
                rule_id="target.rectangle.measured_move.1d",
                ruleset_version=self.ruleset.version,
                category="target",
                status=target_status,
                observed={"measured_target": scenario.measured_target},
                threshold={"range_height": scenario.range_height},
                explanation="The range height is projected from the breakout as an estimate, not a promise.",
                method_reference="PDF pp. 41–42, 78–79",
            ),
            Evidence(
                rule_id="risk.rectangle.hypothetical.1d",
                ruleset_version=self.ruleset.version,
                category="risk",
                status=risk_status,
                observed=(
                    {
                        "risk_per_unit": scenario.risk.risk_per_unit,
                        "reward_risk_ratio": scenario.risk.reward_risk_ratio,
                        "position_size": scenario.risk.position_size,
                    }
                    if scenario.risk is not None
                    else {"available": False}
                ),
                threshold={"minimum_reward_risk": self.ruleset.risk.minimum_reward_risk},
                explanation=(
                    "Position size is hypothetical and requires entry, execution-stop, costs, "
                    "and an explicit account-risk amount."
                ),
                method_reference="PDF pp. 64–67",
            ),
        )

    def _generated_at(self) -> datetime:
        generated_at = self.clock()
        if generated_at.tzinfo is None or generated_at.utcoffset() is None:
            raise ContractError("analysis clock must return a timezone-aware timestamp")
        return generated_at
