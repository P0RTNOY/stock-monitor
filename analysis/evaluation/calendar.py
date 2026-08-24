from __future__ import annotations

from datetime import date, datetime, time, timedelta
from importlib.metadata import version
from zoneinfo import ZoneInfo


SUPPORTED_CALENDARS = {
    "XASE": "America/New_York",
    "XNAS": "America/New_York",
    "XNYS": "America/New_York",
}


def exchange_calendar_version() -> str:
    return version("exchange-calendars")


def next_local_midnight(session: date, timezone_name: str) -> datetime:
    return datetime.combine(
        session + timedelta(days=1),
        time.min,
        tzinfo=ZoneInfo(timezone_name),
    )


def expected_exchange_sessions(
    calendar_id: str,
    activation_cutoff: datetime,
    evaluation_date: date,
) -> tuple[date, ...]:
    import exchange_calendars as xcals

    timezone_name = SUPPORTED_CALENDARS[calendar_id]
    market_zone = ZoneInfo(timezone_name)
    market_activation = activation_cutoff.astimezone(market_zone)
    activation_date = market_activation.date()
    if evaluation_date < activation_date:
        raise ValueError(
            "evaluation_date must not precede the activation market date"
        )
    search_start = activation_date - timedelta(days=8)
    # The library's cached default calendar usually ends about a year from the
    # current date. Forecast horizons are explicit domain input and can extend
    # beyond that cache, so construct the deterministic calendar for the actual
    # requested horizon instead of treating a future valid date as unavailable.
    calendar = xcals.get_calendar(
        calendar_id,
        start=search_start,
        end=evaluation_date,
    )
    sessions = calendar.sessions_in_range(
        calendar.first_session,
        calendar.last_session,
    )
    return tuple(
        session.date()
        for session in sessions
        if next_local_midnight(session.date(), timezone_name) > market_activation
    )
