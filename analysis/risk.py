from __future__ import annotations

import hashlib
import json
from math import floor

from analysis.contracts import (
    AnalysisRequest,
    Bar,
    LevelZone,
    RiskCalculation,
    Scenario,
)
from analysis.patterns.rectangle import RectangleDetection
from analysis.rulesets import Ruleset


def _scenario_id(detection: RectangleDetection, bars: tuple[Bar, ...]) -> str:
    payload = {
        "detector": "rectangle-v1",
        "symbol": bars[0].symbol,
        "timeframe": "1d",
        "formed_at": bars[detection.established_index].completed_at.isoformat(),
        "range_lower": detection.range_lower,
        "range_upper": detection.range_upper,
        "range_start": bars[detection.range_start_index].timestamp.isoformat(),
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(canonical).hexdigest()


def _intermediate_levels(
    detection: RectangleDetection,
    levels: tuple[LevelZone, ...],
    *,
    clearance: float,
) -> tuple[LevelZone, ...]:
    if detection.breakout_price is None or detection.measured_target is None:
        return ()
    lower = min(detection.breakout_price, detection.measured_target) + clearance
    upper = max(detection.breakout_price, detection.measured_target) - clearance
    if lower >= upper:
        return ()
    return tuple(
        level
        for level in levels
        if level.upper >= lower and level.lower <= upper
    )


def build_rectangle_scenario(
    detection: RectangleDetection,
    bars: tuple[Bar, ...],
    request: AnalysisRequest,
    ruleset: Ruleset,
    *,
    historical_levels: tuple[LevelZone, ...] = (),
) -> Scenario:
    formed_at = bars[detection.established_index].completed_at
    confirmed_at = (
        bars[detection.breakout_index].completed_at
        if detection.breakout_index is not None
        else None
    )
    distance_text = (
        f"max({ruleset.rectangles.breakout_distance_atr:.2f} ATR, "
        f"{ruleset.rectangles.breakout_distance_percent * 100:.2f}%)"
    )
    confirmation_condition = (
        f"A completed daily close beyond either range boundary by {distance_text}, "
        f"with relative volume at least {ruleset.rectangles.minimum_relative_volume:.2f}."
    )
    warnings: list[str] = []
    risk: RiskCalculation | None = None
    measured_target = detection.measured_target
    frozen_atr = detection.atr_at_formation or detection.atr_at_breakout or 0.0
    intermediate_levels = _intermediate_levels(
        detection,
        historical_levels,
        clearance=frozen_atr * ruleset.rectangles.breakout_distance_atr,
    )

    if detection.direction == "bullish":
        entry_trigger = "Completed daily close above the frozen upper boundary with volume confirmation."
        analytical_invalidation = (
            "A completed close back through the former upper boundary invalidates the breakout; "
            "a close beyond the opposite boundary is direct structural invalidation."
        )
    elif detection.direction == "bearish":
        entry_trigger = "Completed daily close below the frozen lower boundary with volume confirmation."
        analytical_invalidation = (
            "A completed close back through the former lower boundary invalidates the breakout; "
            "a close beyond the opposite boundary is direct structural invalidation."
        )
    else:
        entry_trigger = "No entry assumption exists until a configured breakout is confirmed."
        analytical_invalidation = (
            "The candidate expires, or is invalidated when price breaks the range without the "
            "required confirmation evidence."
        )

    if detection.event_reason == "relative_volume_not_confirmed":
        warnings.append(
            "Price left the frozen range without the required relative-volume confirmation."
        )
    elif detection.event_reason == "corporate_action_breakout_bar":
        warnings.append(
            "A corporate action occurred on the apparent breakout bar, so confirmation was rejected."
        )

    active_breakout = detection.lifecycle_state in {"confirmed", "retest"}
    if detection.breakout_index is not None and not active_breakout:
        warnings.append(
            "This lifecycle is terminal; current position-size and risk arithmetic are unavailable."
        )

    if (
        active_breakout
        and detection.breakout_price is not None
        and measured_target is not None
    ):
        if measured_target <= 0:
            warnings.append("The measured target is non-positive and is not usable.")
            measured_target = None
        else:
            default_stop = (
                detection.range_lower
                - (frozen_atr * ruleset.risk.execution_stop_atr_buffer)
                if detection.direction == "bullish"
                else detection.range_upper
                + (frozen_atr * ruleset.risk.execution_stop_atr_buffer)
            )
            execution_stop = request.execution_stop_price or default_stop
            if execution_stop <= 0:
                warnings.append(
                    "The ruleset-derived execution-stop assumption is non-positive; "
                    "risk arithmetic is unavailable."
                )
            valid_stop = (
                execution_stop > 0
                and execution_stop < detection.breakout_price
                if detection.direction == "bullish"
                else execution_stop > 0 and execution_stop > detection.breakout_price
            )
            if not valid_stop:
                if execution_stop > 0:
                    warnings.append(
                        "The execution-stop assumption is on the wrong side of the entry; "
                        "risk arithmetic is unavailable."
                    )
            else:
                commission = request.commission_per_unit or 0.0
                slippage = request.expected_slippage_per_unit or 0.0
                costs = commission + slippage
                risk_per_unit = abs(detection.breakout_price - execution_stop) + costs
                gross_reward = (
                    measured_target - detection.breakout_price
                    if detection.direction == "bullish"
                    else detection.breakout_price - measured_target
                )
                reward_per_unit = (
                    gross_reward - costs if gross_reward - costs > 0 else None
                )
                reward_risk_ratio = (
                    reward_per_unit / risk_per_unit
                    if reward_per_unit is not None
                    else None
                )
                explicit_size_inputs = (
                    request.account_risk is not None
                    and request.execution_stop_price is not None
                    and request.commission_per_unit is not None
                    and request.expected_slippage_per_unit is not None
                )
                position_size = (
                    floor(request.account_risk / risk_per_unit)
                    if (
                        explicit_size_inputs
                        and request.account_risk is not None
                        and reward_per_unit is not None
                    )
                    else None
                )
                risk = RiskCalculation(
                    entry_price=detection.breakout_price,
                    execution_stop_price=execution_stop,
                    measured_target=measured_target,
                    account_risk=request.account_risk,
                    commission_per_unit=commission,
                    expected_slippage_per_unit=slippage,
                    risk_per_unit=risk_per_unit,
                    reward_per_unit=reward_per_unit,
                    reward_risk_ratio=reward_risk_ratio,
                    position_size=position_size,
                )
                if not explicit_size_inputs:
                    warnings.append(
                        "Hypothetical position size requires explicit account risk, commission, "
                        "slippage, and execution-stop assumptions."
                    )
                if reward_per_unit is None:
                    warnings.append(
                        "The measured target is not ahead of the entry after costs; "
                        "reward and reward/risk are unavailable."
                    )
                elif reward_risk_ratio is not None and (
                    reward_risk_ratio < ruleset.risk.minimum_reward_risk
                ):
                    warnings.append(
                        "Measured reward/risk is below the configured research threshold."
                    )
                if frozen_atr and abs(detection.breakout_price - execution_stop) < frozen_atr:
                    warnings.append(
                        "The execution-stop assumption is within one formation ATR of the entry."
                    )

    if intermediate_levels:
        warnings.append(
            "A previously confirmed price zone lies between the entry assumption and measured target."
        )
    if detection.breakout_index is not None:
        warnings.append(
            "Execution stops and measured targets are hypothetical; gaps, halts, and liquidity "
            "conditions can produce materially different outcomes."
        )

    return Scenario(
        scenario_id=_scenario_id(detection, bars),
        setup="rectangle",
        timeframe="1d",
        direction=detection.direction,
        lifecycle_state=detection.lifecycle_state,
        range_lower=detection.range_lower,
        range_upper=detection.range_upper,
        range_height=detection.range_height,
        range_started_at=bars[detection.range_start_index].timestamp,
        established_at=formed_at,
        retested_at=(
            bars[detection.retest_index].completed_at
            if detection.retest_index is not None
            else None
        ),
        terminal_at=(
            bars[detection.terminal_index].completed_at
            if detection.terminal_index is not None
            else None
        ),
        last_event_at=bars[
            detection.last_event_index
            if detection.last_event_index is not None
            else detection.established_index
        ].completed_at,
        event_reason=detection.event_reason,
        confirmation_condition=confirmation_condition,
        confirmed_at=confirmed_at,
        entry_trigger=entry_trigger,
        entry_assumption=detection.breakout_price,
        analytical_invalidation=analytical_invalidation,
        measured_target=measured_target,
        intermediate_levels=intermediate_levels,
        risk=risk,
        evidence_ids=(
            "setup.rectangle.geometry.1d",
            "confirmation.rectangle.breakout.1d",
            "management.rectangle.lifecycle.1d",
        ),
        warnings=tuple(warnings),
    )
