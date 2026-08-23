from __future__ import annotations

import math
from typing import Any, Iterable, Mapping, Optional

import pandas as pd

from models import DIRECTIONS, TRIGGER_CONDITIONS


QuoteSnapshot = Mapping[str, Optional[float]]
QuoteSnapshots = Mapping[str, QuoteSnapshot]


def clean_text(value: Any) -> str:
    """Return trimmed scalar text while treating pandas missing values as empty."""
    if value is None:
        return ""
    try:
        missing = pd.isna(value)
        if isinstance(missing, bool) and missing:
            return ""
    except (TypeError, ValueError):
        pass
    return str(value).strip()


def _format_price(value: float | None) -> str:
    return "Unavailable" if value is None else f"${value:,.2f}"


def _format_signed(value: float | None, suffix: str = "") -> str:
    if value is None:
        return ""
    sign = "+" if value > 0 else ""
    return f"{sign}{value:,.2f}{suffix}"


def _drafts_by_id(draft_rows: Iterable[Mapping[str, Any]] | None) -> dict[int, Mapping[str, Any]]:
    drafts: dict[int, Mapping[str, Any]] = {}
    for row in draft_rows or ():
        try:
            stock_id = int(row["ID"])
        except (KeyError, TypeError, ValueError):
            continue
        drafts[stock_id] = row
    return drafts


def build_sheet_rows(
    stocks: Iterable[Mapping[str, Any]],
    saved_entries: Iterable[Mapping[str, Any]],
    quote_snapshots: QuoteSnapshots,
    draft_rows: Iterable[Mapping[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Build editor rows, preferring a date's draft over its persisted values."""
    saved_by_symbol = {
        clean_text(entry.get("symbol")).upper(): entry
        for entry in saved_entries
        if clean_text(entry.get("symbol"))
    }
    drafts = _drafts_by_id(draft_rows)
    rows: list[dict[str, Any]] = []

    for stock in stocks:
        stock_id = int(stock["id"])
        symbol = clean_text(stock["symbol"]).upper()
        saved = saved_by_symbol.get(symbol, {})
        draft = drafts.get(stock_id, {})
        snapshot = quote_snapshots.get(symbol, {})

        def journal_value(draft_key: str, saved_key: str, default: Any) -> Any:
            if draft_key in draft:
                return draft[draft_key]
            return saved.get(saved_key, default)

        rows.append(
            {
                "ID": stock_id,
                "Delete": bool(draft.get("Delete", False)),
                "Stock": clean_text(stock["stock_name"]),
                "Symbol": symbol,
                "Latest Price": _format_price(snapshot.get("latest_price")),
                "Previous Close": _format_price(snapshot.get("previous_close")),
                "Change $": _format_signed(snapshot.get("change")),
                "Change %": _format_signed(snapshot.get("change_pct"), "%"),
                "Direction": clean_text(
                    journal_value("Direction", "direction", "No entry")
                )
                or "No entry",
                "Target / Expectation": clean_text(
                    journal_value("Target / Expectation", "target", "")
                ),
                "Thesis": clean_text(journal_value("Thesis", "thesis", "")),
                "Confidence": journal_value("Confidence", "confidence", 50),
                "_Saved Price": journal_value("_Saved Price", "price", None),
            }
        )

    return rows


def _normalize_confidence(value: Any) -> int:
    if isinstance(value, bool):
        raise ValueError("Confidence must be a whole number from 0 to 100.")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("Confidence must be a whole number from 0 to 100.") from exc
    if not math.isfinite(number) or not number.is_integer() or not 0 <= number <= 100:
        raise ValueError("Confidence must be a whole number from 0 to 100.")
    return int(number)


def _optional_number(value: Any, field_name: str) -> float | None:
    if value is None:
        return None
    try:
        if bool(pd.isna(value)):
            return None
    except (TypeError, ValueError):
        pass
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be a finite number.") from exc
    if not math.isfinite(number):
        raise ValueError(f"{field_name} must be a finite number.")
    return number


def sheet_rows_to_entries(
    rows: Iterable[Mapping[str, Any]],
    log_date: str,
    quote_snapshots: QuoteSnapshots,
) -> tuple[list[dict[str, Any]], set[str], set[str]]:
    """Validate editor rows and convert non-deleted rows to database entries."""
    normalized_date = clean_text(log_date)
    if not normalized_date:
        raise ValueError("Log date is required.")

    entries: list[dict[str, Any]] = []
    visible_symbols: set[str] = set()
    deleted_symbols: set[str] = set()

    for row in rows:
        stock_name = clean_text(row.get("Stock"))
        symbol = clean_text(row.get("Symbol")).upper()
        if not stock_name or not symbol:
            raise ValueError("Every row needs both a stock name and a symbol.")
        if symbol in visible_symbols:
            raise ValueError("Symbols must be unique.")
        visible_symbols.add(symbol)

        if bool(row.get("Delete", False)):
            deleted_symbols.add(symbol)
            continue

        direction = clean_text(row.get("Direction")) or "No entry"
        if direction not in DIRECTIONS:
            raise ValueError("Direction is not supported.")

        saved_price = _optional_number(row.get("_Saved Price"), "Recorded price")
        latest_price = _optional_number(
            quote_snapshots.get(symbol, {}).get("latest_price"),
            "Latest price",
        )
        entries.append(
            {
                "log_date": normalized_date,
                "stock_name": stock_name,
                "symbol": symbol,
                "price": saved_price if saved_price is not None else latest_price,
                "direction": direction,
                "target": clean_text(row.get("Target / Expectation")),
                "thesis": clean_text(row.get("Thesis")),
                "confidence": _normalize_confidence(row.get("Confidence", 50)),
            }
        )

    return entries, visible_symbols, deleted_symbols


def retain_historical_entries(
    saved_entries: Iterable[Mapping[str, Any]],
    visible_symbols: set[str],
    deleted_symbols: set[str],
    log_date: str,
) -> list[dict[str, Any]]:
    """Keep saved rows that are absent from the current watchlist editor."""
    excluded = {clean_text(symbol).upper() for symbol in visible_symbols | deleted_symbols}
    retained: list[dict[str, Any]] = []
    for entry in saved_entries:
        symbol = clean_text(entry.get("symbol")).upper()
        if not symbol or symbol in excluded:
            continue
        direction = clean_text(entry.get("direction")) or "No entry"
        if direction not in DIRECTIONS:
            raise ValueError("Direction is not supported.")
        retained.append(
            {
                "log_date": clean_text(log_date),
                "stock_name": clean_text(entry.get("stock_name")),
                "symbol": symbol,
                "price": _optional_number(entry.get("price"), "Recorded price"),
                "direction": direction,
                "target": clean_text(entry.get("target")),
                "thesis": clean_text(entry.get("thesis")),
                "confidence": _normalize_confidence(entry.get("confidence", 50)),
            }
        )
    return retained


def trigger_status(
    trigger: Mapping[str, Any],
    quote_snapshots: QuoteSnapshots,
) -> str:
    """Evaluate a review reminder against the latest cached quote snapshot."""
    if not bool(trigger.get("active")):
        return "Inactive"

    symbol = clean_text(trigger.get("symbol")).upper()
    condition = clean_text(trigger.get("condition_type"))
    if not symbol:
        raise ValueError("Trigger symbol is required.")
    if condition not in TRIGGER_CONDITIONS:
        raise ValueError("Trigger condition is not supported.")
    threshold = _optional_number(trigger.get("threshold"), "Trigger threshold")
    if threshold is None:
        raise ValueError("Trigger threshold must be a finite number.")

    snapshot = quote_snapshots.get(symbol, {})
    if condition == "Price above":
        value = snapshot.get("latest_price")
        compare = lambda current: current >= threshold
    elif condition == "Price below":
        value = snapshot.get("latest_price")
        compare = lambda current: current <= threshold
    elif condition == "Daily move above %":
        value = snapshot.get("change_pct")
        compare = lambda current: current >= threshold
    else:
        value = snapshot.get("change_pct")
        compare = lambda current: current <= threshold

    normalized_value = _optional_number(value, "Quote value")
    if normalized_value is None:
        return "Waiting for price refresh"
    return "Triggered now" if compare(normalized_value) else "Not triggered"


def sanitize_spreadsheet_frame(frame: pd.DataFrame) -> pd.DataFrame:
    """Return an export copy protected from spreadsheet formula execution."""
    sanitized = frame.copy(deep=True)

    def neutralize(value: Any) -> Any:
        if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
            return "'" + value
        return value

    for column in sanitized.columns:
        sanitized[column] = sanitized[column].map(neutralize)
    return sanitized


def editor_key(log_date: str, revision: int) -> str:
    return f"forecast_sheet_{clean_text(log_date)}_{int(revision)}"
