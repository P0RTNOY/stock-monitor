from __future__ import annotations

import json
from dataclasses import dataclass
from math import isfinite
from pathlib import Path
from types import MappingProxyType
from typing import Any, Mapping

from analysis.contracts import AdjustmentMode, ContractError, Timeframe


@dataclass(frozen=True)
class FeatureConfig:
    atr_period: int
    relative_volume_lookback: int
    moving_average_periods: tuple[int, ...]


@dataclass(frozen=True)
class SwingConfig:
    mode: str
    left_bars: int
    right_bars: int


@dataclass(frozen=True)
class LevelConfig:
    width_atr_multiple: float
    minimum_width_percent: float
    minimum_touches: int
    maximum_zones: int


@dataclass(frozen=True)
class RectangleConfig:
    lookback_bars: int
    minimum_formation_bars: int
    minimum_touch_separation_bars: int
    minimum_touches_per_side: int
    minimum_side_alternations: int
    touch_tolerance_atr: float
    touch_tolerance_percent: float
    minimum_height_atr: float
    minimum_height_percent: float
    maximum_height_atr: float
    maximum_side_drift_fraction: float
    minimum_containment_ratio: float
    maximum_consecutive_outside_closes: int
    breakout_distance_atr: float
    breakout_distance_percent: float
    minimum_relative_volume: float
    retest_tolerance_atr: float
    retest_tolerance_percent: float
    maximum_retest_bars: int
    invalidation_buffer_atr: float
    invalidation_buffer_percent: float
    candidate_expiration_bars: int
    confirmed_expiration_bars: int


@dataclass(frozen=True)
class RiskConfig:
    execution_stop_atr_buffer: float
    minimum_reward_risk: float


@dataclass(frozen=True)
class Ruleset:
    version: str
    description: str
    market_scope: tuple[str, ...]
    provider: str
    adjustment_mode: AdjustmentMode
    timeframes: tuple[Timeframe, ...]
    minimum_bars: Mapping[str, int]
    features: FeatureConfig
    swings: SwingConfig
    levels: LevelConfig
    rectangles: RectangleConfig
    risk: RiskConfig


def _positive_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ContractError(f"{name} must be a positive integer")
    return value


def _positive_number(value: Any, name: str) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not isfinite(value)
        or value <= 0
    ):
        raise ContractError(f"{name} must be positive")
    return float(value)


def _expect_keys(payload: dict[str, Any], expected: set[str], name: str) -> None:
    actual = set(payload)
    if actual != expected:
        missing = sorted(expected - actual)
        unknown = sorted(actual - expected)
        raise ContractError(f"{name} keys mismatch; missing={missing}, unknown={unknown}")


def _non_blank_string(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ContractError(f"{name} must be a non-blank string")
    return value.strip()


def _parse_ruleset(payload: dict[str, Any]) -> Ruleset:
    _expect_keys(
        payload,
        {
            "version",
            "description",
            "market_scope",
            "provider",
            "adjustment_mode",
            "timeframes",
            "minimum_bars",
            "features",
            "swings",
            "levels",
            "rectangles",
            "risk",
        },
        "ruleset",
    )
    features = payload["features"]
    swings = payload["swings"]
    levels = payload["levels"]
    rectangles = payload["rectangles"]
    risk = payload["risk"]
    if not all(
        isinstance(item, dict)
        for item in (features, swings, levels, rectangles, risk)
    ):
        raise ContractError(
            "features, swings, levels, rectangles, and risk must be objects"
        )
    _expect_keys(
        features,
        {"atr_period", "relative_volume_lookback", "moving_average_periods"},
        "features",
    )
    _expect_keys(swings, {"mode", "left_bars", "right_bars"}, "swings")
    _expect_keys(
        levels,
        {
            "width_atr_multiple",
            "minimum_width_percent",
            "minimum_touches",
            "maximum_zones",
        },
        "levels",
    )
    _expect_keys(
        rectangles,
        {
            "lookback_bars",
            "minimum_formation_bars",
            "minimum_touch_separation_bars",
            "minimum_touches_per_side",
            "minimum_side_alternations",
            "touch_tolerance_atr",
            "touch_tolerance_percent",
            "minimum_height_atr",
            "minimum_height_percent",
            "maximum_height_atr",
            "maximum_side_drift_fraction",
            "minimum_containment_ratio",
            "maximum_consecutive_outside_closes",
            "breakout_distance_atr",
            "breakout_distance_percent",
            "minimum_relative_volume",
            "retest_tolerance_atr",
            "retest_tolerance_percent",
            "maximum_retest_bars",
            "invalidation_buffer_atr",
            "invalidation_buffer_percent",
            "candidate_expiration_bars",
            "confirmed_expiration_bars",
        },
        "rectangles",
    )
    _expect_keys(
        risk,
        {"execution_stop_atr_buffer", "minimum_reward_risk"},
        "risk",
    )
    if not isinstance(payload["timeframes"], list):
        raise ContractError("timeframes must be a list")
    timeframes = tuple(payload["timeframes"])
    if not timeframes or set(timeframes) - {"1d", "1wk"}:
        raise ContractError("ruleset timeframes must contain only 1d and 1wk")
    if len(set(timeframes)) != len(timeframes):
        raise ContractError("ruleset timeframes must be unique")
    if not all(isinstance(item, str) for item in timeframes):
        raise ContractError("timeframes must contain strings")
    if swings["mode"] != "left_right_confirmed":
        raise ContractError("ruleset-v1 supports only left_right_confirmed swings")
    adjustment_mode = payload["adjustment_mode"]
    if adjustment_mode not in {"raw", "split_adjusted", "total_return_adjusted"}:
        raise ContractError("invalid adjustment_mode")

    if not isinstance(payload["minimum_bars"], dict):
        raise ContractError("minimum_bars must be an object")
    _expect_keys(payload["minimum_bars"], set(timeframes), "minimum_bars")
    minimum_bars = {
        str(key): _positive_int(value, f"minimum_bars.{key}")
        for key, value in payload["minimum_bars"].items()
    }
    if set(timeframes) - set(minimum_bars):
        raise ContractError("minimum_bars must cover every timeframe")
    if not isinstance(features["moving_average_periods"], list):
        raise ContractError("moving-average periods must be a list")
    moving_average_periods = tuple(
        _positive_int(value, "features.moving_average_periods")
        for value in features["moving_average_periods"]
    )
    if not moving_average_periods or len(set(moving_average_periods)) != len(
        moving_average_periods
    ):
        raise ContractError("moving-average periods must be non-empty and unique")

    if not isinstance(payload["market_scope"], list) or not payload["market_scope"]:
        raise ContractError("market_scope must be a non-empty list")
    market_scope = tuple(
        _non_blank_string(item, "market_scope item") for item in payload["market_scope"]
    )
    rectangle_config = RectangleConfig(
        lookback_bars=_positive_int(rectangles["lookback_bars"], "rectangles.lookback_bars"),
        minimum_formation_bars=_positive_int(
            rectangles["minimum_formation_bars"],
            "rectangles.minimum_formation_bars",
        ),
        minimum_touch_separation_bars=_positive_int(
            rectangles["minimum_touch_separation_bars"],
            "rectangles.minimum_touch_separation_bars",
        ),
        minimum_touches_per_side=_positive_int(
            rectangles["minimum_touches_per_side"],
            "rectangles.minimum_touches_per_side",
        ),
        minimum_side_alternations=_positive_int(
            rectangles["minimum_side_alternations"],
            "rectangles.minimum_side_alternations",
        ),
        touch_tolerance_atr=_positive_number(
            rectangles["touch_tolerance_atr"],
            "rectangles.touch_tolerance_atr",
        ),
        touch_tolerance_percent=_positive_number(
            rectangles["touch_tolerance_percent"],
            "rectangles.touch_tolerance_percent",
        ),
        minimum_height_atr=_positive_number(
            rectangles["minimum_height_atr"],
            "rectangles.minimum_height_atr",
        ),
        minimum_height_percent=_positive_number(
            rectangles["minimum_height_percent"],
            "rectangles.minimum_height_percent",
        ),
        maximum_height_atr=_positive_number(
            rectangles["maximum_height_atr"],
            "rectangles.maximum_height_atr",
        ),
        maximum_side_drift_fraction=_positive_number(
            rectangles["maximum_side_drift_fraction"],
            "rectangles.maximum_side_drift_fraction",
        ),
        minimum_containment_ratio=_positive_number(
            rectangles["minimum_containment_ratio"],
            "rectangles.minimum_containment_ratio",
        ),
        maximum_consecutive_outside_closes=_positive_int(
            rectangles["maximum_consecutive_outside_closes"],
            "rectangles.maximum_consecutive_outside_closes",
        ),
        breakout_distance_atr=_positive_number(
            rectangles["breakout_distance_atr"],
            "rectangles.breakout_distance_atr",
        ),
        breakout_distance_percent=_positive_number(
            rectangles["breakout_distance_percent"],
            "rectangles.breakout_distance_percent",
        ),
        minimum_relative_volume=_positive_number(
            rectangles["minimum_relative_volume"],
            "rectangles.minimum_relative_volume",
        ),
        retest_tolerance_atr=_positive_number(
            rectangles["retest_tolerance_atr"],
            "rectangles.retest_tolerance_atr",
        ),
        retest_tolerance_percent=_positive_number(
            rectangles["retest_tolerance_percent"],
            "rectangles.retest_tolerance_percent",
        ),
        maximum_retest_bars=_positive_int(
            rectangles["maximum_retest_bars"],
            "rectangles.maximum_retest_bars",
        ),
        invalidation_buffer_atr=_positive_number(
            rectangles["invalidation_buffer_atr"],
            "rectangles.invalidation_buffer_atr",
        ),
        invalidation_buffer_percent=_positive_number(
            rectangles["invalidation_buffer_percent"],
            "rectangles.invalidation_buffer_percent",
        ),
        candidate_expiration_bars=_positive_int(
            rectangles["candidate_expiration_bars"],
            "rectangles.candidate_expiration_bars",
        ),
        confirmed_expiration_bars=_positive_int(
            rectangles["confirmed_expiration_bars"],
            "rectangles.confirmed_expiration_bars",
        ),
    )
    if rectangle_config.minimum_height_atr >= rectangle_config.maximum_height_atr:
        raise ContractError(
            "rectangles.minimum_height_atr must be lower than maximum_height_atr"
        )
    if rectangle_config.minimum_formation_bars >= rectangle_config.lookback_bars:
        raise ContractError(
            "rectangles.minimum_formation_bars must be lower than lookback_bars"
        )
    if not 0 < rectangle_config.minimum_containment_ratio <= 1:
        raise ContractError(
            "rectangles.minimum_containment_ratio must be at most 1"
        )
    return Ruleset(
        version=_non_blank_string(payload["version"], "version"),
        description=_non_blank_string(payload["description"], "description"),
        market_scope=market_scope,
        provider=_non_blank_string(payload["provider"], "provider"),
        adjustment_mode=adjustment_mode,
        timeframes=timeframes,
        minimum_bars=MappingProxyType(minimum_bars),
        features=FeatureConfig(
            atr_period=_positive_int(features["atr_period"], "features.atr_period"),
            relative_volume_lookback=_positive_int(
                features["relative_volume_lookback"],
                "features.relative_volume_lookback",
            ),
            moving_average_periods=moving_average_periods,
        ),
        swings=SwingConfig(
            mode=str(swings["mode"]),
            left_bars=_positive_int(swings["left_bars"], "swings.left_bars"),
            right_bars=_positive_int(swings["right_bars"], "swings.right_bars"),
        ),
        levels=LevelConfig(
            width_atr_multiple=_positive_number(
                levels["width_atr_multiple"], "levels.width_atr_multiple"
            ),
            minimum_width_percent=_positive_number(
                levels["minimum_width_percent"], "levels.minimum_width_percent"
            ),
            minimum_touches=_positive_int(
                levels["minimum_touches"], "levels.minimum_touches"
            ),
            maximum_zones=_positive_int(
                levels["maximum_zones"], "levels.maximum_zones"
            ),
        ),
        rectangles=rectangle_config,
        risk=RiskConfig(
            execution_stop_atr_buffer=_positive_number(
                risk["execution_stop_atr_buffer"],
                "risk.execution_stop_atr_buffer",
            ),
            minimum_reward_risk=_positive_number(
                risk["minimum_reward_risk"],
                "risk.minimum_reward_risk",
            ),
        ),
    )


def load_ruleset(version: str = "ruleset-v1") -> Ruleset:
    safe_version = version.strip()
    if safe_version != "ruleset-v1":
        raise ContractError(f"unknown ruleset version: {safe_version}")
    path = Path(__file__).with_name("config") / f"{safe_version}.json"
    try:
        with path.open(encoding="utf-8") as handle:
            payload = json.load(handle)
        if not isinstance(payload, dict):
            raise ContractError("ruleset root must be an object")
        ruleset = _parse_ruleset(payload)
    except ContractError:
        raise
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as exc:
        raise ContractError(f"invalid ruleset file ({type(exc).__name__})") from exc
    if ruleset.version != safe_version:
        raise ContractError("ruleset file version does not match its filename")
    return ruleset
