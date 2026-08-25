import type { EvaluationEvidence, EvaluationObservation, EvaluationRequest, EvaluationResult } from './types.ts';
import { EVALUATION_KINDS, EVALUATION_RULESET_VERSION } from './types.ts';

const RESULT_KEYS = ['kind', 'reason_code', 'explanation', 'evaluator_version', 'ruleset_version', 'forecast_id', 'evaluation_cutoff', 'evaluated_through', 'input_fingerprint', 'evidence'];
const EVIDENCE_KEYS = ['activation_cutoff', 'activation_currency', 'observed_currency', 'observation_count', 'first_eligible_observation', 'last_eligible_observation', 'triggering_observation', 'target_boundary', 'target_range', 'invalidation_boundary', 'detected_at', 'observed_open', 'crossed_boundary', 'corporate_action_findings', 'coverage_findings', 'warnings'];
const OBSERVATION_KEYS = ['symbol', 'market_date', 'timestamp', 'completed_at', 'open', 'high', 'low', 'close', 'volume', 'provider', 'adjustment_mode', 'corporate_action_flags'];
const COVERAGE_KEYS = ['calendar_id', 'calendar_version', 'calendar_supported', 'market_timezone', 'expected_sessions', 'available_expected_sessions', 'future_expected_sessions', 'final_expected_session', 'horizon_available_at', 'missing_available_sessions', 'provider_complete', 'observed_currency', 'horizon_reviewable', 'coverage_complete'];
const COVERAGE_PATH_KEYS = ['observation_path_checked_through', 'observation_path_expected_sessions', 'observation_path_missing_sessions', 'observation_path_complete'];
const EVALUATOR_VERSION = 'forecast-evaluator-1.0.0';
// Phase 1 intentionally permits distant date-only horizons, while Python
// bounds elapsed retrieved history rather than the future calendar proof.
// This covers roughly forty trading years; the independent 512 KiB response
// limit remains the tighter aggregate memory boundary.
const MAX_COVERAGE_SESSION_DATES = 10_000;
const REASONS_BY_KIND = {
  no_change: new Set(['no_terminal_boundary_touched', 'horizon_not_complete']),
  target_hit: new Set(['target_boundary_touched']),
  invalidated: new Set(['invalidation_boundary_touched']),
  expired: new Set(['horizon_complete_without_terminal_touch']),
  needs_review: new Set([
    'same_bar_target_invalidation_collision',
    'insufficient_horizon_coverage',
    'insufficient_observation_path_coverage',
    'corporate_action_price_discontinuity',
    'adjustment_mode_mismatch',
    'neutral_policy_unsupported',
    'currency_mismatch',
    'currency_unverified',
  ]),
} as const;

export type EvaluationProviderFailureKind = 'timeout' | 'unavailable' | 'invalid_response';

export class EvaluationProviderError extends Error {
  readonly failureKind: EvaluationProviderFailureKind;

  constructor(message: string, failureKind: EvaluationProviderFailureKind = 'invalid_response') {
    super(message);
    this.name = 'EvaluationProviderError';
    this.failureKind = failureKind;
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvaluationProviderError(`Invalid ${label}.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new EvaluationProviderError(`Invalid ${label} fields.`);
  }
}

function string(value: unknown, label: string, max = 2_000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new EvaluationProviderError(`Invalid ${label}.`);
  return value;
}

function currency(value: unknown, label: string, nullable = false) {
  if (nullable && value === null) return null;
  const normalized = string(value, label, 12);
  if (!/^[A-Z]{3,12}$/.test(normalized)) throw new EvaluationProviderError(`Invalid ${label}.`);
  return normalized;
}

function instant(value: unknown, label: string) {
  const normalized = string(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)
    || !Number.isFinite(Date.parse(normalized))) throw new EvaluationProviderError(`Invalid ${label}.`);
  return normalized;
}

function date(value: unknown, label: string) {
  const normalized = string(value, label, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  const parsed = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!match || !parsed || parsed.getUTCFullYear() !== Number(match[1])
    || parsed.getUTCMonth() !== Number(match[2]) - 1 || parsed.getUTCDate() !== Number(match[3])) {
    throw new EvaluationProviderError(`Invalid ${label}.`);
  }
  return normalized;
}

function finite(value: unknown, label: string, nullable = true) {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new EvaluationProviderError(`Invalid ${label}.`);
  return value;
}

function strings(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length > 100 || !value.every((item) => typeof item === 'string' && item.length <= 500)) {
    throw new EvaluationProviderError(`Invalid ${label}.`);
  }
  return value as string[];
}

function observation(value: unknown, label: string): EvaluationObservation | null {
  if (value === null) return null;
  const row = object(value, label);
  exactKeys(row, OBSERVATION_KEYS, label);
  const open = finite(row.open, `${label}.open`, false) as number;
  const high = finite(row.high, `${label}.high`, false) as number;
  const low = finite(row.low, `${label}.low`, false) as number;
  const close = finite(row.close, `${label}.close`, false) as number;
  const volume = finite(row.volume, `${label}.volume`, false) as number;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0
    || low > high || open < low || open > high || close < low || close > high) {
    throw new EvaluationProviderError(`Invalid ${label} OHLC values.`);
  }
  return {
    symbol: string(row.symbol, `${label}.symbol`, 32),
    market_date: date(row.market_date, `${label}.market_date`),
    timestamp: instant(row.timestamp, `${label}.timestamp`),
    completed_at: instant(row.completed_at, `${label}.completed_at`),
    open, high, low, close, volume,
    provider: string(row.provider, `${label}.provider`, 100),
    adjustment_mode: string(row.adjustment_mode, `${label}.adjustment_mode`, 50),
    corporate_action_flags: strings(row.corporate_action_flags, `${label}.corporate_action_flags`),
  };
}

function evidence(value: unknown): EvaluationEvidence {
  const row = object(value, 'evaluation evidence');
  exactKeys(row, EVIDENCE_KEYS, 'evaluation evidence');
  const observationCount = finite(row.observation_count, 'evidence.observation_count', false) as number;
  if (!Number.isInteger(observationCount) || observationCount < 0) throw new EvaluationProviderError('Invalid evidence.observation_count.');
  const targetRange = row.target_range === null ? null : (() => {
    if (!Array.isArray(row.target_range) || row.target_range.length !== 2) throw new EvaluationProviderError('Invalid evidence.target_range.');
    const lower = finite(row.target_range[0], 'evidence.target_range[0]', false) as number;
    const upper = finite(row.target_range[1], 'evidence.target_range[1]', false) as number;
    if (lower <= 0 || upper <= lower) throw new EvaluationProviderError('Invalid evidence.target_range.');
    return [lower, upper] as [number, number];
  })();
  const detected = row.detected_at;
  if (detected !== null && detected !== 'open' && detected !== 'within_bar') throw new EvaluationProviderError('Invalid evidence.detected_at.');
  const coverage = object(row.coverage_findings, 'evidence.coverage_findings');
  const actualCoverageKeys = Object.keys(coverage).sort();
  const baseCoverageKeys = [...COVERAGE_KEYS].sort();
  const pathCoverageKeys = [...COVERAGE_KEYS, ...COVERAGE_PATH_KEYS].sort();
  const hasBaseCoverage = actualCoverageKeys.length === baseCoverageKeys.length
    && actualCoverageKeys.every((key, index) => key === baseCoverageKeys[index]);
  const hasPathCoverage = actualCoverageKeys.length === pathCoverageKeys.length
    && actualCoverageKeys.every((key, index) => key === pathCoverageKeys[index]);
  if (!hasBaseCoverage && !hasPathCoverage) throw new EvaluationProviderError('Invalid evidence.coverage_findings fields.');
  string(coverage.calendar_id, 'coverage.calendar_id', 50);
  string(coverage.calendar_version, 'coverage.calendar_version', 100);
  string(coverage.market_timezone, 'coverage.market_timezone', 100);
  instant(coverage.horizon_available_at, 'coverage.horizon_available_at');
  for (const key of ['calendar_supported', 'provider_complete', 'horizon_reviewable', 'coverage_complete']) {
    if (typeof coverage[key] !== 'boolean') throw new EvaluationProviderError(`Invalid coverage.${key}.`);
  }
  currency(coverage.observed_currency, 'coverage.observed_currency', true);
  const dateArray = (candidate: unknown, label: string) => {
    if (!Array.isArray(candidate) || candidate.length > MAX_COVERAGE_SESSION_DATES) throw new EvaluationProviderError(`Invalid ${label}.`);
    const values = candidate.map((item) => date(item, label));
    if (values.some((item, index) => index > 0 && item <= values[index - 1])) {
      throw new EvaluationProviderError(`Invalid ${label} ordering.`);
    }
    return values;
  };
  dateArray(coverage.expected_sessions, 'coverage.expected_sessions');
  dateArray(coverage.available_expected_sessions, 'coverage.available_expected_sessions');
  dateArray(coverage.future_expected_sessions, 'coverage.future_expected_sessions');
  dateArray(coverage.missing_available_sessions, 'coverage.missing_available_sessions');
  if (coverage.final_expected_session !== null) date(coverage.final_expected_session, 'coverage.final_expected_session');
  if (hasPathCoverage) {
    date(coverage.observation_path_checked_through, 'coverage.observation_path_checked_through');
    dateArray(coverage.observation_path_expected_sessions, 'coverage.observation_path_expected_sessions');
    dateArray(coverage.observation_path_missing_sessions, 'coverage.observation_path_missing_sessions');
    if (typeof coverage.observation_path_complete !== 'boolean') throw new EvaluationProviderError('Invalid coverage.observation_path_complete.');
  }
  return {
    activation_cutoff: instant(row.activation_cutoff, 'evidence.activation_cutoff'),
    activation_currency: currency(row.activation_currency, 'evidence.activation_currency') as string,
    observed_currency: currency(row.observed_currency, 'evidence.observed_currency', true),
    observation_count: observationCount,
    first_eligible_observation: observation(row.first_eligible_observation, 'first eligible observation'),
    last_eligible_observation: observation(row.last_eligible_observation, 'last eligible observation'),
    triggering_observation: observation(row.triggering_observation, 'triggering observation'),
    target_boundary: finite(row.target_boundary, 'evidence.target_boundary'),
    target_range: targetRange,
    invalidation_boundary: finite(row.invalidation_boundary, 'evidence.invalidation_boundary'),
    detected_at: detected,
    observed_open: finite(row.observed_open, 'evidence.observed_open'),
    crossed_boundary: finite(row.crossed_boundary, 'evidence.crossed_boundary'),
    corporate_action_findings: strings(row.corporate_action_findings, 'evidence.corporate_action_findings'),
    coverage_findings: coverage,
    warnings: strings(row.warnings, 'evidence.warnings'),
  };
}

export function normalizeEvaluationResult(value: unknown, request: EvaluationRequest): EvaluationResult {
  const row = object(value, 'evaluation result');
  exactKeys(row, RESULT_KEYS, 'evaluation result');
  if (!EVALUATION_KINDS.includes(row.kind as never)) throw new EvaluationProviderError('Invalid evaluation result kind.');
  const result: EvaluationResult = {
    kind: row.kind as EvaluationResult['kind'],
    reason_code: string(row.reason_code, 'reason_code', 200),
    explanation: string(row.explanation, 'explanation', 4_000),
    evaluator_version: string(row.evaluator_version, 'evaluator_version', 100),
    ruleset_version: string(row.ruleset_version, 'ruleset_version', 100),
    forecast_id: finite(row.forecast_id, 'forecast_id', false) as number,
    evaluation_cutoff: instant(row.evaluation_cutoff, 'evaluation_cutoff'),
    evaluated_through: row.evaluated_through === null ? null : date(row.evaluated_through, 'evaluated_through'),
    input_fingerprint: string(row.input_fingerprint, 'input_fingerprint', 64),
    evidence: evidence(row.evidence),
  };
  if (!Number.isInteger(result.forecast_id) || result.forecast_id !== request.forecast.forecast_id
    || result.evaluator_version !== EVALUATOR_VERSION
    || result.ruleset_version !== request.ruleset_version
    || Date.parse(result.evaluation_cutoff) !== Date.parse(request.evaluation_cutoff)
    || Date.parse(result.evidence.activation_cutoff) !== Math.max(
      Date.parse(request.forecast.activated_at),
      Date.parse(request.forecast.activation_market_data_as_of),
    )
    || !/^[a-f0-9]{64}$/.test(result.input_fingerprint)) {
    throw new EvaluationProviderError('Evaluation result does not match the request.');
  }
  const observations = [
    result.evidence.first_eligible_observation,
    result.evidence.last_eligible_observation,
    result.evidence.triggering_observation,
  ].filter((item): item is EvaluationObservation => item !== null);
  if (observations.some((item) => item.symbol !== request.forecast.symbol)) {
    throw new EvaluationProviderError('Evaluation observations do not match the request symbol.');
  }
  if (result.evidence.activation_currency !== request.forecast.currency
    || result.evidence.observed_currency !== result.evidence.coverage_findings.observed_currency) {
    throw new EvaluationProviderError('Evaluation currency evidence does not match the request.');
  }
  if (result.reason_code === 'currency_unverified' && result.evidence.observed_currency !== null) {
    throw new EvaluationProviderError('Unverified-currency evidence is contradictory.');
  }
  if (result.reason_code === 'currency_mismatch'
    && (result.evidence.observed_currency === null || result.evidence.observed_currency === request.forecast.currency)) {
    throw new EvaluationProviderError('Currency-mismatch evidence is contradictory.');
  }
  if (['currency_unverified', 'currency_mismatch'].includes(result.reason_code)
    && (result.evidence.triggering_observation !== null || result.evidence.detected_at !== null
      || result.evidence.crossed_boundary !== null || result.evidence.observed_open !== null)) {
    throw new EvaluationProviderError('Currency review evidence contains a fabricated trigger.');
  }
  if (!['currency_unverified', 'currency_mismatch'].includes(result.reason_code)
    && result.evidence.observed_currency !== request.forecast.currency) {
    throw new EvaluationProviderError('Evaluation used an unverified currency.');
  }
  if ((result.evidence.observation_count === 0)
    !== (result.evidence.first_eligible_observation === null && result.evidence.last_eligible_observation === null)) {
    throw new EvaluationProviderError('Evaluation observation summary is inconsistent.');
  }
  const first = result.evidence.first_eligible_observation;
  const last = result.evidence.last_eligible_observation;
  if ((last?.market_date ?? null) !== result.evaluated_through
    || (first && last && Date.parse(first.completed_at) > Date.parse(last.completed_at))) {
    throw new EvaluationProviderError('Evaluation through-date is inconsistent with its observations.');
  }
  const triggerCompletedAt = result.evidence.triggering_observation?.completed_at;
  if (triggerCompletedAt && first && last
    && (Date.parse(triggerCompletedAt) < Date.parse(first.completed_at)
      || Date.parse(triggerCompletedAt) > Date.parse(last.completed_at))) {
    throw new EvaluationProviderError('Triggering observation is outside the evaluated observation range.');
  }
  if (!(REASONS_BY_KIND[result.kind] as ReadonlySet<string>).has(result.reason_code)) {
    throw new EvaluationProviderError('Evaluation reason does not match its result kind.');
  }
  const expectedRange = request.forecast.target_range;
  const expectedBoundary = request.forecast.direction === 'neutral'
    ? null
    : expectedRange
      ? request.forecast.direction === 'bullish' ? expectedRange[0] : expectedRange[1]
      : request.forecast.target_price;
  if (result.evidence.target_boundary !== expectedBoundary
    || JSON.stringify(result.evidence.target_range) !== JSON.stringify(expectedRange)
    || result.evidence.invalidation_boundary !== request.forecast.invalidation_price) {
    throw new EvaluationProviderError('Evaluation evidence does not match the saved forecast terms.');
  }
  const trigger = result.evidence.triggering_observation;
  if (result.kind === 'target_hit' || result.kind === 'invalidated') {
    const expectedCrossed = result.kind === 'target_hit' ? expectedBoundary : request.forecast.invalidation_price;
    if (!trigger || !result.evidence.detected_at || expectedCrossed === null
      || result.evidence.coverage_findings.observation_path_complete !== true
      || result.evidence.crossed_boundary !== expectedCrossed) {
      throw new EvaluationProviderError('Terminal evaluation evidence is incomplete.');
    }
    const bullish = request.forecast.direction === 'bullish';
    const touched = result.kind === 'target_hit'
      ? bullish ? trigger.high >= expectedCrossed : trigger.low <= expectedCrossed
      : bullish ? trigger.low <= expectedCrossed : trigger.high >= expectedCrossed;
    const crossedAtOpen = result.kind === 'target_hit'
      ? bullish ? trigger.open >= expectedCrossed : trigger.open <= expectedCrossed
      : bullish ? trigger.open <= expectedCrossed : trigger.open >= expectedCrossed;
    const competingBoundary = result.kind === 'target_hit' ? request.forecast.invalidation_price : expectedBoundary;
    const competingTouched = competingBoundary !== null && (result.kind === 'target_hit'
      ? bullish ? trigger.low <= competingBoundary : trigger.high >= competingBoundary
      : bullish ? trigger.high >= competingBoundary : trigger.low <= competingBoundary);
    if (!touched || (result.evidence.detected_at === 'open') !== crossedAtOpen
      || (result.evidence.detected_at === 'within_bar' && competingTouched)
      || (result.evidence.detected_at === 'open' ? result.evidence.observed_open !== trigger.open : result.evidence.observed_open !== null)) {
      throw new EvaluationProviderError('Terminal evaluation evidence contradicts the triggering observation.');
    }
  }
  if (result.kind === 'expired' && (result.evidence.coverage_findings.coverage_complete !== true
    || trigger !== null || result.evidence.detected_at !== null || result.evidence.crossed_boundary !== null)) {
    throw new EvaluationProviderError('Expired evaluation lacks complete coverage evidence.');
  }
  if (result.kind === 'needs_review' && result.reason_code === 'same_bar_target_invalidation_collision') {
    if (!trigger || expectedBoundary === null || request.forecast.invalidation_price === null
      || result.evidence.detected_at !== null || result.evidence.crossed_boundary !== null
      || result.evidence.observed_open !== null) {
      throw new EvaluationProviderError('Collision evidence is incomplete.');
    }
    const bullish = request.forecast.direction === 'bullish';
    const targetTouched = bullish ? trigger.high >= expectedBoundary : trigger.low <= expectedBoundary;
    const invalidationTouched = bullish
      ? trigger.low <= request.forecast.invalidation_price
      : trigger.high >= request.forecast.invalidation_price;
    if (!targetTouched || !invalidationTouched) throw new EvaluationProviderError('Collision evidence is contradictory.');
  }
  return result;
}

function evaluationServiceUrl(configuredValue?: string) {
  const configured = configuredValue || process.env.ANALYSIS_API_URL || 'http://127.0.0.1:8502';
  const url = new URL(configured);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new EvaluationProviderError('Invalid evaluation service URL.');
  }
  return `${url.toString().replace(/\/$/, '')}/v1/evaluate`;
}

async function boundedResponseText(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new EvaluationProviderError('Evaluation provider response is too large.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new EvaluationProviderError('Evaluation provider response is too large.');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function evaluateWithPython(
  request: EvaluationRequest,
  fetcher: typeof fetch = fetch,
  timeoutSignal: AbortSignal = AbortSignal.timeout(30_000),
  serviceBaseUrl?: string,
): Promise<EvaluationResult> {
  let response: Response;
  try {
    response = await fetcher(evaluationServiceUrl(serviceBaseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(request),
      cache: 'no-store',
      redirect: 'error',
      signal: timeoutSignal,
    });
  } catch {
    throw new EvaluationProviderError(
      'Evaluation provider is unavailable.',
      timeoutSignal.aborted ? 'timeout' : 'unavailable',
    );
  }
  if (!response.ok) {
    throw new EvaluationProviderError('Evaluation provider could not evaluate this forecast.', 'unavailable');
  }
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new EvaluationProviderError('Evaluation provider returned an unsupported response.');
  }
  let text: string;
  try {
    text = await boundedResponseText(response, 512 * 1024);
  } catch (error) {
    if (error instanceof EvaluationProviderError) throw error;
    throw new EvaluationProviderError(
      'Evaluation provider response could not be read.',
      timeoutSignal.aborted ? 'timeout' : 'unavailable',
    );
  }
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { throw new EvaluationProviderError('Evaluation provider returned invalid JSON.'); }
  const envelope = object(decoded, 'evaluation response');
  exactKeys(envelope, ['result'], 'evaluation response');
  return normalizeEvaluationResult(envelope.result, request);
}

export function buildEvaluationRequest(forecast: ForecastLike, evaluationCutoff: string): EvaluationRequest {
  if (!forecast.activatedAt || !forecast.marketDataAsOf || !forecast.activationPrice || !forecast.activationCurrency) {
    throw new EvaluationProviderError('Active forecast snapshot is incomplete.');
  }
  return {
    forecast: {
      forecast_id: forecast.id,
      symbol: forecast.symbol,
      direction: forecast.direction,
      activated_at: forecast.activatedAt,
      activation_market_data_as_of: forecast.marketDataAsOf,
      activation_price: forecast.activationPrice,
      currency: forecast.activationCurrency,
      evaluation_date: forecast.evaluationDate,
      target_price: forecast.target.kind === 'price' ? forecast.target.price : null,
      target_range: forecast.target.kind === 'range' ? [forecast.target.lower, forecast.target.upper] : null,
      invalidation_price: forecast.invalidationPrice,
      adjustment_mode: 'raw',
    },
    evaluation_cutoff: evaluationCutoff,
    ruleset_version: EVALUATION_RULESET_VERSION,
  };
}

type ForecastLike = Pick<import('../forecasts/types.ts').Forecast,
  'id' | 'symbol' | 'direction' | 'activatedAt' | 'marketDataAsOf' | 'activationPrice' |
  'activationCurrency' | 'evaluationDate' | 'target' | 'invalidationPrice'>;
