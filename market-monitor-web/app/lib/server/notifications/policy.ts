import {
  isCanonicalNotificationInstant,
  normalizeNotificationPreferenceSnapshot,
  type NotificationPreferenceSnapshot,
} from './preference.ts';
import {
  evaluateQuietHours,
  type QuietHoursWarning,
} from './quiet-hours.ts';
import {
  NOTIFICATION_POLICY_VERSION,
  NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
} from './contract.ts';
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationPolicyDecision,
} from './types.ts';
export type NotificationInitialOutboxState = 'pending' | 'deferred' | 'suppressed';

export type NotificationPolicyInput = {
  policyVersion: string;
  decisionAt: string;
  trustedProfileId: number;
  category: unknown;
  sourceValid: boolean;
  historicalCutoverSuppressed: boolean;
  preferences: unknown | null;
};

export type NotificationPolicyResult = {
  policyVersion: typeof NOTIFICATION_POLICY_VERSION;
  preferenceRevision: number | null;
  decision: NotificationPolicyDecision;
  reason: string;
  decidedAt: string;
  initialOutboxState: NotificationInitialOutboxState;
  earliestEligibleAt: string | null;
  outboxAvailableAt: string | null;
  warnings: QuietHoursWarning[];
};

export class NotificationPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationPolicyError';
  }
}

function result(
  input: NotificationPolicyInput,
  decision: NotificationPolicyDecision,
  reason: string,
  state: NotificationInitialOutboxState,
  preferenceRevision: number | null = null,
  earliestEligibleAt: string | null = null,
  outboxAvailableAt: string | null = null,
  warnings: QuietHoursWarning[] = [],
): NotificationPolicyResult {
  return {
    policyVersion: NOTIFICATION_POLICY_VERSION,
    preferenceRevision,
    decision,
    reason,
    decidedAt: input.decisionAt,
    initialOutboxState: state,
    earliestEligibleAt,
    outboxAvailableAt,
    warnings,
  };
}

function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === 'string' && NOTIFICATION_CATEGORIES.includes(value as NotificationCategory);
}

function preferencesFor(
  input: NotificationPolicyInput,
): { valid: true; value: NotificationPreferenceSnapshot } | { valid: false } {
  if (input.preferences === null) return { valid: false };
  try {
    const value = normalizeNotificationPreferenceSnapshot(input.preferences);
    return value.profileId === input.trustedProfileId ? { valid: true, value } : { valid: false };
  } catch {
    return { valid: false };
  }
}

/** Applies the frozen materialization-time consent and quiet-hours policy. */
export function evaluateNotificationPolicy(input: NotificationPolicyInput): NotificationPolicyResult {
  if (!isCanonicalNotificationInstant(input.decisionAt)) {
    throw new NotificationPolicyError('Notification policy decision time must be a canonical UTC instant.');
  }
  if (!Number.isSafeInteger(input.trustedProfileId) || input.trustedProfileId <= 0) {
    throw new NotificationPolicyError('Trusted notification policy profile is invalid.');
  }
  if (input.policyVersion !== NOTIFICATION_POLICY_VERSION || !input.sourceValid) {
    return result(
      input,
      'invalid_source_needs_review',
      input.policyVersion !== NOTIFICATION_POLICY_VERSION
        ? 'unsupported_notification_policy_version'
        : 'trusted_source_validation_failed',
      'suppressed',
    );
  }
  if (!isNotificationCategory(input.category)) {
    return result(input, 'suppressed_unsupported_category', 'notification_category_is_not_supported', 'suppressed');
  }
  if (input.historicalCutoverSuppressed) {
    return result(input, 'suppressed_historical_cutover', 'source_precedes_notification_cutover', 'suppressed');
  }
  if (input.preferences === null) {
    return result(input, 'suppressed_no_consent', 'notification_preferences_are_missing', 'suppressed');
  }
  const normalized = preferencesFor(input);
  if (!normalized.valid) {
    return result(input, 'suppressed_no_consent', 'notification_preferences_are_invalid', 'suppressed');
  }
  const preferences = normalized.value;
  if (!preferences.masterConsent) {
    return result(
      input,
      'suppressed_no_consent',
      'master_notification_consent_is_disabled',
      'suppressed',
      preferences.revision,
    );
  }
  if (!preferences.categories[input.category]) {
    return result(
      input,
      'suppressed_category_disabled',
      'notification_category_is_disabled',
      'suppressed',
      preferences.revision,
    );
  }
  const quietHours = evaluateQuietHours({
    currentInstant: input.decisionAt,
    timeZone: preferences.timeZone,
    quietHours: preferences.quietHours,
    policyVersion: NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
  });
  if (!quietHours.valid) {
    return result(
      input,
      'suppressed_no_consent',
      `quiet_hours_${quietHours.reason}`,
      'suppressed',
      preferences.revision,
    );
  }
  if (!quietHours.deliveryAllowed) {
    return result(
      input,
      'deferred_quiet_hours',
      'current_instant_is_within_quiet_hours',
      'deferred',
      preferences.revision,
      quietHours.earliestAllowedAt,
      quietHours.earliestAllowedAt,
      quietHours.warnings,
    );
  }
  return result(
    input,
    'eligible',
    'consent_and_category_policy_allow_notification',
    'pending',
    preferences.revision,
    null,
    input.decisionAt,
    quietHours.warnings,
  );
}
