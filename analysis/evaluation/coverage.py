from __future__ import annotations

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from analysis.contracts import Bar
from analysis.evaluation.calendar import (
    SUPPORTED_CALENDARS,
    exchange_calendar_version,
    expected_exchange_sessions,
    next_local_midnight,
)
from analysis.evaluation.contracts import CoverageProof, EvaluationContractError


def build_exchange_coverage(
    observations: tuple[Bar, ...],
    *,
    activation_cutoff: datetime,
    evaluation_date: date,
    cutoff: datetime,
    calendar_id: str,
    provider_complete: bool = True,
    market_timezone: str | None = None,
    observed_currency: str | None = None,
) -> CoverageProof:
    """Build a deterministic daily-session proof without provider or clock access."""
    if activation_cutoff.tzinfo is None or activation_cutoff.utcoffset() is None:
        raise EvaluationContractError("activation_cutoff must be timezone-aware")
    if cutoff.tzinfo is None or cutoff.utcoffset() is None:
        raise EvaluationContractError("cutoff must be timezone-aware")
    if not isinstance(evaluation_date, date) or isinstance(
        evaluation_date, datetime
    ):
        raise EvaluationContractError("evaluation_date must be a date")

    calendar_version = exchange_calendar_version()
    timezone_name = SUPPORTED_CALENDARS.get(calendar_id)
    if timezone_name is None:
        fallback_timezone = market_timezone or (
            observations[0].timezone if observations else "UTC"
        )
        try:
            fallback_zone = ZoneInfo(fallback_timezone)
        except Exception as exc:
            raise EvaluationContractError(
                "market_timezone must be a valid IANA zone"
            ) from exc
        return CoverageProof(
            calendar_id=calendar_id,
            calendar_version=calendar_version,
            market_timezone=fallback_timezone,
            expected_sessions=(),
            final_expected_session=None,
            horizon_available_at=datetime.combine(
                evaluation_date + timedelta(days=1),
                time.min,
                tzinfo=fallback_zone,
            ),
            observed_currency=observed_currency,
            provider_complete=provider_complete,
            calendar_supported=False,
        )

    try:
        if market_timezone is not None and market_timezone != timezone_name:
            raise EvaluationContractError(
                "provider market_timezone does not match the supported calendar"
            )
        market_zone = ZoneInfo(timezone_name)
        expected = expected_exchange_sessions(
            calendar_id,
            activation_cutoff,
            evaluation_date,
        )
    except Exception as exc:
        raise EvaluationContractError(
            f"unable to build coverage for calendar {calendar_id}"
        ) from exc

    horizon_available_at = (
        next_local_midnight(expected[-1], timezone_name)
        if expected
        else datetime.combine(
            evaluation_date + timedelta(days=1),
            time.min,
            tzinfo=market_zone,
        )
    )
    observed = {
        bar.timestamp.astimezone(market_zone).date()
        for bar in observations
        if bar.is_complete
        and bar.completed_at > activation_cutoff
        and bar.completed_at <= cutoff
        and bar.timestamp.date() <= evaluation_date
    }
    available_sessions = tuple(
        session
        for session in expected
        if next_local_midnight(session, timezone_name) <= cutoff
    )
    missing = tuple(
        session for session in available_sessions if session not in observed
    )
    return CoverageProof(
        calendar_id=calendar_id,
        calendar_version=calendar_version,
        market_timezone=timezone_name,
        expected_sessions=expected,
        final_expected_session=expected[-1] if expected else None,
        horizon_available_at=horizon_available_at,
        observed_currency=observed_currency,
        missing_sessions=missing,
        provider_complete=provider_complete,
        calendar_supported=True,
    )
