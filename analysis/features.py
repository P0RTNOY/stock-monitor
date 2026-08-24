from __future__ import annotations

from collections import OrderedDict
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from analysis.contracts import Bar, ContractError
from analysis.providers import validate_bar_sequence


def true_range(bars: tuple[Bar, ...]) -> tuple[float, ...]:
    validate_bar_sequence(bars)
    values: list[float] = []
    previous_close: float | None = None
    for bar in bars:
        if previous_close is None:
            value = bar.high - bar.low
        else:
            value = max(
                bar.high - bar.low,
                abs(bar.high - previous_close),
                abs(bar.low - previous_close),
            )
        values.append(value)
        previous_close = bar.close
    return tuple(values)


def wilder_atr(bars: tuple[Bar, ...], period: int = 14) -> tuple[float | None, ...]:
    if period <= 0:
        raise ContractError("ATR period must be positive")
    ranges = true_range(bars)
    result: list[float | None] = [None] * len(ranges)
    if len(ranges) < period:
        return tuple(result)

    latest = sum(ranges[:period]) / period
    result[period - 1] = latest
    for index in range(period, len(ranges)):
        latest = ((latest * (period - 1)) + ranges[index]) / period
        result[index] = latest
    return tuple(result)


def relative_volume(
    bars: tuple[Bar, ...],
    lookback: int = 20,
) -> tuple[float | None, ...]:
    if lookback <= 0:
        raise ContractError("relative-volume lookback must be positive")
    validate_bar_sequence(bars)
    result: list[float | None] = []
    for index, bar in enumerate(bars):
        if index < lookback:
            result.append(None)
            continue
        baseline = sum(item.volume for item in bars[index - lookback : index]) / lookback
        result.append(None if baseline <= 0 else bar.volume / baseline)
    return tuple(result)


def simple_moving_average(
    bars: tuple[Bar, ...],
    period: int,
) -> tuple[float | None, ...]:
    if period <= 0:
        raise ContractError("moving-average period must be positive")
    validate_bar_sequence(bars)
    result: list[float | None] = []
    rolling_sum = 0.0
    for index, bar in enumerate(bars):
        rolling_sum += bar.close
        if index >= period:
            rolling_sum -= bars[index - period].close
        result.append(rolling_sum / period if index + 1 >= period else None)
    return tuple(result)


def resample_completed_weeks(
    daily_bars: tuple[Bar, ...],
    as_of: datetime,
) -> tuple[Bar, ...]:
    validate_bar_sequence(daily_bars)
    if as_of.tzinfo is None or as_of.utcoffset() is None:
        raise ContractError("as_of must be timezone-aware")
    if not daily_bars:
        return ()

    complete_daily = tuple(bar for bar in daily_bars if bar.is_complete and bar.timestamp <= as_of)
    groups: OrderedDict[tuple[int, int], list[Bar]] = OrderedDict()
    for bar in complete_daily:
        iso = bar.timestamp.isocalendar()
        groups.setdefault((iso.year, iso.week), []).append(bar)

    weekly: list[Bar] = []
    for group_index, group in enumerate(groups.values()):
        # Provider windows and post-split slices can start midweek. Without an
        # exchange calendar, dropping the first boundary group is the only safe
        # way to prevent a partial week from becoming technical evidence.
        if group_index == 0:
            continue
        first = group[0]
        last = group[-1]
        market_zone = ZoneInfo(first.timezone)
        week_start = first.timestamp.date() - timedelta(days=first.timestamp.weekday())
        completed_at = datetime.combine(
            week_start + timedelta(days=7),
            time.min,
            tzinfo=market_zone,
        )
        if completed_at > as_of.astimezone(market_zone):
            continue
        weekly.append(
            Bar(
                symbol=first.symbol,
                timeframe="1wk",
                timestamp=last.timestamp,
                completed_at=completed_at,
                timezone=first.timezone,
                open=first.open,
                high=max(bar.high for bar in group),
                low=min(bar.low for bar in group),
                close=last.close,
                volume=sum(bar.volume for bar in group),
                is_complete=True,
                adjustment_mode=first.adjustment_mode,
                provider=first.provider,
                corporate_action_flags=tuple(
                    sorted(
                        {
                            flag
                            for bar in group
                            for flag in bar.corporate_action_flags
                        }
                    )
                ),
            )
        )
    return validate_bar_sequence(weekly)
