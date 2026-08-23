from __future__ import annotations

import logging
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from datetime import date, timedelta
from pathlib import Path
from typing import Iterator
from unittest.mock import patch

import pandas as pd
from streamlit.testing.v1 import AppTest

import db


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

    def tearDown(self) -> None:
        db.DB_PATH = self.original_db_path
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


if __name__ == "__main__":
    unittest.main()
