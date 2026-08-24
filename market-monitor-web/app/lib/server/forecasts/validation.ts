import { TICKER_PATTERN } from '../../tickers.ts';
import {
  FORECAST_DIRECTIONS,
  FORECAST_NOTE_KINDS,
  FORECAST_STATUSES,
  type ForecastDirection,
  type ForecastDraftInput,
  type ForecastFilters,
  type ForecastNoteKind,
  type ForecastTarget,
  type NormalizedAnalysisSnapshot,
} from './types.ts';

const DIRECTION_SET = new Set<string>(FORECAST_DIRECTIONS);
const STATUS_SET = new Set<string>(FORECAST_STATUSES);
const NOTE_KIND_SET = new Set<string>(FORECAST_NOTE_KINDS);
const DRAFT_FIELDS = new Set([
  'symbol', 'direction', 'confidence', 'thesis', 'supportingEvidence',
  'counterEvidence', 'setupTag', 'evaluationDate', 'target', 'invalidationPrice',
]);
const DRAFT_REQUEST_FIELDS = new Set([...DRAFT_FIELDS, 'analysisSeed']);
const REPORT_MAX_BYTES = 512 * 1024;
const LINKABLE_SCENARIO_STATES = new Set(['candidate', 'confirmed', 'retest']);
const EVIDENCE_STATUSES = new Set(['passed', 'failed', 'warning', 'unknown', 'not_applicable']);

export class ForecastValidationError extends Error {
  readonly fieldErrors: Record<string, string>;

  constructor(message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = 'ForecastValidationError';
    this.fieldErrors = fieldErrors;
  }
}

function object(value: unknown, message = 'Request body must be an object.'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ForecastValidationError(message);
  return value as Record<string, unknown>;
}

function rejectUnknown(values: Record<string, unknown>, allowed: Set<string>) {
  const unknown = Object.keys(values).filter((key) => !allowed.has(key));
  if (unknown.length) throw new ForecastValidationError(`Unsupported field: ${unknown[0]}.`);
}

function requiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ForecastValidationError(`${field} is required.`, { [field]: `${field} is required.` });
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    const message = `${field} must be ${maxLength} characters or fewer.`;
    throw new ForecastValidationError(message, { [field]: message });
  }
  return normalized;
}

function finiteNumber(value: unknown, field: string, minimum: number, maximum = 100_000_000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    const message = `${field} must be a finite number between ${minimum} and ${maximum}.`;
    throw new ForecastValidationError(message, { [field]: message });
  }
  return value;
}

function validDateOnly(value: unknown) {
  const date = requiredText(value, 'evaluationDate', 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new ForecastValidationError('Evaluation date must use YYYY-MM-DD.', { evaluationDate: 'Enter a valid date.' });
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new ForecastValidationError('Evaluation date is not a valid calendar date.', { evaluationDate: 'Enter a valid date.' });
  }
  return date;
}

function normalizeTarget(value: unknown): ForecastTarget {
  const target = object(value, 'Target must be an object.');
  if (target.kind === 'price') {
    rejectUnknown(target, new Set(['kind', 'price']));
    return { kind: 'price', price: finiteNumber(target.price, 'target.price', 0.000001) };
  }
  if (target.kind === 'range') {
    rejectUnknown(target, new Set(['kind', 'lower', 'upper']));
    const lower = finiteNumber(target.lower, 'target.lower', 0.000001);
    const upper = finiteNumber(target.upper, 'target.upper', 0.000001);
    if (upper <= lower) throw new ForecastValidationError('Target range upper bound must exceed its lower bound.', { target: 'Enter an increasing target range.' });
    return { kind: 'range', lower, upper };
  }
  throw new ForecastValidationError('Target kind must be price or range.', { target: 'Choose a target type.' });
}

function targetBounds(target: ForecastTarget) {
  return target.kind === 'price'
    ? { lower: target.price, upper: target.price }
    : { lower: target.lower, upper: target.upper };
}

function validateDraftGeometry(direction: ForecastDirection, target: ForecastTarget, invalidationPrice: number | null) {
  const bounds = targetBounds(target);
  if (direction === 'neutral' && target.kind !== 'range') {
    throw new ForecastValidationError('Neutral forecasts require a target range.', { target: 'Use a range for a neutral forecast.' });
  }
  if (invalidationPrice === null) return;
  const valid = direction === 'bullish'
    ? invalidationPrice < bounds.lower
    : direction === 'bearish'
      ? invalidationPrice > bounds.upper
      : invalidationPrice < bounds.lower || invalidationPrice > bounds.upper;
  if (!valid) {
    throw new ForecastValidationError('Invalidation price is inconsistent with the forecast direction and target.', {
      invalidationPrice: 'Place invalidation beyond the opposite side of the forecast target.',
    });
  }
}

export function normalizeDraftInput(value: unknown): ForecastDraftInput {
  const values = object(value);
  rejectUnknown(values, DRAFT_FIELDS);
  const symbol = requiredText(values.symbol, 'symbol', 10).toUpperCase();
  if (!TICKER_PATTERN.test(symbol)) throw new ForecastValidationError('Enter a valid ticker symbol.', { symbol: 'Enter a valid ticker symbol.' });
  const directionValue = requiredText(values.direction, 'direction', 12).toLowerCase();
  if (!DIRECTION_SET.has(directionValue)) throw new ForecastValidationError('Direction must be bullish, bearish, or neutral.', { direction: 'Choose a supported direction.' });
  const confidence = finiteNumber(values.confidence, 'confidence', 0, 100);
  if (!Number.isInteger(confidence)) throw new ForecastValidationError('Confidence must be a whole percentage.', { confidence: 'Use a whole number from 0 to 100.' });
  const target = normalizeTarget(values.target);
  const invalidationPrice = values.invalidationPrice === null || values.invalidationPrice === undefined
    ? null
    : finiteNumber(values.invalidationPrice, 'invalidationPrice', 0.000001);
  const direction = directionValue as ForecastDirection;
  validateDraftGeometry(direction, target, invalidationPrice);
  return {
    symbol,
    direction,
    confidence,
    thesis: requiredText(values.thesis, 'thesis', 4_000),
    supportingEvidence: requiredText(values.supportingEvidence, 'supportingEvidence', 6_000),
    counterEvidence: requiredText(values.counterEvidence, 'counterEvidence', 6_000),
    setupTag: requiredText(values.setupTag, 'setupTag', 80),
    evaluationDate: validDateOnly(values.evaluationDate),
    target,
    invalidationPrice,
  };
}

export function normalizeDraftRequest(
  value: unknown,
): { draft: ForecastDraftInput; analysisSeed: NormalizedAnalysisSnapshot | null | undefined } {
  const values = object(value);
  rejectUnknown(values, DRAFT_REQUEST_FIELDS);
  const draftValues = Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'analysisSeed'));
  const draft = normalizeDraftInput(draftValues);
  if (!Object.hasOwn(values, 'analysisSeed')) return { draft, analysisSeed: undefined };
  if (values.analysisSeed === null) return { draft, analysisSeed: null };
  const seed = object(values.analysisSeed, 'Analysis seed must be an object.');
  rejectUnknown(seed, new Set(['report', 'scenarioId']));
  return {
    draft,
    analysisSeed: normalizeAnalysisSnapshot(seed.report, seed.scenarioId, draft.symbol, draft.direction),
  };
}

export function normalizeForecastId(value: string) {
  if (!/^\d+$/.test(value)) throw new ForecastValidationError('Forecast ID is invalid.');
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new ForecastValidationError('Forecast ID is invalid.');
  return id;
}

export function normalizeFilters(url: URL): ForecastFilters {
  const rawStatus = url.searchParams.get('status')?.trim().toLowerCase();
  const rawSymbol = url.searchParams.get('symbol')?.trim().toUpperCase();
  const allowedParams = new Set(['status', 'symbol']);
  for (const key of url.searchParams.keys()) {
    if (!allowedParams.has(key)) throw new ForecastValidationError(`Unsupported filter: ${key}.`);
  }
  if (rawStatus && !STATUS_SET.has(rawStatus)) throw new ForecastValidationError('Choose a supported forecast status.');
  if (rawSymbol && !TICKER_PATTERN.test(rawSymbol)) throw new ForecastValidationError('Enter a valid ticker symbol.');
  return {
    status: rawStatus as ForecastFilters['status'] || undefined,
    symbol: rawSymbol || undefined,
  };
}

export function normalizeCancelReason(value: unknown) {
  const values = object(value);
  rejectUnknown(values, new Set(['reason']));
  return requiredText(values.reason, 'reason', 1_000);
}

export function normalizeNote(value: unknown): { kind: ForecastNoteKind; note: string } {
  const values = object(value);
  rejectUnknown(values, new Set(['kind', 'note']));
  const kindValue = requiredText(values.kind, 'kind', 20).toLowerCase();
  if (!NOTE_KIND_SET.has(kindValue)) throw new ForecastValidationError('Note kind must be amendment or review_note.');
  return { kind: kindValue as ForecastNoteKind, note: requiredText(values.note, 'note', 2_000) };
}

export function validateActivationGeometry(input: ForecastDraftInput, activationPrice: number) {
  const bounds = targetBounds(input.target);
  const targetValid = input.direction === 'bullish'
    ? bounds.lower > activationPrice
    : input.direction === 'bearish'
      ? bounds.upper < activationPrice
      : bounds.lower <= activationPrice && bounds.upper >= activationPrice;
  if (!targetValid) {
    throw new ForecastValidationError('Target is inconsistent with the server-verified activation price.', {
      target: 'Adjust the target so it makes directional sense from the activation price.',
    });
  }
  if (input.invalidationPrice === null) return;
  const invalidationValid = input.direction === 'bullish'
    ? input.invalidationPrice < activationPrice
    : input.direction === 'bearish'
      ? input.invalidationPrice > activationPrice
      : input.invalidationPrice < bounds.lower || input.invalidationPrice > bounds.upper;
  if (!invalidationValid) {
    throw new ForecastValidationError('Invalidation price is inconsistent with the server-verified activation price.', {
      invalidationPrice: 'Place invalidation on the opposite side of the activation price.',
    });
  }
}

export function normalizeTimeZone(value: unknown) {
  if (value === undefined || value === null || value === '') return 'UTC';
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) {
    throw new ForecastValidationError('Activation time zone is invalid.');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
  } catch {
    throw new ForecastValidationError('Activation time zone is invalid.');
  }
  return value;
}

export function calendarDateInTimeZone(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function validateEvaluationDateAtActivation(evaluationDate: string, activationDate: string) {
  if (evaluationDate < activationDate) {
    throw new ForecastValidationError('Evaluation date cannot be earlier than the activation date.', {
      evaluationDate: 'Choose today or a future calendar date.',
    });
  }
}

function strictString(record: Record<string, unknown>, field: string, maxLength = 240) {
  return requiredText(record[field], field, maxLength);
}

export function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const componentDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (componentDate.getUTCFullYear() !== year || componentDate.getUTCMonth() !== month - 1
    || componentDate.getUTCDate() !== day || componentDate.getUTCHours() !== hour
    || componentDate.getUTCMinutes() !== minute || componentDate.getUTCSeconds() !== second) return false;
  if (match[7] !== 'Z') {
    const offsetHour = Number(match[9]);
    const offsetMinute = Number(match[10]);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function strictIso(record: Record<string, unknown>, field: string) {
  const value = strictString(record, field, 64);
  if (!isCanonicalInstant(value)) throw new ForecastValidationError(`Analysis ${field} is invalid.`);
  return value;
}

function strictPositive(record: Record<string, unknown>, field: string) {
  return finiteNumber(record[field], field, 0.000001);
}

export function normalizeAnalysisSnapshot(
  value: unknown,
  scenarioIdValue: unknown,
  expectedSymbol: string,
  forecastDirection: ForecastDirection,
): NormalizedAnalysisSnapshot {
  const report = object(value, 'Analysis report must be an object.');
  const reportJson = JSON.stringify(report);
  if (new TextEncoder().encode(reportJson).byteLength > REPORT_MAX_BYTES) {
    throw new ForecastValidationError('Analysis report is too large to snapshot.');
  }
  if (strictString(report, 'symbol', 10).toUpperCase() !== expectedSymbol) throw new ForecastValidationError('Analysis report symbol does not match this forecast.');
  if (report.status !== 'scenario_detected') throw new ForecastValidationError('Only a report with a detected scenario can be linked.');
  const generatedAt = strictIso(report, 'generated_at');
  const analysisAsOf = strictIso(report, 'as_of');
  if (Date.parse(generatedAt) < Date.parse(analysisAsOf)) throw new ForecastValidationError('Analysis generation time precedes its as-of time.');
  const provider = strictString(report, 'provider', 120);
  const adjustmentMode = strictString(report, 'adjustment_mode', 80);
  const engineVersion = strictString(report, 'engine_version', 80);
  const rulesetVersion = strictString(report, 'ruleset_version', 80);
  const dataHash = strictString(report, 'data_hash', 128);
  if (!/^[a-f0-9]{64}$/i.test(dataHash)) throw new ForecastValidationError('Analysis data hash is invalid.');
  if (!Array.isArray(report.scenarios) || !Array.isArray(report.evidence) || !Array.isArray(report.warnings)) {
    throw new ForecastValidationError('Analysis report is incomplete.');
  }
  if (!report.warnings.every((warning) => typeof warning === 'string' && warning.length <= 2_000)) throw new ForecastValidationError('Analysis warnings are invalid.');
  for (const candidate of report.evidence) {
    const evidence = object(candidate, 'Analysis evidence is invalid.');
    strictString(evidence, 'rule_id', 160);
    strictString(evidence, 'category', 80);
    const status = strictString(evidence, 'status', 32);
    if (!EVIDENCE_STATUSES.has(status)) throw new ForecastValidationError('Analysis evidence status is invalid.');
    strictString(evidence, 'explanation', 2_000);
  }
  const scenarioId = typeof scenarioIdValue === 'string' ? scenarioIdValue.trim() : '';
  if (!scenarioId || scenarioId.length > 128) throw new ForecastValidationError('Choose a valid analysis scenario.');
  const rawScenario = report.scenarios.find((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    return (candidate as Record<string, unknown>).scenario_id === scenarioId;
  });
  const scenario = object(rawScenario, 'The selected analysis scenario was not found.');
  const direction = strictString(scenario, 'direction', 20);
  const lifecycleState = strictString(scenario, 'lifecycle_state', 40);
  const timeframe = strictString(scenario, 'timeframe', 20);
  if ((direction !== 'bullish' && direction !== 'bearish') || direction !== forecastDirection) {
    throw new ForecastValidationError('Analysis scenario direction must match a bullish or bearish forecast.');
  }
  if (!LINKABLE_SCENARIO_STATES.has(lifecycleState)) throw new ForecastValidationError('Only a candidate, confirmed, or retest scenario can seed an activated forecast.');
  const rangeLower = strictPositive(scenario, 'range_lower');
  const rangeUpper = strictPositive(scenario, 'range_upper');
  const rangeHeight = strictPositive(scenario, 'range_height');
  if (rangeUpper <= rangeLower) throw new ForecastValidationError('Analysis scenario range is invalid.');
  const expectedHeight = rangeUpper - rangeLower;
  if (Math.abs(rangeHeight - expectedHeight) > Math.max(0.000001, expectedHeight * 0.000001)) {
    throw new ForecastValidationError('Analysis scenario range geometry is inconsistent.');
  }
  if (!Array.isArray(scenario.warnings) || !scenario.warnings.every((warning) => typeof warning === 'string' && warning.length <= 2_000)) {
    throw new ForecastValidationError('Analysis scenario warnings are invalid.');
  }
  if (!Array.isArray(scenario.evidence_ids) || !scenario.evidence_ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 160)) {
    throw new ForecastValidationError('Analysis scenario evidence references are invalid.');
  }
  const measuredTarget = scenario.measured_target === null
    ? null
    : finiteNumber(scenario.measured_target, 'measured_target', 0.000001);
  if (measuredTarget === null) throw new ForecastValidationError('Analysis scenario has no usable measured target.');
  if ((direction === 'bullish' && measuredTarget <= rangeUpper)
    || (direction === 'bearish' && measuredTarget >= rangeLower)) {
    throw new ForecastValidationError('Analysis measured target contradicts the scenario direction and range.');
  }
  const timeframes = object(report.timeframes, 'Analysis timeframes are missing.');
  const scenarioTimeframe = object(timeframes[timeframe], 'Selected scenario timeframe is missing from the analysis report.');
  const completedBarAsOf = scenarioTimeframe.last_bar;
  if (!isCanonicalInstant(completedBarAsOf)) {
    throw new ForecastValidationError('Selected scenario completed-bar timestamp is invalid.');
  }
  if (Date.parse(completedBarAsOf) > Date.parse(analysisAsOf)) {
    throw new ForecastValidationError('Completed-bar timestamp is later than the analysis as-of time.');
  }
  return {
    generatedAt,
    analysisAsOf,
    completedBarAsOf,
    provider,
    adjustmentMode,
    engineVersion,
    rulesetVersion,
    dataHash,
    scenarioId,
    setup: strictString(scenario, 'setup', 80),
    timeframe,
    lifecycleState,
    direction,
    rangeLower,
    rangeUpper,
    rangeHeight,
    measuredTarget,
    evidence: report.evidence,
    warnings: report.warnings as string[],
    report,
  };
}
