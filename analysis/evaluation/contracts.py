from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date, datetime, time, timedelta, timezone
from math import isfinite
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from analysis.contracts import Bar, ContractError
from analysis.evaluation.calendar import (
    SUPPORTED_CALENDARS,
    exchange_calendar_version,
    expected_exchange_sessions,
    next_local_midnight,
)
from analysis.providers import validate_bar_sequence


Direction = Literal["bullish", "bearish", "neutral"]
DecisionKind = Literal[
    "no_change",
    "target_hit",
    "invalidated",
    "expired",
    "needs_review",
]
DetectionMode = Literal["open", "within_bar"]


class EvaluationContractError(ContractError):
    """Raised when pure forecast-evaluation input violates its contract."""


def _aware(value: datetime, field_name: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise EvaluationContractError(f"{field_name} must be timezone-aware")
    return value


def _positive(value: float, field_name: str) -> float:
    if isinstance(value, bool) or not isfinite(value) or value <= 0:
        raise EvaluationContractError(f"{field_name} must be finite and positive")
    return float(value)


def _jsonable(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_jsonable(item) for item in value]
    return value


@dataclass(frozen=True)
class ForecastTerms:
    forecast_id: int
    symbol: str
    direction: Direction
    activated_at: datetime
    activation_market_data_as_of: datetime
    activation_price: float
    currency: str
    evaluation_date: date
    target_price: float | None = None
    target_range: tuple[float, float] | None = None
    invalidation_price: float | None = None
    adjustment_mode: str = "raw"

    def __post_init__(self) -> None:
        if (
            isinstance(self.forecast_id, bool)
            or not isinstance(self.forecast_id, int)
            or self.forecast_id < 1
        ):
            raise EvaluationContractError("forecast_id must be a positive integer")
        symbol = self.symbol.strip().upper()
        if not symbol:
            raise EvaluationContractError("symbol must not be blank")
        object.__setattr__(self, "symbol", symbol)
        if self.direction not in {"bullish", "bearish", "neutral"}:
            raise EvaluationContractError("direction is unsupported")
        _aware(self.activated_at, "activated_at")
        _aware(
            self.activation_market_data_as_of,
            "activation_market_data_as_of",
        )
        _positive(self.activation_price, "activation_price")
        currency = self.currency.strip().upper()
        if not currency:
            raise EvaluationContractError("currency must not be blank")
        object.__setattr__(self, "currency", currency)
        if not isinstance(self.evaluation_date, date) or isinstance(
            self.evaluation_date, datetime
        ):
            raise EvaluationContractError("evaluation_date must be a date")
        if (self.target_price is None) == (self.target_range is None):
            raise EvaluationContractError(
                "exactly one of target_price or target_range is required"
            )
        if self.target_price is not None:
            _positive(self.target_price, "target_price")
        if self.target_range is not None:
            if len(self.target_range) != 2:
                raise EvaluationContractError("target_range requires two boundaries")
            lower = _positive(self.target_range[0], "target_range lower")
            upper = _positive(self.target_range[1], "target_range upper")
            if lower >= upper:
                raise EvaluationContractError(
                    "target_range upper must exceed lower"
                )
            object.__setattr__(self, "target_range", (lower, upper))
        if self.invalidation_price is not None:
            _positive(self.invalidation_price, "invalidation_price")
        if self.adjustment_mode != "raw":
            raise EvaluationContractError(
                "forecast adjustment_mode must be raw in ruleset v1"
            )
        self._validate_geometry()

    def _validate_geometry(self) -> None:
        lower, upper = self.target_bounds
        if self.direction == "bullish":
            if lower <= self.activation_price:
                raise EvaluationContractError(
                    "bullish target must exceed activation_price"
                )
            if (
                self.invalidation_price is not None
                and self.invalidation_price >= self.activation_price
            ):
                raise EvaluationContractError(
                    "bullish invalidation must be below activation_price"
                )
        elif self.direction == "bearish":
            if upper >= self.activation_price:
                raise EvaluationContractError(
                    "bearish target must be below activation_price"
                )
            if (
                self.invalidation_price is not None
                and self.invalidation_price <= self.activation_price
            ):
                raise EvaluationContractError(
                    "bearish invalidation must exceed activation_price"
                )
        elif not (lower <= self.activation_price <= upper):
            raise EvaluationContractError(
                "neutral target range must contain activation_price"
            )

    @property
    def activation_cutoff(self) -> datetime:
        return max(self.activated_at, self.activation_market_data_as_of)

    @property
    def target_bounds(self) -> tuple[float, float]:
        if self.target_range is not None:
            return self.target_range
        assert self.target_price is not None
        return (self.target_price, self.target_price)

    @property
    def target_entry_boundary(self) -> float:
        lower, upper = self.target_bounds
        return lower if self.direction == "bullish" else upper

    def to_dict(self) -> dict[str, Any]:
        return _jsonable(asdict(self))


@dataclass(frozen=True)
class CoverageProof:
    calendar_id: str
    calendar_version: str
    market_timezone: str
    expected_sessions: tuple[date, ...]
    final_expected_session: date | None
    horizon_available_at: datetime
    observed_currency: str | None = None
    missing_sessions: tuple[date, ...] = ()
    provider_complete: bool = True
    calendar_supported: bool = True

    def __post_init__(self) -> None:
        if not self.calendar_id.strip():
            raise EvaluationContractError("calendar_id must not be blank")
        if not self.calendar_version.strip():
            raise EvaluationContractError("calendar_version must not be blank")
        if not self.market_timezone.strip():
            raise EvaluationContractError("market_timezone must not be blank")
        try:
            ZoneInfo(self.market_timezone)
        except ZoneInfoNotFoundError as exc:
            raise EvaluationContractError(
                "market_timezone must be a valid IANA zone"
            ) from exc
        _aware(self.horizon_available_at, "horizon_available_at")
        if self.observed_currency is not None:
            observed_currency = self.observed_currency.strip().upper()
            if not observed_currency or len(observed_currency) > 12:
                raise EvaluationContractError(
                    "observed_currency must be a valid currency identifier"
                )
            object.__setattr__(self, "observed_currency", observed_currency)
        if not isinstance(self.provider_complete, bool):
            raise EvaluationContractError("provider_complete must be boolean")
        if not isinstance(self.calendar_supported, bool):
            raise EvaluationContractError("calendar_supported must be boolean")
        if not all(
            isinstance(session, date) and not isinstance(session, datetime)
            for session in self.expected_sessions
        ):
            raise EvaluationContractError("expected_sessions must contain dates")
        if tuple(sorted(set(self.expected_sessions))) != self.expected_sessions:
            raise EvaluationContractError(
                "expected_sessions must be strictly increasing and unique"
            )
        if not all(
            isinstance(session, date) and not isinstance(session, datetime)
            for session in self.missing_sessions
        ):
            raise EvaluationContractError("missing_sessions must contain dates")
        if tuple(sorted(set(self.missing_sessions))) != self.missing_sessions:
            raise EvaluationContractError(
                "missing_sessions must be strictly increasing and unique"
            )
        expected = set(self.expected_sessions)
        if not set(self.missing_sessions).issubset(expected):
            raise EvaluationContractError(
                "missing_sessions must be included in expected_sessions"
            )
        expected_final = self.expected_sessions[-1] if self.expected_sessions else None
        if self.final_expected_session != expected_final:
            raise EvaluationContractError(
                "final_expected_session must match the last expected session"
            )

    def to_dict(self) -> dict[str, Any]:
        return _jsonable(asdict(self))


@dataclass(frozen=True)
class EvaluationInput:
    forecast: ForecastTerms
    observations: tuple[Bar, ...]
    cutoff: datetime
    coverage: CoverageProof
    ruleset_version: str = "forecast-evaluation-ruleset-v1"

    def __post_init__(self) -> None:
        if not isinstance(self.forecast, ForecastTerms):
            raise EvaluationContractError("forecast must be ForecastTerms")
        _aware(self.cutoff, "cutoff")
        if self.cutoff < self.forecast.activation_cutoff:
            raise EvaluationContractError(
                "cutoff must not precede the forecast activation cutoff"
            )
        if not isinstance(self.coverage, CoverageProof):
            raise EvaluationContractError("coverage must be CoverageProof")
        if not isinstance(self.observations, tuple):
            object.__setattr__(self, "observations", tuple(self.observations))
        if not self.observations:
            raise EvaluationContractError(
                "observations must include normalized completed-bar history"
            )
        if not all(isinstance(bar, Bar) for bar in self.observations):
            raise EvaluationContractError("observations must contain Bar values")
        try:
            normalized = validate_bar_sequence(self.observations)
        except ContractError as exc:
            raise EvaluationContractError(str(exc)) from exc
        object.__setattr__(self, "observations", normalized)
        first = normalized[0]
        if first.symbol != self.forecast.symbol:
            raise EvaluationContractError(
                "observation symbol must match forecast symbol"
            )
        if first.timeframe != "1d":
            raise EvaluationContractError(
                "ruleset v1 accepts only daily observations"
            )
        if first.timezone != self.coverage.market_timezone:
            raise EvaluationContractError(
                "observation timezone must match coverage timezone"
            )
        previous_completed_at: datetime | None = None
        for bar in normalized:
            if not bar.is_complete:
                raise EvaluationContractError(
                    "observations must not include explicitly incomplete bars"
                )
            expected_completed_at = next_local_midnight(
                bar.timestamp.date(), bar.timezone
            )
            if bar.completed_at != expected_completed_at:
                raise EvaluationContractError(
                    "daily completed_at must equal the next market-local midnight"
                )
            if (
                previous_completed_at is not None
                and bar.completed_at <= previous_completed_at
            ):
                raise EvaluationContractError(
                    "completed_at values must be strictly increasing"
                )
            previous_completed_at = bar.completed_at
        self._validate_coverage()

    def _validate_coverage(self) -> None:
        proof = self.coverage
        known_calendar = proof.calendar_id in SUPPORTED_CALENDARS
        if proof.calendar_supported != known_calendar:
            raise EvaluationContractError(
                "calendar_supported contradicts the configured calendar mapping"
            )
        if not proof.calendar_supported:
            if proof.expected_sessions or proof.final_expected_session is not None:
                raise EvaluationContractError(
                    "unsupported calendars cannot assert expected sessions"
                )
            return
        if proof.calendar_version != exchange_calendar_version():
            raise EvaluationContractError(
                "calendar_version must match the installed exchange calendar"
            )
        expected_timezone = SUPPORTED_CALENDARS[proof.calendar_id]
        if proof.market_timezone != expected_timezone:
            raise EvaluationContractError(
                "coverage timezone does not match the supported calendar"
            )
        try:
            expected_sessions = expected_exchange_sessions(
                proof.calendar_id,
                self.forecast.activation_cutoff,
                self.forecast.evaluation_date,
            )
        except (KeyError, ValueError) as exc:
            raise EvaluationContractError(str(exc)) from exc
        if proof.expected_sessions != expected_sessions:
            raise EvaluationContractError(
                "expected_sessions do not match the exchange calendar horizon"
            )
        expected_horizon = (
            next_local_midnight(expected_sessions[-1], expected_timezone)
            if expected_sessions
            else datetime.combine(
                self.forecast.evaluation_date + timedelta(days=1),
                time.min,
                tzinfo=ZoneInfo(expected_timezone),
            )
        )
        if proof.horizon_available_at != expected_horizon:
            raise EvaluationContractError(
                "horizon_available_at does not match the final expected session"
            )
        observed_available = {
            bar.timestamp.date()
            for bar in self.observations
            if bar.completed_at > self.forecast.activation_cutoff
            and bar.completed_at <= self.cutoff
            and bar.timestamp.date() <= self.forecast.evaluation_date
        }
        available_expected = {
            session
            for session in expected_sessions
            if next_local_midnight(session, expected_timezone) <= self.cutoff
        }
        unexpected_eligible = observed_available - set(expected_sessions)
        if unexpected_eligible:
            raise EvaluationContractError(
                "eligible observations must correspond to expected exchange sessions"
            )
        if not set(proof.missing_sessions).issubset(available_expected):
            raise EvaluationContractError(
                "missing_sessions cannot include sessions unavailable at cutoff"
            )
        if set(proof.missing_sessions) & observed_available:
            raise EvaluationContractError(
                "missing_sessions contradict supplied completed observations"
            )


@dataclass(frozen=True)
class ObservationEvidence:
    symbol: str
    market_date: date
    timestamp: datetime
    completed_at: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float
    provider: str
    adjustment_mode: str
    corporate_action_flags: tuple[str, ...]

    @classmethod
    def from_bar(cls, bar: Bar) -> ObservationEvidence:
        return cls(
            symbol=bar.symbol,
            market_date=bar.timestamp.date(),
            timestamp=bar.timestamp,
            completed_at=bar.completed_at,
            open=bar.open,
            high=bar.high,
            low=bar.low,
            close=bar.close,
            volume=bar.volume,
            provider=bar.provider,
            adjustment_mode=bar.adjustment_mode,
            corporate_action_flags=bar.corporate_action_flags,
        )

    def to_dict(self) -> dict[str, Any]:
        return _jsonable(asdict(self))


@dataclass(frozen=True)
class EvaluationEvidence:
    activation_cutoff: datetime
    activation_currency: str
    observed_currency: str | None
    observation_count: int
    first_eligible_observation: ObservationEvidence | None
    last_eligible_observation: ObservationEvidence | None
    triggering_observation: ObservationEvidence | None
    target_boundary: float | None
    target_range: tuple[float, float] | None
    invalidation_boundary: float | None
    detected_at: DetectionMode | None
    observed_open: float | None
    crossed_boundary: float | None
    corporate_action_findings: tuple[str, ...]
    coverage_findings: dict[str, Any]
    warnings: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return _jsonable(asdict(self))


@dataclass(frozen=True)
class EvaluationResult:
    kind: DecisionKind
    reason_code: str
    explanation: str
    evaluator_version: str
    ruleset_version: str
    forecast_id: int
    evaluation_cutoff: datetime
    evaluated_through: date | None
    input_fingerprint: str
    evidence: EvaluationEvidence

    def to_dict(self) -> dict[str, Any]:
        return _jsonable(asdict(self))
