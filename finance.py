from __future__ import annotations

import json
import logging
from datetime import date
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import pandas as pd
import yfinance as yf


LOGGER = logging.getLogger(__name__)
OHLCV_COLUMNS = [
    "Timestamp",
    "Open",
    "High",
    "Low",
    "Close",
    "Volume",
    "Dividends",
    "Stock Splits",
]


def _log_external_failure(operation: str, error: Exception) -> None:
    LOGGER.warning("%s failed (%s)", operation, type(error).__name__)


def get_latest_price(symbol: str) -> float | None:
    try:
        ticker = yf.Ticker(symbol)
        history = ticker.history(period="5d", interval="1d", auto_adjust=False)
    except Exception as exc:
        _log_external_failure("Latest price lookup", exc)
        return None

    if history.empty or "Close" not in history:
        return None

    latest_close = history["Close"].dropna()
    if latest_close.empty:
        return None

    return round(float(latest_close.iloc[-1]), 2)


def get_prices_for_symbols(symbols: list[str]) -> dict[str, float | None]:
    return {symbol: get_latest_price(symbol) for symbol in symbols}


def get_quote_snapshot(symbol: str) -> dict[str, float | None]:
    try:
        ticker = yf.Ticker(symbol)
        history = ticker.history(period="7d", interval="1d", auto_adjust=False)
    except Exception as exc:
        _log_external_failure("Quote snapshot lookup", exc)
        return {
            "latest_price": None,
            "previous_close": None,
            "change": None,
            "change_pct": None,
        }

    if history.empty or "Close" not in history:
        return {
            "latest_price": None,
            "previous_close": None,
            "change": None,
            "change_pct": None,
        }

    closes = history["Close"].dropna()
    if closes.empty:
        return {
            "latest_price": None,
            "previous_close": None,
            "change": None,
            "change_pct": None,
        }

    latest_price = round(float(closes.iloc[-1]), 2)
    previous_close = round(float(closes.iloc[-2]), 2) if len(closes) > 1 else None
    if previous_close in (None, 0):
        change = None
        change_pct = None
    else:
        change = round(latest_price - previous_close, 2)
        change_pct = round((change / previous_close) * 100, 2)

    return {
        "latest_price": latest_price,
        "previous_close": previous_close,
        "change": change,
        "change_pct": change_pct,
    }


def get_quote_snapshots_for_symbols(
    symbols: list[str],
) -> dict[str, dict[str, float | None]]:
    return {symbol: get_quote_snapshot(symbol) for symbol in symbols}


def get_price_history(symbol: str, period: str = "1mo") -> pd.DataFrame:
    try:
        ticker = yf.Ticker(symbol)
        history = ticker.history(period=period, interval="1d", auto_adjust=False)
    except Exception as exc:
        _log_external_failure("Price history lookup", exc)
        return pd.DataFrame(columns=["Date", "Close"])

    if history.empty or "Close" not in history:
        return pd.DataFrame(columns=["Date", "Close"])

    history = history.reset_index()
    if "Date" not in history:
        return pd.DataFrame(columns=["Date", "Close"])

    return history[["Date", "Close"]].dropna()


def get_ohlcv_history(
    symbol: str,
    period: str = "2y",
    interval: str = "1d",
) -> pd.DataFrame:
    """Return raw Yahoo OHLCV data through a stable, provider-neutral shape.

    This is additive to ``get_price_history`` so the existing Streamlit UI keeps
    its close-only contract. Validation and completed-bar decisions belong to
    the analysis provider layer.
    """

    empty = pd.DataFrame(columns=OHLCV_COLUMNS)
    try:
        ticker = yf.Ticker(symbol)
        history = ticker.history(
            period=period,
            interval=interval,
            auto_adjust=False,
            back_adjust=False,
            actions=True,
            repair=False,
            keepna=True,
            prepost=False,
            rounding=False,
            timeout=10,
        )
    except Exception as exc:
        _log_external_failure("OHLCV history lookup", exc)
        return empty

    required = {"Open", "High", "Low", "Close", "Volume"}
    if history.empty or not required.issubset(history.columns):
        return empty

    history = history.reset_index()
    timestamp_column = next(
        (column for column in ("Datetime", "Date") if column in history),
        None,
    )
    if timestamp_column is None:
        return empty

    history = history.rename(columns={timestamp_column: "Timestamp"})
    for action_column in ("Dividends", "Stock Splits"):
        if action_column not in history:
            history[action_column] = 0.0

    result = history[OHLCV_COLUMNS].copy()
    for column in OHLCV_COLUMNS[1:]:
        result[column] = pd.to_numeric(result[column], errors="coerce")
    # Keep questionable numeric rows for the analysis contract to reject. Silent
    # omission would hide a data-quality failure and change indicator windows.
    result = result.dropna(subset=["Timestamp"])
    return result.reset_index(drop=True)


def get_ohlcv_history_range_with_metadata(
    symbol: str,
    start: date,
    end: date,
    interval: str = "1d",
    *,
    timeout: int = 10,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Return bounded raw OHLCV data and Yahoo chart metadata.

    This adapter is reserved for trusted server-side forecast evaluation.  The
    caller supplies an explicit date range and timeout; provider normalization
    and completed-bar decisions remain in :mod:`analysis.providers`.
    """

    empty = pd.DataFrame(columns=OHLCV_COLUMNS)
    try:
        ticker = yf.Ticker(symbol)
        history = ticker.history(
            start=start.isoformat(),
            end=end.isoformat(),
            interval=interval,
            auto_adjust=False,
            back_adjust=False,
            actions=True,
            repair=False,
            keepna=True,
            prepost=False,
            rounding=False,
            timeout=timeout,
        )
        metadata = ticker.get_history_metadata()
    except Exception as exc:
        _log_external_failure("Bounded OHLCV history lookup", exc)
        return empty, {}

    required = {"Open", "High", "Low", "Close", "Volume"}
    if history.empty or not required.issubset(history.columns):
        return empty, dict(metadata) if isinstance(metadata, dict) else {}

    history = history.reset_index()
    timestamp_column = next(
        (column for column in ("Datetime", "Date") if column in history),
        None,
    )
    if timestamp_column is None:
        return empty, dict(metadata) if isinstance(metadata, dict) else {}

    history = history.rename(columns={timestamp_column: "Timestamp"})
    for action_column in ("Dividends", "Stock Splits"):
        if action_column not in history:
            # Evaluation must distinguish absent Yahoo action metadata from a
            # verified zero. The trusted provider converts these missing values
            # into an explicit review condition.
            history[action_column] = pd.NA

    result = history[OHLCV_COLUMNS].copy()
    for column in OHLCV_COLUMNS[1:]:
        result[column] = pd.to_numeric(result[column], errors="coerce")
    result = result.dropna(subset=["Timestamp"]).reset_index(drop=True)
    return result, dict(metadata) if isinstance(metadata, dict) else {}


def search_symbols(query: str, limit: int = 10) -> list[dict[str, str]]:
    clean_query = query.strip()
    if not clean_query:
        return []

    params = urlencode({"q": clean_query, "quotesCount": limit, "newsCount": 0})
    url = f"https://query2.finance.yahoo.com/v1/finance/search?{params}"
    request = Request(url, headers={"User-Agent": "stock-forecast-journal/1.0"})

    try:
        with urlopen(request, timeout=8) as response:
            payload: dict[str, Any] = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        _log_external_failure("Symbol search", exc)
        return []

    results: list[dict[str, str]] = []
    for quote in payload.get("quotes", []):
        symbol = str(quote.get("symbol", "")).strip().upper()
        name = str(quote.get("shortname") or quote.get("longname") or "").strip()
        quote_type = str(quote.get("quoteType") or "").strip()
        exchange = str(quote.get("exchange") or "").strip()

        if not symbol or not name:
            continue

        results.append(
            {
                "symbol": symbol,
                "name": name,
                "type": quote_type,
                "exchange": exchange,
            }
        )

    return results
