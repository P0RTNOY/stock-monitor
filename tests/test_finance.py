from __future__ import annotations

import json
import unittest
from unittest.mock import MagicMock, patch

import pandas as pd

import finance


class _Response:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return self.payload


class FinanceTests(unittest.TestCase):
    def test_quote_snapshot_calculates_latest_change(self) -> None:
        ticker = MagicMock()
        ticker.history.return_value = pd.DataFrame({"Close": [100.0, 110.0]})

        with patch("finance.yf.Ticker", return_value=ticker):
            snapshot = finance.get_quote_snapshot("AAPL")

        self.assertEqual(
            snapshot,
            {
                "latest_price": 110.0,
                "previous_close": 100.0,
                "change": 10.0,
                "change_pct": 10.0,
            },
        )

    def test_one_close_has_no_change_context(self) -> None:
        ticker = MagicMock()
        ticker.history.return_value = pd.DataFrame({"Close": [100.0]})

        with patch("finance.yf.Ticker", return_value=ticker):
            snapshot = finance.get_quote_snapshot("AAPL")

        self.assertEqual(snapshot["latest_price"], 100.0)
        self.assertIsNone(snapshot["previous_close"])
        self.assertIsNone(snapshot["change"])
        self.assertIsNone(snapshot["change_pct"])

    def test_quote_failure_logs_only_operation_and_exception_type(self) -> None:
        with patch("finance.yf.Ticker", side_effect=RuntimeError("private response")):
            with self.assertLogs("finance", level="WARNING") as captured:
                snapshot = finance.get_quote_snapshot("SECRET")

        self.assertIsNone(snapshot["latest_price"])
        output = " ".join(captured.output)
        self.assertIn("RuntimeError", output)
        self.assertNotIn("private response", output)
        self.assertNotIn("SECRET", output)

    def test_price_history_returns_only_date_and_close(self) -> None:
        ticker = MagicMock()
        ticker.history.return_value = pd.DataFrame(
            {
                "Date": pd.to_datetime(["2026-08-13", "2026-08-14"]),
                "Close": [100.0, 101.0],
                "Volume": [10, 20],
            }
        ).set_index("Date")

        with patch("finance.yf.Ticker", return_value=ticker):
            history = finance.get_price_history("AAPL")

        self.assertEqual(list(history.columns), ["Date", "Close"])
        self.assertEqual(history["Close"].tolist(), [100.0, 101.0])

    def test_symbol_search_filters_incomplete_results(self) -> None:
        payload = json.dumps(
            {
                "quotes": [
                    {
                        "symbol": " nflx ",
                        "shortname": "Netflix",
                        "quoteType": "EQUITY",
                        "exchange": "NMS",
                    },
                    {"symbol": "EMPTY", "shortname": ""},
                    {"symbol": "", "shortname": "Missing symbol"},
                ]
            }
        ).encode("utf-8")

        with patch("finance.urlopen", return_value=_Response(payload)):
            results = finance.search_symbols("netflix")

        self.assertEqual(
            results,
            [
                {
                    "symbol": "NFLX",
                    "name": "Netflix",
                    "type": "EQUITY",
                    "exchange": "NMS",
                }
            ],
        )

    def test_malformed_search_payload_returns_empty_and_logs_safely(self) -> None:
        with patch("finance.urlopen", return_value=_Response(b"not json")):
            with self.assertLogs("finance", level="WARNING") as captured:
                results = finance.search_symbols("private query")

        self.assertEqual(results, [])
        output = " ".join(captured.output)
        self.assertIn("JSONDecodeError", output)
        self.assertNotIn("private query", output)
        self.assertNotIn("not json", output)


if __name__ == "__main__":
    unittest.main()
