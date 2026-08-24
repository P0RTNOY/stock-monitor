from __future__ import annotations

import unittest
from dataclasses import replace

from analysis.contracts import AnalysisRequest, LevelZone
from analysis.patterns.rectangle import RectangleDetection, detect_rectangle
from analysis.risk import build_rectangle_scenario
from analysis.rulesets import load_ruleset
from tests.analysis_helpers import START, make_bar, make_pivot


def _rectangle_fixture(extra_bars=(), breakout_rvol: float = 1.3):
    bars = [make_bar(index, close=105, high=106, low=104) for index in range(33)]
    # The bar values need not manufacture pivots because detector unit tests pass
    # already-confirmed pivot contracts explicitly.
    pivots = (
        make_pivot("low", 100.0, 10),
        make_pivot("high", 110.0, 15),
        make_pivot("low", 100.1, 25),
        make_pivot("high", 109.9, 30),
    )
    bars.extend(extra_bars)
    atr = tuple(2.0 for _ in bars)
    rvol = [1.0 for _ in bars]
    if len(bars) > 33:
        rvol[33] = breakout_rvol
    return tuple(bars), pivots, atr, tuple(rvol)


def _detect(extra_bars=(), breakout_rvol: float = 1.3):
    bars, pivots, atr, rvol = _rectangle_fixture(extra_bars, breakout_rvol)
    return detect_rectangle(
        bars,
        pivots,
        atr,
        rvol,
        load_ruleset().rectangles,
        ruleset_version="ruleset-v1",
    )


class RectangleLifecycleTests(unittest.TestCase):
    def test_candidate_appears_only_when_fourth_touch_is_confirmed(self) -> None:
        before_bars, pivots, before_atr, before_rvol = _rectangle_fixture()
        before = detect_rectangle(
            before_bars[:32],
            pivots,
            before_atr[:32],
            before_rvol[:32],
            load_ruleset().rectangles,
            ruleset_version="ruleset-v1",
        )
        after = _detect()

        self.assertIsNone(before.detection)
        self.assertIsNotNone(after.detection)
        self.assertEqual(after.detection.lifecycle_state, "candidate")
        self.assertAlmostEqual(after.detection.range_lower, 100.05)
        self.assertAlmostEqual(after.detection.range_upper, 109.95)
        self.assertEqual(after.detection.atr_at_formation, 2.0)

    def test_bullish_breakout_requires_close_distance_and_relative_volume(self) -> None:
        breakout = make_bar(33, close=111, high=112, low=110)
        confirmed = _detect((breakout,))
        low_volume = _detect((breakout,), breakout_rvol=1.249)

        self.assertEqual(confirmed.detection.lifecycle_state, "confirmed")
        self.assertEqual(confirmed.detection.direction, "bullish")
        self.assertAlmostEqual(confirmed.detection.measured_target, 119.85)
        self.assertEqual(low_volume.detection.lifecycle_state, "invalidated")
        self.assertEqual(low_volume.detection.event_reason, "relative_volume_not_confirmed")

    def test_wick_only_breakout_does_not_confirm(self) -> None:
        result = _detect((make_bar(33, close=110.4, high=112, low=109),))
        self.assertEqual(result.detection.lifecycle_state, "candidate")
        self.assertIsNone(result.detection.breakout_index)

    def test_formation_bar_can_confirm_breakout_without_lookahead(self) -> None:
        bars, pivots, atr, rvol = _rectangle_fixture()
        bars = (*bars[:32], make_bar(32, close=111, high=112, low=110))
        rvol = (*rvol[:32], 1.3)
        result = detect_rectangle(
            bars,
            pivots,
            atr,
            rvol,
            load_ruleset().rectangles,
            ruleset_version="ruleset-v1",
        )
        self.assertEqual(result.detection.lifecycle_state, "confirmed")
        self.assertEqual(result.detection.breakout_index, 32)

    def test_confirmation_close_reaches_target_but_wick_alone_does_not(self) -> None:
        close_at_target = _detect((make_bar(33, close=120, high=121, low=119),))
        wick_only = _detect((make_bar(33, close=111, high=120, low=110),))

        self.assertEqual(close_at_target.detection.lifecycle_state, "target_reached")
        self.assertEqual(close_at_target.detection.terminal_index, 33)
        self.assertEqual(
            close_at_target.detection.event_reason,
            "measured_target_reached_on_confirmation_close",
        )
        self.assertEqual(wick_only.detection.lifecycle_state, "confirmed")

    def test_bearish_breakout_is_mirrored(self) -> None:
        result = _detect((make_bar(33, close=99, high=100, low=98),))
        self.assertEqual(result.detection.lifecycle_state, "confirmed")
        self.assertEqual(result.detection.direction, "bearish")
        self.assertAlmostEqual(result.detection.measured_target, 90.15)

    def test_retest_failure_target_and_direct_invalidation_precedence(self) -> None:
        breakout = make_bar(33, close=111, high=112, low=110)
        retest = _detect((breakout, make_bar(34, close=110.2, high=111, low=109.8)))
        failed = _detect((breakout, make_bar(34, close=109, high=111, low=108)))
        invalidated = _detect((breakout, make_bar(34, close=99, high=100, low=98)))
        target_and_failure = _detect(
            (breakout, make_bar(34, close=109, high=120, low=108))
        )

        self.assertEqual(retest.detection.lifecycle_state, "retest")
        self.assertEqual(failed.detection.lifecycle_state, "failed_breakout")
        self.assertEqual(invalidated.detection.lifecycle_state, "invalidated")
        self.assertEqual(target_and_failure.detection.lifecycle_state, "target_reached")

    def test_first_retest_is_preserved_through_later_bars_and_target(self) -> None:
        breakout = make_bar(33, close=111, high=112, low=110)
        first_retest = make_bar(34, close=110.2, high=111, low=109.8)
        second_retest = make_bar(35, close=110.3, high=111, low=109.9)
        still_retested = _detect((breakout, first_retest, second_retest))
        target = _detect(
            (breakout, first_retest, second_retest, make_bar(36, close=119, high=120, low=118))
        )

        self.assertEqual(still_retested.detection.lifecycle_state, "retest")
        self.assertEqual(still_retested.detection.retest_index, 34)
        self.assertEqual(still_retested.detection.last_event_index, 34)
        self.assertEqual(target.detection.lifecycle_state, "target_reached")
        self.assertEqual(target.detection.retest_index, 34)
        self.assertEqual(target.detection.terminal_index, 36)
        self.assertEqual(target.detection.last_event_index, 36)

    def test_candidate_and_confirmed_scenarios_expire_by_completed_bar_count(self) -> None:
        candidate_bars = tuple(
            make_bar(index, close=105, high=106, low=104)
            for index in range(33, 53)
        )
        candidate = _detect(candidate_bars)
        breakout = make_bar(33, close=111, high=112, low=110)
        follow_through = tuple(
            make_bar(index, close=112, high=113, low=111)
            for index in range(34, 64)
        )
        confirmed = _detect((breakout, *follow_through))

        self.assertEqual(candidate.detection.lifecycle_state, "expired")
        self.assertEqual(confirmed.detection.lifecycle_state, "expired")

    def test_stale_terminal_scenario_ages_out_of_current_report(self) -> None:
        candidate_expiry = [
            make_bar(index, close=105, high=106, low=104)
            for index in range(33, 53)
        ]
        stale_tail = [
            make_bar(index, close=130 + index, high=131 + index, low=129 + index)
            for index in range(53, 115)
        ]
        result = _detect((*candidate_expiry, *stale_tail))
        self.assertIsNone(result.detection)

    def test_breakout_on_exact_candidate_expiry_bar_wins(self) -> None:
        extra = [
            make_bar(index, close=105, high=106, low=104)
            for index in range(33, 52)
        ]
        extra.append(make_bar(52, close=111, high=112, low=110))
        bars, pivots, atr, rvol = _rectangle_fixture(tuple(extra))
        rvol = tuple(1.3 if index == 52 else value for index, value in enumerate(rvol))
        result = detect_rectangle(
            bars,
            pivots,
            atr,
            rvol,
            load_ruleset().rectangles,
            ruleset_version="ruleset-v1",
        )
        self.assertEqual(result.detection.lifecycle_state, "confirmed")
        self.assertEqual(result.detection.breakout_index, 52)

    def test_future_pivots_do_not_redraw_frozen_rectangle(self) -> None:
        extra = tuple(
            make_bar(index, close=112, high=113, low=111)
            for index in range(33, 38)
        )
        bars, pivots, atr, rvol = _rectangle_fixture(extra)
        rvol = tuple(1.3 if index == 33 else value for index, value in enumerate(rvol))
        baseline = detect_rectangle(
            bars,
            pivots,
            atr,
            rvol,
            load_ruleset().rectangles,
            ruleset_version="ruleset-v1",
        )
        with_future_pivot = detect_rectangle(
            bars,
            (*pivots, make_pivot("high", 115, 34)),
            atr,
            rvol,
            load_ruleset().rectangles,
            ruleset_version="ruleset-v1",
        )
        self.assertEqual(baseline.detection.range_lower, with_future_pivot.detection.range_lower)
        self.assertEqual(baseline.detection.range_upper, with_future_pivot.detection.range_upper)
        self.assertEqual(
            baseline.detection.atr_at_formation,
            with_future_pivot.detection.atr_at_formation,
        )

    def test_corporate_action_breakout_is_not_confirmed(self) -> None:
        breakout = make_bar(
            33,
            close=111,
            high=112,
            low=110,
            flags=("dividend",),
        )
        result = _detect((breakout,))
        self.assertEqual(result.detection.lifecycle_state, "invalidated")
        self.assertEqual(result.detection.event_reason, "corporate_action_breakout_bar")

    def test_missing_relative_volume_rejects_price_break(self) -> None:
        bars, pivots, atr, rvol = _rectangle_fixture(
            (make_bar(33, close=111, high=112, low=110),)
        )
        rvol = (*rvol[:33], None)
        result = detect_rectangle(
            bars,
            pivots,
            atr,
            rvol,
            load_ruleset().rectangles,
            ruleset_version="ruleset-v1",
        )
        self.assertEqual(result.detection.lifecycle_state, "invalidated")
        self.assertEqual(result.detection.event_reason, "relative_volume_not_confirmed")

    def test_dual_kind_pivot_on_one_bar_is_ambiguous_not_two_touches(self) -> None:
        bars, pivots, atr, rvol = _rectangle_fixture()
        ambiguous = (*pivots, make_pivot("low", 100.0, 30))
        result = detect_rectangle(
            bars,
            ambiguous,
            atr,
            rvol,
            load_ruleset().rectangles,
            ruleset_version="ruleset-v1",
        )
        self.assertIsNone(result.detection)


class RectangleRiskTests(unittest.TestCase):
    def test_position_size_uses_explicit_risk_costs_and_stop_assumption(self) -> None:
        bars, _, _, _ = _rectangle_fixture((make_bar(33, close=111, high=112, low=110),))
        result = _detect((make_bar(33, close=111, high=112, low=110),))
        request = AnalysisRequest(
            "AAPL",
            bars[-1].completed_at,
            account_risk=1_000,
            commission_per_unit=0.2,
            expected_slippage_per_unit=0.1,
            execution_stop_price=108,
        )

        scenario = build_rectangle_scenario(
            result.detection,
            bars,
            request,
            load_ruleset(),
        )

        self.assertIsNotNone(scenario.risk)
        self.assertAlmostEqual(scenario.risk.risk_per_unit, 3.3)
        self.assertEqual(scenario.risk.position_size, 303)
        self.assertAlmostEqual(scenario.risk.reward_per_unit, 8.55)
        self.assertAlmostEqual(scenario.risk.reward_risk_ratio, 8.55 / 3.3)

    def test_candidate_has_no_entry_or_position_size(self) -> None:
        bars, _, _, _ = _rectangle_fixture()
        detection = _detect().detection
        scenario = build_rectangle_scenario(
            detection,
            bars,
            AnalysisRequest("AAPL", bars[-1].completed_at, account_risk=1_000),
            load_ruleset(),
        )
        self.assertIsNone(scenario.entry_assumption)
        self.assertIsNone(scenario.risk)

    def test_wrong_side_stop_disables_risk_calculation(self) -> None:
        breakout = make_bar(33, close=111, high=112, low=110)
        bars, _, _, _ = _rectangle_fixture((breakout,))
        detection = _detect((breakout,)).detection
        scenario = build_rectangle_scenario(
            detection,
            bars,
            AnalysisRequest("AAPL", bars[-1].completed_at, execution_stop_price=115),
            load_ruleset(),
        )
        self.assertIsNone(scenario.risk)
        self.assertTrue(any("wrong side" in warning for warning in scenario.warnings))

    def test_account_risk_alone_never_produces_position_size(self) -> None:
        breakout = make_bar(33, close=111, high=112, low=110)
        bars, _, _, _ = _rectangle_fixture((breakout,))
        scenario = build_rectangle_scenario(
            _detect((breakout,)).detection,
            bars,
            AnalysisRequest("AAPL", bars[-1].completed_at, account_risk=1_000),
            load_ruleset(),
        )

        self.assertIsNotNone(scenario.risk)
        self.assertIsNone(scenario.risk.position_size)
        self.assertTrue(any("requires explicit" in warning for warning in scenario.warnings))

    def test_target_behind_entry_has_no_reward_ratio_or_size(self) -> None:
        bullish_bar = make_bar(33, close=111, high=112, low=110)
        bullish_bars, _, _, _ = _rectangle_fixture((bullish_bar,))
        bullish = replace(
            _detect((bullish_bar,)).detection,
            breakout_price=125,
        )
        bearish_bar = make_bar(33, close=99, high=100, low=98)
        bearish_bars, _, _, _ = _rectangle_fixture((bearish_bar,))
        bearish = replace(
            _detect((bearish_bar,)).detection,
            breakout_price=85,
        )

        for detection, bars, stop in (
            (bullish, bullish_bars, 108),
            (bearish, bearish_bars, 112),
        ):
            with self.subTest(direction=detection.direction):
                scenario = build_rectangle_scenario(
                    detection,
                    bars,
                    AnalysisRequest(
                        "AAPL",
                        bars[-1].completed_at,
                        account_risk=1_000,
                        commission_per_unit=0,
                        expected_slippage_per_unit=0,
                        execution_stop_price=stop,
                    ),
                    load_ruleset(),
                )
                self.assertIsNotNone(scenario.risk)
                self.assertIsNone(scenario.risk.reward_per_unit)
                self.assertIsNone(scenario.risk.reward_risk_ratio)
                self.assertIsNone(scenario.risk.position_size)

    def test_terminal_lifecycle_suppresses_current_risk_arithmetic(self) -> None:
        breakout = make_bar(33, close=111, high=112, low=110)
        target = make_bar(34, close=119, high=120, low=118)
        bars, _, _, _ = _rectangle_fixture((breakout, target))
        scenario = build_rectangle_scenario(
            _detect((breakout, target)).detection,
            bars,
            AnalysisRequest(
                "AAPL",
                bars[-1].completed_at,
                account_risk=1_000,
                commission_per_unit=0,
                expected_slippage_per_unit=0,
                execution_stop_price=108,
            ),
            load_ruleset(),
        )
        self.assertEqual(scenario.lifecycle_state, "target_reached")
        self.assertIsNone(scenario.risk)
        self.assertIsNotNone(scenario.terminal_at)

    def test_non_positive_default_stop_disables_risk_arithmetic(self) -> None:
        breakout = make_bar(33, close=111, high=112, low=110)
        bars, _, _, _ = _rectangle_fixture((breakout,))
        detection = replace(
            _detect((breakout,)).detection,
            range_lower=0.1,
            range_upper=10.0,
            range_height=9.9,
            breakout_price=11.0,
            measured_target=19.9,
        )
        scenario = build_rectangle_scenario(
            detection,
            bars,
            AnalysisRequest("AAPL", bars[-1].completed_at),
            load_ruleset(),
        )
        self.assertIsNone(scenario.risk)
        self.assertTrue(any("non-positive" in warning for warning in scenario.warnings))

    def test_intermediate_zone_edge_overlap_is_reported(self) -> None:
        breakout = make_bar(33, close=111, high=112, low=110)
        bars, _, _, _ = _rectangle_fixture((breakout,))
        level = LevelZone(
            role="resistance",
            lower=110.0,
            upper=112.0,
            center=111.0,
            touch_count=2,
            pivot_kinds=("high",),
            first_touch=START,
            last_touch=START,
            distance_from_close_pct=0.0,
        )
        scenario = build_rectangle_scenario(
            _detect((breakout,)).detection,
            bars,
            AnalysisRequest("AAPL", bars[-1].completed_at),
            load_ruleset(),
            historical_levels=(level,),
        )
        self.assertEqual(scenario.intermediate_levels, (level,))


if __name__ == "__main__":
    unittest.main()
