from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path
from typing import Any

import db


class ReplaceLogsByDateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = db.DB_PATH
        db.DB_PATH = Path(self.temp_dir.name) / "journal.db"
        db.init_db()

    def tearDown(self) -> None:
        db.DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

    @staticmethod
    def _entry(
        symbol: str,
        *,
        log_date: str = "2026-07-14",
        direction: str = "Bullish",
    ) -> dict[str, Any]:
        return {
            "log_date": log_date,
            "stock_name": f"{symbol} Inc.",
            "symbol": symbol,
            "price": 100.0,
            "direction": direction,
            "target": "Review tomorrow",
            "thesis": "Focused regression fixture",
            "confidence": 65,
        }

    def test_replaces_selected_date_without_changing_other_dates(self) -> None:
        db.insert_log_entry(self._entry("OLD"))
        db.insert_log_entry(self._entry("KEEP", log_date="2026-07-13"))

        db.replace_logs_by_date(
            "2026-07-14",
            [
                self._entry("AAPL", log_date="ignored"),
                self._entry("MSFT", log_date="ignored", direction="Neutral"),
            ],
        )

        replaced = db.get_logs_by_date("2026-07-14")
        self.assertEqual([row["symbol"] for row in replaced], ["AAPL", "MSFT"])
        self.assertTrue(all(row["log_date"] == "2026-07-14" for row in replaced))
        self.assertEqual(
            [row["symbol"] for row in db.get_logs_by_date("2026-07-13")],
            ["KEEP"],
        )

    def test_rolls_back_entire_replacement_when_any_entry_is_invalid(self) -> None:
        db.insert_log_entry(self._entry("AAPL"))
        db.insert_log_entry(self._entry("MSFT", direction="Bearish"))
        original_rows = db.get_logs_by_date("2026-07-14")

        invalid_entry = self._entry("BROKEN")
        del invalid_entry["direction"]

        with self.assertRaises(KeyError):
            db.replace_logs_by_date(
                "2026-07-14",
                [self._entry("NVDA"), invalid_entry],
            )

        self.assertEqual(db.get_logs_by_date("2026-07-14"), original_rows)

    def test_empty_replacement_removes_existing_rows_for_date(self) -> None:
        db.insert_log_entry(self._entry("AAPL"))

        db.replace_logs_by_date("2026-07-14", [])

        self.assertEqual(db.get_logs_by_date("2026-07-14"), [])

    def test_rejects_invalid_direction_without_replacing_existing_rows(self) -> None:
        db.insert_log_entry(self._entry("AAPL"))
        invalid_entry = self._entry("MSFT", direction="Trade now")

        with self.assertRaisesRegex(ValueError, "Direction"):
            db.replace_logs_by_date("2026-07-14", [invalid_entry])

        self.assertEqual(
            [row["symbol"] for row in db.get_logs_by_date("2026-07-14")],
            ["AAPL"],
        )

    def test_rejects_invalid_numbers_without_replacing_existing_rows(self) -> None:
        db.insert_log_entry(self._entry("AAPL"))
        invalid_entries = []
        for field, value in (
            ("confidence", -1),
            ("confidence", 101),
            ("confidence", 50.5),
            ("confidence", math.nan),
            ("price", math.inf),
        ):
            entry = self._entry("MSFT")
            entry[field] = value
            invalid_entries.append(entry)

        for invalid_entry in invalid_entries:
            with self.subTest(entry=invalid_entry):
                with self.assertRaises(ValueError):
                    db.replace_logs_by_date("2026-07-14", [invalid_entry])
                self.assertEqual(
                    [row["symbol"] for row in db.get_logs_by_date("2026-07-14")],
                    ["AAPL"],
                )

    def test_rejects_blank_required_log_values(self) -> None:
        for field in ("log_date", "stock_name", "symbol"):
            invalid_entry = self._entry("AAPL")
            invalid_entry[field] = "  "
            with self.subTest(field=field):
                with self.assertRaises(ValueError):
                    db.insert_log_entry(invalid_entry)


class DatabaseBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = db.DB_PATH
        db.DB_PATH = Path(self.temp_dir.name) / "journal.db"
        db.init_db()

    def tearDown(self) -> None:
        db.DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

    def test_watchlist_symbol_is_normalized_and_duplicates_are_rejected(self) -> None:
        db.add_watchlist_stock(" Shopify ", " shop ")

        shop = next(row for row in db.get_watchlist_stocks() if row["symbol"] == "SHOP")
        self.assertEqual(shop["stock_name"], "Shopify")
        with self.assertRaisesRegex(ValueError, "already"):
            db.add_watchlist_stock("Duplicate Apple", " aapl ")

    def test_watchlist_updates_and_deletes_require_an_existing_id(self) -> None:
        with self.assertRaisesRegex(ValueError, "not found"):
            db.update_watchlist_stock(999_999, "Missing", "MISS")
        with self.assertRaisesRegex(ValueError, "not found"):
            db.delete_watchlist_stock(999_999)

    def test_watchlist_sheet_replacement_is_atomic_and_allows_symbol_swaps(self) -> None:
        original = db.get_watchlist_stocks()
        apple = next(row for row in original if row["symbol"] == "AAPL")
        microsoft = next(row for row in original if row["symbol"] == "MSFT")
        replacement = []
        for row in original:
            symbol = row["symbol"]
            if row["id"] == apple["id"]:
                symbol = "MSFT"
            elif row["id"] == microsoft["id"]:
                symbol = "AAPL"
            replacement.append(
                {
                    "ID": row["id"],
                    "Delete": False,
                    "Stock": row["stock_name"],
                    "Symbol": symbol,
                }
            )

        db.replace_watchlist_stocks(replacement)

        updated = {row["id"]: row for row in db.get_watchlist_stocks()}
        self.assertEqual(updated[apple["id"]]["symbol"], "MSFT")
        self.assertEqual(updated[microsoft["id"]]["symbol"], "AAPL")

    def test_invalid_watchlist_sheet_replacement_keeps_every_existing_row(self) -> None:
        original = db.get_watchlist_stocks()
        replacement = [
            {
                "ID": row["id"],
                "Delete": False,
                "Stock": (
                    "Name changed before invalid row"
                    if index == 0
                    else row["stock_name"]
                ),
                "Symbol": "DUPLICATE" if index < 2 else row["symbol"],
            }
            for index, row in enumerate(original)
        ]

        with self.assertRaisesRegex(ValueError, "unique"):
            db.replace_watchlist_stocks(replacement)

        self.assertEqual(db.get_watchlist_stocks(), original)

    def test_trigger_crud_normalizes_values(self) -> None:
        db.add_review_trigger(" aapl ", "Price above", 200, "  revisit  ")
        trigger = db.get_review_triggers()[0]
        self.assertEqual(trigger["symbol"], "AAPL")
        self.assertEqual(trigger["note"], "revisit")

        db.update_review_trigger(
            trigger["id"],
            " msft ",
            "Daily move below %",
            -2.5,
            "  daily move  ",
            False,
        )
        updated = db.get_review_triggers()[0]
        self.assertEqual(updated["symbol"], "MSFT")
        self.assertEqual(updated["threshold"], -2.5)
        self.assertEqual(updated["note"], "daily move")
        self.assertEqual(updated["active"], 0)

        db.delete_review_trigger(trigger["id"])
        self.assertEqual(db.get_review_triggers(), [])

    def test_invalid_trigger_values_are_rejected(self) -> None:
        cases = [
            ("", "Price above", 1.0),
            ("AAPL", "Unknown", 1.0),
            ("AAPL", "Price above", math.nan),
            ("AAPL", "Price above", math.inf),
        ]

        for symbol, condition, threshold in cases:
            with self.subTest(symbol=symbol, condition=condition, threshold=threshold):
                with self.assertRaises(ValueError):
                    db.add_review_trigger(symbol, condition, threshold)
        self.assertEqual(db.get_review_triggers(), [])

    def test_trigger_updates_and_deletes_require_an_existing_id(self) -> None:
        with self.assertRaisesRegex(ValueError, "not found"):
            db.update_review_trigger(
                999_999,
                "AAPL",
                "Price above",
                200,
                "",
                True,
            )
        with self.assertRaisesRegex(ValueError, "not found"):
            db.delete_review_trigger(999_999)

    def test_trigger_sheet_replacement_is_atomic_when_a_threshold_is_blank(self) -> None:
        db.add_review_trigger("AAPL", "Price above", 200, "original")
        db.add_review_trigger("MSFT", "Price below", 300, "second")
        original = db.get_review_triggers()
        replacement = [
            {
                "ID": original[0]["id"],
                "Delete": False,
                "Active": True,
                "Symbol": original[0]["symbol"],
                "Condition": original[0]["condition_type"],
                "Threshold": original[0]["threshold"],
                "Note": "changed before invalid row",
            },
            {
                "ID": original[1]["id"],
                "Delete": False,
                "Active": True,
                "Symbol": original[1]["symbol"],
                "Condition": original[1]["condition_type"],
                "Threshold": math.nan,
                "Note": original[1]["note"],
            },
        ]

        with self.assertRaisesRegex(ValueError, "threshold"):
            db.replace_review_triggers(replacement)

        self.assertEqual(db.get_review_triggers(), original)


if __name__ == "__main__":
    unittest.main()
