from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from statistics import median
from typing import Literal

from analysis.contracts import Bar, ContractError, Evidence, LifecycleState, Pivot
from analysis.providers import validate_bar_sequence
from analysis.rulesets import RectangleConfig


Direction = Literal["bullish", "bearish", "undetermined"]
TERMINAL_STATES = {"failed_breakout", "invalidated", "target_reached", "expired"}


@dataclass(frozen=True)
class RectangleDetection:
    lifecycle_state: LifecycleState
    direction: Direction
    range_lower: float
    range_upper: float
    range_height: float
    range_start_index: int
    established_index: int
    lower_touch_count: int
    upper_touch_count: int
    breakout_index: int | None = None
    breakout_price: float | None = None
    measured_target: float | None = None
    atr_at_formation: float | None = None
    atr_at_breakout: float | None = None
    retest_index: int | None = None
    terminal_index: int | None = None
    last_event_index: int | None = None
    event_reason: str | None = None


@dataclass(frozen=True)
class RectangleResult:
    detection: RectangleDetection | None
    evidence: tuple[Evidence, ...]


def _separated_pivots(
    pivots: list[Pivot],
    minimum_separation: int,
) -> tuple[Pivot, ...]:
    selected: list[Pivot] = []
    for pivot in sorted(pivots, key=lambda item: item.bar_index):
        if not selected or pivot.bar_index - selected[-1].bar_index >= minimum_separation:
            selected.append(pivot)
    return tuple(selected)


def _best_price_cluster(
    pivots: tuple[Pivot, ...],
    *,
    kind: str,
    start_index: int,
    confirmation_index: int,
    available_at: datetime,
    tolerance: float,
    minimum_separation: int,
) -> tuple[Pivot, ...]:
    eligible = sorted(
        (
            pivot
            for pivot in pivots
            if pivot.kind == kind
            and pivot.bar_index >= start_index
            and pivot.confirmation_index <= confirmation_index
            and pivot.confirmation_timestamp <= available_at
        ),
        key=lambda item: item.price,
    )
    best: tuple[Pivot, ...] = ()
    for left in range(len(eligible)):
        for right in range(left, len(eligible)):
            window = eligible[left : right + 1]
            if window[-1].price - window[0].price > tolerance:
                break
            separated = _separated_pivots(window, minimum_separation)
            score = (
                len(separated),
                separated[-1].confirmation_index if separated else -1,
                separated[-1].bar_index if separated else -1,
            )
            best_score = (
                len(best),
                best[-1].confirmation_index if best else -1,
                best[-1].bar_index if best else -1,
            )
            if score > best_score:
                best = separated
    return best


def _candidate_at(
    index: int,
    bars: tuple[Bar, ...],
    pivots: tuple[Pivot, ...],
    atr_values: tuple[float | None, ...],
    config: RectangleConfig,
    search_after_index: int,
) -> RectangleDetection | None:
    atr = atr_values[index]
    if atr is None or atr <= 0:
        return None
    start_index = max(search_after_index, index - config.lookback_bars + 1)
    midprice = bars[index].close
    tolerance = max(
        atr * config.touch_tolerance_atr,
        midprice * config.touch_tolerance_percent,
    )
    highs = _best_price_cluster(
        pivots,
        kind="high",
        start_index=start_index,
        confirmation_index=index,
        available_at=bars[index].completed_at,
        tolerance=tolerance,
        minimum_separation=config.minimum_touch_separation_bars,
    )
    lows = _best_price_cluster(
        pivots,
        kind="low",
        start_index=start_index,
        confirmation_index=index,
        available_at=bars[index].completed_at,
        tolerance=tolerance,
        minimum_separation=config.minimum_touch_separation_bars,
    )
    if (
        len(highs) < config.minimum_touches_per_side
        or len(lows) < config.minimum_touches_per_side
    ):
        return None
    # A single outside bar can legitimately be emitted as both a high and a
    # low pivot, but it is not evidence of two independent range traversals.
    if {pivot.bar_index for pivot in highs} & {pivot.bar_index for pivot in lows}:
        return None

    established_index = max(
        max(pivot.confirmation_index for pivot in highs),
        max(pivot.confirmation_index for pivot in lows),
    )
    if established_index != index:
        return None
    if max(highs[0].bar_index, lows[0].bar_index) > min(
        highs[-1].bar_index, lows[-1].bar_index
    ):
        return None
    ordered_touches = sorted((*highs, *lows), key=lambda pivot: pivot.bar_index)
    alternations = sum(
        current.kind != previous.kind
        for previous, current in zip(ordered_touches, ordered_touches[1:])
    )
    if alternations < config.minimum_side_alternations:
        return None

    range_start_index = min(
        min(pivot.bar_index for pivot in highs),
        min(pivot.bar_index for pivot in lows),
    )
    range_end_index = max(
        max(pivot.bar_index for pivot in highs),
        max(pivot.bar_index for pivot in lows),
    )
    if range_end_index - range_start_index < config.minimum_formation_bars:
        return None

    range_upper = float(median(pivot.price for pivot in highs))
    range_lower = float(median(pivot.price for pivot in lows))
    range_height = range_upper - range_lower
    height_atr = range_height / atr
    minimum_height = max(
        config.minimum_height_atr * atr,
        config.minimum_height_percent * midprice,
    )
    if (
        range_height < minimum_height
        or height_atr > config.maximum_height_atr
    ):
        return None
    maximum_side_drift = range_height * config.maximum_side_drift_fraction
    if (
        abs(highs[-1].price - highs[0].price) > maximum_side_drift
        or abs(lows[-1].price - lows[0].price) > maximum_side_drift
    ):
        return None

    containment_buffer = max(
        atr * config.breakout_distance_atr,
        midprice * config.breakout_distance_percent,
    )
    formation_bars = bars[range_start_index : established_index + 1]
    outside = [
        bar.close > range_upper + containment_buffer
        or bar.close < range_lower - containment_buffer
        for bar in formation_bars
    ]
    containment_ratio = 1 - (sum(outside) / len(formation_bars))
    longest_outside_run = 0
    current_outside_run = 0
    for is_outside in outside:
        current_outside_run = current_outside_run + 1 if is_outside else 0
        longest_outside_run = max(longest_outside_run, current_outside_run)
    if (
        containment_ratio < config.minimum_containment_ratio
        or longest_outside_run > config.maximum_consecutive_outside_closes
    ):
        return None

    return RectangleDetection(
        lifecycle_state="candidate",
        direction="undetermined",
        range_lower=range_lower,
        range_upper=range_upper,
        range_height=range_height,
        range_start_index=range_start_index,
        established_index=established_index,
        lower_touch_count=len(lows),
        upper_touch_count=len(highs),
        atr_at_formation=atr,
        last_event_index=established_index,
    )


def _advance(
    detection: RectangleDetection,
    index: int,
    bars: tuple[Bar, ...],
    atr_values: tuple[float | None, ...],
    relative_volume_values: tuple[float | None, ...],
    config: RectangleConfig,
) -> RectangleDetection:
    bar = bars[index]
    current_atr = atr_values[index]
    frozen_atr = detection.atr_at_formation
    if current_atr is None or current_atr <= 0 or frozen_atr is None:
        return detection

    if detection.breakout_index is None:
        rvol = relative_volume_values[index]
        upper_distance = max(
            frozen_atr * config.breakout_distance_atr,
            detection.range_upper * config.breakout_distance_percent,
        )
        lower_distance = max(
            frozen_atr * config.breakout_distance_atr,
            detection.range_lower * config.breakout_distance_percent,
        )
        volume_confirmed = rvol is not None and rvol >= config.minimum_relative_volume
        bullish_price_break = bar.close >= detection.range_upper + upper_distance
        bearish_price_break = bar.close <= detection.range_lower - lower_distance
        if (bullish_price_break or bearish_price_break) and (
            not volume_confirmed or bar.corporate_action_flags
        ):
            direction: Direction = "bullish" if bullish_price_break else "bearish"
            reason = (
                "corporate_action_breakout_bar"
                if bar.corporate_action_flags
                else "relative_volume_not_confirmed"
            )
            return replace(
                detection,
                lifecycle_state="invalidated",
                direction=direction,
                terminal_index=index,
                last_event_index=index,
                event_reason=reason,
            )
        if bullish_price_break and volume_confirmed:
            measured_target = detection.range_upper + detection.range_height
            target_reached = bar.close >= measured_target
            return replace(
                detection,
                lifecycle_state="target_reached" if target_reached else "confirmed",
                direction="bullish",
                breakout_index=index,
                breakout_price=bar.close,
                measured_target=measured_target,
                atr_at_breakout=current_atr,
                terminal_index=index if target_reached else None,
                last_event_index=index,
                event_reason=(
                    "measured_target_reached_on_confirmation_close"
                    if target_reached
                    else "confirmed_close_and_relative_volume"
                ),
            )
        if bearish_price_break and volume_confirmed:
            measured_target = detection.range_lower - detection.range_height
            target_reached = bar.close <= measured_target
            return replace(
                detection,
                lifecycle_state="target_reached" if target_reached else "confirmed",
                direction="bearish",
                breakout_index=index,
                breakout_price=bar.close,
                measured_target=measured_target,
                atr_at_breakout=current_atr,
                terminal_index=index if target_reached else None,
                last_event_index=index,
                event_reason=(
                    "measured_target_reached_on_confirmation_close"
                    if target_reached
                    else "confirmed_close_and_relative_volume"
                ),
            )
        if index - detection.established_index >= config.candidate_expiration_bars:
            return replace(
                detection,
                lifecycle_state="expired",
                terminal_index=index,
                last_event_index=index,
                event_reason="candidate_expiration",
            )
        return detection

    bars_since_breakout = index - detection.breakout_index
    if detection.direction == "bullish":
        reentry_buffer = max(
            frozen_atr * config.invalidation_buffer_atr,
            detection.range_upper * config.invalidation_buffer_percent,
        )
        opposite_buffer = max(
            frozen_atr * config.invalidation_buffer_atr,
            detection.range_lower * config.invalidation_buffer_percent,
        )
        if detection.measured_target is not None and bar.high >= detection.measured_target:
            return replace(
                detection,
                lifecycle_state="target_reached",
                terminal_index=index,
                last_event_index=index,
                event_reason="measured_target_touched",
            )
        if bar.close <= detection.range_lower - opposite_buffer:
            return replace(
                detection,
                lifecycle_state="invalidated",
                terminal_index=index,
                last_event_index=index,
                event_reason="opposite_boundary_invalidated",
            )
        if bar.close < detection.range_upper - reentry_buffer:
            return replace(
                detection,
                lifecycle_state="failed_breakout",
                terminal_index=index,
                last_event_index=index,
                event_reason="close_back_inside_range",
            )
        retest_tolerance = max(
            frozen_atr * config.retest_tolerance_atr,
            detection.range_upper * config.retest_tolerance_percent,
        )
        if (
            detection.lifecycle_state == "confirmed"
            and bars_since_breakout <= config.maximum_retest_bars
            and bar.low <= detection.range_upper + retest_tolerance
            and bar.close >= detection.range_upper
        ):
            return replace(
                detection,
                lifecycle_state="retest",
                retest_index=index,
                last_event_index=index,
                event_reason="former_resistance_retested",
            )
    else:
        reentry_buffer = max(
            frozen_atr * config.invalidation_buffer_atr,
            detection.range_lower * config.invalidation_buffer_percent,
        )
        opposite_buffer = max(
            frozen_atr * config.invalidation_buffer_atr,
            detection.range_upper * config.invalidation_buffer_percent,
        )
        if detection.measured_target is not None and bar.low <= detection.measured_target:
            return replace(
                detection,
                lifecycle_state="target_reached",
                terminal_index=index,
                last_event_index=index,
                event_reason="measured_target_touched",
            )
        if bar.close >= detection.range_upper + opposite_buffer:
            return replace(
                detection,
                lifecycle_state="invalidated",
                terminal_index=index,
                last_event_index=index,
                event_reason="opposite_boundary_invalidated",
            )
        if bar.close > detection.range_lower + reentry_buffer:
            return replace(
                detection,
                lifecycle_state="failed_breakout",
                terminal_index=index,
                last_event_index=index,
                event_reason="close_back_inside_range",
            )
        retest_tolerance = max(
            frozen_atr * config.retest_tolerance_atr,
            detection.range_lower * config.retest_tolerance_percent,
        )
        if (
            detection.lifecycle_state == "confirmed"
            and bars_since_breakout <= config.maximum_retest_bars
            and bar.high >= detection.range_lower - retest_tolerance
            and bar.close <= detection.range_lower
        ):
            return replace(
                detection,
                lifecycle_state="retest",
                retest_index=index,
                last_event_index=index,
                event_reason="former_support_retested",
            )

    if bars_since_breakout >= config.confirmed_expiration_bars:
        return replace(
            detection,
            lifecycle_state="expired",
            terminal_index=index,
            last_event_index=index,
            event_reason="confirmed_scenario_expiration",
        )
    return detection


def _evidence(
    detection: RectangleDetection | None,
    bars: tuple[Bar, ...],
    config: RectangleConfig,
    ruleset_version: str,
) -> tuple[Evidence, ...]:
    if detection is None:
        return (
            Evidence(
                rule_id="setup.rectangle.geometry.1d",
                ruleset_version=ruleset_version,
                category="setup",
                status="unknown",
                observed={"candidate": False},
                threshold={
                    "minimum_touches_per_side": config.minimum_touches_per_side,
                    "minimum_formation_bars": config.minimum_formation_bars,
                },
                explanation="No completed daily-bar rectangle met every configured geometry rule.",
                method_reference="PDF pp. 41–42, 76, 78–79",
            ),
        )

    geometry_id = "setup.rectangle.geometry.1d"
    confirmation_id = "confirmation.rectangle.breakout.1d"
    lifecycle_id = "management.rectangle.lifecycle.1d"
    confirmation_status = "passed" if detection.breakout_index is not None else "unknown"
    lifecycle_status = (
        "warning"
        if detection.lifecycle_state in {"failed_breakout", "invalidated", "expired"}
        else "passed"
    )
    event_indexes = [detection.established_index]
    if detection.breakout_index is not None:
        event_indexes.append(detection.breakout_index)
    if detection.retest_index is not None:
        event_indexes.append(detection.retest_index)
    if detection.terminal_index is not None:
        event_indexes.append(detection.terminal_index)
    if detection.last_event_index is not None:
        event_indexes.append(detection.last_event_index)
    timestamps = tuple(
        bars[event_index].completed_at for event_index in dict.fromkeys(event_indexes)
    )
    return (
        Evidence(
            rule_id=geometry_id,
            ruleset_version=ruleset_version,
            category="setup",
            status="passed",
            observed={
                "range_lower": detection.range_lower,
                "range_upper": detection.range_upper,
                "height": detection.range_height,
                "lower_touches": detection.lower_touch_count,
                "upper_touches": detection.upper_touch_count,
            },
            threshold={
                "minimum_touches_per_side": config.minimum_touches_per_side,
                "minimum_formation_bars": config.minimum_formation_bars,
                "touch_tolerance_atr": config.touch_tolerance_atr,
            },
            bar_timestamps=timestamps,
            explanation="Two horizontal pivot clusters formed a bounded daily-bar range.",
            method_reference="PDF pp. 41–42",
        ),
        Evidence(
            rule_id=confirmation_id,
            ruleset_version=ruleset_version,
            category="confirmation",
            status=confirmation_status,
            observed={
                "direction": detection.direction,
                "breakout_price": detection.breakout_price,
            },
            threshold={
                "distance_atr": config.breakout_distance_atr,
                "minimum_relative_volume": config.minimum_relative_volume,
            },
            bar_timestamps=timestamps,
            explanation=(
                "Breakout confirmation requires both a completed close beyond the ATR buffer "
                "and the configured relative-volume threshold."
            ),
            method_reference="PDF pp. 33–34, 57–59",
        ),
        Evidence(
            rule_id=lifecycle_id,
            ruleset_version=ruleset_version,
            category="management",
            status=lifecycle_status,
            observed={
                "state": detection.lifecycle_state,
                "event_reason": detection.event_reason,
                "last_event_completed_at": (
                    bars[detection.last_event_index].completed_at.isoformat()
                    if detection.last_event_index is not None
                    else None
                ),
            },
            bar_timestamps=timestamps,
            explanation="The lifecycle is evaluated only from bars completed after range establishment.",
            method_reference="PDF pp. 57–63, 78–79",
        ),
    )


def detect_rectangle(
    bars: tuple[Bar, ...],
    pivots: tuple[Pivot, ...],
    atr_values: tuple[float | None, ...],
    relative_volume_values: tuple[float | None, ...],
    config: RectangleConfig,
    *,
    ruleset_version: str,
) -> RectangleResult:
    validate_bar_sequence(bars)
    if any(not bar.is_complete for bar in bars):
        raise ContractError("rectangle detection requires completed bars")
    if not (len(bars) == len(atr_values) == len(relative_volume_values)):
        raise ContractError("rectangle feature arrays must align with bars")

    active: RectangleDetection | None = None
    last_terminal: RectangleDetection | None = None
    search_after_index = 0
    for index in range(len(bars)):
        if active is None:
            active = _candidate_at(
                index,
                bars,
                pivots,
                atr_values,
                config,
                search_after_index,
            )
            if active is not None:
                # The bar that makes the last pivot available can also close as
                # a breakout; both facts become known at the same completed_at.
                active = _advance(
                    active,
                    index,
                    bars,
                    atr_values,
                    relative_volume_values,
                    config,
                )
                if active.lifecycle_state in TERMINAL_STATES:
                    last_terminal = active
                    search_after_index = index + 1
                    active = None
            continue
        if index <= active.established_index:
            continue
        active = _advance(
            active,
            index,
            bars,
            atr_values,
            relative_volume_values,
            config,
        )
        if active.lifecycle_state in TERMINAL_STATES:
            last_terminal = active
            search_after_index = index + 1
            active = None

    detection = active or last_terminal
    if (
        active is None
        and detection is not None
        and detection.last_event_index is not None
        and len(bars) - 1 - detection.last_event_index > config.lookback_bars
    ):
        detection = None
    return RectangleResult(
        detection=detection,
        evidence=_evidence(detection, bars, config, ruleset_version),
    )
