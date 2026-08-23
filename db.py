from __future__ import annotations

import math
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from models import DIRECTIONS, MAG7, TRIGGER_CONDITIONS


DB_PATH = Path(__file__).with_name("stock_forecast_journal.db")


def _required_text(value: Any, field_name: str) -> str:
    text = str(value).strip() if value is not None else ""
    if not text:
        raise ValueError(f"{field_name} is required.")
    return text


def _finite_number(
    value: Any,
    field_name: str,
    *,
    allow_none: bool = False,
) -> float | None:
    if value is None and allow_none:
        return None
    if isinstance(value, bool):
        raise ValueError(f"{field_name} must be a finite number.")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be a finite number.") from exc
    if not math.isfinite(number):
        raise ValueError(f"{field_name} must be a finite number.")
    return number


def _normalize_confidence(value: Any) -> int:
    number = _finite_number(value, "Confidence")
    if number is None or not number.is_integer() or not 0 <= number <= 100:
        raise ValueError("Confidence must be a whole number from 0 to 100.")
    return int(number)


def _normalize_log_entry(entry: dict[str, Any]) -> dict[str, Any]:
    log_date = _required_text(entry["log_date"], "Log date")
    stock_name = _required_text(entry["stock_name"], "Stock name")
    symbol = _required_text(entry["symbol"], "Symbol").upper()
    direction = _required_text(entry["direction"], "Direction")
    if direction not in DIRECTIONS:
        raise ValueError("Direction is not supported.")

    return {
        "log_date": log_date,
        "stock_name": stock_name,
        "symbol": symbol,
        "price": _finite_number(entry.get("price"), "Price", allow_none=True),
        "direction": direction,
        "target": str(entry.get("target") or "").strip(),
        "thesis": str(entry.get("thesis") or "").strip(),
        "confidence": _normalize_confidence(entry["confidence"]),
    }


def _normalize_trigger(
    symbol: str,
    condition_type: str,
    threshold: float,
    note: str,
) -> tuple[str, str, float, str]:
    clean_symbol = _required_text(symbol, "Symbol").upper()
    clean_condition = _required_text(condition_type, "Condition")
    if clean_condition not in TRIGGER_CONDITIONS:
        raise ValueError("Trigger condition is not supported.")
    clean_threshold = _finite_number(threshold, "Trigger threshold")
    if clean_threshold is None:
        raise ValueError("Trigger threshold must be a finite number.")
    return clean_symbol, clean_condition, clean_threshold, str(note or "").strip()


def _connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db() -> None:
    with _connect() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS stock_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                log_date TEXT NOT NULL,
                stock_name TEXT NOT NULL,
                symbol TEXT NOT NULL,
                price REAL,
                direction TEXT NOT NULL,
                target TEXT,
                thesis TEXT,
                confidence INTEGER NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS stock_watchlist (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                stock_name TEXT NOT NULL,
                symbol TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS review_triggers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                condition_type TEXT NOT NULL,
                threshold REAL NOT NULL,
                note TEXT,
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            )
            """
        )
        for stock_name, symbol in MAG7.items():
            connection.execute(
                """
                INSERT OR IGNORE INTO stock_watchlist (stock_name, symbol, created_at)
                VALUES (?, ?, ?)
                """,
                (stock_name, symbol, datetime.now(timezone.utc).isoformat()),
            )


def _insert_log_entry(
    connection: sqlite3.Connection,
    entry: dict[str, Any],
) -> None:
    connection.execute(
        """
        INSERT INTO stock_logs (
            log_date,
            stock_name,
            symbol,
            price,
            direction,
            target,
            thesis,
            confidence,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            entry["log_date"],
            entry["stock_name"],
            entry["symbol"],
            entry.get("price"),
            entry["direction"],
            entry.get("target", ""),
            entry.get("thesis", ""),
            entry["confidence"],
            datetime.now(timezone.utc).isoformat(),
        ),
    )


def insert_log_entry(entry: dict[str, Any]) -> None:
    normalized = _normalize_log_entry(entry)
    with _connect() as connection:
        _insert_log_entry(connection, normalized)


def replace_logs_by_date(log_date: str, entries: list[dict[str, Any]]) -> None:
    """Replace one day's entries in a single transaction."""
    normalized_date = _required_text(log_date, "Log date")
    normalized_entries = [
        _normalize_log_entry({**entry, "log_date": normalized_date})
        for entry in entries
    ]
    with _connect() as connection:
        connection.execute(
            "DELETE FROM stock_logs WHERE log_date = ?",
            (normalized_date,),
        )
        for entry in normalized_entries:
            _insert_log_entry(connection, entry)


def get_logs_by_date(log_date: str) -> list[dict[str, Any]]:
    with _connect() as connection:
        rows = connection.execute(
            """
            SELECT *
            FROM stock_logs
            WHERE log_date = ?
            ORDER BY stock_name
            """,
            (log_date,),
        ).fetchall()
    return [dict(row) for row in rows]


def get_all_logs() -> list[dict[str, Any]]:
    with _connect() as connection:
        rows = connection.execute(
            """
            SELECT *
            FROM stock_logs
            ORDER BY log_date DESC, stock_name
            """
        ).fetchall()
    return [dict(row) for row in rows]


def delete_logs_by_date(log_date: str) -> None:
    with _connect() as connection:
        connection.execute("DELETE FROM stock_logs WHERE log_date = ?", (log_date,))


def get_watchlist_stocks() -> list[dict[str, Any]]:
    with _connect() as connection:
        rows = connection.execute(
            """
            SELECT *
            FROM stock_watchlist
            ORDER BY stock_name
            """
        ).fetchall()
    return [dict(row) for row in rows]


def add_watchlist_stock(stock_name: str, symbol: str) -> None:
    clean_name = _required_text(stock_name, "Stock name")
    clean_symbol = _required_text(symbol, "Symbol").upper()

    try:
        with _connect() as connection:
            connection.execute(
                """
                INSERT INTO stock_watchlist (stock_name, symbol, created_at)
                VALUES (?, ?, ?)
                """,
                (clean_name, clean_symbol, datetime.now(timezone.utc).isoformat()),
            )
    except sqlite3.IntegrityError as exc:
        raise ValueError(f"{clean_symbol} is already in the watchlist.") from exc


def update_watchlist_stock(stock_id: int, stock_name: str, symbol: str) -> None:
    clean_name = _required_text(stock_name, "Stock name")
    clean_symbol = _required_text(symbol, "Symbol").upper()

    try:
        with _connect() as connection:
            cursor = connection.execute(
                """
                UPDATE stock_watchlist
                SET stock_name = ?, symbol = ?
                WHERE id = ?
                """,
                (clean_name, clean_symbol, stock_id),
            )
            if cursor.rowcount != 1:
                raise ValueError(f"Watchlist stock {stock_id} was not found.")
    except sqlite3.IntegrityError as exc:
        raise ValueError(f"{clean_symbol} is already in the watchlist.") from exc


def delete_watchlist_stock(stock_id: int) -> None:
    with _connect() as connection:
        cursor = connection.execute(
            "DELETE FROM stock_watchlist WHERE id = ?",
            (stock_id,),
        )
        if cursor.rowcount != 1:
            raise ValueError(f"Watchlist stock {stock_id} was not found.")


def replace_watchlist_stocks(rows: list[dict[str, Any]]) -> None:
    """Apply the complete watchlist editor state in one transaction."""
    normalized: list[dict[str, Any]] = []
    supplied_ids: set[int] = set()
    kept_symbols: set[str] = set()

    for row in rows:
        stock_id = int(row["ID"])
        if stock_id in supplied_ids:
            raise ValueError("Watchlist row IDs must be unique.")
        supplied_ids.add(stock_id)

        delete = bool(row.get("Delete", False))
        item: dict[str, Any] = {"id": stock_id, "delete": delete}
        if not delete:
            item["stock_name"] = _required_text(row.get("Stock"), "Stock name")
            item["symbol"] = _required_text(row.get("Symbol"), "Symbol").upper()
            if item["symbol"] in kept_symbols:
                raise ValueError("Watchlist symbols must be unique.")
            kept_symbols.add(item["symbol"])
        normalized.append(item)

    if not kept_symbols:
        raise ValueError("Keep at least one stock in the watchlist.")

    with _connect() as connection:
        existing = {
            int(row["id"]): dict(row)
            for row in connection.execute("SELECT * FROM stock_watchlist").fetchall()
        }
        if supplied_ids != set(existing):
            raise ValueError("The watchlist changed. Refresh and try again.")

        connection.execute("DELETE FROM stock_watchlist")
        for item in normalized:
            if item["delete"]:
                continue
            connection.execute(
                """
                INSERT INTO stock_watchlist (
                    id,
                    stock_name,
                    symbol,
                    created_at
                )
                VALUES (?, ?, ?, ?)
                """,
                (
                    item["id"],
                    item["stock_name"],
                    item["symbol"],
                    existing[item["id"]]["created_at"],
                ),
            )


def get_review_triggers() -> list[dict[str, Any]]:
    with _connect() as connection:
        rows = connection.execute(
            """
            SELECT *
            FROM review_triggers
            ORDER BY active DESC, symbol, condition_type
            """
        ).fetchall()
    return [dict(row) for row in rows]


def add_review_trigger(
    symbol: str,
    condition_type: str,
    threshold: float,
    note: str = "",
    active: bool = True,
) -> None:
    clean_symbol, clean_condition, clean_threshold, clean_note = _normalize_trigger(
        symbol,
        condition_type,
        threshold,
        note,
    )

    with _connect() as connection:
        connection.execute(
            """
            INSERT INTO review_triggers (
                symbol,
                condition_type,
                threshold,
                note,
                active,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                clean_symbol,
                clean_condition,
                clean_threshold,
                clean_note,
                1 if active else 0,
                datetime.now(timezone.utc).isoformat(),
            ),
        )


def update_review_trigger(
    trigger_id: int,
    symbol: str,
    condition_type: str,
    threshold: float,
    note: str,
    active: bool,
) -> None:
    clean_symbol, clean_condition, clean_threshold, clean_note = _normalize_trigger(
        symbol,
        condition_type,
        threshold,
        note,
    )

    with _connect() as connection:
        cursor = connection.execute(
            """
            UPDATE review_triggers
            SET symbol = ?,
                condition_type = ?,
                threshold = ?,
                note = ?,
                active = ?
            WHERE id = ?
            """,
            (
                clean_symbol,
                clean_condition,
                clean_threshold,
                clean_note,
                1 if active else 0,
                trigger_id,
            ),
        )
        if cursor.rowcount != 1:
            raise ValueError(f"Review trigger {trigger_id} was not found.")


def delete_review_trigger(trigger_id: int) -> None:
    with _connect() as connection:
        cursor = connection.execute(
            "DELETE FROM review_triggers WHERE id = ?",
            (trigger_id,),
        )
        if cursor.rowcount != 1:
            raise ValueError(f"Review trigger {trigger_id} was not found.")


def replace_review_triggers(rows: list[dict[str, Any]]) -> None:
    """Apply the complete trigger editor state in one transaction."""
    normalized: list[dict[str, Any]] = []
    supplied_ids: set[int] = set()

    for row in rows:
        trigger_id = int(row["ID"])
        if trigger_id in supplied_ids:
            raise ValueError("Review trigger row IDs must be unique.")
        supplied_ids.add(trigger_id)

        delete = bool(row.get("Delete", False))
        item: dict[str, Any] = {"id": trigger_id, "delete": delete}
        if not delete:
            symbol, condition, threshold, note = _normalize_trigger(
                row.get("Symbol"),
                row.get("Condition"),
                row.get("Threshold"),
                row.get("Note", ""),
            )
            item.update(
                {
                    "symbol": symbol,
                    "condition_type": condition,
                    "threshold": threshold,
                    "note": note,
                    "active": 1 if bool(row.get("Active", True)) else 0,
                }
            )
        normalized.append(item)

    with _connect() as connection:
        existing = {
            int(row["id"]): dict(row)
            for row in connection.execute("SELECT * FROM review_triggers").fetchall()
        }
        if supplied_ids != set(existing):
            raise ValueError("Review triggers changed. Refresh and try again.")

        connection.execute("DELETE FROM review_triggers")
        for item in normalized:
            if item["delete"]:
                continue
            connection.execute(
                """
                INSERT INTO review_triggers (
                    id,
                    symbol,
                    condition_type,
                    threshold,
                    note,
                    active,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item["id"],
                    item["symbol"],
                    item["condition_type"],
                    item["threshold"],
                    item["note"],
                    item["active"],
                    existing[item["id"]]["created_at"],
                ),
            )
