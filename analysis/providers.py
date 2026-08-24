from __future__ import annotations

from datetime import datetime, time, timedelta
from typing import Callable
from zoneinfo import ZoneInfo

import pandas as pd

from analysis.contracts import Bar, ContractError
from finance import get_ohlcv_history


class ProviderError(RuntimeError):
    """Safe provider failure without leaking upstream payloads."""


HistoryLoader = Callable[[str, str, str], pd.DataFrame]


def validate_bar_sequence(bars: tuple[Bar, ...] | list[Bar]) -> tuple[Bar, ...]:
    normalized = tuple(bars)
    if not normalized:
        return normalized

    first = normalized[0]
    previous_timestamp: datetime | None = None
    for bar in normalized:
        if bar.symbol != first.symbol:
            raise ContractError("all bars must have the same symbol")
        if bar.timeframe != first.timeframe:
            raise ContractError("all bars must have the same timeframe")
        if bar.provider != first.provider:
            raise ContractError("all bars must have the same provider")
        if bar.timezone != first.timezone:
            raise ContractError("all bars must have the same timezone")
        if bar.adjustment_mode != first.adjustment_mode:
            raise ContractError("all bars must have the same adjustment mode")
        if previous_timestamp is not None and bar.timestamp <= previous_timestamp:
            raise ContractError("bar timestamps must be strictly increasing and unique")
        previous_timestamp = bar.timestamp
    return normalized


def bars_from_frame(
    frame: pd.DataFrame,
    symbol: str,
    as_of: datetime,
    *,
    timezone: str = "America/New_York",
    provider: str = "yahoo-finance-prototype",
) -> tuple[Bar, ...]:
    if as_of.tzinfo is None or as_of.utcoffset() is None:
        raise ContractError("as_of must be timezone-aware")
    required = {"Timestamp", "Open", "High", "Low", "Close", "Volume"}
    missing = required - set(frame.columns)
    if missing:
        raise ContractError(f"OHLCV frame is missing columns: {sorted(missing)}")

    market_zone = ZoneInfo(timezone)
    market_as_of = as_of.astimezone(market_zone)
    bars: list[Bar] = []
    for row in frame.to_dict(orient="records"):
        timestamp = pd.Timestamp(row["Timestamp"])
        if timestamp.tzinfo is None:
            timestamp = timestamp.tz_localize(market_zone)
        else:
            timestamp = timestamp.tz_convert(market_zone)
        timestamp_value = timestamp.to_pydatetime()
        if timestamp_value > market_as_of:
            continue
        completed_at = datetime.combine(
            timestamp_value.date() + timedelta(days=1),
            time.min,
            tzinfo=market_zone,
        )

        flags: list[str] = []
        dividends = row.get("Dividends", 0.0)
        splits = row.get("Stock Splits", 0.0)
        if pd.notna(dividends) and float(dividends) != 0:
            flags.append("dividend")
        if pd.notna(splits) and float(splits) != 0:
            flags.append("split")

        bars.append(
            Bar(
                symbol=symbol,
                timeframe="1d",
                timestamp=timestamp_value,
                completed_at=completed_at,
                timezone=timezone,
                open=float(row["Open"]),
                high=float(row["High"]),
                low=float(row["Low"]),
                close=float(row["Close"]),
                volume=float(row["Volume"]),
                # Without an exchange calendar, excluding the as-of date is the
                # conservative way to avoid treating a live daily candle as final.
                is_complete=completed_at <= market_as_of,
                adjustment_mode="raw",
                provider=provider,
                corporate_action_flags=tuple(flags),
            )
        )
    return validate_bar_sequence(bars)


class YahooFinanceProvider:
    def __init__(
        self,
        history_loader: HistoryLoader = get_ohlcv_history,
        *,
        timezone: str = "America/New_York",
    ) -> None:
        self.history_loader = history_loader
        self.timezone = timezone
        self.name = "yahoo-finance-prototype"

    def fetch_daily_bars(
        self,
        symbol: str,
        as_of: datetime,
        *,
        period: str = "2y",
    ) -> tuple[Bar, ...]:
        frame = self.history_loader(symbol, period, "1d")
        if frame.empty:
            raise ProviderError("No OHLCV market data is available")
        return bars_from_frame(
            frame,
            symbol,
            as_of,
            timezone=self.timezone,
            provider=self.name,
        )
