import type { Position, QuoteMap, ReviewAlert } from './types';

export function positionValue(position: Position, quotes: QuoteMap) {
  const price = quotes[position.symbol]?.price;
  return price === null || price === undefined ? null : position.shares * price;
}

export function portfolioMetrics(positions: Position[], quotes: QuoteMap, cashBalance: number) {
  const marketValues = positions.map((position) => positionValue(position, quotes));
  const hasAllPrices = marketValues.every((value) => value !== null);
  const investedValue = hasAllPrices
    ? marketValues.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
  const costBasis = positions.reduce((sum, position) => sum + position.shares * position.averageCost, 0);
  const hasAllDailyChanges = positions.every((position) => quotes[position.symbol]?.change !== null && quotes[position.symbol]?.change !== undefined);
  const dailyChange = hasAllDailyChanges ? positions.reduce((sum, position) => {
    const quote = quotes[position.symbol];
    return sum + (quote?.change as number) * position.shares;
  }, 0) : null;
  const totalValue = investedValue === null ? null : investedValue + cashBalance;
  const totalReturn = investedValue === null ? null : investedValue - costBasis;
  const dailyBase = totalValue !== null && dailyChange !== null ? totalValue - dailyChange : null;
  return {
    investedValue,
    costBasis,
    dailyChange,
    dailyChangePct: dailyBase ? ((dailyChange as number) / dailyBase) * 100 : dailyBase === 0 ? 0 : null,
    totalValue,
    totalReturn,
    totalReturnPct: totalReturn === null ? null : costBasis ? (totalReturn / costBasis) * 100 : 0,
    unpricedSymbols: positions.filter((position) => positionValue(position, quotes) === null).map((position) => position.symbol),
  };
}

export function portfolioHistory(positions: Position[], quotes: QuoteMap, cashBalance: number) {
  if (!positions.length) return [];
  const histories = positions.map((position) => quotes[position.symbol]?.history ?? []);
  if (histories.some((history) => !history.length)) return [];
  const sharedLength = Math.min(...histories.map((history) => history.length));
  return Array.from({ length: sharedLength }, (_, index) => positions.reduce((sum, position, positionIndex) => {
    const history = histories[positionIndex];
    const price = history[history.length - sharedLength + index];
    return sum + position.shares * price;
  }, cashBalance));
}

export function alertIsTriggered(alert: ReviewAlert, quotes: QuoteMap) {
  if (!alert.active) return false;
  const quote = quotes[alert.symbol];
  if (!quote) return false;
  if (alert.conditionType === 'Price above') return quote.price !== null && quote.price >= alert.threshold;
  if (alert.conditionType === 'Price below') return quote.price !== null && quote.price <= alert.threshold;
  if (alert.conditionType === 'Daily move above %') return quote.changePct !== null && quote.changePct >= alert.threshold;
  return quote.changePct !== null && quote.changePct <= alert.threshold;
}

export function rsiFromHistory(history: number[]) {
  if (history.length < 15) return null;
  const changes = history.slice(-15).map((value, index, values) => index === 0 ? 0 : value - values[index - 1]).slice(1);
  const gains = changes.reduce((sum, value) => sum + Math.max(value, 0), 0) / 14;
  const losses = changes.reduce((sum, value) => sum + Math.max(-value, 0), 0) / 14;
  if (!losses) return 100;
  return 100 - (100 / (1 + gains / losses));
}
