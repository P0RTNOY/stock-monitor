from __future__ import annotations

from typing import Any

import pandas as pd

from finance import get_price_history


def _safe_round(value: Any, digits: int = 2) -> float | None:
    if value is None or pd.isna(value):
        return None
    return round(float(value), digits)


def _calculate_rsi(close: pd.Series, period: int = 14) -> float | None:
    if len(close.dropna()) <= period:
        return None

    delta = close.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    latest_loss = loss.iloc[-1]

    if pd.isna(latest_loss):
        return None
    latest_gain = gain.iloc[-1]
    if pd.isna(latest_gain):
        return None
    if latest_gain == 0 and latest_loss == 0:
        return 50.0
    if latest_loss == 0:
        return 100.0

    rs = latest_gain / latest_loss
    return _safe_round(100 - (100 / (1 + rs)))


def get_technical_context(symbol: str) -> dict[str, float | None]:
    history = get_price_history(symbol, period="1y")
    if history.empty:
        return {
            "latest_close": None,
            "sma_20": None,
            "sma_50": None,
            "rsi_14": None,
            "week_52_high": None,
            "week_52_low": None,
            "distance_from_52w_high_pct": None,
            "distance_from_52w_low_pct": None,
        }

    close = history["Close"].dropna()
    if close.empty:
        return {
            "latest_close": None,
            "sma_20": None,
            "sma_50": None,
            "rsi_14": None,
            "week_52_high": None,
            "week_52_low": None,
            "distance_from_52w_high_pct": None,
            "distance_from_52w_low_pct": None,
        }

    latest_close = float(close.iloc[-1])
    high_52 = float(close.max())
    low_52 = float(close.min())

    return {
        "latest_close": _safe_round(latest_close),
        "sma_20": _safe_round(close.tail(20).mean()) if len(close) >= 20 else None,
        "sma_50": _safe_round(close.tail(50).mean()) if len(close) >= 50 else None,
        "rsi_14": _calculate_rsi(close),
        "week_52_high": _safe_round(high_52),
        "week_52_low": _safe_round(low_52),
        "distance_from_52w_high_pct": _safe_round(
            ((latest_close - high_52) / high_52) * 100
        )
        if high_52
        else None,
        "distance_from_52w_low_pct": _safe_round(
            ((latest_close - low_52) / low_52) * 100
        )
        if low_52
        else None,
    }
