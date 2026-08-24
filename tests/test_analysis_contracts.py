from __future__ import annotations

import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from math import inf, nan

import pandas as pd

from analysis.contracts import AnalysisRequest, Bar, ContractError
from analysis.providers import ProviderError, YahooFinanceProvider, bars_from_frame, validate_bar_sequence
from analysis.rulesets import load_ruleset
from tests.analysis_helpers import START, make_bar


class AnalysisContractTests(unittest.TestCase):
    def test_valid_bar_accepts_price_boundaries_and_zero_volume(self) -> None:
        bar = make_bar(
            0,
            close=100,
            open_price=101,
            high=101,
            low=100,
            volume=0,
        )

        self.assertEqual(bar.symbol, "AAPL")
        self.assertEqual(bar.volume, 0)

    def test_bar_rejects_non_finite_prices_and_volume(self) -> None:
        for field_name in ("open", "high", "low", "close"):
            for value in (nan, inf, -inf):
                with self.subTest(field_name=field_name, value=value):
                    values = {
                        "symbol": "AAPL",
                        "timeframe": "1d",
                        "timestamp": START,
                        "completed_at": START + timedelta(days=1),
                        "timezone": "America/New_York",
                        "open": 100.0,
                        "high": 101.0,
                        "low": 99.0,
                        "close": 100.0,
                        "volume": 100.0,
                        "is_complete": True,
                        "adjustment_mode": "raw",
                        "provider": "test",
                    }
                    values[field_name] = value
                    with self.assertRaises(ContractError):
                        Bar(**values)  # type: ignore[arg-type]

        for value in (nan, inf, -inf, -1.0):
            with self.subTest(volume=value):
                with self.assertRaises(ContractError):
                    replace(make_bar(0), volume=value)

    def test_bar_rejects_invalid_envelope_and_naive_timestamp(self) -> None:
        with self.assertRaisesRegex(ContractError, "high"):
            make_bar(0, close=100, open_price=101, high=100.5)
        with self.assertRaisesRegex(ContractError, "low"):
            make_bar(0, close=100, open_price=99, low=99.5)
        with self.assertRaisesRegex(ContractError, "timezone-aware"):
            replace(make_bar(0), timestamp=START.replace(tzinfo=None))
        with self.assertRaisesRegex(ContractError, "valid IANA"):
            replace(make_bar(0), timezone="Mars/Olympus")

    def test_runtime_enums_and_request_are_validated(self) -> None:
        with self.assertRaisesRegex(ContractError, "timeframe"):
            replace(make_bar(0), timeframe="1h")  # type: ignore[arg-type]
        with self.assertRaisesRegex(ContractError, "adjustment_mode"):
            replace(make_bar(0), adjustment_mode="mystery")  # type: ignore[arg-type]
        with self.assertRaisesRegex(ContractError, "unique"):
            AnalysisRequest("AAPL", START, timeframes=("1d", "1d"))

    def test_sequence_rejects_duplicate_out_of_order_and_mixed_bars(self) -> None:
        first = make_bar(0)
        second = make_bar(1)
        self.assertEqual(validate_bar_sequence([first, second]), (first, second))
        with self.assertRaisesRegex(ContractError, "strictly increasing"):
            validate_bar_sequence([first, first])
        with self.assertRaisesRegex(ContractError, "strictly increasing"):
            validate_bar_sequence([second, first])
        with self.assertRaisesRegex(ContractError, "symbol"):
            validate_bar_sequence([first, replace(second, symbol="MSFT")])
        with self.assertRaisesRegex(ContractError, "same timezone"):
            validate_bar_sequence([first, replace(second, timezone="UTC")])

    def test_ruleset_freezes_v1_engineering_defaults(self) -> None:
        first = load_ruleset()
        second = load_ruleset()

        self.assertEqual(first, second)
        self.assertIsNot(first, second)
        self.assertEqual(first.timeframes, ("1wk", "1d"))
        self.assertEqual((first.swings.left_bars, first.swings.right_bars), (2, 2))
        self.assertEqual(first.adjustment_mode, "raw")
        with self.assertRaisesRegex(ContractError, "unknown ruleset"):
            load_ruleset("future")


class YahooProviderContractTests(unittest.TestCase):
    def test_frame_normalization_marks_current_bar_incomplete_and_flags_actions(self) -> None:
        frame = pd.DataFrame(
            {
                "Timestamp": pd.to_datetime(["2025-01-02", "2025-01-03"]),
                "Open": [100, 101],
                "High": [102, 103],
                "Low": [99, 100],
                "Close": [101, 102],
                "Volume": [1_000, 2_000],
                "Dividends": [0.5, 0],
                "Stock Splits": [0, 4],
            }
        )
        as_of = datetime(2025, 1, 3, 18, tzinfo=timezone.utc)

        bars = bars_from_frame(frame, " aapl ", as_of)

        self.assertTrue(bars[0].is_complete)
        self.assertFalse(bars[1].is_complete)
        self.assertEqual(bars[0].corporate_action_flags, ("dividend",))
        self.assertEqual(bars[1].corporate_action_flags, ("split",))

    def test_frame_normalization_rejects_bad_data_and_disorder(self) -> None:
        frame = pd.DataFrame(
            {
                "Timestamp": pd.to_datetime(["2025-01-03", "2025-01-02"]),
                "Open": [100, 100],
                "High": [101, 101],
                "Low": [99, 99],
                "Close": [100, 100],
                "Volume": [1_000, 1_000],
            }
        )
        as_of = START + timedelta(days=5)
        with self.assertRaisesRegex(ContractError, "strictly increasing"):
            bars_from_frame(frame, "AAPL", as_of)

        frame.loc[0, "Volume"] = nan
        with self.assertRaisesRegex(ContractError, "volume"):
            bars_from_frame(frame.sort_values("Timestamp"), "AAPL", as_of)

    def test_provider_wraps_empty_market_data(self) -> None:
        provider = YahooFinanceProvider(
            history_loader=lambda _symbol, _period, _interval: pd.DataFrame()
        )
        with self.assertRaisesRegex(ProviderError, "No OHLCV"):
            provider.fetch_daily_bars("AAPL", START)


if __name__ == "__main__":
    unittest.main()
