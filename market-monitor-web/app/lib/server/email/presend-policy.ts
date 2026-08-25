import {
  isCanonicalNotificationInstant,
  normalizeNotificationPreferenceSnapshot,
  type NotificationPreferenceSnapshot,
} from '../notifications/preference.ts';
import { evaluateQuietHours } from '../notifications/quiet-hours.ts';
import { NOTIFICATION_QUIET_HOURS_POLICY_VERSION } from '../notifications/contract.ts';
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from '../notifications/types.ts';
import {
  EMAIL_CONSENT_SOURCES,
  FORECAST_EMAIL_CONSENT_VERSION,
  type EmailConsentSnapshot,
  type EmailPreSendDecision,
  type EmailRecipient,
} from './types.ts';

export type EmailPreSendPolicyInput = {
  checkedAt: string;
  cutoff: string;
  category: unknown;
  availableAt: string | null;
  outboxCreatedAt: string;
  claimValid: boolean;
  supportedTemplate: boolean;
  configurationValid: boolean;
  providerAlreadyAccepted: boolean;
  preparedRecipientId: string | null;
  currentRecipient: EmailRecipient | null;
  notificationPreference: unknown | null;
  emailConsent: unknown | null;
};

export type EmailPreSendPolicyResult = {
  decision: EmailPreSendDecision;
  reason: string;
  recipientId: string | null;
  notificationPreferenceRevision: number | null;
  emailConsentRevision: number | null;
  nextAvailableAt: string | null;
};

export class EmailPreSendPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailPreSendPolicyError';
  }
}

function result(
  decision: EmailPreSendDecision,
  reason: string,
  recipientId: string | null = null,
  notificationPreferenceRevision: number | null = null,
  emailConsentRevision: number | null = null,
  nextAvailableAt: string | null = null,
): EmailPreSendPolicyResult {
  return {
    decision,
    reason,
    recipientId,
    notificationPreferenceRevision,
    emailConsentRevision,
    nextAvailableAt,
  };
}

function notificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === 'string'
    && NOTIFICATION_CATEGORIES.includes(value as NotificationCategory);
}

function validEmailConsent(
  value: unknown,
  profileId: number,
): EmailConsentSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<EmailConsentSnapshot>;
  if (row.profileId !== profileId || row.schemaVersion !== FORECAST_EMAIL_CONSENT_VERSION
    || !Number.isSafeInteger(row.revision) || Number(row.revision) <= 0
    || typeof row.recipientId !== 'string' || row.recipientId.length === 0
    || typeof row.masterConsent !== 'boolean'
    || !row.categories || typeof row.categories !== 'object'
    || !EMAIL_CONSENT_SOURCES.includes(row.source as never)
    || !isCanonicalNotificationInstant(row.createdAt)
    || (row.consentedAt !== null && !isCanonicalNotificationInstant(row.consentedAt))
    || (row.revokedAt !== null && !isCanonicalNotificationInstant(row.revokedAt))) return null;
  for (const category of NOTIFICATION_CATEGORIES) {
    if (typeof row.categories[category] !== 'boolean') return null;
  }
  return row as EmailConsentSnapshot;
}

function validNotificationPreference(
  value: unknown,
  profileId: number,
): NotificationPreferenceSnapshot | null {
  try {
    const preference = normalizeNotificationPreferenceSnapshot(value);
    return preference.profileId === profileId ? preference : null;
  } catch {
    return null;
  }
}

/**
 * Frozen final authorization check. It is intentionally stricter than the
 * projection-time policy: a channel consent can never release older work.
 */
export function evaluateEmailPreSendPolicy(
  input: EmailPreSendPolicyInput,
  trustedProfileId: number,
): EmailPreSendPolicyResult {
  if (!Number.isSafeInteger(trustedProfileId) || trustedProfileId <= 0) {
    throw new EmailPreSendPolicyError('Trusted email profile is invalid.');
  }
  if (!isCanonicalNotificationInstant(input.checkedAt)
    || !isCanonicalNotificationInstant(input.cutoff)
    || !isCanonicalNotificationInstant(input.outboxCreatedAt)) {
    throw new EmailPreSendPolicyError('Email pre-send timestamps are invalid.');
  }
  if (!input.claimValid) {
    throw new EmailPreSendPolicyError('Email claim authority is unavailable.');
  }
  if (!notificationCategory(input.category) || !input.supportedTemplate) {
    return result('suppressed_unsupported_category', 'unsupported_notification_category_or_template');
  }
  if (!input.configurationValid) {
    return result('suppressed_configuration', 'email_configuration_is_invalid');
  }
  if (input.providerAlreadyAccepted) {
    return result('suppressed_already_accepted', 'provider_request_was_already_accepted');
  }
  if (!input.availableAt || !isCanonicalNotificationInstant(input.availableAt)
    || input.availableAt > input.checkedAt || input.availableAt > input.cutoff) {
    throw new EmailPreSendPolicyError('Email outbox item is not currently available.');
  }

  const recipient = input.currentRecipient;
  if (!recipient) return result('suppressed_recipient_missing', 'verified_email_recipient_is_missing');
  if (recipient.profileId !== trustedProfileId) {
    return result('suppressed_recipient_missing', 'verified_email_recipient_is_missing');
  }
  if (recipient.lifecycle === 'replaced') {
    return result('suppressed_recipient_replaced', 'email_recipient_was_replaced', recipient.id);
  }
  if (recipient.lifecycle === 'revoked') {
    return result('suppressed_recipient_revoked', 'email_recipient_was_revoked', recipient.id);
  }
  if (recipient.lifecycle !== 'verified' || !recipient.verifiedAt) {
    return result('suppressed_recipient_unverified', 'email_recipient_is_not_verified', recipient.id);
  }
  if (recipient.suppressionState === 'suppressed') {
    return result('suppressed_recipient_provider', 'email_recipient_is_suppressed', recipient.id);
  }
  if (input.preparedRecipientId !== null && input.preparedRecipientId !== recipient.id) {
    return result('suppressed_recipient_changed', 'prepared_email_recipient_changed', recipient.id);
  }

  const notificationPreference = validNotificationPreference(
    input.notificationPreference,
    trustedProfileId,
  );
  if (!notificationPreference) {
    return result('suppressed_invalid_preference', 'notification_preferences_are_invalid', recipient.id);
  }
  if (!notificationPreference.masterConsent) {
    return result(
      'suppressed_notification_consent',
      'master_notification_consent_is_disabled',
      recipient.id,
      notificationPreference.revision,
    );
  }
  if (!notificationPreference.categories[input.category]) {
    return result(
      'suppressed_category',
      'notification_category_is_disabled',
      recipient.id,
      notificationPreference.revision,
    );
  }

  const emailConsent = validEmailConsent(input.emailConsent, trustedProfileId);
  if (!emailConsent || emailConsent.recipientId !== recipient.id) {
    return result(
      'suppressed_email_consent',
      'email_consent_is_missing_invalid_or_recipient_bound_elsewhere',
      recipient.id,
      notificationPreference.revision,
    );
  }
  if (!emailConsent.masterConsent || emailConsent.revokedAt !== null) {
    return result(
      'suppressed_email_consent',
      'master_email_consent_is_disabled',
      recipient.id,
      notificationPreference.revision,
      emailConsent.revision,
    );
  }
  if (!emailConsent.categories[input.category]) {
    return result(
      'suppressed_category',
      'email_category_is_disabled',
      recipient.id,
      notificationPreference.revision,
      emailConsent.revision,
    );
  }

  // Channel opt-in and verification are prospective. They cannot drain an
  // outbox row created before the current recipient was verified and enabled.
  if (recipient.verifiedAt > input.outboxCreatedAt
    || emailConsent.consentedAt === null
    || emailConsent.consentedAt > input.outboxCreatedAt) {
    return result(
      'suppressed_email_consent',
      'email_channel_consent_does_not_cover_historical_outbox_item',
      recipient.id,
      notificationPreference.revision,
      emailConsent.revision,
    );
  }

  const quietHours = evaluateQuietHours({
    currentInstant: input.checkedAt,
    timeZone: notificationPreference.timeZone,
    quietHours: notificationPreference.quietHours,
    policyVersion: NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
  });
  if (!quietHours.valid) {
    return result(
      'suppressed_invalid_preference',
      `quiet_hours_${quietHours.reason}`,
      recipient.id,
      notificationPreference.revision,
      emailConsent.revision,
    );
  }
  if (!quietHours.deliveryAllowed) {
    return result(
      'deferred_quiet_hours',
      'current_instant_is_within_quiet_hours',
      recipient.id,
      notificationPreference.revision,
      emailConsent.revision,
      quietHours.earliestAllowedAt,
    );
  }
  return result(
    'eligible',
    'current_recipient_and_consent_allow_email',
    recipient.id,
    notificationPreference.revision,
    emailConsent.revision,
  );
}
