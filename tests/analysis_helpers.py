from __future__ import annotations

from datetime import datetime, timedelta, timezone

from analysis.contracts import Bar, Pivot


START = datetime(2025, 1, 1, 21, 0, tzinfo=timezone.utc)


def make_bar(
    index: int,
    *,
    close: float = 100.0,
    high: float | None = None,
    low: float | None = None,
    open_price: float | None = None,
    volume: float = 1_000.0,
    complete: bool = True,
    timeframe: str = "1d",
    flags: tuple[str, ...] = (),
    completed_after_days: int = 1,
) -> Bar:
    timestamp = START + timedelta(days=index)
    return Bar(
        symbol="AAPL",
        timeframe=timeframe,  # type: ignore[arg-type]
        timestamp=timestamp,
        completed_at=timestamp + timedelta(days=completed_after_days),
        timezone="America/New_York",
        open=close if open_price is None else open_price,
        high=close + 1 if high is None else high,
        low=close - 1 if low is None else low,
        close=close,
        volume=volume,
        is_complete=complete,
        adjustment_mode="raw",
        provider="yahoo-finance-prototype",
        corporate_action_flags=flags,
    )


def make_pivot(
    kind: str,
    price: float,
    index: int,
) -> Pivot:
    return Pivot(
        kind=kind,  # type: ignore[arg-type]
        price=price,
        bar_index=index,
        timestamp=START + timedelta(days=index),
        confirmation_index=index + 2,
        confirmation_timestamp=START + timedelta(days=index + 2),
    )
