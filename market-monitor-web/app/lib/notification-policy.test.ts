import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NOTIFICATION_POLICY_VERSION,
  NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
  NOTIFICATION_RETRY_POLICY_VERSION,
} from './server/notifications/contract.ts';
import {
  NOTIFICATION_PREFERENCE_SCHEMA_VERSION,
  NotificationPreferenceValidationError,
  isCanonicalNotificationInstant,
  isNotificationLocalTime,
  isValidIanaTimeZone,
  normalizeNotificationPreferenceSnapshot,
  normalizeNotificationQuietHours,
  type NotificationPreferenceSnapshot,
} from './server/notifications/preference.ts';
import { evaluateNotificationPolicy } from './server/notifications/policy.ts';
import { evaluateQuietHours } from './server/notifications/quiet-hours.ts';
import {
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_RETRY_DELAYS_MS,
  NotificationRetryPolicyError,
  calculateNotificationRetry,
} from './server/notifications/retry.ts';

const decisionAt = '2026-08-25T06:30:00.000Z';

function preferences(overrides: Partial<NotificationPreferenceSnapshot> = {}): NotificationPreferenceSnapshot {
  return {
    profileId: 1,
    schemaVersion: NOTIFICATION_PREFERENCE_SCHEMA_VERSION,
    revision: 1,
    masterConsent: true,
    categories: {
      target_hit: true,
      invalidated: true,
      expired: true,
      needs_review: true,
    },
    timeZone: 'UTC',
    quietHours: null,
    createdAt: '2026-08-25T06:00:00.000Z',
    updatedAt: '2026-08-25T06:00:00.000Z',
    ...overrides,
  };
}

function policy(overrides: Record<string, unknown> = {}) {
  return evaluateNotificationPolicy({
    policyVersion: NOTIFICATION_POLICY_VERSION,
    decisionAt,
    trustedProfileId: 1,
    category: 'target_hit',
    sourceValid: true,
    historicalCutoverSuppressed: false,
    preferences: preferences(),
    ...overrides,
  });
}

test('preference snapshot validation is strict, versioned, and profile scoped', () => {
  assert.deepEqual(normalizeNotificationPreferenceSnapshot(preferences()), preferences());
  assert.equal(isCanonicalNotificationInstant(decisionAt), true);
  assert.equal(isCanonicalNotificationInstant('2026-08-25T06:30:00Z'), false);
  assert.equal(isNotificationLocalTime('09:05'), true);
  assert.equal(isNotificationLocalTime('9:05'), false);
  assert.equal(isValidIanaTimeZone('America/New_York'), true);
  assert.equal(isValidIanaTimeZone('Mars/Olympus'), false);

  for (const [value, code] of [
    [{ ...preferences(), extra: true }, 'invalid_input'],
    [{ ...preferences(), profileId: 0 }, 'invalid_profile'],
    [{ ...preferences(), schemaVersion: 'future' }, 'invalid_version'],
    [{ ...preferences(), revision: 0 }, 'invalid_revision'],
    [{ ...preferences(), masterConsent: 'yes' }, 'invalid_consent'],
    [{ ...preferences(), categories: { target_hit: true } }, 'invalid_categories'],
    [{ ...preferences(), timeZone: 'UTC+02:00' }, 'invalid_timezone'],
    [{ ...preferences(), quietHours: { start: '22:00', end: '22:00' } }, 'invalid_quiet_hours'],
    [{ ...preferences(), updatedAt: '2026-08-25T05:59:59.999Z' }, 'invalid_timestamp'],
  ] as const) {
    assert.throws(() => normalizeNotificationPreferenceSnapshot(value), (error: unknown) => (
      error instanceof NotificationPreferenceValidationError && error.code === code
    ));
  }
});

test('quiet-hours preference syntax rejects ambiguous or malformed configurations', () => {
  assert.deepEqual(normalizeNotificationQuietHours({ start: '22:00', end: '07:00' }), {
    start: '22:00', end: '07:00',
  });
  assert.equal(normalizeNotificationQuietHours(null), null);
  for (const value of [
    undefined, {}, { start: '9:00', end: '17:00' }, { start: '24:00', end: '07:00' },
    { start: '22:00', end: '22:00' }, { start: '22:00', end: '07:00', seconds: true },
  ]) assert.throws(() => normalizeNotificationQuietHours(value), NotificationPreferenceValidationError);
});

test('policy defaults fail closed and preserves the materialization-time preference revision', () => {
  assert.deepEqual(policy({ preferences: null }), {
    policyVersion: NOTIFICATION_POLICY_VERSION,
    preferenceRevision: null,
    decision: 'suppressed_no_consent',
    reason: 'notification_preferences_are_missing',
    decidedAt: decisionAt,
    initialOutboxState: 'suppressed',
    earliestEligibleAt: null,
    outboxAvailableAt: null,
    warnings: [],
  });
  assert.equal(policy({ preferences: preferences({ masterConsent: false, revision: 2 }) }).decision,
    'suppressed_no_consent');
  const categoryDisabled = policy({ preferences: preferences({
    revision: 3,
    categories: { ...preferences().categories, target_hit: false },
  }) });
  assert.equal(categoryDisabled.decision, 'suppressed_category_disabled');
  assert.equal(categoryDisabled.preferenceRevision, 3);
  const eligible = policy({ preferences: preferences({ revision: 4 }) });
  assert.equal(eligible.decision, 'eligible');
  assert.equal(eligible.preferenceRevision, 4);
  assert.equal(eligible.initialOutboxState, 'pending');
  assert.equal(eligible.earliestEligibleAt, null);
  assert.equal(eligible.outboxAvailableAt, decisionAt);
});

test('policy suppresses unsupported, historical, invalid-source, and invalid-preference inputs', () => {
  assert.equal(policy({ category: 'no_change' }).decision, 'suppressed_unsupported_category');
  assert.equal(policy({ historicalCutoverSuppressed: true }).decision, 'suppressed_historical_cutover');
  assert.equal(policy({ sourceValid: false }).decision, 'invalid_source_needs_review');
  assert.equal(policy({ policyVersion: 'future' }).decision, 'invalid_source_needs_review');
  assert.equal(policy({ preferences: { ...preferences(), profileId: 2 } }).decision,
    'suppressed_no_consent');
  assert.equal(policy({ preferences: { ...preferences(), revision: 0 } }).decision,
    'suppressed_no_consent');
});

test('no quiet hours allows delivery at the injected instant', () => {
  assert.deepEqual(evaluateQuietHours({
    currentInstant: decisionAt,
    timeZone: 'America/New_York',
    quietHours: null,
    policyVersion: NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
  }), {
    policyVersion: NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
    valid: true,
    deliveryAllowed: true,
    inQuietHours: false,
    reason: 'not_configured',
    earliestAllowedAt: decisionAt,
    warnings: [],
  });
});

test('same-day and overnight quiet ranges are start-inclusive and end-exclusive', () => {
  const check = (currentInstant: string, quietHours: { start: string; end: string }) => evaluateQuietHours({
    currentInstant, timeZone: 'UTC', quietHours,
    policyVersion: NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
  });
  const sameDay = { start: '09:00', end: '17:00' };
  assert.equal(check('2026-01-15T08:59:59.999Z', sameDay).deliveryAllowed, true);
  assert.equal(check('2026-01-15T09:00:00.000Z', sameDay).deliveryAllowed, false);
  assert.equal(check('2026-01-15T09:00:00.000Z', sameDay).earliestAllowedAt,
    '2026-01-15T17:00:00.000Z');
  assert.equal(check('2026-01-15T17:00:00.000Z', sameDay).deliveryAllowed, true);

  const overnight = { start: '22:00', end: '07:00' };
  assert.equal(check('2026-01-15T21:59:59.999Z', overnight).deliveryAllowed, true);
  assert.equal(check('2026-01-15T22:00:00.000Z', overnight).deliveryAllowed, false);
  assert.equal(check('2026-01-16T02:00:00.000Z', overnight).earliestAllowedAt,
    '2026-01-16T07:00:00.000Z');
  assert.equal(check('2026-01-16T07:00:00.000Z', overnight).deliveryAllowed, true);
});

test('quiet hours convert named local time to UTC without using the machine timezone', () => {
  const result = evaluateQuietHours({
    currentInstant: '2026-01-15T16:30:00.000Z',
    timeZone: 'Asia/Kolkata',
    quietHours: { start: '22:00', end: '07:00' },
    policyVersion: NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
  });
  assert.equal(result.deliveryAllowed, false);
  assert.equal(result.earliestAllowedAt, '2026-01-16T01:30:00.000Z');
});

test('New York spring gap shifts nonexistent boundaries forward deterministically', () => {
  const beforeShiftedEnd = evaluateQuietHours({
    currentInstant: '2026-03-08T06:45:00.000Z',
    timeZone: 'America/New_York',
    quietHours: { start: '22:00', end: '02:30' },
    policyVersion: NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
  });
  assert.equal(beforeShiftedEnd.deliveryAllowed, false);
  assert.equal(beforeShiftedEnd.earliestAllowedAt, '2026-03-08T07:30:00.000Z');
  assert.deepEqual(beforeShiftedEnd.warnings, ['nonexistent_end_shifted_forward']);

  const afterShiftedStart = evaluateQuietHours({
    currentInstant: '2026-03-08T07:45:00.000Z',
    timeZone: 'America/New_York',
    quietHours: { start: '02:30', end: '04:00' },
    policyVersion: NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
  });
  assert.equal(afterShiftedStart.deliveryAllowed, false);
  assert.equal(afterShiftedStart.earliestAllowedAt, '2026-03-08T08:00:00.000Z');
  assert.deepEqual(afterShiftedStart.warnings, ['nonexistent_start_shifted_forward']);
});

test('New York fall overlap uses earlier start and later end occurrences', () => {
  const ambiguousEnd = evaluateQuietHours({
    currentInstant: '2026-11-01T05:45:00.000Z',
    timeZone: 'America/New_York',
    quietHours: { start: '22:00', end: '01:30' },
    policyVersion: NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
  });
  assert.equal(ambiguousEnd.deliveryAllowed, false);
  assert.equal(ambiguousEnd.earliestAllowedAt, '2026-11-01T06:30:00.000Z');
  assert.deepEqual(ambiguousEnd.warnings, ['ambiguous_end_used_later']);

  const ambiguousStart = evaluateQuietHours({
    currentInstant: '2026-11-01T05:45:00.000Z',
    timeZone: 'America/New_York',
    quietHours: { start: '01:30', end: '02:30' },
    policyVersion: NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
  });
  assert.equal(ambiguousStart.deliveryAllowed, false);
  assert.equal(ambiguousStart.earliestAllowedAt, '2026-11-01T07:30:00.000Z');
  assert.deepEqual(ambiguousStart.warnings, ['ambiguous_start_used_earlier']);
});

test('quiet-hours invalid inputs fail closed with explainable reasons', () => {
  for (const [overrides, reason] of [
    [{ policyVersion: 'future' }, 'unsupported_policy_version'],
    [{ currentInstant: '2026-08-25T06:30:00Z' }, 'invalid_current_instant'],
    [{ timeZone: 'Mars/Olympus' }, 'invalid_timezone'],
    [{ quietHours: { start: '9:00', end: '17:00' } }, 'invalid_configuration'],
    [{ quietHours: { start: '09:00', end: '09:00' } }, 'invalid_configuration'],
  ] as const) {
    const input = {
      currentInstant: decisionAt,
      timeZone: 'UTC',
      quietHours: { start: '09:00', end: '17:00' },
      policyVersion: NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
    };
    Object.assign(input, overrides);
    const result = evaluateQuietHours(input);
    assert.equal(result.valid, false);
    assert.equal(result.deliveryAllowed, false);
    assert.equal(result.reason, reason);
    assert.equal(result.earliestAllowedAt, null);
  }
});

test('policy persists a quiet-hours deferral decision and earliest UTC eligibility', () => {
  const result = policy({
    decisionAt: '2026-11-01T05:45:00.000Z',
    preferences: preferences({
      revision: 7,
      timeZone: 'America/New_York',
      quietHours: { start: '22:00', end: '01:30' },
    }),
  });
  assert.equal(result.decision, 'deferred_quiet_hours');
  assert.equal(result.initialOutboxState, 'deferred');
  assert.equal(result.preferenceRevision, 7);
  assert.equal(result.earliestEligibleAt, '2026-11-01T06:30:00.000Z');
  assert.equal(result.outboxAvailableAt, '2026-11-01T06:30:00.000Z');
  assert.deepEqual(result.warnings, ['ambiguous_end_used_later']);
});

test('retry policy follows the frozen bounded schedule from an injected completion time', () => {
  for (let attempt = 1; attempt < NOTIFICATION_MAX_ATTEMPTS; attempt += 1) {
    const result = calculateNotificationRetry({
      policyVersion: NOTIFICATION_RETRY_POLICY_VERSION,
      completedAttemptNumber: attempt,
      completedAt: '2026-08-25T06:30:00.000Z',
      failure: 'provider_timeout',
    });
    assert.equal(result.disposition, 'retry_scheduled');
    assert.equal(result.reason, 'retryable_failure');
    assert.equal(result.delayMs, NOTIFICATION_RETRY_DELAYS_MS[attempt - 1]);
    assert.equal(Date.parse(result.nextAttemptAt) - Date.parse('2026-08-25T06:30:00.000Z'),
      NOTIFICATION_RETRY_DELAYS_MS[attempt - 1]);
    assert.deepEqual(result, calculateNotificationRetry({
      policyVersion: NOTIFICATION_RETRY_POLICY_VERSION,
      completedAttemptNumber: attempt,
      completedAt: '2026-08-25T06:30:00.000Z',
      failure: 'provider_timeout',
    }));
  }
});

test('terminal failures and exhausted retryable failures dead-letter without another attempt', () => {
  const terminal = calculateNotificationRetry({
    policyVersion: NOTIFICATION_RETRY_POLICY_VERSION,
    completedAttemptNumber: 1,
    completedAt: decisionAt,
    failure: 'invalid_recipient',
  });
  assert.equal(terminal.disposition, 'dead_letter');
  assert.equal(terminal.reason, 'terminal_failure');
  assert.equal(terminal.nextAttemptAt, null);

  const exhausted = calculateNotificationRetry({
    policyVersion: NOTIFICATION_RETRY_POLICY_VERSION,
    completedAttemptNumber: NOTIFICATION_MAX_ATTEMPTS,
    completedAt: decisionAt,
    failure: 'provider_timeout',
  });
  assert.equal(exhausted.disposition, 'dead_letter');
  assert.equal(exhausted.reason, 'attempts_exhausted');
  assert.equal(exhausted.delayMs, null);
});

test('retry policy rejects unknown versions, attempt boundaries, timestamps, and failures', () => {
  for (const invalid of [
    { policyVersion: 'future', completedAttemptNumber: 1, completedAt: decisionAt, failure: 'provider_timeout' },
    { policyVersion: NOTIFICATION_RETRY_POLICY_VERSION, completedAttemptNumber: 0, completedAt: decisionAt, failure: 'provider_timeout' },
    { policyVersion: NOTIFICATION_RETRY_POLICY_VERSION, completedAttemptNumber: 1.5, completedAt: decisionAt, failure: 'provider_timeout' },
    { policyVersion: NOTIFICATION_RETRY_POLICY_VERSION, completedAttemptNumber: NOTIFICATION_MAX_ATTEMPTS + 1, completedAt: decisionAt, failure: 'provider_timeout' },
    { policyVersion: NOTIFICATION_RETRY_POLICY_VERSION, completedAttemptNumber: 1, completedAt: '2026-08-25T06:30:00Z', failure: 'provider_timeout' },
    { policyVersion: NOTIFICATION_RETRY_POLICY_VERSION, completedAttemptNumber: 1, completedAt: decisionAt, failure: 'secret_provider_body' },
  ]) assert.throws(
    () => calculateNotificationRetry(invalid as never),
    NotificationRetryPolicyError,
  );
});
