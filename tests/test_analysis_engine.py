from __future__ import annotations

import json
import math
import unittest
from dataclasses import replace
from datetime import timedelta

from analysis.contracts import AnalysisRequest, ContractError
from analysis.engine import AnalysisEngine
from tests.analysis_helpers import START, make_bar


def _oscillating_bars(count: int = 220):
    bars = []
    for index in range(count):
        close = 100 + (index * 0.05) + (5 * math.sin(index * math.pi / 5))
        bars.append(make_bar(index, close=close, high=close + 1, low=close - 1))
    return tuple(bars)


def _trending_bars(count: int = 220):
    return tuple(
        make_bar(index, close=100 + index, high=101 + index, low=99 + index)
        for index in range(count)
    )


def _engine_rectangle_bars():
    bars = [
        make_bar(index, close=105, high=106, low=104, volume=1_000)
        for index in range(209)
    ]
    bars[185] = make_bar(185, close=105, high=110, low=104, volume=1_000)
    bars[190] = make_bar(190, close=105, high=106, low=100, volume=1_000)
    bars[200] = make_bar(200, close=105, high=110, low=104, volume=1_000)
    bars[205] = make_bar(205, close=105, high=106, low=100, volume=1_000)
    bars[208] = make_bar(208, close=111.6, high=112, low=110.5, volume=2_000)
    return tuple(bars)


class AnalysisEngineTests(unittest.TestCase):
    @staticmethod
    def _engine() -> AnalysisEngine:
        return AnalysisEngine(clock=lambda: START + timedelta(days=500))

    def test_report_is_deterministic_explainable_and_no_setup(self) -> None:
        bars = _trending_bars()
        request = AnalysisRequest("AAPL", START + timedelta(days=221))
        engine = self._engine()

        first = engine.analyze(request, bars)
        second = engine.analyze(request, bars)

        self.assertEqual(first, second)
        self.assertEqual(first.status, "no_setup")
        self.assertIn("no rectangle setup", first.summary)
        self.assertEqual(set(first.timeframes), {"1d", "1wk"})
        self.assertTrue(first.evidence)
        self.assertEqual(len(first.data_hash), 64)
        serialized = json.dumps(first.to_dict(), sort_keys=True, allow_nan=False)
        self.assertEqual(serialized, json.dumps(second.to_dict(), sort_keys=True, allow_nan=False))

    def test_incomplete_and_future_bars_do_not_change_report(self) -> None:
        bars = _oscillating_bars()
        as_of = START + timedelta(days=221)
        request = AnalysisRequest("AAPL", as_of)
        engine = self._engine()
        base = engine.analyze(request, bars)
        ignored = (
            replace(make_bar(221, close=200), is_complete=False),
            make_bar(222, close=300),
        )

        with_extra = engine.analyze(request, bars + ignored)

        self.assertEqual(base, with_extra)

    def test_short_history_returns_insufficient_data(self) -> None:
        report = self._engine().analyze(
            AnalysisRequest("AAPL", START + timedelta(days=25)),
            _oscillating_bars(20),
        )
        self.assertEqual(report.status, "insufficient_data")
        self.assertTrue(
            any(
                item.rule_id == "data.minimum_bars.1d" and item.status == "failed"
                for item in report.evidence
            )
        )

    def test_recent_split_truncates_raw_history_and_emits_warning(self) -> None:
        bars = list(_oscillating_bars())
        bars[200] = replace(bars[200], corporate_action_flags=("split",))
        report = self._engine().analyze(
            AnalysisRequest("AAPL", START + timedelta(days=221)),
            tuple(bars),
        )

        self.assertEqual(report.status, "insufficient_data")
        self.assertTrue(report.warnings)
        self.assertTrue(any(item.rule_id == "data.raw_prices.recent_split" for item in report.evidence))

    def test_symbol_and_ruleset_mismatch_fail_closed(self) -> None:
        engine = self._engine()
        bars = _oscillating_bars()
        with self.assertRaisesRegex(ContractError, "symbol"):
            engine.analyze(AnalysisRequest("MSFT", START + timedelta(days=221)), bars)
        with self.assertRaisesRegex(ContractError, "ruleset"):
            engine.analyze(
                AnalysisRequest("AAPL", START + timedelta(days=221), ruleset_version="other"),
                bars,
            )

    def test_timeframe_order_is_canonicalized(self) -> None:
        bars = _oscillating_bars()
        as_of = START + timedelta(days=221)
        engine = self._engine()
        default = engine.analyze(AnalysisRequest("AAPL", as_of), bars)
        reversed_order = engine.analyze(
            AnalysisRequest("AAPL", as_of, timeframes=("1d", "1wk")),
            bars,
        )
        self.assertEqual(default, reversed_order)

    def test_generated_at_uses_injected_clock_not_historical_cutoff(self) -> None:
        as_of = START + timedelta(days=221)
        report = self._engine().analyze(AnalysisRequest("AAPL", as_of), _oscillating_bars())
        self.assertEqual(report.generated_at, START + timedelta(days=500))
        self.assertNotEqual(report.generated_at, report.as_of)

    def test_engine_assembles_rectangle_scenario_and_risk_evidence(self) -> None:
        bars = _engine_rectangle_bars()
        report = self._engine().analyze(
            AnalysisRequest(
                "AAPL",
                bars[-1].completed_at,
                account_risk=1_000,
                commission_per_unit=0,
                expected_slippage_per_unit=0,
                execution_stop_price=108,
            ),
            bars,
        )

        self.assertEqual(report.status, "scenario_detected")
        self.assertEqual(len(report.scenarios), 1)
        scenario = report.scenarios[0]
        self.assertEqual(scenario.setup, "rectangle")
        self.assertEqual(scenario.lifecycle_state, "confirmed")
        self.assertEqual(scenario.direction, "bullish")
        self.assertIsNotNone(scenario.risk)
        self.assertGreater(scenario.risk.position_size, 0)
        self.assertTrue(any(item.category == "risk" for item in report.evidence))


if __name__ == "__main__":
    unittest.main()
