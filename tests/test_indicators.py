from __future__ import annotations

import unittest
from unittest.mock import patch

import pandas as pd

import indicators


class IndicatorTests(unittest.TestCase):
    def test_rsi_for_rising_falling_and_flat_series(self) -> None:
        rising = pd.Series(range(1, 17), dtype="float64")
        falling = pd.Series(range(16, 0, -1), dtype="float64")
        flat = pd.Series([10.0] * 16)

        self.assertEqual(indicators._calculate_rsi(rising), 100.0)
        self.assertEqual(indicators._calculate_rsi(falling), 0.0)
        self.assertEqual(indicators._calculate_rsi(flat), 50.0)

    def test_short_history_returns_unavailable_rolling_metrics(self) -> None:
        history = pd.DataFrame(
            {
                "Date": pd.date_range("2026-08-01", periods=10),
                "Close": list(range(10, 20)),
            }
        )

        with patch("indicators.get_price_history", return_value=history):
            context = indicators.get_technical_context("AAPL")

        self.assertEqual(context["latest_close"], 19.0)
        self.assertIsNone(context["sma_20"])
        self.assertIsNone(context["sma_50"])
        self.assertIsNone(context["rsi_14"])

    def test_context_calculates_averages_and_52_week_distances(self) -> None:
        closes = pd.Series(range(1, 61), dtype="float64")
        history = pd.DataFrame(
            {
                "Date": pd.date_range("2026-06-01", periods=60),
                "Close": closes,
            }
        )

        with patch("indicators.get_price_history", return_value=history):
            context = indicators.get_technical_context("AAPL")

        self.assertEqual(context["latest_close"], 60.0)
        self.assertEqual(context["sma_20"], 50.5)
        self.assertEqual(context["sma_50"], 35.5)
        self.assertEqual(context["week_52_high"], 60.0)
        self.assertEqual(context["week_52_low"], 1.0)
        self.assertEqual(context["distance_from_52w_high_pct"], 0.0)
        self.assertEqual(context["distance_from_52w_low_pct"], 5900.0)


if __name__ == "__main__":
    unittest.main()
