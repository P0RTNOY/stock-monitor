from __future__ import annotations

from analysis.contracts import Bar, ContractError, Pivot, StructureState
from analysis.providers import validate_bar_sequence


def find_confirmed_pivots(
    bars: tuple[Bar, ...],
    *,
    left_bars: int,
    right_bars: int,
) -> tuple[Pivot, ...]:
    if left_bars <= 0 or right_bars <= 0:
        raise ContractError("pivot left/right bars must be positive")
    validate_bar_sequence(bars)
    if any(not bar.is_complete for bar in bars):
        raise ContractError("confirmed pivots require completed bars")
    pivots: list[Pivot] = []
    end = len(bars) - right_bars
    for index in range(left_bars, end):
        bar = bars[index]
        left = bars[index - left_bars : index]
        right = bars[index + 1 : index + right_bars + 1]
        neighbors = left + right
        confirmation_index = index + right_bars
        confirmation_timestamp = bars[confirmation_index].completed_at
        if all(bar.high > neighbor.high for neighbor in neighbors):
            pivots.append(
                Pivot(
                    kind="high",
                    price=bar.high,
                    bar_index=index,
                    timestamp=bar.timestamp,
                    confirmation_index=confirmation_index,
                    confirmation_timestamp=confirmation_timestamp,
                )
            )
        if all(bar.low < neighbor.low for neighbor in neighbors):
            pivots.append(
                Pivot(
                    kind="low",
                    price=bar.low,
                    bar_index=index,
                    timestamp=bar.timestamp,
                    confirmation_index=confirmation_index,
                    confirmation_timestamp=confirmation_timestamp,
                )
            )
    return tuple(pivots)


def classify_structure(pivots: tuple[Pivot, ...]) -> StructureState:
    highs = [pivot for pivot in pivots if pivot.kind == "high"]
    lows = [pivot for pivot in pivots if pivot.kind == "low"]
    if len(highs) < 2 or len(lows) < 2:
        return StructureState(
            trend="insufficient_data",
            latest_high=highs[-1].price if highs else None,
            previous_high=highs[-2].price if len(highs) >= 2 else None,
            latest_low=lows[-1].price if lows else None,
            previous_low=lows[-2].price if len(lows) >= 2 else None,
            reason="At least two confirmed swing highs and lows are required.",
        )

    previous_high, latest_high = highs[-2:]
    previous_low, latest_low = lows[-2:]
    if latest_high.price > previous_high.price and latest_low.price > previous_low.price:
        trend = "uptrend"
        reason = "The latest confirmed swing high and swing low are both higher."
    elif latest_high.price < previous_high.price and latest_low.price < previous_low.price:
        trend = "downtrend"
        reason = "The latest confirmed swing high and swing low are both lower."
    else:
        trend = "range"
        reason = "Confirmed swing highs and lows do not agree on one trend direction."

    return StructureState(
        trend=trend,
        latest_high=latest_high.price,
        previous_high=previous_high.price,
        latest_low=latest_low.price,
        previous_low=previous_low.price,
        reason=reason,
    )
