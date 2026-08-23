from __future__ import annotations

from typing import TypedDict


MAG7: dict[str, str] = {
    "Apple": "AAPL",
    "Microsoft": "MSFT",
    "NVIDIA": "NVDA",
    "Amazon": "AMZN",
    "Alphabet": "GOOGL",
    "Meta": "META",
    "Tesla": "TSLA",
}

DIRECTIONS: tuple[str, ...] = (
    "No entry",
    "Bullish",
    "Bearish",
    "Neutral",
    "Pullback then bullish",
    "Pullback then bearish",
)

TRIGGER_CONDITIONS: tuple[str, ...] = (
    "Price above",
    "Price below",
    "Daily move above %",
    "Daily move below %",
)


class StockLogEntry(TypedDict):
    log_date: str
    stock_name: str
    symbol: str
    price: float | None
    direction: str
    target: str
    thesis: str
    confidence: int


class WatchlistStock(TypedDict):
    id: int
    stock_name: str
    symbol: str
    created_at: str
