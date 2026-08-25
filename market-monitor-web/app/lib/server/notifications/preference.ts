import { Temporal } from '@js-temporal/polyfill';
import { isCanonicalUtcInstant } from '../coordinator/contract.ts';
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from './types.ts';

export const NOTIFICATION_PREFERENCE_SCHEMA_VERSION = 'forecast-notification-preferences-1.0.0' as const;

export type NotificationCategoryPreferences = Record<NotificationCategory, boolean>;

export type NotificationQuietHoursPreference = {
  start: string;
  end: string;
};

export type NotificationPreferenceSnapshot = {
  profileId: number;
  schemaVersion: typeof NOTIFICATION_PREFERENCE_SCHEMA_VERSION;
  revision: number;
  masterConsent: boolean;
  categories: NotificationCategoryPreferences;
  timeZone: string;
  quietHours: NotificationQuietHoursPreference | null;
  createdAt: string;
  updatedAt: string;
};

export type NotificationPreferenceValidationCode =
  | 'invalid_input'
  | 'invalid_profile'
  | 'invalid_version'
  | 'invalid_revision'
  | 'invalid_consent'
  | 'invalid_categories'
  | 'invalid_timezone'
  | 'invalid_quiet_hours'
  | 'invalid_timestamp';

export class NotificationPreferenceValidationError extends Error {
  readonly code: NotificationPreferenceValidationCode;

  constructor(message: string, code: NotificationPreferenceValidationCode) {
    super(message);
    this.name = 'NotificationPreferenceValidationError';
    this.code = code;
  }
}

const PREFERENCE_KEYS = new Set([
  'profileId',
  'schemaVersion',
  'revision',
  'masterConsent',
  'categories',
  'timeZone',
  'quietHours',
  'createdAt',
  'updatedAt',
]);
const QUIET_HOURS_KEYS = new Set(['start', 'end']);
const CATEGORY_KEYS = new Set<string>(NOTIFICATION_CATEGORIES);
const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const TIME_ZONE_PATTERN = /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/u;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>) {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

export function isCanonicalNotificationInstant(value: unknown): value is string {
  return isCanonicalUtcInstant(value);
}

/**
 * Validates a named timezone using the Temporal implementation's IANA data.
 * Offset strings are deliberately excluded: preferences must retain a zone
 * whose future daylight-saving rules can be evaluated.
 */
export function isValidIanaTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64
    || value.trim() !== value || !TIME_ZONE_PATTERN.test(value)) return false;
  try {
    Temporal.ZonedDateTime.from({
      timeZone: value,
      year: 2000,
      month: 1,
      day: 1,
      hour: 0,
    });
    return true;
  } catch {
    return false;
  }
}

export function isNotificationLocalTime(value: unknown): value is string {
  return typeof value === 'string' && LOCAL_TIME_PATTERN.test(value);
}

export function normalizeNotificationQuietHours(value: unknown): NotificationQuietHoursPreference | null {
  if (value === null) return null;
  if (!plainObject(value) || !hasExactKeys(value, QUIET_HOURS_KEYS)
    || !isNotificationLocalTime(value.start) || !isNotificationLocalTime(value.end)
    || value.start === value.end) {
    throw new NotificationPreferenceValidationError(
      'Notification quiet hours must contain distinct canonical HH:mm start and end times.',
      'invalid_quiet_hours',
    );
  }
  return { start: value.start, end: value.end };
}

function normalizeCategories(value: unknown): NotificationCategoryPreferences {
  if (!plainObject(value) || !hasExactKeys(value, CATEGORY_KEYS)) {
    throw new NotificationPreferenceValidationError(
      'Notification category preferences are incomplete or contain unknown categories.',
      'invalid_categories',
    );
  }
  for (const category of NOTIFICATION_CATEGORIES) {
    if (typeof value[category] !== 'boolean') {
      throw new NotificationPreferenceValidationError(
        'Notification category preferences must be boolean.',
        'invalid_categories',
      );
    }
  }
  return Object.fromEntries(
    NOTIFICATION_CATEGORIES.map((category) => [category, value[category]]),
  ) as NotificationCategoryPreferences;
}

/** Strictly validates the immutable preference snapshot used by policy. */
export function normalizeNotificationPreferenceSnapshot(value: unknown): NotificationPreferenceSnapshot {
  if (!plainObject(value) || !hasExactKeys(value, PREFERENCE_KEYS)) {
    throw new NotificationPreferenceValidationError(
      'Notification preference snapshot is invalid or contains unknown fields.',
      'invalid_input',
    );
  }
  if (!Number.isSafeInteger(value.profileId) || typeof value.profileId !== 'number' || value.profileId <= 0) {
    throw new NotificationPreferenceValidationError('Notification profile is invalid.', 'invalid_profile');
  }
  if (value.schemaVersion !== NOTIFICATION_PREFERENCE_SCHEMA_VERSION) {
    throw new NotificationPreferenceValidationError('Notification preference version is unsupported.', 'invalid_version');
  }
  if (!Number.isSafeInteger(value.revision) || typeof value.revision !== 'number' || value.revision <= 0) {
    throw new NotificationPreferenceValidationError('Notification preference revision is invalid.', 'invalid_revision');
  }
  if (typeof value.masterConsent !== 'boolean') {
    throw new NotificationPreferenceValidationError('Notification consent must be boolean.', 'invalid_consent');
  }
  if (!isValidIanaTimeZone(value.timeZone)) {
    throw new NotificationPreferenceValidationError('Notification timezone is not a valid IANA timezone.', 'invalid_timezone');
  }
  if (!isCanonicalNotificationInstant(value.createdAt) || !isCanonicalNotificationInstant(value.updatedAt)
    || value.updatedAt < value.createdAt) {
    throw new NotificationPreferenceValidationError('Notification preference timestamps are invalid.', 'invalid_timestamp');
  }
  return {
    profileId: value.profileId,
    schemaVersion: NOTIFICATION_PREFERENCE_SCHEMA_VERSION,
    revision: value.revision,
    masterConsent: value.masterConsent,
    categories: normalizeCategories(value.categories),
    timeZone: value.timeZone,
    quietHours: normalizeNotificationQuietHours(value.quietHours),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
