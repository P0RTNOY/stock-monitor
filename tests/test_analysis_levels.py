from __future__ import annotations

import unittest

from analysis.levels import cluster_levels
from tests.analysis_helpers import make_bar, make_pivot


class AnalysisLevelTests(unittest.TestCase):
    def _cluster(self, prices: tuple[float, ...], close: float = 110):
        pivots = tuple(
            make_pivot("high" if index % 2 == 0 else "low", price, index)
            for index, price in enumerate(prices)
        )
        bars = tuple(make_bar(index, close=close) for index in range(max(5, len(prices))))
        return cluster_levels(
            pivots,
            bars,
            latest_atr=2.0,
            width_atr_multiple=0.5,
            minimum_width_percent=0.001,
            minimum_touches=2,
            maximum_zones=3,
        )

    def test_nearby_pivots_form_one_support_zone(self) -> None:
        zones = self._cluster((99.8, 100.0, 100.2))
        self.assertEqual(len(zones), 1)
        self.assertEqual(zones[0].touch_count, 3)
        self.assertAlmostEqual(zones[0].center, 100.0)
        self.assertEqual(zones[0].role, "support")
        self.assertAlmostEqual(zones[0].upper - zones[0].lower, 1.0)

    def test_cluster_does_not_transitively_absorb_distant_point(self) -> None:
        zones = self._cluster((100.0, 100.9, 101.8))
        self.assertEqual(len(zones), 1)
        self.assertEqual(zones[0].touch_count, 2)

    def test_cluster_width_is_a_hard_maximum_span(self) -> None:
        zones = self._cluster((100.0, 101.0, 101.5))
        self.assertEqual(len(zones), 1)
        self.assertEqual(zones[0].touch_count, 2)
        self.assertLessEqual(zones[0].upper - zones[0].lower, 1.0)

    def test_maximum_three_zones_are_selected_deterministically(self) -> None:
        prices = (89.8, 90.0, 99.8, 100.0, 109.8, 110.0, 119.8, 120.0)
        first = self._cluster(prices, close=105)
        second = self._cluster(tuple(reversed(prices)), close=105)

        self.assertEqual(len(first), 3)
        self.assertEqual(
            [(zone.center, zone.touch_count) for zone in first],
            [(zone.center, zone.touch_count) for zone in second],
        )


if __name__ == "__main__":
    unittest.main()
