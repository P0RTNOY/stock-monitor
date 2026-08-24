from __future__ import annotations

import unittest
from datetime import timedelta

from analysis.features import (
    relative_volume,
    resample_completed_weeks,
    simple_moving_average,
    true_range,
    wilder_atr,
)
from tests.analysis_helpers import START, make_bar


class AnalysisFeatureTests(unittest.TestCase):
    def test_true_range_includes_gaps(self) -> None:
        bars = (
            make_bar(0, close=100, high=101, low=99),
            make_bar(1, close=111, high=112, low=110),
            make_bar(2, close=91, high=92, low=90),
        )

        self.assertEqual(true_range(bars), (2, 12, 21))

    def test_wilder_atr_uses_arithmetic_seed_then_recurrence(self) -> None:
        ranges = list(range(1, 15)) + [28]
        bars = tuple(
            make_bar(index, close=100, high=100 + value / 2, low=100 - value / 2)
            for index, value in enumerate(ranges)
        )

        values = wilder_atr(bars, 14)

        self.assertTrue(all(value is None for value in values[:13]))
        self.assertAlmostEqual(values[13], 7.5)
        self.assertAlmostEqual(values[14], 8.964285714285714)

    def test_relative_volume_excludes_current_bar_and_handles_zero_baseline(self) -> None:
        bars = tuple(
            make_bar(index, volume=volume)
            for index, volume in enumerate((100, 200, 300, 600))
        )
        zero_bars = tuple(make_bar(index, volume=0) for index in range(4))

        self.assertEqual(relative_volume(bars, 3), (None, None, None, 3.0))
        self.assertIsNone(relative_volume(zero_bars, 3)[-1])

    def test_simple_moving_average_warmup(self) -> None:
        bars = tuple(make_bar(index, close=index + 10) for index in range(4))
        self.assertEqual(simple_moving_average(bars, 3), (None, None, 11.0, 12.0))

    def test_weekly_resampling_excludes_current_week_and_aggregates_ohlcv(self) -> None:
        # Jan 6–10, 2025 is one complete ISO week; Jan 13 is the current week.
        # Jan 1 is a deliberately discarded boundary week. Jan 6–10 is the
        # first full retained week, and Jan 13 is the incomplete current week.
        day_indexes = (0, 5, 6, 7, 8, 9, 12)
        bars = tuple(
            make_bar(
                day_index,
                open_price=99 if day_index == 0 else 100 + (index - 1),
                high=100 if day_index == 0 else 105 + (index - 1),
                low=98 if day_index == 0 else 95 - (index - 1),
                close=99 if day_index == 0 else 101 + (index - 1),
                volume=50 if day_index == 0 else 100 * index,
                flags=("dividend",) if day_index == 7 else (),
            )
            for index, day_index in enumerate(day_indexes)
        )
        as_of = START + timedelta(days=12, hours=4)

        weekly = resample_completed_weeks(bars, as_of)

        self.assertEqual(len(weekly), 1)
        self.assertEqual(weekly[0].open, 100)
        self.assertEqual(weekly[0].high, 109)
        self.assertEqual(weekly[0].low, 91)
        self.assertEqual(weekly[0].close, 105)
        self.assertEqual(weekly[0].volume, 1_500)
        self.assertEqual(weekly[0].corporate_action_flags, ("dividend",))

    def test_first_boundary_week_is_dropped_even_when_it_precedes_as_of(self) -> None:
        # A provider or post-split slice beginning Wednesday must not create a
        # synthetic Wed–Fri weekly bar.
        bars = tuple(make_bar(index) for index in (0, 1, 2, 5, 6, 7, 8, 9))
        as_of = START + timedelta(days=12)
        weekly = resample_completed_weeks(bars, as_of)
        self.assertEqual(len(weekly), 1)
        self.assertEqual(weekly[0].timestamp, bars[-1].timestamp)
        self.assertGreater(weekly[0].completed_at, weekly[0].timestamp)


if __name__ == "__main__":
    unittest.main()
