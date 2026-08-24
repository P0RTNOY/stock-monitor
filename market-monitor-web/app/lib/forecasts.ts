import type {
  AnalysisScenario,
  Forecast,
  ForecastDirection,
  ForecastSeed,
  ForecastStatus,
  ForecastTarget,
  TechnicalAnalysisReport,
} from './types';

export type ForecastStatusFilter = ForecastStatus | 'all';

export const FORECAST_STATUSES: ForecastStatus[] = [
  'draft',
  'active',
  'target_hit',
  'invalidated',
  'expired',
  'cancelled',
];

const STATUS_LABELS: Record<ForecastStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  target_hit: 'Target hit',
  invalidated: 'Invalidated',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

const ACTIVE_SCENARIO_STATES = new Set(['candidate', 'confirmed', 'retest']);

export function forecastStatusLabel(status: ForecastStatus) {
  return STATUS_LABELS[status];
}

export function todayLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function defaultEvaluationDate(date = new Date()) {
  const targetMonth = date.getMonth() + 3;
  const lastDay = new Date(date.getFullYear(), targetMonth + 1, 0).getDate();
  const evaluation = new Date(date.getFullYear(), targetMonth, Math.min(date.getDate(), lastDay));
  return todayLocalDate(evaluation);
}

export function formatLocalDate(value: string | null | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Unavailable';
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return 'Unavailable';
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatInstant(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Unavailable';
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatForecastMoney(
  value: number | null | undefined,
  currency = 'USD',
) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return value.toFixed(2);
  }
}

export function forecastTargetBounds(target: ForecastTarget) {
  return target.kind === 'price'
    ? { lower: target.price, upper: null }
    : { lower: target.lower, upper: target.upper };
}

export function forecastTargetLabel(target: ForecastTarget, currency = 'USD') {
  if (target.kind === 'price') return formatForecastMoney(target.price, currency);
  return `${formatForecastMoney(target.lower, currency)}–${formatForecastMoney(target.upper, currency)}`;
}

export function filterForecasts(
  forecasts: Forecast[],
  status: ForecastStatusFilter,
  symbol: string,
) {
  return forecasts.filter((forecast) => (
    (status === 'all' || forecast.status === status)
    && (!symbol || forecast.symbol === symbol)
  ));
}

export function groupForecasts(forecasts: Forecast[]) {
  return {
    drafts: forecasts.filter((forecast) => forecast.status === 'draft'),
    active: forecasts.filter((forecast) => forecast.status === 'active'),
    closed: forecasts.filter((forecast) => !['draft', 'active'].includes(forecast.status)),
  };
}

export function isQualifyingForecastScenario(
  report: TechnicalAnalysisReport,
  scenario: AnalysisScenario | undefined,
): scenario is AnalysisScenario & { direction: ForecastDirection; measured_target: number } {
  return report.status === 'scenario_detected'
    && Boolean(scenario)
    && (scenario?.direction === 'bullish' || scenario?.direction === 'bearish')
    && ACTIVE_SCENARIO_STATES.has(scenario?.lifecycle_state ?? '')
    && typeof scenario?.measured_target === 'number'
    && Number.isFinite(scenario.measured_target)
    && scenario.measured_target > 0;
}

export function forecastSeedFromScenario(
  report: TechnicalAnalysisReport,
  scenario: AnalysisScenario,
): ForecastSeed | null {
  if (!isQualifyingForecastScenario(report, scenario)) return null;
  return {
    symbol: report.symbol,
    direction: scenario.direction,
    setupTag: 'Rectangle',
    target: { kind: 'price', price: scenario.measured_target },
    analysisReport: report,
    analysisScenarioId: scenario.scenario_id,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isForecastTarget(value: unknown): value is ForecastTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return target.kind === 'price'
    ? isFiniteNumber(target.price)
    : target.kind === 'range'
      && isFiniteNumber(target.lower)
      && isFiniteNumber(target.upper);
}

export function isForecast(value: unknown): value is Forecast {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const forecast = value as Record<string, unknown>;
  return Number.isInteger(forecast.id)
    && typeof forecast.symbol === 'string'
    && ['bullish', 'bearish', 'neutral'].includes(String(forecast.direction))
    && FORECAST_STATUSES.includes(forecast.status as ForecastStatus)
    && isFiniteNumber(forecast.confidence)
    && typeof forecast.thesis === 'string'
    && typeof forecast.supportingEvidence === 'string'
    && typeof forecast.counterEvidence === 'string'
    && typeof forecast.setupTag === 'string'
    && typeof forecast.evaluationDate === 'string'
    && isForecastTarget(forecast.target)
    && (forecast.invalidationPrice === null || isFiniteNumber(forecast.invalidationPrice))
    && isNullableString(forecast.activatedAt)
    && (forecast.activationPrice === null || isFiniteNumber(forecast.activationPrice))
    && isNullableString(forecast.activationCurrency)
    && isNullableString(forecast.marketDataAsOf)
    && isNullableString(forecast.marketProvider)
    && isNullableString(forecast.resolvedAt)
    && isNullableString(forecast.resolutionReason)
    && typeof forecast.createdAt === 'string'
    && typeof forecast.updatedAt === 'string'
    && Array.isArray(forecast.events)
    && (forecast.pendingAnalysis === null || typeof forecast.pendingAnalysis === 'object');
}

export function normalizeFieldErrors(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
