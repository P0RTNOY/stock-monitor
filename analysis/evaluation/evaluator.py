from __future__ import annotations

from datetime import date
from typing import Any

from analysis.contracts import Bar
from analysis.evaluation.calendar import next_local_midnight
from analysis.evaluation.contracts import (
    DecisionKind,
    DetectionMode,
    EvaluationEvidence,
    EvaluationInput,
    EvaluationResult,
    ObservationEvidence,
)
from analysis.evaluation.fingerprint import input_fingerprint
from analysis.evaluation.ruleset import (
    EVALUATOR_VERSION,
    load_evaluation_ruleset,
)


_EXPLANATIONS: dict[str, str] = {
    "no_terminal_boundary_touched": (
        "No target or invalidation boundary was touched by an eligible completed bar."
    ),
    "horizon_not_complete": (
        "The forecast horizon is not yet complete under the exchange coverage proof."
    ),
    "target_boundary_touched": (
        "An eligible completed bar reached the saved target boundary."
    ),
    "invalidation_boundary_touched": (
        "An eligible completed bar reached the saved invalidation boundary."
    ),
    "horizon_complete_without_terminal_touch": (
        "Complete exchange-session coverage reached the horizon without a target or invalidation touch."
    ),
    "same_bar_target_invalidation_collision": (
        "The same completed OHLC bar touched target and invalidation, so their order cannot be proven."
    ),
    "insufficient_horizon_coverage": (
        "The horizon should be reviewable, but complete exchange-session coverage cannot be proven."
    ),
    "insufficient_observation_path_coverage": (
        "A later boundary touch cannot be proven because the completed observation path to that session is incomplete."
    ),
    "corporate_action_price_discontinuity": (
        "A verified split or incomplete corporate-action metadata makes the saved raw forecast levels unsafe to compare with evaluated prices."
    ),
    "adjustment_mode_mismatch": (
        "The observation adjustment mode does not match the raw activation snapshot."
    ),
    "currency_mismatch": (
        "The verified observation currency does not match the saved activation currency."
    ),
    "currency_unverified": (
        "The observation currency is unavailable, so the saved forecast levels cannot be compared safely."
    ),
    "neutral_policy_unsupported": (
        "Phase 1 neutral forecasts do not store enough policy information for deterministic evaluation."
    ),
}


def eligible_observations(evaluation: EvaluationInput) -> tuple[Bar, ...]:
    activation_cutoff = evaluation.forecast.activation_cutoff
    return tuple(
        bar
        for bar in evaluation.observations
        if bar.is_complete
        and bar.completed_at > activation_cutoff
        and bar.completed_at <= evaluation.cutoff
        and bar.timestamp.date() <= evaluation.forecast.evaluation_date
    )


def _target_touched(direction: str, boundary: float, bar: Bar) -> bool:
    return bar.high >= boundary if direction == "bullish" else bar.low <= boundary


def _target_at_open(direction: str, boundary: float, bar: Bar) -> bool:
    return bar.open >= boundary if direction == "bullish" else bar.open <= boundary


def _invalidation_touched(direction: str, boundary: float, bar: Bar) -> bool:
    return bar.low <= boundary if direction == "bullish" else bar.high >= boundary


def _invalidation_at_open(direction: str, boundary: float, bar: Bar) -> bool:
    return bar.open <= boundary if direction == "bullish" else bar.open >= boundary


def _warnings(bars: tuple[Bar, ...]) -> tuple[str, ...]:
    warnings: set[str] = set()
    for bar in bars:
        flags = set(bar.corporate_action_flags)
        if "dividend" in flags:
            warnings.add("dividend_observed")
        if "corporate_action_metadata_incomplete" in flags:
            warnings.add("corporate_action_metadata_incomplete")
    return tuple(sorted(warnings))


def _coverage_findings(
    evaluation: EvaluationInput,
    bars: tuple[Bar, ...],
) -> dict[str, Any]:
    proof = evaluation.coverage
    observed_sessions = {bar.timestamp.date() for bar in bars}
    available_expected = tuple(
        session
        for session in proof.expected_sessions
        if next_local_midnight(session, proof.market_timezone) <= evaluation.cutoff
    )
    future_expected = tuple(
        session
        for session in proof.expected_sessions
        if session not in set(available_expected)
    )
    derived_missing = {
        session for session in available_expected if session not in observed_sessions
    }
    missing_available = tuple(
        sorted(set(proof.missing_sessions) | derived_missing)
    )
    return {
        "calendar_id": proof.calendar_id,
        "calendar_version": proof.calendar_version,
        "calendar_supported": proof.calendar_supported,
        "market_timezone": proof.market_timezone,
        "expected_sessions": proof.expected_sessions,
        "available_expected_sessions": available_expected,
        "future_expected_sessions": future_expected,
        "final_expected_session": proof.final_expected_session,
        "horizon_available_at": proof.horizon_available_at,
        "missing_available_sessions": missing_available,
        "provider_complete": proof.provider_complete,
        "observed_currency": proof.observed_currency,
        "horizon_reviewable": evaluation.cutoff >= proof.horizon_available_at,
        "coverage_complete": (
            proof.calendar_supported
            and proof.provider_complete
            and bool(proof.expected_sessions)
            and not missing_available
            and evaluation.cutoff >= proof.horizon_available_at
        ),
    }


def _candidate_path_findings(
    findings: dict[str, Any],
    candidate: Bar,
) -> dict[str, Any]:
    candidate_date = candidate.timestamp.date()
    expected_path = tuple(
        session
        for session in findings["available_expected_sessions"]
        if session <= candidate_date
    )
    missing_path = tuple(
        session
        for session in findings["missing_available_sessions"]
        if session <= candidate_date
    )
    candidate_is_expected = candidate_date in set(expected_path)
    path_complete = (
        findings["calendar_supported"]
        and findings["provider_complete"]
        and candidate_is_expected
        and not missing_path
    )
    return {
        **findings,
        "observation_path_checked_through": candidate_date,
        "observation_path_expected_sessions": expected_path,
        "observation_path_missing_sessions": missing_path,
        "observation_path_complete": path_complete,
    }


def _result(
    evaluation: EvaluationInput,
    bars: tuple[Bar, ...],
    fingerprint: str,
    *,
    kind: DecisionKind,
    reason_code: str,
    triggering: Bar | None = None,
    detected_at: DetectionMode | None = None,
    crossed_boundary: float | None = None,
    corporate_findings: tuple[str, ...] = (),
    coverage_findings: dict[str, Any] | None = None,
) -> EvaluationResult:
    forecast = evaluation.forecast
    first = ObservationEvidence.from_bar(bars[0]) if bars else None
    last = ObservationEvidence.from_bar(bars[-1]) if bars else None
    target_boundary = (
        forecast.target_entry_boundary
        if forecast.direction in {"bullish", "bearish"}
        else None
    )
    evidence = EvaluationEvidence(
        activation_cutoff=forecast.activation_cutoff,
        activation_currency=forecast.currency,
        observed_currency=evaluation.coverage.observed_currency,
        observation_count=len(bars),
        first_eligible_observation=first,
        last_eligible_observation=last,
        triggering_observation=(
            ObservationEvidence.from_bar(triggering) if triggering else None
        ),
        target_boundary=target_boundary,
        target_range=forecast.target_range,
        invalidation_boundary=forecast.invalidation_price,
        detected_at=detected_at,
        observed_open=triggering.open if triggering and detected_at == "open" else None,
        crossed_boundary=crossed_boundary,
        corporate_action_findings=corporate_findings,
        coverage_findings=coverage_findings
        if coverage_findings is not None
        else _coverage_findings(evaluation, bars),
        warnings=_warnings(bars),
    )
    return EvaluationResult(
        kind=kind,
        reason_code=reason_code,
        explanation=_EXPLANATIONS[reason_code],
        evaluator_version=EVALUATOR_VERSION,
        ruleset_version=evaluation.ruleset_version,
        forecast_id=forecast.forecast_id,
        evaluation_cutoff=evaluation.cutoff,
        evaluated_through=bars[-1].timestamp.date() if bars else None,
        input_fingerprint=fingerprint,
        evidence=evidence,
    )


def evaluate_forecast(evaluation: EvaluationInput) -> EvaluationResult:
    """Evaluate immutable forecast terms with no I/O, clock, or mutable state."""
    load_evaluation_ruleset(evaluation.ruleset_version)
    bars = eligible_observations(evaluation)
    coverage_findings = _coverage_findings(evaluation, bars)
    fingerprint = input_fingerprint(
        evaluation.forecast,
        bars,
        coverage_findings,
        evaluation.ruleset_version,
    )
    forecast = evaluation.forecast

    if evaluation.coverage.observed_currency is None:
        return _result(
            evaluation,
            bars,
            fingerprint,
            kind="needs_review",
            reason_code="currency_unverified",
            coverage_findings=coverage_findings,
        )
    if evaluation.coverage.observed_currency != forecast.currency:
        return _result(
            evaluation,
            bars,
            fingerprint,
            kind="needs_review",
            reason_code="currency_mismatch",
            coverage_findings=coverage_findings,
        )

    if forecast.direction == "neutral":
        return _result(
            evaluation,
            bars,
            fingerprint,
            kind="needs_review",
            reason_code="neutral_policy_unsupported",
            coverage_findings=coverage_findings,
        )

    mismatched = tuple(
        bar for bar in bars if bar.adjustment_mode != forecast.adjustment_mode
    )
    if mismatched:
        modes = tuple(sorted({bar.adjustment_mode for bar in mismatched}))
        return _result(
            evaluation,
            bars,
            fingerprint,
            kind="needs_review",
            reason_code="adjustment_mode_mismatch",
            corporate_findings=(
                f"forecast={forecast.adjustment_mode}",
                f"observations={','.join(modes)}",
            ),
            coverage_findings=coverage_findings,
        )

    target = forecast.target_entry_boundary
    invalidation = forecast.invalidation_price
    for bar in bars:
        flags = set(bar.corporate_action_flags)
        if "split" in flags or "corporate_action_metadata_incomplete" in flags:
            finding = (
                "split"
                if "split" in flags
                else "corporate_action_metadata_incomplete"
            )
            return _result(
                evaluation,
                bars,
                fingerprint,
                kind="needs_review",
                reason_code="corporate_action_price_discontinuity",
                triggering=bar,
                corporate_findings=(
                    f"{finding}:{bar.timestamp.date().isoformat()}",
                ),
                coverage_findings=coverage_findings,
            )
        target_touch = _target_touched(forecast.direction, target, bar)
        target_open = _target_at_open(forecast.direction, target, bar)
        invalidation_touch = (
            invalidation is not None
            and _invalidation_touched(forecast.direction, invalidation, bar)
        )
        invalidation_open = (
            invalidation is not None
            and _invalidation_at_open(forecast.direction, invalidation, bar)
        )

        if target_touch or invalidation_touch:
            path_findings = _candidate_path_findings(coverage_findings, bar)
            if not path_findings["observation_path_complete"]:
                return _result(
                    evaluation,
                    bars,
                    fingerprint,
                    kind="needs_review",
                    reason_code="insufficient_observation_path_coverage",
                    triggering=bar,
                    coverage_findings=path_findings,
                )
        else:
            path_findings = coverage_findings

        if target_open and not invalidation_open:
            return _result(
                evaluation,
                bars,
                fingerprint,
                kind="target_hit",
                reason_code="target_boundary_touched",
                triggering=bar,
                detected_at="open",
                crossed_boundary=target,
                coverage_findings=path_findings,
            )
        if invalidation_open and not target_open:
            assert invalidation is not None
            return _result(
                evaluation,
                bars,
                fingerprint,
                kind="invalidated",
                reason_code="invalidation_boundary_touched",
                triggering=bar,
                detected_at="open",
                crossed_boundary=invalidation,
                coverage_findings=path_findings,
            )
        if target_touch and invalidation_touch:
            return _result(
                evaluation,
                bars,
                fingerprint,
                kind="needs_review",
                reason_code="same_bar_target_invalidation_collision",
                triggering=bar,
                coverage_findings=path_findings,
            )
        if target_touch:
            return _result(
                evaluation,
                bars,
                fingerprint,
                kind="target_hit",
                reason_code="target_boundary_touched",
                triggering=bar,
                detected_at="within_bar",
                crossed_boundary=target,
                coverage_findings=path_findings,
            )
        if invalidation_touch:
            assert invalidation is not None
            return _result(
                evaluation,
                bars,
                fingerprint,
                kind="invalidated",
                reason_code="invalidation_boundary_touched",
                triggering=bar,
                detected_at="within_bar",
                crossed_boundary=invalidation,
                coverage_findings=path_findings,
            )

    if not coverage_findings["horizon_reviewable"]:
        return _result(
            evaluation,
            bars,
            fingerprint,
            kind="no_change",
            reason_code="horizon_not_complete",
            coverage_findings=coverage_findings,
        )
    if not coverage_findings["coverage_complete"]:
        return _result(
            evaluation,
            bars,
            fingerprint,
            kind="needs_review",
            reason_code="insufficient_horizon_coverage",
            coverage_findings=coverage_findings,
        )
    return _result(
        evaluation,
        bars,
        fingerprint,
        kind="expired",
        reason_code="horizon_complete_without_terminal_touch",
        coverage_findings=coverage_findings,
    )
