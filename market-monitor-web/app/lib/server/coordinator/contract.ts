export const COORDINATOR_VERSION = 'forecast-coordinator-1.0.0' as const;
export const COORDINATOR_CURSOR_VERSION = 1 as const;

export const COORDINATOR_DEFAULT_LIMIT = 25;
export const COORDINATOR_MIN_LIMIT = 1;
export const COORDINATOR_MAX_LIMIT = 100;
export const COORDINATOR_MAX_SAME_CUTOFF_RETRIES = 3;
export const COORDINATOR_MAX_CURSOR_LENGTH = 4_096;

export const COORDINATOR_MODES = ['dry_run', 'execute'] as const;
export const COORDINATOR_RUN_STATUSES = [
  'running',
  'completed',
  'completed_with_errors',
  'interrupted',
  'failed_before_processing',
] as const;
export const COORDINATOR_OUTCOMES = [
  'no_change',
  'target_hit',
  'invalidated',
  'expired',
  'needs_review',
  'duplicate_or_replayed',
  'provider_unavailable',
  'provider_timeout',
  'stale_state',
  'not_active',
  'not_due',
  'claim_conflict',
  'validation_failure',
  'unexpected_error',
  'dry_run_candidate',
] as const;
export const COORDINATOR_DUE_REASONS = [
  'never_evaluated',
  'new_information_possible',
  'new_information_possible_after_no_change',
  'new_information_possible_after_needs_review',
  'horizon_may_be_complete',
  'retry_after_provider_unavailable',
  'retry_after_provider_timeout',
  'retry_after_stale_state',
  'retry_after_unexpected_error',
] as const;

export type CoordinatorMode = typeof COORDINATOR_MODES[number];
export type CoordinatorRunStatus = typeof COORDINATOR_RUN_STATUSES[number];
export type CoordinatorOutcome = typeof COORDINATOR_OUTCOMES[number];
export type CoordinatorDueReason = typeof COORDINATOR_DUE_REASONS[number];

export type CoordinatorInput = {
  profileId: number;
  cutoff: string;
  limit: number;
  cursor?: string;
  mode: CoordinatorMode;
  operatorRunKey?: string;
};

export type CoordinatorContractErrorCode =
  | 'invalid_input'
  | 'invalid_profile'
  | 'invalid_cutoff'
  | 'invalid_limit'
  | 'invalid_cursor'
  | 'invalid_mode'
  | 'invalid_operator_run_key';

export class CoordinatorContractError extends Error {
  readonly code: CoordinatorContractErrorCode;

  constructor(message: string, code: CoordinatorContractErrorCode) {
    super(message);
    this.name = 'CoordinatorContractError';
    this.code = code;
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>) {
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Accepts only the canonical persisted form, including milliseconds and UTC Z. */
export function isCanonicalUtcInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function optionalString(
  row: Record<string, unknown>,
  key: 'cursor' | 'operatorRunKey',
  maximumLength: number,
  code: CoordinatorContractErrorCode,
) {
  if (!Object.hasOwn(row, key)) return undefined;
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength || value.trim() !== value) {
    throw new CoordinatorContractError(`Invalid coordinator ${key}.`, code);
  }
  return value;
}

/**
 * Strictly normalizes the frozen Phase 2B input. The trusted profile is a
 * separate argument so adapters cannot accidentally treat input as authority.
 */
export function parseCoordinatorInput(value: unknown, trustedProfileId: number): CoordinatorInput {
  if (!isPositiveSafeInteger(trustedProfileId)) {
    throw new CoordinatorContractError('Invalid trusted coordinator profile.', 'invalid_profile');
  }
  if (!plainObject(value)) {
    throw new CoordinatorContractError('Coordinator input must be an object.', 'invalid_input');
  }
  const allowed = new Set(['profileId', 'cutoff', 'limit', 'cursor', 'mode', 'operatorRunKey']);
  if (!exactKeys(value, allowed)) {
    throw new CoordinatorContractError('Coordinator input contains unknown fields.', 'invalid_input');
  }
  if (!isPositiveSafeInteger(value.profileId) || value.profileId !== trustedProfileId) {
    throw new CoordinatorContractError('Coordinator profile does not match the trusted operator context.', 'invalid_profile');
  }
  if (!isCanonicalUtcInstant(value.cutoff)) {
    throw new CoordinatorContractError('Coordinator cutoff must be a canonical UTC instant.', 'invalid_cutoff');
  }
  if (!COORDINATOR_MODES.includes(value.mode as CoordinatorMode)) {
    throw new CoordinatorContractError('Coordinator mode must be dry_run or execute.', 'invalid_mode');
  }
  const limit = Object.hasOwn(value, 'limit') ? value.limit : COORDINATOR_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || typeof limit !== 'number'
    || limit < COORDINATOR_MIN_LIMIT || limit > COORDINATOR_MAX_LIMIT) {
    throw new CoordinatorContractError(
      `Coordinator limit must be an integer from ${COORDINATOR_MIN_LIMIT} through ${COORDINATOR_MAX_LIMIT}.`,
      'invalid_limit',
    );
  }
  const cursor = optionalString(value, 'cursor', COORDINATOR_MAX_CURSOR_LENGTH, 'invalid_cursor');
  const operatorRunKey = optionalString(value, 'operatorRunKey', 128, 'invalid_operator_run_key');
  if (operatorRunKey && /[\u0000-\u001f\u007f]/.test(operatorRunKey)) {
    throw new CoordinatorContractError('Coordinator operatorRunKey contains control characters.', 'invalid_operator_run_key');
  }
  return {
    profileId: value.profileId,
    cutoff: value.cutoff,
    limit,
    ...(cursor ? { cursor } : {}),
    mode: value.mode as CoordinatorMode,
    ...(operatorRunKey ? { operatorRunKey } : {}),
  };
}
