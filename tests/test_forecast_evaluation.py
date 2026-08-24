from __future__ import annotations

import json
import unittest
from dataclasses import replace
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from analysis.contracts import Bar
from analysis.evaluation.calendar import exchange_calendar_version
from analysis.evaluation import (
    CoverageProof,
    EVALUATOR_VERSION,
    EvaluationContractError,
    EvaluationInput,
    ForecastTerms,
    RULESET_VERSION,
    build_exchange_coverage,
    evaluate_forecast,
)
from analysis.evaluation.ruleset import load_evaluation_ruleset


NY = ZoneInfo("America/New_York")
FIXTURES = Path(__file__).parent / "fixtures" / "forecast_evaluation_cases.json"


def instant(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def make_daily_bar(
    market_date: date | str,
    open_price: float,
    high: float,
    low: float,
    close: float,
    *,
    symbol: str = "AAPL",
    adjustment_mode: str = "raw",
    flags: tuple[str, ...] = (),
    is_complete: bool = True,
) -> Bar:
    if isinstance(market_date, str):
        market_date = date.fromisoformat(market_date)
    timestamp = datetime.combine(market_date, time.min, tzinfo=NY)
    return Bar(
        symbol=symbol,
        timeframe="1d",
        timestamp=timestamp,
        completed_at=datetime.combine(
            market_date + timedelta(days=1), time.min, tzinfo=NY
        ),
        timezone="America/New_York",
        open=open_price,
        high=high,
        low=low,
        close=close,
        volume=1_000,
        is_complete=is_complete,
        adjustment_mode=adjustment_mode,  # type: ignore[arg-type]
        provider="fixture-provider",
        corporate_action_flags=flags,
    )


def make_terms(
    direction: str = "bullish",
    *,
    activated_at: datetime = instant("2025-01-05T12:00:00Z"),
    market_data_as_of: datetime | None = None,
    evaluation_date: date = date(2025, 1, 7),
    target_range: tuple[float, float] | None = None,
) -> ForecastTerms:
    target = 110.0 if direction == "bullish" else 90.0
    invalidation = 90.0 if direction == "bullish" else 110.0
    if direction == "neutral":
        target_range = target_range or (95.0, 105.0)
        target = None  # type: ignore[assignment]
        invalidation = 90.0
    return ForecastTerms(
        forecast_id=41,
        symbol="AAPL",
        direction=direction,  # type: ignore[arg-type]
        activated_at=activated_at,
        activation_market_data_as_of=market_data_as_of or activated_at,
        activation_price=100.0,
        currency="USD",
        evaluation_date=evaluation_date,
        target_price=None if target_range else target,
        target_range=target_range,
        invalidation_price=invalidation,
    )


def make_coverage(
    *,
    expected: tuple[date, ...] = (date(2025, 1, 6), date(2025, 1, 7)),
    available_at: datetime = instant("2025-01-08T05:00:00Z"),
    missing: tuple[date, ...] = (),
    provider_complete: bool = True,
    supported: bool = True,
    observed_currency: str | None = "USD",
) -> CoverageProof:
    return CoverageProof(
        calendar_id="XNYS" if supported else "UNKNOWN",
        calendar_version=exchange_calendar_version(),
        market_timezone="America/New_York",
        expected_sessions=expected,
        final_expected_session=expected[-1] if expected else None,
        horizon_available_at=available_at,
        observed_currency=observed_currency,
        missing_sessions=missing,
        provider_complete=provider_complete,
        calendar_supported=supported,
    )


def make_input(
    bars: tuple[Bar, ...],
    *,
    terms: ForecastTerms | None = None,
    cutoff: datetime = instant("2025-01-08T05:00:00Z"),
    coverage: CoverageProof | None = None,
) -> EvaluationInput:
    return EvaluationInput(
        forecast=terms or make_terms(),
        observations=bars,
        cutoff=cutoff,
        coverage=coverage or make_coverage(),
    )


class FixtureOutcomeTests(unittest.TestCase):
    def test_readable_outcome_boundary_ordering_and_gap_fixtures(self) -> None:
        cases = json.loads(FIXTURES.read_text(encoding="utf-8"))
        for case in cases:
            with self.subTest(case=case["name"]):
                direction = case["direction"]
                target_range = (
                    tuple(case["target_range"])
                    if "target_range" in case
                    else None
                )
                terms = make_terms(direction, target_range=target_range)
                bars = tuple(make_daily_bar(*values) for values in case["bars"])
                result = evaluate_forecast(
                    make_input(
                        bars,
                        terms=terms,
                        cutoff=instant(
                            case.get("cutoff", "2025-01-08T05:00:00Z")
                        ),
                    )
                )
                self.assertEqual(
                    (result.kind, result.reason_code), tuple(case["expected"])
                )
                if "detected_at" in case:
                    self.assertEqual(result.evidence.detected_at, case["detected_at"])
                    self.assertEqual(
                        result.evidence.observed_open, case["bars"][0][1]
                    )
                if target_range:
                    self.assertEqual(result.evidence.target_range, target_range)


class TimeAndCoverageTests(unittest.TestCase):
    def test_pre_activation_and_unavailable_bars_are_ignored(self) -> None:
        bars = (
            make_daily_bar("2025-01-03", 100, 120, 80, 100),
            make_daily_bar("2025-01-06", 100, 109, 95, 105),
            make_daily_bar("2025-01-07", 105, 120, 95, 115),
        )
        result = evaluate_forecast(
            make_input(bars, cutoff=instant("2025-01-07T17:00:00Z"))
        )
        self.assertEqual(result.kind, "no_change")
        self.assertEqual(result.evidence.observation_count, 1)
        self.assertEqual(
            result.evidence.first_eligible_observation.market_date,
            date(2025, 1, 6),
        )

    def test_bar_labelled_before_activation_but_completed_after_is_eligible(self) -> None:
        activated = datetime(2025, 1, 6, 20, 0, tzinfo=NY)
        terms = make_terms(
            activated_at=activated,
            evaluation_date=date(2025, 1, 7),
        )
        bar = make_daily_bar("2025-01-06", 100, 111, 99, 108)
        coverage = make_coverage(expected=(date(2025, 1, 6), date(2025, 1, 7)))
        result = evaluate_forecast(make_input((bar,), terms=terms, coverage=coverage))
        self.assertEqual(result.kind, "target_hit")
        self.assertEqual(result.evidence.observation_count, 1)

    def test_terminal_touch_on_final_bar_precedes_expiry(self) -> None:
        bars = (
            make_daily_bar("2025-01-06", 100, 105, 95, 100),
            make_daily_bar("2025-01-07", 100, 110, 95, 108),
        )
        result = evaluate_forecast(make_input(bars))
        self.assertEqual(result.kind, "target_hit")
        self.assertEqual(
            result.evidence.triggering_observation.market_date, date(2025, 1, 7)
        )

    def test_weekend_horizon_uses_friday_as_final_session(self) -> None:
        terms = make_terms(evaluation_date=date(2025, 1, 11))
        sessions = tuple(date(2025, 1, day) for day in (6, 7, 8, 10))
        bars = tuple(make_daily_bar(day, 100, 105, 95, 100) for day in sessions)
        coverage = build_exchange_coverage(
            bars,
            activation_cutoff=terms.activation_cutoff,
            evaluation_date=terms.evaluation_date,
            cutoff=instant("2025-01-11T05:00:00Z"),
            calendar_id="XNYS",
            observed_currency="USD",
        )
        result = evaluate_forecast(
            make_input(
                bars,
                terms=terms,
                cutoff=instant("2025-01-11T05:00:00Z"),
                coverage=coverage,
            )
        )
        self.assertEqual(coverage.final_expected_session, date(2025, 1, 10))
        self.assertEqual(result.kind, "expired")

    def test_market_holiday_horizon_uses_previous_session(self) -> None:
        activated = datetime(2025, 7, 3, 12, 0, tzinfo=NY)
        terms = make_terms(
            activated_at=activated,
            evaluation_date=date(2025, 7, 4),
        )
        bar = make_daily_bar("2025-07-03", 100, 105, 95, 100)
        cutoff = datetime(2025, 7, 4, 0, 0, tzinfo=NY)
        coverage = build_exchange_coverage(
            (bar,),
            activation_cutoff=terms.activation_cutoff,
            evaluation_date=terms.evaluation_date,
            cutoff=cutoff,
            calendar_id="XNYS",
            observed_currency="USD",
        )
        result = evaluate_forecast(
            make_input((bar,), terms=terms, cutoff=cutoff, coverage=coverage)
        )
        self.assertEqual(coverage.expected_sessions, (date(2025, 7, 3),))
        self.assertEqual(result.kind, "expired")

    def test_zero_post_activation_sessions_never_fabricates_expiry(self) -> None:
        activated = datetime(2025, 1, 11, 12, 0, tzinfo=NY)
        terms = make_terms(
            activated_at=activated,
            evaluation_date=date(2025, 1, 11),
        )
        prior_bar = make_daily_bar("2025-01-10", 100, 105, 95, 100)
        cutoff = datetime(2025, 1, 12, 0, 0, tzinfo=NY)
        coverage = build_exchange_coverage(
            (prior_bar,),
            activation_cutoff=terms.activation_cutoff,
            evaluation_date=terms.evaluation_date,
            cutoff=cutoff,
            calendar_id="XNYS",
            observed_currency="USD",
        )
        result = evaluate_forecast(
            make_input(
                (prior_bar,),
                terms=terms,
                cutoff=cutoff,
                coverage=coverage,
            )
        )
        self.assertEqual(coverage.expected_sessions, ())
        self.assertEqual(
            (result.kind, result.reason_code),
            ("needs_review", "insufficient_horizon_coverage"),
        )

    def test_missing_session_and_partial_provider_need_review(self) -> None:
        bar = make_daily_bar("2025-01-06", 100, 105, 95, 100)
        for coverage in (
            make_coverage(missing=(date(2025, 1, 7),)),
            make_coverage(provider_complete=False),
        ):
            with self.subTest(coverage=coverage):
                result = evaluate_forecast(make_input((bar,), coverage=coverage))
                self.assertEqual(
                    (result.kind, result.reason_code),
                    ("needs_review", "insufficient_horizon_coverage"),
                )

    def test_missing_earlier_session_blocks_later_target_touch(self) -> None:
        later_target = make_daily_bar("2025-01-07", 105, 111, 100, 109)
        coverage = make_coverage(missing=(date(2025, 1, 6),))
        result = evaluate_forecast(
            make_input((later_target,), coverage=coverage)
        )
        self.assertEqual(
            (result.kind, result.reason_code),
            ("needs_review", "insufficient_observation_path_coverage"),
        )
        self.assertEqual(
            result.evidence.coverage_findings[
                "observation_path_missing_sessions"
            ],
            (date(2025, 1, 6),),
        )

    def test_partial_or_unsupported_provider_blocks_candidate_touch(self) -> None:
        target = make_daily_bar("2025-01-06", 100, 111, 99, 108)
        unsupported = make_coverage(
            expected=(),
            available_at=instant("2025-01-08T05:00:00Z"),
            supported=False,
        )
        for coverage in (
            make_coverage(provider_complete=False),
            unsupported,
        ):
            with self.subTest(coverage=coverage):
                result = evaluate_forecast(
                    make_input((target,), coverage=coverage)
                )
                self.assertEqual(
                    (result.kind, result.reason_code),
                    (
                        "needs_review",
                        "insufficient_observation_path_coverage",
                    ),
                )

    def test_future_session_after_trigger_does_not_block_proven_touch(self) -> None:
        target = make_daily_bar("2025-01-06", 100, 111, 99, 108)
        cutoff = instant("2025-01-07T17:00:00Z")
        result = evaluate_forecast(make_input((target,), cutoff=cutoff))
        self.assertEqual(result.kind, "target_hit")
        findings = result.evidence.coverage_findings
        self.assertEqual(findings["future_expected_sessions"], (date(2025, 1, 7),))
        self.assertEqual(findings["observation_path_missing_sessions"], ())

    def test_unsupported_calendar_needs_review_only_when_reviewable(self) -> None:
        terms = make_terms()
        bar = make_daily_bar("2025-01-06", 100, 105, 95, 100)
        proof = build_exchange_coverage(
            (bar,),
            activation_cutoff=terms.activation_cutoff,
            evaluation_date=terms.evaluation_date,
            cutoff=instant("2025-01-09T00:00:00Z"),
            calendar_id="UNSUPPORTED",
            observed_currency="USD",
        )
        result = evaluate_forecast(
            make_input(
                (bar,),
                terms=terms,
                cutoff=instant("2025-01-09T00:00:00Z"),
                coverage=proof,
            )
        )
        self.assertEqual(result.reason_code, "insufficient_horizon_coverage")

    def test_dst_boundary_uses_local_midnight_offset(self) -> None:
        activated = datetime(2025, 3, 7, 12, 0, tzinfo=NY)
        terms = make_terms(
            activated_at=activated,
            evaluation_date=date(2025, 3, 10),
        )
        bars = (
            make_daily_bar("2025-03-07", 100, 105, 95, 100),
            make_daily_bar("2025-03-10", 100, 105, 95, 100),
        )
        cutoff = datetime(2025, 3, 11, 0, 0, tzinfo=NY)
        coverage = build_exchange_coverage(
            bars,
            activation_cutoff=terms.activation_cutoff,
            evaluation_date=terms.evaluation_date,
            cutoff=cutoff,
            calendar_id="XNYS",
            observed_currency="USD",
        )
        result = evaluate_forecast(
            make_input(bars, terms=terms, cutoff=cutoff, coverage=coverage)
        )
        self.assertEqual(coverage.horizon_available_at.utcoffset(), timedelta(hours=-4))
        self.assertEqual(result.kind, "expired")

    def test_fall_dst_boundary_uses_new_local_midnight_offset(self) -> None:
        activated = datetime(2025, 10, 31, 12, 0, tzinfo=NY)
        terms = make_terms(
            activated_at=activated,
            evaluation_date=date(2025, 11, 3),
        )
        bars = (
            make_daily_bar("2025-10-31", 100, 105, 95, 100),
            make_daily_bar("2025-11-03", 100, 105, 95, 100),
        )
        cutoff = datetime(2025, 11, 4, 0, 0, tzinfo=NY)
        coverage = build_exchange_coverage(
            bars,
            activation_cutoff=terms.activation_cutoff,
            evaluation_date=terms.evaluation_date,
            cutoff=cutoff,
            calendar_id="XNYS",
            observed_currency="USD",
        )
        result = evaluate_forecast(
            make_input(bars, terms=terms, cutoff=cutoff, coverage=coverage)
        )
        self.assertEqual(coverage.horizon_available_at.utcoffset(), timedelta(hours=-5))
        self.assertEqual(result.kind, "expired")


class CorporateActionAndNeutralTests(unittest.TestCase):
    def test_currency_mismatch_and_unverified_currency_need_review(self) -> None:
        bar = make_daily_bar("2025-01-06", 100, 105, 95, 100)
        cases = (
            ("JPY", "currency_mismatch"),
            (None, "currency_unverified"),
        )
        for observed_currency, reason in cases:
            with self.subTest(observed_currency=observed_currency):
                result = evaluate_forecast(
                    make_input(
                        (bar,),
                        coverage=make_coverage(
                            observed_currency=observed_currency
                        ),
                    )
                )
                self.assertEqual((result.kind, result.reason_code), ("needs_review", reason))
                self.assertEqual(result.evidence.activation_currency, "USD")
                self.assertEqual(
                    result.evidence.observed_currency, observed_currency
                )

    def test_split_takes_precedence_over_price_touch(self) -> None:
        bar = make_daily_bar("2025-01-06", 25, 26, 24, 25, flags=("split",))
        result = evaluate_forecast(make_input((bar,)))
        self.assertEqual(
            (result.kind, result.reason_code),
            ("needs_review", "corporate_action_price_discontinuity"),
        )

    def test_explicitly_incomplete_corporate_action_metadata_blocks_scoring(self) -> None:
        bar = make_daily_bar(
            "2025-01-06",
            25,
            26,
            24,
            25,
            flags=("corporate_action_metadata_incomplete",),
        )
        result = evaluate_forecast(make_input((bar,)))
        self.assertEqual(
            (result.kind, result.reason_code),
            ("needs_review", "corporate_action_price_discontinuity"),
        )
        self.assertIn("incomplete corporate-action metadata", result.explanation)

    def test_unflagged_split_like_raw_move_is_not_guessed(self) -> None:
        bar = make_daily_bar("2025-01-06", 25, 26, 24, 25)
        result = evaluate_forecast(make_input((bar,)))
        self.assertEqual(result.kind, "invalidated")

    def test_prior_proven_terminal_event_wins_over_later_split(self) -> None:
        bars = (
            make_daily_bar("2025-01-06", 100, 111, 99, 108),
            make_daily_bar("2025-01-07", 25, 26, 24, 25, flags=("split",)),
        )
        result = evaluate_forecast(make_input(bars))
        self.assertEqual(result.kind, "target_hit")
        self.assertEqual(
            result.evidence.triggering_observation.market_date, date(2025, 1, 6)
        )

    def test_consistent_raw_series_and_dividend_warning_remain_evaluable(self) -> None:
        bars = (
            make_daily_bar("2025-01-06", 100, 105, 95, 101, flags=("dividend",)),
            make_daily_bar("2025-01-07", 101, 106, 96, 102),
        )
        result = evaluate_forecast(make_input(bars))
        self.assertEqual(result.kind, "expired")
        self.assertEqual(result.evidence.warnings, ("dividend_observed",))

    def test_adjustment_mode_mismatch_needs_review(self) -> None:
        bar = make_daily_bar(
            "2025-01-06", 100, 111, 99, 108, adjustment_mode="split_adjusted"
        )
        result = evaluate_forecast(make_input((bar,)))
        self.assertEqual(
            (result.kind, result.reason_code),
            ("needs_review", "adjustment_mode_mismatch"),
        )

    def test_neutral_forecast_is_explicitly_unsupported(self) -> None:
        result = evaluate_forecast(
            make_input(
                (make_daily_bar("2025-01-06", 100, 104, 96, 101),),
                terms=make_terms("neutral"),
            )
        )
        self.assertEqual(
            (result.kind, result.reason_code),
            ("needs_review", "neutral_policy_unsupported"),
        )
        self.assertIsNone(result.evidence.target_boundary)

    def test_directional_forecast_without_invalidation_can_hit_or_expire(self) -> None:
        without_invalidation = replace(make_terms(), invalidation_price=None)
        target = evaluate_forecast(
            make_input(
                (make_daily_bar("2025-01-06", 100, 110, 80, 105),),
                terms=without_invalidation,
            )
        )
        expired = evaluate_forecast(
            make_input(
                (
                    make_daily_bar("2025-01-06", 100, 105, 80, 100),
                    make_daily_bar("2025-01-07", 100, 105, 75, 100),
                ),
                terms=without_invalidation,
            )
        )
        self.assertEqual(target.kind, "target_hit")
        self.assertEqual(expired.kind, "expired")


class ValidationAndDeterminismTests(unittest.TestCase):
    def test_malformed_unordered_duplicate_and_mixed_observations_fail_typed(self) -> None:
        first = make_daily_bar("2025-01-06", 100, 105, 95, 100)
        second = make_daily_bar("2025-01-07", 100, 105, 95, 100)
        malformed = (
            (second, first),
            (first, first),
            (first, replace(second, symbol="MSFT")),
        )
        for bars in malformed:
            with self.subTest(bars=bars):
                with self.assertRaises(EvaluationContractError):
                    make_input(bars)

    def test_invalid_forecast_geometry_cutoff_and_coverage_fail_typed(self) -> None:
        with self.assertRaises(EvaluationContractError):
            replace(make_terms(), target_price=99)
        with self.assertRaises(EvaluationContractError):
            make_input((), cutoff=instant("2025-01-01T00:00:00Z"))
        with self.assertRaises(EvaluationContractError):
            replace(
                make_coverage(),
                expected_sessions=(date(2025, 1, 7), date(2025, 1, 6)),
            )

    def test_incomplete_and_malformed_availability_are_rejected(self) -> None:
        incomplete = make_daily_bar(
            "2025-01-06", 100, 105, 95, 100, is_complete=False
        )
        malformed_completion = replace(
            make_daily_bar("2025-01-06", 100, 105, 95, 100),
            completed_at=datetime(2025, 1, 8, 0, 0, tzinfo=NY),
        )
        for bar in (incomplete, malformed_completion):
            with self.subTest(bar=bar):
                with self.assertRaises(EvaluationContractError):
                    make_input((bar,))

    def test_fabricated_or_cutoff_inconsistent_coverage_is_rejected(self) -> None:
        bar = make_daily_bar("2025-01-06", 100, 105, 95, 100)
        cutoff = instant("2025-01-07T17:00:00Z")
        fabricated_schedule = make_coverage(expected=(date(2025, 1, 7),))
        future_missing = make_coverage(missing=(date(2025, 1, 7),))
        wrong_version = replace(make_coverage(), calendar_version="fabricated")
        for coverage in (fabricated_schedule, future_missing, wrong_version):
            with self.subTest(coverage=coverage):
                with self.assertRaises(EvaluationContractError):
                    make_input((bar,), cutoff=cutoff, coverage=coverage)

    def test_empty_observation_history_is_rejected(self) -> None:
        with self.assertRaises(EvaluationContractError):
            make_input(())

    def test_ruleset_is_frozen_and_unknown_version_is_rejected(self) -> None:
        first = load_evaluation_ruleset()
        second = load_evaluation_ruleset()
        self.assertEqual(first, second)
        self.assertIsNot(first, second)
        self.assertEqual(first["evaluator_version"], EVALUATOR_VERSION)
        with self.assertRaises(EvaluationContractError):
            evaluate_forecast(
                replace(
                    make_input(
                        (make_daily_bar("2025-01-06", 100, 105, 95, 100),)
                    ),
                    ruleset_version="future-ruleset",
                )
            )

    def test_identical_logical_input_has_fixed_fingerprint_and_serialization(self) -> None:
        bars = (
            make_daily_bar("2025-01-06", 100, 105, 95, 101),
            make_daily_bar("2025-01-07", 101, 106, 96, 102),
        )
        first = evaluate_forecast(make_input(bars))
        second = evaluate_forecast(make_input(tuple(bars)))
        self.assertEqual(first, second)
        self.assertEqual(first.input_fingerprint, second.input_fingerprint)
        self.assertRegex(first.input_fingerprint, r"^[0-9a-f]{64}$")
        self.assertEqual(first.ruleset_version, RULESET_VERSION)
        payload = first.to_dict()
        self.assertEqual(payload["kind"], "expired")
        self.assertEqual(payload["evidence"]["activation_currency"], "USD")
        self.assertEqual(payload["evidence"]["observed_currency"], "USD")
        self.assertEqual(payload["evaluated_through"], "2025-01-07")
        self.assertEqual(
            payload["evidence"]["first_eligible_observation"]["market_date"],
            "2025-01-06",
        )
        self.assertEqual(
            first.input_fingerprint,
            "72f58c267e3e71d05cc1b28ca7d8ac3f7e1da2b17b0c874fee1afb57433dcf93",
        )

    def test_unavailable_future_observation_does_not_change_fingerprint(self) -> None:
        eligible = make_daily_bar("2025-01-06", 100, 105, 95, 101)
        unavailable = make_daily_bar("2025-01-07", 101, 120, 90, 110)
        cutoff = instant("2025-01-07T17:00:00Z")
        first = evaluate_forecast(make_input((eligible,), cutoff=cutoff))
        second = evaluate_forecast(
            make_input((eligible, unavailable), cutoff=cutoff)
        )
        self.assertEqual(first.kind, "no_change")
        self.assertEqual(first.input_fingerprint, second.input_fingerprint)

    def test_cutoff_advances_without_milestone_preserve_fingerprint(self) -> None:
        bar = make_daily_bar("2025-01-06", 100, 105, 95, 101)
        morning = evaluate_forecast(
            make_input((bar,), cutoff=instant("2025-01-07T12:00:00Z"))
        )
        evening = evaluate_forecast(
            make_input((bar,), cutoff=instant("2025-01-07T22:00:00Z"))
        )
        self.assertNotEqual(morning.evaluation_cutoff, evening.evaluation_cutoff)
        self.assertEqual(morning.input_fingerprint, evening.input_fingerprint)

    def test_equivalent_timezone_representations_have_same_fingerprint(self) -> None:
        bar = make_daily_bar("2025-01-06", 100, 105, 95, 101)
        utc_input = make_input((bar,))
        local_input = replace(
            utc_input,
            forecast=replace(
                utc_input.forecast,
                activated_at=utc_input.forecast.activated_at.astimezone(NY),
                activation_market_data_as_of=(
                    utc_input.forecast.activation_market_data_as_of.astimezone(NY)
                ),
            ),
            cutoff=utc_input.cutoff.astimezone(NY),
            coverage=replace(
                utc_input.coverage,
                horizon_available_at=(
                    utc_input.coverage.horizon_available_at.astimezone(NY)
                ),
            ),
        )
        self.assertEqual(
            evaluate_forecast(utc_input).input_fingerprint,
            evaluate_forecast(local_input).input_fingerprint,
        )


if __name__ == "__main__":
    unittest.main()
