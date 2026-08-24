from __future__ import annotations

from datetime import datetime

from analysis.contracts import AnalysisReport, AnalysisRequest
from analysis.engine import AnalysisEngine
from analysis.providers import YahooFinanceProvider


def analyze_symbol(
    symbol: str,
    as_of: datetime,
    *,
    engine: AnalysisEngine | None = None,
    provider: YahooFinanceProvider | None = None,
    account_risk: float | None = None,
    commission_per_unit: float | None = None,
    expected_slippage_per_unit: float | None = None,
    execution_stop_price: float | None = None,
) -> AnalysisReport:
    """Fetch normalized daily bars and run the configured foundation analysis."""

    selected_engine = engine or AnalysisEngine()
    selected_provider = provider or YahooFinanceProvider()
    request = AnalysisRequest(
        symbol=symbol,
        as_of=as_of,
        timeframes=selected_engine.ruleset.timeframes,
        ruleset_version=selected_engine.ruleset.version,
        account_risk=account_risk,
        commission_per_unit=commission_per_unit,
        expected_slippage_per_unit=expected_slippage_per_unit,
        execution_stop_price=execution_stop_price,
    )
    daily_bars = selected_provider.fetch_daily_bars(request.symbol, request.as_of)
    return selected_engine.analyze(request, daily_bars)
