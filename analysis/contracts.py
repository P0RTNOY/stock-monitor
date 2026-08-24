from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from math import isfinite
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


Timeframe = Literal["1d", "1wk"]
AdjustmentMode = Literal["raw", "split_adjusted", "total_return_adjusted"]
EvidenceStatus = Literal["passed", "failed", "warning", "unknown", "not_applicable"]
ReportStatus = Literal["no_setup", "scenario_detected", "insufficient_data"]
LifecycleState = Literal[
    "candidate",
    "confirmed",
    "retest",
    "failed_breakout",
    "invalidated",
    "target_reached",
    "expired",
]


class ContractError(ValueError):
    """Raised when analysis input violates a domain contract."""


def _require_aware(timestamp: datetime, field_name: str) -> None:
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        raise ContractError(f"{field_name} must be timezone-aware")


def _jsonable(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


@dataclass(frozen=True)
class Bar:
    symbol: str
    timeframe: Timeframe
    timestamp: datetime
    completed_at: datetime
    timezone: str
    open: float
    high: float
    low: float
    close: float
    volume: float
    is_complete: bool
    adjustment_mode: AdjustmentMode
    provider: str
    corporate_action_flags: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        symbol = self.symbol.strip().upper()
        if not symbol:
            raise ContractError("symbol must not be blank")
        object.__setattr__(self, "symbol", symbol)
        _require_aware(self.timestamp, "timestamp")
        _require_aware(self.completed_at, "completed_at")
        if self.timeframe not in {"1d", "1wk"}:
            raise ContractError("timeframe must be 1d or 1wk")
        timezone_name = self.timezone.strip()
        if not timezone_name:
            raise ContractError("timezone must not be blank")
        try:
            market_zone = ZoneInfo(timezone_name)
        except ZoneInfoNotFoundError as exc:
            raise ContractError("timezone must be a valid IANA zone") from exc
        timestamp = self.timestamp.astimezone(market_zone)
        completed_at = self.completed_at.astimezone(market_zone)
        if completed_at < timestamp:
            raise ContractError("completed_at must not precede timestamp")
        object.__setattr__(self, "timezone", timezone_name)
        object.__setattr__(self, "timestamp", timestamp)
        object.__setattr__(self, "completed_at", completed_at)
        if not self.provider.strip():
            raise ContractError("provider must not be blank")
        if self.adjustment_mode not in {
            "raw",
            "split_adjusted",
            "total_return_adjusted",
        }:
            raise ContractError("invalid adjustment_mode")
        prices = (self.open, self.high, self.low, self.close)
        if not all(
            not isinstance(value, bool) and isfinite(value) and value > 0
            for value in prices
        ):
            raise ContractError("OHLC prices must be finite and positive")
        if self.high < max(self.open, self.close):
            raise ContractError("high must be at least open and close")
        if self.low > min(self.open, self.close):
            raise ContractError("low must be at most open and close")
        if (
            isinstance(self.volume, bool)
            or not isfinite(self.volume)
            or self.volume < 0
        ):
            raise ContractError("volume must be finite and non-negative")
        if not isinstance(self.is_complete, bool):
            raise ContractError("is_complete must be boolean")
        flags = tuple(sorted({flag.strip() for flag in self.corporate_action_flags if flag.strip()}))
        object.__setattr__(self, "corporate_action_flags", flags)

    def to_dict(self) -> dict[str, Any]:
        return _jsonable(asdict(self))


@dataclass(frozen=True)
class AnalysisRequest:
    symbol: str
    as_of: datetime
    timeframes: tuple[Timeframe, ...] = ("1wk", "1d")
    ruleset_version: str = "ruleset-v1"
    account_risk: float | None = None
    commission_per_unit: float | None = None
    expected_slippage_per_unit: float | None = None
    execution_stop_price: float | None = None

    def __post_init__(self) -> None:
        symbol = self.symbol.strip().upper()
        if not symbol:
            raise ContractError("symbol must not be blank")
        object.__setattr__(self, "symbol", symbol)
        _require_aware(self.as_of, "as_of")
        if not self.timeframes:
            raise ContractError("at least one timeframe is required")
        if len(set(self.timeframes)) != len(self.timeframes):
            raise ContractError("timeframes must be unique")
        unsupported = set(self.timeframes) - {"1d", "1wk"}
        if unsupported:
            raise ContractError(f"unsupported timeframes: {sorted(unsupported)}")
        if not self.ruleset_version.strip():
            raise ContractError("ruleset_version must not be blank")
        if self.account_risk is not None and (
            isinstance(self.account_risk, bool)
            or not isfinite(self.account_risk)
            or self.account_risk <= 0
        ):
            raise ContractError("account_risk must be finite and positive when supplied")
        for field_name, value in (
            ("commission_per_unit", self.commission_per_unit),
            ("expected_slippage_per_unit", self.expected_slippage_per_unit),
        ):
            if value is not None and (
                isinstance(value, bool) or not isfinite(value) or value < 0
            ):
                raise ContractError(f"{field_name} must be finite and non-negative")
        if self.execution_stop_price is not None and (
            isinstance(self.execution_stop_price, bool)
            or not isfinite(self.execution_stop_price)
            or self.execution_stop_price <= 0
        ):
            raise ContractError(
                "execution_stop_price must be finite and positive when supplied"
            )


@dataclass(frozen=True)
class Evidence:
    rule_id: str
    ruleset_version: str
    category: str
    status: EvidenceStatus
    explanation: str
    observed: Any = None
    threshold: Any = None
    bar_timestamps: tuple[datetime, ...] = ()
    method_reference: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return _jsonable(asdict(self))


@dataclass(frozen=True)
class Pivot:
    kind: Literal["high", "low"]
    price: float
    bar_index: int
    timestamp: datetime
    confirmation_index: int
    confirmation_timestamp: datetime


@dataclass(frozen=True)
class StructureState:
    trend: Literal["uptrend", "downtrend", "range", "insufficient_data"]
    latest_high: float | None
    previous_high: float | None
    latest_low: float | None
    previous_low: float | None
    reason: str


@dataclass(frozen=True)
class LevelZone:
    role: Literal["support", "resistance", "decision"]
    lower: float
    upper: float
    center: float
    touch_count: int
    pivot_kinds: tuple[str, ...]
    first_touch: datetime
    last_touch: datetime
    distance_from_close_pct: float


@dataclass(frozen=True)
class TimeframeAnalysis:
    timeframe: Timeframe
    bar_count: int
    first_bar: datetime | None
    last_bar: datetime | None
    atr: float | None
    relative_volume: float | None
    moving_averages: dict[str, float | None]
    pivots: tuple[Pivot, ...]
    structure: StructureState
    levels: tuple[LevelZone, ...]


@dataclass(frozen=True)
class RiskCalculation:
    entry_price: float
    execution_stop_price: float
    measured_target: float
    account_risk: float | None
    commission_per_unit: float
    expected_slippage_per_unit: float
    risk_per_unit: float
    reward_per_unit: float | None
    reward_risk_ratio: float | None
    position_size: int | None


@dataclass(frozen=True)
class Scenario:
    scenario_id: str
    setup: Literal["rectangle"]
    timeframe: Timeframe
    direction: Literal["bullish", "bearish", "undetermined"]
    lifecycle_state: LifecycleState
    range_lower: float
    range_upper: float
    range_height: float
    range_started_at: datetime
    established_at: datetime
    retested_at: datetime | None
    terminal_at: datetime | None
    last_event_at: datetime
    event_reason: str | None
    confirmation_condition: str
    confirmed_at: datetime | None
    entry_trigger: str
    entry_assumption: float | None
    analytical_invalidation: str
    measured_target: float | None
    intermediate_levels: tuple[LevelZone, ...]
    risk: RiskCalculation | None
    evidence_ids: tuple[str, ...]
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class AnalysisReport:
    symbol: str
    as_of: datetime
    generated_at: datetime
    engine_version: str
    ruleset_version: str
    provider: str
    adjustment_mode: AdjustmentMode
    data_hash: str
    status: ReportStatus
    summary: str
    timeframes: dict[str, TimeframeAnalysis]
    scenarios: tuple[Scenario, ...] = field(default_factory=tuple)
    evidence: tuple[Evidence, ...] = field(default_factory=tuple)
    warnings: tuple[str, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        return _jsonable(asdict(self))
