from __future__ import annotations

import math
import unittest

import pandas as pd

from journal import (
    build_sheet_rows,
    clean_text,
    editor_key,
    retain_historical_entries,
    sanitize_spreadsheet_frame,
    sheet_rows_to_entries,
    trigger_status,
)


class JournalSheetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.stocks = [
            {"id": 1, "stock_name": "Apple", "symbol": "AAPL"},
            {"id": 2, "stock_name": "Microsoft", "symbol": "MSFT"},
        ]
        self.snapshots = {
            "AAPL": {
                "latest_price": 210.0,
                "previous_close": 208.0,
                "change": 2.0,
                "change_pct": 0.96,
            },
            "MSFT": {
                "latest_price": None,
                "previous_close": None,
                "change": None,
                "change_pct": None,
            },
        }

    @staticmethod
    def _saved(symbol: str, **overrides: object) -> dict[str, object]:
        entry: dict[str, object] = {
            "log_date": "2026-08-14",
            "stock_name": "Apple" if symbol == "AAPL" else symbol,
            "symbol": symbol,
            "price": 199.5,
            "direction": "Bullish",
            "target": "220",
            "thesis": "Demand",
            "confidence": 70,
        }
        entry.update(overrides)
        return entry

    def test_clean_text_handles_missing_values_and_whitespace(self) -> None:
        self.assertEqual(clean_text(None), "")
        self.assertEqual(clean_text(pd.NA), "")
        self.assertEqual(clean_text(float("nan")), "")
        self.assertEqual(clean_text("  AAPL  "), "AAPL")

    def test_saved_entry_prefills_matching_watchlist_symbol(self) -> None:
        rows = build_sheet_rows(
            self.stocks,
            [self._saved("AAPL")],
            self.snapshots,
        )

        self.assertEqual(rows[0]["Stock"], "Apple")
        self.assertEqual(rows[0]["Direction"], "Bullish")
        self.assertEqual(rows[0]["Target / Expectation"], "220")
        self.assertEqual(rows[0]["Thesis"], "Demand")
        self.assertEqual(rows[0]["Confidence"], 70)
        self.assertEqual(rows[0]["_Saved Price"], 199.5)

    def test_unsaved_watchlist_symbol_uses_neutral_defaults(self) -> None:
        rows = build_sheet_rows(self.stocks, [], self.snapshots)

        self.assertEqual(rows[1]["Direction"], "No entry")
        self.assertEqual(rows[1]["Target / Expectation"], "")
        self.assertEqual(rows[1]["Thesis"], "")
        self.assertEqual(rows[1]["Confidence"], 50)
        self.assertIsNone(rows[1]["_Saved Price"])

    def test_draft_takes_precedence_over_saved_entry(self) -> None:
        draft = [
            {
                "ID": 1,
                "Delete": False,
                "Stock": "Stale name",
                "Symbol": "OLD",
                "Direction": "Bearish",
                "Target / Expectation": "190",
                "Thesis": "Draft thesis",
                "Confidence": 35,
                "_Saved Price": 199.5,
            }
        ]

        rows = build_sheet_rows(
            self.stocks,
            [self._saved("AAPL")],
            self.snapshots,
            draft,
        )

        self.assertEqual(rows[0]["Stock"], "Apple")
        self.assertEqual(rows[0]["Symbol"], "AAPL")
        self.assertEqual(rows[0]["Direction"], "Bearish")
        self.assertEqual(rows[0]["Thesis"], "Draft thesis")
        self.assertEqual(rows[0]["Confidence"], 35)

    def test_each_saved_dataset_builds_only_its_own_date_values(self) -> None:
        first = build_sheet_rows(
            self.stocks,
            [self._saved("AAPL", direction="Bullish")],
            self.snapshots,
        )
        second = build_sheet_rows(
            self.stocks,
            [self._saved("AAPL", direction="Bearish")],
            self.snapshots,
        )

        self.assertEqual(first[0]["Direction"], "Bullish")
        self.assertEqual(second[0]["Direction"], "Bearish")

    def test_sheet_rows_normalize_values_and_preserve_recorded_price(self) -> None:
        rows = [
            {
                "Delete": False,
                "Stock": " Apple ",
                "Symbol": " aapl ",
                "Direction": "Bullish",
                "Target / Expectation": " 220 ",
                "Thesis": " Demand ",
                "Confidence": 70.0,
                "_Saved Price": 199.5,
            }
        ]

        entries, visible, deleted = sheet_rows_to_entries(
            rows,
            "2026-08-14",
            self.snapshots,
        )

        self.assertEqual(entries[0]["stock_name"], "Apple")
        self.assertEqual(entries[0]["symbol"], "AAPL")
        self.assertEqual(entries[0]["target"], "220")
        self.assertEqual(entries[0]["thesis"], "Demand")
        self.assertEqual(entries[0]["confidence"], 70)
        self.assertEqual(entries[0]["price"], 199.5)
        self.assertEqual(visible, {"AAPL"})
        self.assertEqual(deleted, set())

    def test_sheet_rows_use_latest_price_when_no_recorded_price_exists(self) -> None:
        rows = [
            {
                "Delete": False,
                "Stock": "Apple",
                "Symbol": "AAPL",
                "Direction": "Neutral",
                "Target / Expectation": "",
                "Thesis": "",
                "Confidence": 50,
                "_Saved Price": None,
            }
        ]

        entries, _, _ = sheet_rows_to_entries(rows, "2026-08-14", self.snapshots)

        self.assertEqual(entries[0]["price"], 210.0)

    def test_deleted_rows_are_reported_but_not_returned_as_entries(self) -> None:
        rows = [
            {
                "Delete": True,
                "Stock": "Apple",
                "Symbol": "aapl",
                "Direction": "No entry",
                "Confidence": 50,
            }
        ]

        entries, visible, deleted = sheet_rows_to_entries(rows, "2026-08-14", {})

        self.assertEqual(entries, [])
        self.assertEqual(visible, {"AAPL"})
        self.assertEqual(deleted, {"AAPL"})

    def test_invalid_sheet_values_are_rejected(self) -> None:
        base = {
            "Delete": False,
            "Stock": "Apple",
            "Symbol": "AAPL",
            "Direction": "Bullish",
            "Confidence": 50,
        }
        invalid_rows = [
            {**base, "Stock": ""},
            {**base, "Symbol": ""},
            {**base, "Direction": "Trade now"},
            {**base, "Confidence": -1},
            {**base, "Confidence": 101},
            {**base, "Confidence": 50.5},
            {**base, "Confidence": float("nan")},
        ]

        for row in invalid_rows:
            with self.subTest(row=row):
                with self.assertRaises(ValueError):
                    sheet_rows_to_entries([row], "2026-08-14", {})

    def test_duplicate_visible_symbols_are_rejected(self) -> None:
        rows = [
            {
                "Delete": False,
                "Stock": "Apple",
                "Symbol": "AAPL",
                "Direction": "Neutral",
                "Confidence": 50,
            },
            {
                "Delete": False,
                "Stock": "Duplicate",
                "Symbol": "aapl",
                "Direction": "Neutral",
                "Confidence": 50,
            },
        ]

        with self.assertRaisesRegex(ValueError, "unique"):
            sheet_rows_to_entries(rows, "2026-08-14", {})


class HistoricalRetentionTests(unittest.TestCase):
    @staticmethod
    def _saved(symbol: str) -> dict[str, object]:
        return {
            "id": 10,
            "log_date": "2026-08-13",
            "stock_name": "Old stock",
            "symbol": symbol,
            "price": 10.0,
            "direction": "Neutral",
            "target": "",
            "thesis": "Historical",
            "confidence": 50,
            "created_at": "2026-08-13T10:00:00+00:00",
        }

    def test_removed_watchlist_symbol_is_retained_on_replace(self) -> None:
        retained = retain_historical_entries(
            [self._saved("OLD")],
            {"AAPL"},
            set(),
            "2026-08-14",
        )

        self.assertEqual([entry["symbol"] for entry in retained], ["OLD"])
        self.assertEqual(retained[0]["log_date"], "2026-08-14")
        self.assertNotIn("id", retained[0])
        self.assertNotIn("created_at", retained[0])

    def test_visible_or_explicitly_deleted_symbols_are_not_retained(self) -> None:
        saved = [self._saved("AAPL"), self._saved("MSFT")]

        retained = retain_historical_entries(
            saved,
            {"AAPL", "MSFT"},
            {"MSFT"},
            "2026-08-14",
        )

        self.assertEqual(retained, [])


class TriggerStatusTests(unittest.TestCase):
    def setUp(self) -> None:
        self.snapshots = {
            "AAPL": {"latest_price": 210.0, "change_pct": 2.5},
        }

    def _trigger(self, condition: str, threshold: float) -> dict[str, object]:
        return {
            "active": True,
            "symbol": "AAPL",
            "condition_type": condition,
            "threshold": threshold,
        }

    def test_all_supported_trigger_comparisons(self) -> None:
        cases = [
            ("Price above", 200.0, "Triggered now"),
            ("Price above", 220.0, "Not triggered"),
            ("Price below", 220.0, "Triggered now"),
            ("Price below", 200.0, "Not triggered"),
            ("Daily move above %", 2.0, "Triggered now"),
            ("Daily move above %", 3.0, "Not triggered"),
            ("Daily move below %", 3.0, "Triggered now"),
            ("Daily move below %", 2.0, "Not triggered"),
        ]

        for condition, threshold, expected in cases:
            with self.subTest(condition=condition, threshold=threshold):
                self.assertEqual(
                    trigger_status(self._trigger(condition, threshold), self.snapshots),
                    expected,
                )

    def test_inactive_and_missing_price_statuses(self) -> None:
        inactive = self._trigger("Price above", 200.0)
        inactive["active"] = False
        self.assertEqual(trigger_status(inactive, self.snapshots), "Inactive")
        self.assertEqual(
            trigger_status(self._trigger("Price above", 200.0), {}),
            "Waiting for price refresh",
        )

    def test_invalid_condition_threshold_and_symbol_are_rejected(self) -> None:
        invalid = [
            self._trigger("Unknown", 1.0),
            self._trigger("Price above", float("nan")),
            self._trigger("Price above", float("inf")),
            {**self._trigger("Price above", 1.0), "symbol": ""},
        ]

        for trigger in invalid:
            with self.subTest(trigger=trigger):
                with self.assertRaises(ValueError):
                    trigger_status(trigger, self.snapshots)


class SpreadsheetSafetyTests(unittest.TestCase):
    def test_formula_prefixes_are_neutralized_in_a_copy(self) -> None:
        original = pd.DataFrame(
            {
                "safe": ["AAPL", "  ordinary"],
                "unsafe": ["=HYPERLINK(\"bad\")", "  +SUM(1,2)"],
                "number": [1.0, 2.0],
            }
        )

        sanitized = sanitize_spreadsheet_frame(original)

        self.assertEqual(sanitized.loc[0, "unsafe"], "'=HYPERLINK(\"bad\")")
        self.assertEqual(sanitized.loc[1, "unsafe"], "'  +SUM(1,2)")
        self.assertEqual(sanitized["safe"].tolist(), original["safe"].tolist())
        self.assertEqual(sanitized["number"].tolist(), [1.0, 2.0])
        self.assertEqual(original.loc[0, "unsafe"], "=HYPERLINK(\"bad\")")


class EditorKeyTests(unittest.TestCase):
    def test_key_is_date_and_revision_specific(self) -> None:
        self.assertEqual(editor_key("2026-08-14", 3), "forecast_sheet_2026-08-14_3")
        self.assertNotEqual(
            editor_key("2026-08-14", 3),
            editor_key("2026-08-15", 3),
        )
        self.assertNotEqual(
            editor_key("2026-08-14", 3),
            editor_key("2026-08-14", 4),
        )


if __name__ == "__main__":
    unittest.main()
