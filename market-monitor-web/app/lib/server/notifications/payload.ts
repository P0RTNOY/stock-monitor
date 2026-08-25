import { TICKER_PATTERN } from '../../tickers.ts';
import { isCanonicalUtcInstant, isDateOnly, isPositiveSafeInteger } from '../coordinator/contract.ts';
import {
  NOTIFICATION_DEDUP_VERSION,
  NOTIFICATION_PAYLOAD_SCHEMA_VERSION,
  NOTIFICATION_PROJECTOR_VERSION,
  NotificationContractError,
} from './contract.ts';
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationPayload,
  type NotificationTargetRange,
  type TrustedNotificationSourceRow,
} from './types.ts';

const MAX_EVIDENCE_JSON_LENGTH = 512 * 1_024;
const MAX_REASON_CODE_LENGTH = 200;
const MAX_VERSION_LENGTH = 100;
const MAX_PRICE_VALUE = 100_000_000;
const PAYLOAD_KEYS = [
  'payloadVersion', 'profileId', 'forecastId', 'evaluationRunId', 'reviewItemId',
  'category', 'previousStatus', 'resultingStatus', 'symbol', 'reasonCode',
  'evaluatedThrough', 'triggeringMarketDate', 'occurredAt', 'evaluationCutoff',
  'targetBoundary', 'targetRange', 'invalidationBoundary', 'detectedAt',
  'crossedBoundary', 'activationCurrency', 'observedCurrency', 'analysisSnapshotId',
  'evaluatorVersion', 'rulesetVersion',
] as const;

type MinimalEvidence = {
  activationCurrency: string;
  observedCurrency: string | null;
  triggeringMarketDate: string | null;
  targetBoundary: number | null;
  targetRange: NotificationTargetRange | null;
  invalidationBoundary: number | null;
  detectedAt: 'open' | 'within_bar' | null;
  crossedBoundary: number | null;
};

function sourceError(message: string): never {
  throw new NotificationContractError(message, 'invalid_source');
}

function payloadError(message: string): never {
  throw new NotificationContractError(message, 'invalid_payload');
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedText(value: unknown, maximum: number) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function currency(value: unknown, nullable: boolean): string | null {
  if (nullable && value === null) return null;
  return typeof value === 'string' && /^[A-Z]{3,12}$/u.test(value) ? value : sourceError('Invalid source currency.');
}

function price(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_PRICE_VALUE) {
    return sourceError('Invalid source price evidence.');
  }
  return value;
}

function targetRange(value: unknown): NotificationTargetRange | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 2) return sourceError('Invalid source target range.');
  const lower = price(value[0]);
  const upper = price(value[1]);
  if (lower === null || upper === null || upper <= lower) return sourceError('Invalid source target range.');
  return [lower, upper] as const;
}

function parseMinimalEvidence(evidenceJson: string): MinimalEvidence {
  if (!evidenceJson || evidenceJson.length > MAX_EVIDENCE_JSON_LENGTH) {
    return sourceError('Source evaluation evidence is missing or too large.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(evidenceJson) as unknown;
  } catch {
    return sourceError('Source evaluation evidence is not valid JSON.');
  }
  const evidence = record(parsed);
  if (!evidence) return sourceError('Source evaluation evidence must be an object.');
  const triggering = evidence.triggering_observation === null
    ? null
    : record(evidence.triggering_observation);
  if (evidence.triggering_observation !== null && !triggering) {
    return sourceError('Source triggering observation is invalid.');
  }
  const triggeringMarketDate = triggering?.market_date ?? null;
  if (triggeringMarketDate !== null && !isDateOnly(triggeringMarketDate)) {
    return sourceError('Source triggering market date is invalid.');
  }
  const detectedAt = evidence.detected_at;
  if (detectedAt !== null && detectedAt !== 'open' && detectedAt !== 'within_bar') {
    return sourceError('Source detection mode is invalid.');
  }
  return {
    activationCurrency: currency(evidence.activation_currency, false) as string,
    observedCurrency: currency(evidence.observed_currency, true),
    triggeringMarketDate,
    targetBoundary: price(evidence.target_boundary),
    targetRange: targetRange(evidence.target_range),
    invalidationBoundary: price(evidence.invalidation_boundary),
    detectedAt,
    crossedBoundary: price(evidence.crossed_boundary),
  };
}

function validateSourceIdentity(source: TrustedNotificationSourceRow) {
  if (!isPositiveSafeInteger(source.profileId) || !isPositiveSafeInteger(source.forecastId)
    || !isPositiveSafeInteger(source.evaluationRunId) || !isPositiveSafeInteger(source.reviewItemId)
    || (source.analysisSnapshotId !== null && !isPositiveSafeInteger(source.analysisSnapshotId))) {
    sourceError('Source notification identifiers are invalid.');
  }
  if (!NOTIFICATION_CATEGORIES.includes(source.resultKind as NotificationCategory)) {
    sourceError('Source evaluation result is not notification-eligible.');
  }
  const category = source.resultKind as NotificationCategory;
  const expectedReviewKind = category === 'needs_review' ? 'needs_review' : 'resolved';
  if (source.reviewKind !== expectedReviewKind) sourceError('Source review item does not match its evaluation result.');
  if (!TICKER_PATTERN.test(source.symbol)) sourceError('Source notification symbol is invalid.');
  if (!boundedText(source.reasonCode, MAX_REASON_CODE_LENGTH) || !/^[a-z0-9_]+$/u.test(source.reasonCode)) {
    sourceError('Source notification reason code is invalid.');
  }
  if (!boundedText(source.evaluatorVersion, MAX_VERSION_LENGTH)
    || !boundedText(source.rulesetVersion, MAX_VERSION_LENGTH)) {
    sourceError('Source evaluation versions are invalid.');
  }
  if (!isCanonicalUtcInstant(source.createdAt) || !isCanonicalUtcInstant(source.evaluationCutoff)) {
    sourceError('Source evaluation timestamps are invalid.');
  }
  if (source.evaluatedThrough !== null && !isDateOnly(source.evaluatedThrough)) {
    sourceError('Source evaluated-through date is invalid.');
  }
  return category;
}

function assertCategoryEvidence(
  category: NotificationCategory,
  evaluatedThrough: string | null,
  evidence: MinimalEvidence,
) {
  if (category === 'target_hit' && (evidence.triggeringMarketDate === null
    || evidence.targetBoundary === null || evidence.detectedAt === null
    || evidence.crossedBoundary !== evidence.targetBoundary)) {
    sourceError('Target-hit source evidence is incomplete.');
  }
  if (category === 'invalidated' && (evidence.triggeringMarketDate === null
    || evidence.invalidationBoundary === null || evidence.detectedAt === null
    || evidence.crossedBoundary !== evidence.invalidationBoundary)) {
    sourceError('Invalidated source evidence is incomplete.');
  }
  if (category === 'expired' && (evaluatedThrough === null
    || evidence.triggeringMarketDate !== null || evidence.detectedAt !== null
    || evidence.crossedBoundary !== null)) {
    sourceError('Expired source evidence is inconsistent.');
  }
}

export function materializeNotificationPayload(source: TrustedNotificationSourceRow): NotificationPayload {
  const category = validateSourceIdentity(source);
  const evidence = parseMinimalEvidence(source.evidenceJson);
  assertCategoryEvidence(category, source.evaluatedThrough, evidence);
  return {
    payloadVersion: NOTIFICATION_PAYLOAD_SCHEMA_VERSION,
    profileId: source.profileId,
    forecastId: source.forecastId,
    evaluationRunId: source.evaluationRunId,
    reviewItemId: source.reviewItemId,
    category,
    previousStatus: 'active',
    resultingStatus: category === 'needs_review' ? 'active' : category,
    symbol: source.symbol,
    reasonCode: source.reasonCode,
    evaluatedThrough: source.evaluatedThrough,
    triggeringMarketDate: evidence.triggeringMarketDate,
    occurredAt: source.createdAt,
    evaluationCutoff: source.evaluationCutoff,
    targetBoundary: evidence.targetBoundary,
    targetRange: evidence.targetRange,
    invalidationBoundary: evidence.invalidationBoundary,
    detectedAt: evidence.detectedAt,
    crossedBoundary: evidence.crossedBoundary,
    activationCurrency: evidence.activationCurrency,
    observedCurrency: evidence.observedCurrency,
    analysisSnapshotId: source.analysisSnapshotId,
    evaluatorVersion: source.evaluatorVersion,
    rulesetVersion: source.rulesetVersion,
  };
}

export function parseNotificationPayload(value: unknown): NotificationPayload {
  const row = record(value);
  if (!row || !exactKeys(row, PAYLOAD_KEYS)) payloadError('Invalid notification payload fields.');
  if (row.payloadVersion !== NOTIFICATION_PAYLOAD_SCHEMA_VERSION
    || !isPositiveSafeInteger(row.profileId) || !isPositiveSafeInteger(row.forecastId)
    || !isPositiveSafeInteger(row.evaluationRunId) || !isPositiveSafeInteger(row.reviewItemId)
    || !NOTIFICATION_CATEGORIES.includes(row.category as NotificationCategory)
    || row.previousStatus !== 'active'
    || !TICKER_PATTERN.test(typeof row.symbol === 'string' ? row.symbol : '')
    || !boundedText(row.reasonCode, MAX_REASON_CODE_LENGTH)
    || !/^[a-z0-9_]+$/u.test(row.reasonCode as string)
    || !isCanonicalUtcInstant(row.occurredAt) || !isCanonicalUtcInstant(row.evaluationCutoff)
    || (row.evaluatedThrough !== null && !isDateOnly(row.evaluatedThrough))
    || (row.triggeringMarketDate !== null && !isDateOnly(row.triggeringMarketDate))
    || (row.analysisSnapshotId !== null && !isPositiveSafeInteger(row.analysisSnapshotId))
    || !boundedText(row.evaluatorVersion, MAX_VERSION_LENGTH)
    || !boundedText(row.rulesetVersion, MAX_VERSION_LENGTH)) {
    payloadError('Notification payload is invalid.');
  }
  const category = row.category as NotificationCategory;
  const expectedStatus = category === 'needs_review' ? 'active' : category;
  if (row.resultingStatus !== expectedStatus) payloadError('Notification payload lifecycle transition is invalid.');
  let evidence: MinimalEvidence;
  try {
    evidence = {
      activationCurrency: currency(row.activationCurrency, false) as string,
      observedCurrency: currency(row.observedCurrency, true),
      triggeringMarketDate: row.triggeringMarketDate as string | null,
      targetBoundary: price(row.targetBoundary),
      targetRange: targetRange(row.targetRange),
      invalidationBoundary: price(row.invalidationBoundary),
      detectedAt: row.detectedAt as MinimalEvidence['detectedAt'],
      crossedBoundary: price(row.crossedBoundary),
    };
    if (row.detectedAt !== null && row.detectedAt !== 'open' && row.detectedAt !== 'within_bar') {
      payloadError('Notification payload detection mode is invalid.');
    }
    assertCategoryEvidence(category, row.evaluatedThrough as string | null, evidence);
  } catch {
    payloadError('Notification payload category evidence is invalid.');
  }
  return {
    payloadVersion: NOTIFICATION_PAYLOAD_SCHEMA_VERSION,
    profileId: row.profileId,
    forecastId: row.forecastId,
    evaluationRunId: row.evaluationRunId,
    reviewItemId: row.reviewItemId,
    category,
    previousStatus: 'active',
    resultingStatus: expectedStatus,
    symbol: row.symbol as string,
    reasonCode: row.reasonCode as string,
    evaluatedThrough: row.evaluatedThrough as string | null,
    triggeringMarketDate: row.triggeringMarketDate as string | null,
    occurredAt: row.occurredAt,
    evaluationCutoff: row.evaluationCutoff,
    targetBoundary: evidence.targetBoundary,
    targetRange: evidence.targetRange,
    invalidationBoundary: evidence.invalidationBoundary,
    detectedAt: evidence.detectedAt,
    crossedBoundary: evidence.crossedBoundary,
    activationCurrency: evidence.activationCurrency,
    observedCurrency: evidence.observedCurrency,
    analysisSnapshotId: row.analysisSnapshotId,
    evaluatorVersion: row.evaluatorVersion as string,
    rulesetVersion: row.rulesetVersion as string,
  };
}

export function canonicalNotificationPayloadJson(value: unknown) {
  const payload = parseNotificationPayload(value);
  return JSON.stringify({
    payloadVersion: payload.payloadVersion,
    profileId: payload.profileId,
    forecastId: payload.forecastId,
    evaluationRunId: payload.evaluationRunId,
    reviewItemId: payload.reviewItemId,
    category: payload.category,
    previousStatus: payload.previousStatus,
    resultingStatus: payload.resultingStatus,
    symbol: payload.symbol,
    reasonCode: payload.reasonCode,
    evaluatedThrough: payload.evaluatedThrough,
    triggeringMarketDate: payload.triggeringMarketDate,
    occurredAt: payload.occurredAt,
    evaluationCutoff: payload.evaluationCutoff,
    targetBoundary: payload.targetBoundary,
    targetRange: payload.targetRange,
    invalidationBoundary: payload.invalidationBoundary,
    detectedAt: payload.detectedAt,
    crossedBoundary: payload.crossedBoundary,
    activationCurrency: payload.activationCurrency,
    observedCurrency: payload.observedCurrency,
    analysisSnapshotId: payload.analysisSnapshotId,
    evaluatorVersion: payload.evaluatorVersion,
    rulesetVersion: payload.rulesetVersion,
  });
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  return bytesToHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
}

function canonicalSourceIdentity(payload: NotificationPayload) {
  return JSON.stringify({
    dedupVersion: NOTIFICATION_DEDUP_VERSION,
    projectorVersion: NOTIFICATION_PROJECTOR_VERSION,
    payloadVersion: NOTIFICATION_PAYLOAD_SCHEMA_VERSION,
    profileId: payload.profileId,
    evaluationRunId: payload.evaluationRunId,
    category: payload.category,
  });
}

export async function notificationSourceDedupKey(value: unknown) {
  const payload = parseNotificationPayload(value);
  return sha256(canonicalSourceIdentity(payload));
}

export async function notificationIntentId(value: unknown) {
  const payload = parseNotificationPayload(value);
  const dedupKey = await sha256(canonicalSourceIdentity(payload));
  return sha256(JSON.stringify({ domain: 'notification_intent', dedupKey }));
}

export async function notificationPayloadFingerprint(value: unknown) {
  return sha256(canonicalNotificationPayloadJson(value));
}
