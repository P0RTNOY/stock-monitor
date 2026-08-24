from __future__ import annotations

import unittest

from analysis.contracts import ContractError
from analysis.structure import classify_structure, find_confirmed_pivots
from tests.analysis_helpers import make_bar, make_pivot


class AnalysisStructureTests(unittest.TestCase):
    def test_pivot_is_emitted_only_after_right_side_confirmation(self) -> None:
        highs = (10, 11, 15, 11, 10)
        full = tuple(
            make_bar(index, close=high - 1, high=high, low=high - 2)
            for index, high in enumerate(highs)
        )

        self.assertEqual(find_confirmed_pivots(full[:4], left_bars=2, right_bars=2), ())
        pivots = find_confirmed_pivots(full, left_bars=2, right_bars=2)
        high_pivot = next(pivot for pivot in pivots if pivot.kind == "high")
        self.assertEqual(high_pivot.bar_index, 2)
        self.assertEqual(high_pivot.confirmation_index, 4)
        self.assertEqual(high_pivot.timestamp, full[2].timestamp)
        self.assertEqual(high_pivot.confirmation_timestamp, full[4].completed_at)

    def test_incomplete_right_side_bar_cannot_confirm_pivot(self) -> None:
        highs = (10, 11, 15, 11, 10)
        bars = tuple(
            make_bar(
                index,
                close=high - 1,
                high=high,
                low=high - 2,
                complete=index != 4,
            )
            for index, high in enumerate(highs)
        )
        with self.assertRaisesRegex(ContractError, "completed bars"):
            find_confirmed_pivots(bars, left_bars=2, right_bars=2)

    def test_equal_high_plateau_is_not_a_confirmed_pivot(self) -> None:
        highs = (10, 11, 15, 15, 10, 9)
        bars = tuple(
            make_bar(index, close=high - 1, high=high, low=high - 2)
            for index, high in enumerate(highs)
        )
        self.assertFalse(
            any(
                pivot.kind == "high"
                for pivot in find_confirmed_pivots(bars, left_bars=2, right_bars=2)
            )
        )

    def test_structure_classifies_up_down_range_and_insufficient(self) -> None:
        fixtures = {
            "uptrend": (
                make_pivot("high", 100, 1),
                make_pivot("low", 90, 2),
                make_pivot("high", 110, 3),
                make_pivot("low", 95, 4),
            ),
            "downtrend": (
                make_pivot("high", 110, 1),
                make_pivot("low", 95, 2),
                make_pivot("high", 100, 3),
                make_pivot("low", 90, 4),
            ),
            "range": (
                make_pivot("high", 110, 1),
                make_pivot("low", 90, 2),
                make_pivot("high", 100, 3),
                make_pivot("low", 95, 4),
            ),
        }
        for expected, pivots in fixtures.items():
            with self.subTest(expected=expected):
                self.assertEqual(classify_structure(pivots).trend, expected)
        self.assertEqual(
            classify_structure((make_pivot("high", 100, 1),)).trend,
            "insufficient_data",
        )


if __name__ == "__main__":
    unittest.main()
