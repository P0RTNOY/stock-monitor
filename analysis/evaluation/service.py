from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime
from typing import Protocol
from zoneinfo import ZoneInfo

from analysis.evaluation.contracts import (
    EvaluationContractError,
    EvaluationInput,
    EvaluationResult,
    ForecastTerms,
)
from analysis.evaluation.coverage import build_exchange_coverage
from analysis.evaluation.evaluator import evaluate_forecast
from analysis.providers import (
    EvaluationMarketData,
    ProviderError,
    YahooEvaluationProvider,
)


class ObservationProvider(Protocol):
    def fetch_completed_observations(
        self,
        symbol: str,
        activation_cutoff: datetime,
        evaluation_date: date,
        cutoff: datetime,
    ) -> EvaluationMarketData: ...


PureEvaluator = Callable[[EvaluationInput], EvaluationResult]


def evaluate_forecast_with_provider(
    forecast: ForecastTerms,
    cutoff: datetime,
    ruleset_version: str,
    *,
    provider: ObservationProvider | None = None,
    evaluator: PureEvaluator = evaluate_forecast,
) -> EvaluationResult:
    """Fetch trusted observations, prove coverage, then call the pure evaluator."""

    if cutoff.tzinfo is None or cutoff.utcoffset() is None:
        raise EvaluationContractError("evaluation_cutoff must be timezone-aware")
    if cutoff < forecast.activation_cutoff:
        raise EvaluationContractError(
            "evaluation_cutoff must not precede the forecast activation cutoff"
        )

    selected_provider = provider or YahooEvaluationProvider()
    market_data = selected_provider.fetch_completed_observations(
        forecast.symbol,
        forecast.activation_cutoff,
        forecast.evaluation_date,
        cutoff,
    )
    market_zone = ZoneInfo(market_data.market_timezone)
    if forecast.evaluation_date < forecast.activation_cutoff.astimezone(
        market_zone
    ).date():
        raise EvaluationContractError(
            "evaluation_date must not precede the activation market date"
        )
    try:
        coverage = build_exchange_coverage(
            market_data.observations,
            activation_cutoff=forecast.activation_cutoff,
            evaluation_date=forecast.evaluation_date,
            cutoff=cutoff,
            calendar_id=market_data.calendar_id,
            market_timezone=market_data.market_timezone,
            observed_currency=market_data.currency,
        )
    except EvaluationContractError as exc:
        raise ProviderError("Exchange-session coverage is unavailable") from exc

    evaluation = EvaluationInput(
        forecast=forecast,
        observations=market_data.observations,
        cutoff=cutoff,
        coverage=coverage,
        ruleset_version=ruleset_version,
    )
    return evaluator(evaluation)
