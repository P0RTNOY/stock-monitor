from __future__ import annotations

import logging
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from dataclasses import replace
from datetime import date, timedelta
from pathlib import Path
from typing import Iterator
from unittest.mock import patch

import pandas as pd
import streamlit as st
from streamlit.testing.v1 import AppTest

import db
from analysis.providers import ProviderError
from tests.analysis_helpers import make_bar


APP_PATH = Path(__file__).resolve().parents[1] / "app.py"
logging.getLogger("streamlit.runtime.scriptrunner_utils.script_run_context").setLevel(
    logging.ERROR
)


class StreamlitJournalWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = db.DB_PATH
        db.DB_PATH = Path(self.temp_dir.name) / "journal.db"
        db.init_db()
        st.cache_data.clear()

    def tearDown(self) -> None:
        db.DB_PATH = self.original_db_path
        st.cache_data.clear()
        self.temp_dir.cleanup()

    @staticmethod
    def _entry(log_date: str, symbol: str, direction: str) -> dict[str, object]:
        return {
            "log_date": log_date,
            "stock_name": "Apple" if symbol == "AAPL" else "Historical stock",
            "symbol": symbol,
            "price": 199.5,
            "direction": direction,
            "target": "220",
            "thesis": f"Saved {direction.lower()} thesis",
            "confidence": 70,
        }

    @contextmanager
    def _offline_integrations(self) -> Iterator[None]:
        technical = {
            "latest_close": None,
            "sma_20": None,
            "sma_50": None,
            "rsi_14": None,
            "week_52_high": None,
            "week_52_low": None,
            "distance_from_52w_high_pct": None,
            "distance_from_52w_low_pct": None,
        }
        with ExitStack() as stack:
            stack.enter_context(
                patch(
                    "finance.get_price_history",
                    return_value=pd.DataFrame(columns=["Date", "Close"]),
                )
            )
            stack.enter_context(
                patch("indicators.get_technical_context", return_value=technical)
            )
            stack.enter_context(patch("news.get_stock_headlines", return_value=[]))
            yield

    @staticmethod
    def _forecast_frame(app: AppTest) -> pd.DataFrame:
        return app.dataframe[0].value

    @staticmethod
    def _row_for_symbol(frame: pd.DataFrame, symbol: str) -> pd.Series:
        return frame.loc[frame["Symbol"] == symbol].iloc[0]

    def test_saved_entry_prefills_forecast_editor(self) -> None:
        today = date.today().isoformat()
        db.insert_log_entry(self._entry(today, "AAPL", "Bullish"))

        with self._offline_integrations():
            app = AppTest.from_file(APP_PATH, default_timeout=10).run()

        self.assertEqual(len(app.exception), 0)
        apple = self._row_for_symbol(self._forecast_frame(app), "AAPL")
        self.assertEqual(apple["Direction"], "Bullish")
        self.assertEqual(apple["Thesis"], "Saved bullish thesis")
        self.assertEqual(apple["Confidence"], 70)

    def test_switching_dates_loads_each_dates_values(self) -> None:
        today = date.today()
        previous = today - timedelta(days=1)
        db.insert_log_entry(self._entry(today.isoformat(), "AAPL", "Bullish"))
        db.insert_log_entry(self._entry(previous.isoformat(), "AAPL", "Bearish"))

        with self._offline_integrations():
            app = AppTest.from_file(APP_PATH, default_timeout=10).run()
            today_row = self._row_for_symbol(self._forecast_frame(app), "AAPL")
            app.date_input[0].set_value(previous)
            app.run()
            previous_row = self._row_for_symbol(self._forecast_frame(app), "AAPL")

        self.assertEqual(len(app.exception), 0)
        self.assertEqual(today_row["Direction"], "Bullish")
        self.assertEqual(previous_row["Direction"], "Bearish")

    def test_saving_preserves_historical_symbol_outside_watchlist(self) -> None:
        today = date.today().isoformat()
        db.insert_log_entry(self._entry(today, "OLD", "Neutral"))

        with self._offline_integrations():
            app = AppTest.from_file(APP_PATH, default_timeout=10).run()
            save_button = next(
                button for button in app.button if button.label == "Save Daily Log"
            )
            save_button.click()
            app.run()

        self.assertEqual(len(app.exception), 0)
        symbols = {row["symbol"] for row in db.get_logs_by_date(today)}
        self.assertIn("OLD", symbols)

    def test_scenario_analysis_is_explicit_and_survives_unrelated_rerun(self) -> None:
        bars = tuple(
            replace(
                make_bar(index, close=100 + index, high=101 + index, low=99 + index),
                symbol="GOOGL",
            )
            for index in range(220)
        )
        with self._offline_integrations(), patch(
            "analysis.providers.YahooFinanceProvider.fetch_daily_bars",
            return_value=bars,
        ) as fetch_bars:
            app = AppTest.from_file(APP_PATH, default_timeout=10).run()
            fetch_bars.assert_not_called()

            analyze_button = next(
                button for button in app.button if button.label == "Analyze completed bars"
            )
            analyze_button.click()
            app.run()
            fetch_bars.assert_called_once()
            self.assertEqual(len(app.exception), 0)
            scenario_tab = next(tab for tab in app.tabs if tab.label == "Scenario Analysis")
            self.assertTrue(
                any(
                    "No rectangle setup detected" in item.value
                    for item in scenario_tab.markdown
                ),
                [item.value for item in scenario_tab.markdown],
            )

            app.date_input[0].set_value(date.today() - timedelta(days=1))
            app.run()
            fetch_bars.assert_called_once()
            self.assertTrue(
                any(
                    "No rectangle setup detected" in item.value
                    for item in scenario_tab.markdown
                )
            )

    def test_scenario_analysis_provider_failure_is_safe(self) -> None:
        with self._offline_integrations(), patch(
            "analysis.providers.YahooFinanceProvider.fetch_daily_bars",
            side_effect=ProviderError("DO_NOT_RENDER_UPSTREAM_DETAIL"),
        ):
            app = AppTest.from_file(APP_PATH, default_timeout=10).run()
            analyze_button = next(
                button for button in app.button if button.label == "Analyze completed bars"
            )
            analyze_button.click()
            app.run()

        self.assertEqual(len(app.exception), 0)
        warning_text = " ".join(item.value for item in app.warning)
        self.assertIn("Completed OHLCV data is not available", warning_text)
        self.assertNotIn("DO_NOT_RENDER_UPSTREAM_DETAIL", warning_text)

    def test_scenario_analysis_renders_rectangle_lifecycle_and_risk_table(self) -> None:
        bars = [
            replace(
                make_bar(index, close=105, high=106, low=104, volume=1_000),
                symbol="GOOGL",
            )
            for index in range(209)
        ]
        for index, high, low in (
            (185, 110, 104),
            (190, 106, 100),
            (200, 110, 104),
            (205, 106, 100),
        ):
            bars[index] = replace(
                make_bar(index, close=105, high=high, low=low, volume=1_000),
                symbol="GOOGL",
            )
        bars[208] = replace(
            make_bar(208, close=111.6, high=112, low=110.5, volume=2_000),
            symbol="GOOGL",
        )

        with self._offline_integrations(), patch(
            "analysis.providers.YahooFinanceProvider.fetch_daily_bars",
            return_value=tuple(bars),
        ):
            app = AppTest.from_file(APP_PATH, default_timeout=10).run()
            analyze_button = next(
                button for button in app.button if button.label == "Analyze completed bars"
            )
            analyze_button.click()
            app.run()

        self.assertEqual(len(app.exception), 0)
        scenario_tab = next(tab for tab in app.tabs if tab.label == "Scenario Analysis")
        self.assertTrue(
            any("Rectangle scenario available" in item.value for item in scenario_tab.markdown)
        )
        metric_values = {metric.label: metric.value for metric in scenario_tab.metric}
        self.assertEqual(metric_values["Lifecycle"], "confirmed")
        self.assertEqual(metric_values["Direction"], "bullish")
        risk_tables = [
            dataframe.value
            for dataframe in scenario_tab.dataframe
            if set(dataframe.value.columns) == {"Metric", "Value"}
        ]
        self.assertEqual(len(risk_tables), 1)
        self.assertIn("Risk per unit including costs", set(risk_tables[0]["Metric"]))


if __name__ == "__main__":
    unittest.main()
