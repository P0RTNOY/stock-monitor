from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any, Callable, Mapping
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pandas as pd

from analysis.contracts import Bar, ContractError
from finance import get_ohlcv_history, get_ohlcv_history_range_with_metadata


class ProviderError(RuntimeError):
    """Safe provider failure without leaking upstream payloads."""


HistoryLoader = Callable[[str, str, str], pd.DataFrame]
EvaluationHistoryLoader = Callable[
    [str, date, date, str],
    tuple[pd.DataFrame, Mapping[str, Any]],
]

EVALUATION_PROVIDER_TIMEOUT_SECONDS = 10
MAX_EVALUATION_HISTORY_DAYS = 740
_HISTORY_LOOKBACK_BUFFER_DAYS = 10
_YAHOO_CALENDAR_ALIASES = {
    "ASE": "XASE",
    "AMEX": "XASE",
    "XASE": "XASE",
    "NCM": "XNAS",
    "NGM": "XNAS",
    "NMS": "XNAS",
    "NASDAQ": "XNAS",
    "XNAS": "XNAS",
    "NYQ": "XNYS",
    "NYSE": "XNYS",
    "XNYS": "XNYS",
}


@dataclass(frozen=True)
class EvaluationMarketData:
    observations: tuple[Bar, ...]
    calendar_id: str
    market_timezone: str
    currency: str | None
    exchange: str


def _default_evaluation_history_loader(
    symbol: str,
    start: date,
    end: date,
    interval: str,
) -> tuple[pd.DataFrame, Mapping[str, Any]]:
    return get_ohlcv_history_range_with_metadata(
        symbol,
        start,
        end,
        interval,
        timeout=EVALUATION_PROVIDER_TIMEOUT_SECONDS,
    )


def yahoo_calendar_id(exchange: str) -> str:
    """Resolve only explicitly supported Yahoo exchange identifiers."""

    normalized = exchange.strip().upper()
    if not normalized or len(normalized) > 32:
        raise ProviderError("Yahoo exchange metadata is unavailable")
    return _YAHOO_CALENDAR_ALIASES.get(normalized, f"YAHOO:{normalized}")


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
        if pd.isna(dividends) or pd.isna(splits):
            flags.append("corporate_action_metadata_incomplete")
        else:
            if float(dividends) != 0:
                flags.append("dividend")
            if float(splits) != 0:
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


class YahooEvaluationProvider:
    """Trusted, bounded Yahoo adapter for forecast-evaluation observations."""

    def __init__(
        self,
        history_loader: EvaluationHistoryLoader = _default_evaluation_history_loader,
    ) -> None:
        self.history_loader = history_loader
        self.name = "yahoo-finance-prototype"

    def fetch_completed_observations(
        self,
        symbol: str,
        activation_cutoff: datetime,
        evaluation_date: date,
        cutoff: datetime,
    ) -> EvaluationMarketData:
        if activation_cutoff.tzinfo is None or activation_cutoff.utcoffset() is None:
            raise ContractError("activation_cutoff must be timezone-aware")
        if cutoff.tzinfo is None or cutoff.utcoffset() is None:
            raise ContractError("cutoff must be timezone-aware")
        retrieval_through = min(evaluation_date, cutoff.date())
        retrieval_days = (retrieval_through - activation_cutoff.date()).days
        if retrieval_days > MAX_EVALUATION_HISTORY_DAYS:
            raise ContractError(
                "elapsed evaluation window exceeds the bounded provider history window"
            )

        history_start = activation_cutoff.date() - timedelta(
            days=_HISTORY_LOOKBACK_BUFFER_DAYS
        )
        history_end = min(
            cutoff.date() + timedelta(days=2),
            evaluation_date + timedelta(days=2),
        )
        if history_end <= history_start:
            history_end = history_start + timedelta(days=1)

        try:
            frame, metadata = self.history_loader(
                symbol,
                history_start,
                history_end,
                "1d",
            )
        except Exception as exc:
            raise ProviderError("Yahoo market data is unavailable") from exc
        if not isinstance(frame, pd.DataFrame):
            raise ProviderError("Yahoo OHLCV market data is malformed")
        if frame.empty:
            raise ProviderError("No OHLCV market data is available")
        if not isinstance(metadata, Mapping):
            raise ProviderError("Yahoo market metadata is malformed")

        # Yahoo can omit action columns even when ``actions=True``. Evaluation
        # must not interpret absence as a verified zero because that can turn a
        # split discontinuity into a false terminal result. Explicit missing
        # values become the evaluator's review flag in ``bars_from_frame``. The
        # legacy analysis loader retains its existing zero-fill behavior.
        frame = frame.copy()
        for action_column in ("Dividends", "Stock Splits"):
            if action_column not in frame:
                frame[action_column] = pd.NA

        exchange = str(
            metadata.get("exchangeName") or metadata.get("exchange") or ""
        ).strip().upper()
        timezone_name = str(metadata.get("exchangeTimezoneName") or "").strip()
        raw_currency = metadata.get("currency")
        currency = (
            raw_currency.strip().upper()
            if isinstance(raw_currency, str) and raw_currency.strip()
            else None
        )
        if not timezone_name or len(timezone_name) > 64:
            raise ProviderError("Yahoo market timezone metadata is unavailable")
        try:
            ZoneInfo(timezone_name)
        except ZoneInfoNotFoundError as exc:
            raise ProviderError("Yahoo market timezone metadata is malformed") from exc
        if raw_currency is not None and currency is None:
            raise ProviderError("Yahoo currency metadata is malformed")
        if currency is not None and (
            not currency.isascii()
            or not currency.isalpha()
            or not 3 <= len(currency) <= 12
        ):
            raise ProviderError("Yahoo currency metadata is malformed")

        calendar_id = yahoo_calendar_id(exchange)
        try:
            observations = tuple(
                bar
                for bar in bars_from_frame(
                    frame,
                    symbol,
                    cutoff,
                    timezone=timezone_name,
                    provider=self.name,
                )
                if bar.is_complete
            )
        except (ContractError, TypeError, ValueError, OverflowError) as exc:
            raise ProviderError("Yahoo OHLCV market data is malformed") from exc
        if not observations:
            raise ProviderError("No completed OHLCV market data is available")
        return EvaluationMarketData(
            observations=observations,
            calendar_id=calendar_id,
            market_timezone=timezone_name,
            currency=currency,
            exchange=exchange,
        )
