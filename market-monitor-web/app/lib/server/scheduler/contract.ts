import {
  COORDINATOR_VERSION,
  isCanonicalUtcInstant,
  type CoordinatorOutcome,
} from '../coordinator/contract.ts';

export const SCHEDULER_VERSION = 'forecast-scheduler-1.0.0';
export const SCHEDULER_DEFAULT_PAGE_SIZE = 10;
export const SCHEDULER_MAX_PAGE_SIZE = 25;
export const SCHEDULER_DEFAULT_MAX_PAGES = 3;
export const SCHEDULER_HARD_MAX_PAGES = 10;
export const SCHEDULER_DEFAULT_MAX_ITEMS = 25;
export const SCHEDULER_HARD_MAX_ITEMS = 100;
export const SCHEDULER_DEFAULT_MAX_RUNTIME_MS = 8 * 60_000;
export const SCHEDULER_HARD_MAX_RUNTIME_MS = 12 * 60_000;
export const SCHEDULER_DEFAULT_MIN_REMAINING_MS = 45_000;
export const SCHEDULER_HARD_MAX_MIN_REMAINING_MS = 2 * 60_000;
export const SCHEDULER_INVOCATION_LEASE_MS = 13 * 60_000;

export const SCHEDULER_ENVIRONMENTS = ['local', 'preview', 'staging', 'production'] as const;
export type SchedulerEnvironment = typeof SCHEDULER_ENVIRONMENTS[number];

export const SCHEDULER_PERSISTED_STATUSES = [
  'running',
  'completed',
  'partial_budget_exhausted',
  'coordinator_failure',
  'unexpected_error',
] as const;
export type SchedulerPersistedStatus = typeof SCHEDULER_PERSISTED_STATUSES[number];

export type SchedulerOperationalState =
  | 'disabled'
  | 'ready'
  | 'running'
  | 'completed'
  | 'partial_budget_exhausted'
  | 'replayed'
  | 'recovered'
  | 'configuration_error'
  | 'coordinator_failure'
  | 'unexpected_error';

export const SCHEDULER_STOP_REASONS = [
  'no_more_work',
  'max_pages_reached',
  'max_items_reached',
  'runtime_budget_reached',
  'authority_lost',
  'overlap_in_progress',
  'replayed_terminal_invocation',
  'repeated_cursor',
  'coordinator_failure',
  'unexpected_error',
] as const;
export type SchedulerStopReason = typeof SCHEDULER_STOP_REASONS[number];

export type SchedulerRawConfig = {
  enabled?: unknown;
  environment?: unknown;
  pageSize?: unknown;
  maxPages?: unknown;
  maxItems?: unknown;
  maxRuntimeMs?: unknown;
  minRemainingMs?: unknown;
  schedulerVersion?: unknown;
  coordinatorVersion?: unknown;
};

export type SchedulerConfig = {
  enabled: boolean;
  environment: SchedulerEnvironment;
  pageSize: number;
  maxPages: number;
  maxItems: number;
  maxRuntimeMs: number;
  minRemainingMs: number;
  schedulerVersion: typeof SCHEDULER_VERSION;
  coordinatorVersion: typeof COORDINATOR_VERSION;
};

export class SchedulerConfigurationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'SchedulerConfigurationError';
    this.field = field;
  }
}

function booleanValue(value: unknown) {
  if (value === undefined) return false;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new SchedulerConfigurationError('enabled', 'Scheduler enabled must be true or false.');
}

function integerValue(
  value: unknown,
  fallback: number,
  field: string,
  minimum: number,
  maximum: number,
) {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/u.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new SchedulerConfigurationError(
      field,
      `${field} must be a whole number from ${minimum} through ${maximum}.`,
    );
  }
  return parsed;
}

export function parseSchedulerConfig(raw: SchedulerRawConfig): SchedulerConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SchedulerConfigurationError('configuration', 'Scheduler configuration is invalid.');
  }
  const allowed = new Set([
    'enabled', 'environment', 'pageSize', 'maxPages', 'maxItems', 'maxRuntimeMs',
    'minRemainingMs', 'schedulerVersion', 'coordinatorVersion',
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new SchedulerConfigurationError('configuration', 'Scheduler configuration contains unknown fields.');
  }
  const environment = raw.environment ?? 'local';
  if (typeof environment !== 'string'
    || !SCHEDULER_ENVIRONMENTS.includes(environment as SchedulerEnvironment)) {
    throw new SchedulerConfigurationError(
      'environment',
      `environment must be one of ${SCHEDULER_ENVIRONMENTS.join(', ')}.`,
    );
  }
  const config: SchedulerConfig = {
    enabled: booleanValue(raw.enabled),
    environment: environment as SchedulerEnvironment,
    pageSize: integerValue(raw.pageSize, SCHEDULER_DEFAULT_PAGE_SIZE, 'pageSize', 1, SCHEDULER_MAX_PAGE_SIZE),
    maxPages: integerValue(raw.maxPages, SCHEDULER_DEFAULT_MAX_PAGES, 'maxPages', 1, SCHEDULER_HARD_MAX_PAGES),
    maxItems: integerValue(raw.maxItems, SCHEDULER_DEFAULT_MAX_ITEMS, 'maxItems', 1, SCHEDULER_HARD_MAX_ITEMS),
    maxRuntimeMs: integerValue(raw.maxRuntimeMs, SCHEDULER_DEFAULT_MAX_RUNTIME_MS, 'maxRuntimeMs', 1_000, SCHEDULER_HARD_MAX_RUNTIME_MS),
    minRemainingMs: integerValue(
      raw.minRemainingMs,
      SCHEDULER_DEFAULT_MIN_REMAINING_MS,
      'minRemainingMs',
      1_000,
      SCHEDULER_HARD_MAX_MIN_REMAINING_MS,
    ),
    schedulerVersion: (raw.schedulerVersion ?? SCHEDULER_VERSION) as typeof SCHEDULER_VERSION,
    coordinatorVersion: (raw.coordinatorVersion ?? COORDINATOR_VERSION) as typeof COORDINATOR_VERSION,
  };
  if (config.schedulerVersion !== SCHEDULER_VERSION) {
    throw new SchedulerConfigurationError('schedulerVersion', 'Configured scheduler version does not match this worker.');
  }
  if (config.coordinatorVersion !== COORDINATOR_VERSION) {
    throw new SchedulerConfigurationError('coordinatorVersion', 'Configured coordinator version does not match this worker.');
  }
  if (config.minRemainingMs >= config.maxRuntimeMs) {
    throw new SchedulerConfigurationError(
      'minRemainingMs',
      'minRemainingMs must be less than maxRuntimeMs.',
    );
  }
  return config;
}

export function scheduledTimeFromEpoch(scheduledTimeMs: number) {
  if (!Number.isSafeInteger(scheduledTimeMs) || scheduledTimeMs < 0
    || scheduledTimeMs > 8_640_000_000_000_000) {
    throw new SchedulerConfigurationError('scheduledTime', 'Scheduled event time is invalid.');
  }
  let value: string;
  try {
    value = new Date(scheduledTimeMs).toISOString();
  } catch {
    throw new SchedulerConfigurationError('scheduledTime', 'Scheduled event time is outside the supported range.');
  }
  if (!isCanonicalUtcInstant(value)) {
    throw new SchedulerConfigurationError('scheduledTime', 'Scheduled event time is outside the supported range.');
  }
  return value;
}

function exactScheduleExpression(value: string) {
  if (!value || value.trim() !== value || value.length > 100 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new SchedulerConfigurationError('scheduleExpression', 'Schedule expression is invalid.');
  }
  return value;
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  return bytesToHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
}

export async function scheduleOccurrenceKey(
  profileId: number,
  environment: SchedulerEnvironment,
  scheduleExpression: string,
  scheduledTime: string,
) {
  if (!Number.isSafeInteger(profileId) || profileId < 1) {
    throw new SchedulerConfigurationError('profileId', 'Scheduled profile is invalid.');
  }
  if (!isCanonicalUtcInstant(scheduledTime)) {
    throw new SchedulerConfigurationError('scheduledTime', 'Scheduled time must be canonical UTC.');
  }
  const canonical = JSON.stringify({
    schedulerVersion: SCHEDULER_VERSION,
    environment,
    profileId,
    scheduleExpression: exactScheduleExpression(scheduleExpression),
    scheduledTime,
  });
  return `fsched1:${await sha256(canonical)}`;
}

export function schedulePageRunKey(occurrenceKey: string, pageNumber: number) {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > SCHEDULER_HARD_MAX_PAGES) {
    throw new SchedulerConfigurationError('pageNumber', 'Scheduled page number is invalid.');
  }
  const key = `${occurrenceKey}:page:${pageNumber}`;
  if (key.length > 128) throw new SchedulerConfigurationError('occurrenceKey', 'Schedule occurrence key is too long.');
  return key;
}

export function emptyOutcomeCounts(): Partial<Record<CoordinatorOutcome, number>> {
  return {};
}

export function safePersistedConfig(config: SchedulerConfig) {
  return {
    schedulerVersion: config.schedulerVersion,
    coordinatorVersion: config.coordinatorVersion,
    pageSize: config.pageSize,
    maxPages: config.maxPages,
    maxItems: config.maxItems,
    maxRuntimeMs: config.maxRuntimeMs,
    minRemainingMs: config.minRemainingMs,
    environment: config.environment,
  };
}

export function validateSchedulerProviderUrl(value: unknown, environment: SchedulerEnvironment) {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 2_000) {
    throw new SchedulerConfigurationError('analysisApiUrl', 'Enabled scheduler provider URL is required.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SchedulerConfigurationError('analysisApiUrl', 'Enabled scheduler provider URL is invalid.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || (environment !== 'local' && url.protocol !== 'https:')
    || (environment !== 'local' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname))) {
    throw new SchedulerConfigurationError('analysisApiUrl', 'Enabled scheduler provider URL is not permitted.');
  }
  return url.toString().replace(/\/$/u, '');
}

export async function schedulerConfigFingerprint(config: SchedulerConfig) {
  return sha256(JSON.stringify(safePersistedConfig(config)));
}
