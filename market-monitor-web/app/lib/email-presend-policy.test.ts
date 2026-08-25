import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateEmailPreSendPolicy,
  type EmailPreSendPolicyInput,
} from './server/email/presend-policy.ts';
import {
  FORECAST_EMAIL_CONSENT_VERSION,
  type EmailConsentSnapshot,
  type EmailRecipient,
} from './server/email/types.ts';
import {
  NOTIFICATION_PREFERENCE_SCHEMA_VERSION,
  type NotificationPreferenceSnapshot,
} from './server/notifications/preference.ts';

const PROFILE_ID = 7;
const CHECKED_AT = '2026-08-25T12:00:00.000Z';
const CREATED_AT = '2026-08-25T11:00:00.000Z';

function recipient(overrides: Partial<EmailRecipient> = {}): EmailRecipient {
  return {
    id: 'recipient-1',
    profileId: PROFILE_ID,
    revision: 1,
    canonicalEmail: 'Journal@example.com',
    maskedEmail: 'J***@e***.com',
    lifecycle: 'verified',
    verificationRequestedAt: '2026-08-25T09:00:00.000Z',
    verifiedAt: '2026-08-25T10:00:00.000Z',
    revokedAt: null,
    suppressionState: 'none',
    suppressionReason: null,
    suppressedAt: null,
    createdAt: '2026-08-25T09:00:00.000Z',
    updatedAt: '2026-08-25T10:00:00.000Z',
    ...overrides,
  };
}

function preferences(
  overrides: Partial<NotificationPreferenceSnapshot> = {},
): NotificationPreferenceSnapshot {
  return {
    profileId: PROFILE_ID,
    schemaVersion: NOTIFICATION_PREFERENCE_SCHEMA_VERSION,
    revision: 3,
    masterConsent: true,
    categories: {
      target_hit: true,
      invalidated: true,
      expired: true,
      needs_review: true,
    },
    timeZone: 'UTC',
    quietHours: null,
    createdAt: '2026-08-25T09:00:00.000Z',
    updatedAt: '2026-08-25T10:00:00.000Z',
    ...overrides,
  };
}

function consent(overrides: Partial<EmailConsentSnapshot> = {}): EmailConsentSnapshot {
  return {
    profileId: PROFILE_ID,
    revision: 2,
    recipientId: 'recipient-1',
    schemaVersion: FORECAST_EMAIL_CONSENT_VERSION,
    masterConsent: true,
    categories: {
      target_hit: true,
      invalidated: true,
      expired: true,
      needs_review: true,
    },
    source: 'operator',
    consentedAt: '2026-08-25T10:30:00.000Z',
    revokedAt: null,
    createdAt: '2026-08-25T10:30:00.000Z',
    ...overrides,
  };
}

function input(overrides: Partial<EmailPreSendPolicyInput> = {}): EmailPreSendPolicyInput {
  return {
    checkedAt: CHECKED_AT,
    cutoff: CHECKED_AT,
    category: 'target_hit',
    availableAt: '2026-08-25T11:30:00.000Z',
    outboxCreatedAt: CREATED_AT,
    claimValid: true,
    supportedTemplate: true,
    configurationValid: true,
    providerAlreadyAccepted: false,
    preparedRecipientId: null,
    currentRecipient: recipient(),
    notificationPreference: preferences(),
    emailConsent: consent(),
    ...overrides,
  };
}

test('pre-send policy requires current verified, active, unsuppressed recipient state', () => {
  assert.equal(evaluateEmailPreSendPolicy(input({ currentRecipient: null }), PROFILE_ID).decision,
    'suppressed_recipient_missing');
  assert.equal(evaluateEmailPreSendPolicy(input({
    currentRecipient: recipient({ lifecycle: 'pending', verifiedAt: null }),
  }), PROFILE_ID).decision, 'suppressed_recipient_unverified');
  assert.equal(evaluateEmailPreSendPolicy(input({
    currentRecipient: recipient({ lifecycle: 'revoked', revokedAt: CHECKED_AT }),
  }), PROFILE_ID).decision, 'suppressed_recipient_revoked');
  assert.equal(evaluateEmailPreSendPolicy(input({
    currentRecipient: recipient({ lifecycle: 'replaced', revokedAt: CHECKED_AT }),
  }), PROFILE_ID).decision, 'suppressed_recipient_replaced');
  assert.equal(evaluateEmailPreSendPolicy(input({
    currentRecipient: recipient({
      suppressionState: 'suppressed',
      suppressionReason: 'hard_bounce',
      suppressedAt: CHECKED_AT,
    }),
  }), PROFILE_ID).decision, 'suppressed_recipient_provider');
});

test('pre-send policy fails closed for missing, disabled, invalid, and stale consent', () => {
  assert.equal(evaluateEmailPreSendPolicy(input({ notificationPreference: null }), PROFILE_ID).decision,
    'suppressed_invalid_preference');
  assert.equal(evaluateEmailPreSendPolicy(input({
    notificationPreference: preferences({ masterConsent: false }),
  }), PROFILE_ID).decision, 'suppressed_notification_consent');
  assert.equal(evaluateEmailPreSendPolicy(input({
    notificationPreference: preferences({
      categories: { ...preferences().categories, target_hit: false },
    }),
  }), PROFILE_ID).decision, 'suppressed_category');
  assert.equal(evaluateEmailPreSendPolicy(input({ emailConsent: null }), PROFILE_ID).decision,
    'suppressed_email_consent');
  assert.equal(evaluateEmailPreSendPolicy(input({
    emailConsent: consent({ masterConsent: false, consentedAt: null, revokedAt: CHECKED_AT }),
  }), PROFILE_ID).decision, 'suppressed_email_consent');
  assert.equal(evaluateEmailPreSendPolicy(input({
    emailConsent: consent({ categories: { ...consent().categories, target_hit: false } }),
  }), PROFILE_ID).decision, 'suppressed_category');
});

test('post-claim consent and recipient races are blocked before provider construction', () => {
  assert.equal(evaluateEmailPreSendPolicy(input({
    emailConsent: consent({ masterConsent: false, consentedAt: null, revokedAt: CHECKED_AT }),
  }), PROFILE_ID).reason, 'master_email_consent_is_disabled');
  assert.equal(evaluateEmailPreSendPolicy(input({
    preparedRecipientId: 'recipient-original',
  }), PROFILE_ID).decision, 'suppressed_recipient_changed');
  assert.equal(evaluateEmailPreSendPolicy(input({
    providerAlreadyAccepted: true,
  }), PROFILE_ID).decision, 'suppressed_already_accepted');
});

test('verification and consent are prospective and cannot release historical outbox work', () => {
  assert.equal(evaluateEmailPreSendPolicy(input({
    currentRecipient: recipient({ verifiedAt: '2026-08-25T11:30:00.000Z' }),
  }), PROFILE_ID).decision, 'suppressed_email_consent');
  assert.equal(evaluateEmailPreSendPolicy(input({
    emailConsent: consent({ consentedAt: '2026-08-25T11:30:00.000Z' }),
  }), PROFILE_ID).decision, 'suppressed_email_consent');
});

test('new quiet hours after claim produce a deterministic defer time', () => {
  const outcome = evaluateEmailPreSendPolicy(input({
    notificationPreference: preferences({ quietHours: { start: '11:00', end: '13:00' } }),
  }), PROFILE_ID);
  assert.equal(outcome.decision, 'deferred_quiet_hours');
  assert.equal(outcome.nextAvailableAt, '2026-08-25T13:00:00.000Z');
  assert.equal(outcome.notificationPreferenceRevision, 3);
  assert.equal(outcome.emailConsentRevision, 2);
});

test('eligible decisions retain the exact authorizing revisions', () => {
  assert.deepEqual(evaluateEmailPreSendPolicy(input(), PROFILE_ID), {
    decision: 'eligible',
    reason: 'current_recipient_and_consent_allow_email',
    recipientId: 'recipient-1',
    notificationPreferenceRevision: 3,
    emailConsentRevision: 2,
    nextAvailableAt: null,
  });
});
