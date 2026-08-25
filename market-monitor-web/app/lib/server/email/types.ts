import type { NotificationCategory } from '../notifications/types.ts';

export const EMAIL_ENVIRONMENTS = ['local', 'preview', 'staging', 'production'] as const;
export type EmailEnvironment = typeof EMAIL_ENVIRONMENTS[number];

export const FORECAST_EMAIL_CHANNEL_VERSION = 'forecast-email-channel-1.0.0' as const;
export const FORECAST_EMAIL_CONSENT_VERSION = 'forecast-email-consent-1.0.0' as const;
export const FORECAST_EMAIL_CAPABILITY_VERSION = 'forecast-email-capability-1.0.0' as const;
export const FORECAST_EMAIL_DISPATCHER_VERSION = 'forecast-email-dispatcher-1.0.0' as const;
export const RESEND_ADAPTER_VERSION = 'northstar-resend-adapter-1.0.0' as const;

export const EMAIL_RECIPIENT_LIFECYCLES = [
  'pending',
  'verified',
  'revoked',
  'replaced',
] as const;
export type EmailRecipientLifecycle = typeof EMAIL_RECIPIENT_LIFECYCLES[number];

export const EMAIL_RECIPIENT_SUPPRESSION_STATES = ['none', 'suppressed'] as const;
export type EmailRecipientSuppressionState = typeof EMAIL_RECIPIENT_SUPPRESSION_STATES[number];

export const EMAIL_RECIPIENT_SUPPRESSION_REASONS = [
  'hard_bounce',
  'complaint',
  'provider_suppressed',
  'operator',
] as const;
export type EmailRecipientSuppressionReason = typeof EMAIL_RECIPIENT_SUPPRESSION_REASONS[number];

export const EMAIL_CAPABILITY_PURPOSES = ['verification', 'unsubscribe'] as const;
export type EmailCapabilityPurpose = typeof EMAIL_CAPABILITY_PURPOSES[number];

export const EMAIL_CAPABILITY_STATES = ['active', 'consumed', 'revoked', 'expired'] as const;
export type EmailCapabilityState = typeof EMAIL_CAPABILITY_STATES[number];

export const EMAIL_CONSENT_SOURCES = [
  'operator',
  'unsubscribe',
  'provider_complaint',
  'recipient_replacement',
  'internal',
] as const;
export type EmailConsentSource = typeof EMAIL_CONSENT_SOURCES[number];

export type EmailCategoryConsent = Record<NotificationCategory, boolean>;

export type EmailRecipient = {
  id: string;
  profileId: number;
  revision: number;
  canonicalEmail: string;
  maskedEmail: string;
  lifecycle: EmailRecipientLifecycle;
  verificationRequestedAt: string | null;
  verifiedAt: string | null;
  revokedAt: string | null;
  suppressionState: EmailRecipientSuppressionState;
  suppressionReason: EmailRecipientSuppressionReason | null;
  suppressedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EmailConsentSnapshot = {
  profileId: number;
  revision: number;
  recipientId: string;
  schemaVersion: typeof FORECAST_EMAIL_CONSENT_VERSION;
  masterConsent: boolean;
  categories: EmailCategoryConsent;
  source: EmailConsentSource;
  consentedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type EmailCapabilityRecord = {
  id: string;
  profileId: number;
  recipientId: string;
  purpose: EmailCapabilityPurpose;
  capabilityVersion: typeof FORECAST_EMAIL_CAPABILITY_VERSION;
  tokenHash: string;
  state: EmailCapabilityState;
  consentRevision: number | null;
  expiresAt: string | null;
  consumedAt: string | null;
  revokedAt: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  createdAt: string;
};

export const EMAIL_PRE_SEND_DECISIONS = [
  'eligible',
  'deferred_quiet_hours',
  'suppressed_recipient_missing',
  'suppressed_recipient_unverified',
  'suppressed_recipient_revoked',
  'suppressed_recipient_replaced',
  'suppressed_recipient_provider',
  'suppressed_notification_consent',
  'suppressed_email_consent',
  'suppressed_category',
  'suppressed_invalid_preference',
  'suppressed_unsupported_category',
  'suppressed_recipient_changed',
  'suppressed_already_accepted',
  'suppressed_configuration',
] as const;
export type EmailPreSendDecision = typeof EMAIL_PRE_SEND_DECISIONS[number];

export const EMAIL_DELIVERY_SOURCE_KINDS = [
  'forecast_notification',
  'recipient_verification',
] as const;
export type EmailDeliverySourceKind = typeof EMAIL_DELIVERY_SOURCE_KINDS[number];

export const EMAIL_DELIVERY_STATES = [
  'prepared',
  'request_started',
  'provider_accepted',
  'ambiguous',
  'terminal_failure',
  'dead_letter',
] as const;
export type EmailDeliveryState = typeof EMAIL_DELIVERY_STATES[number];

export const EMAIL_RECONCILIATION_STATES = [
  'none',
  'delayed',
  'delivered',
  'failed',
  'bounced',
  'complained',
  'suppressed',
] as const;
export type EmailReconciliationState = typeof EMAIL_RECONCILIATION_STATES[number];

export const EMAIL_PROVIDER_ATTEMPT_STATES = [
  'started',
  'accepted',
  'retry_scheduled',
  'terminal_failure',
  'ambiguous',
  'interrupted',
] as const;
export type EmailProviderAttemptState = typeof EMAIL_PROVIDER_ATTEMPT_STATES[number];

export const EMAIL_PROVIDER_FAILURE_CODES = [
  'timeout',
  'network_error',
  'response_too_large',
  'malformed_response',
  'rate_limited',
  'quota_exceeded',
  'provider_unavailable',
  'concurrent_idempotent_request',
  'idempotent_payload_conflict',
  'invalid_request',
  'unauthorized',
  'security_rejection',
  'configuration_error',
  'safe_retry_window_expired',
  'claim_lost',
] as const;
export type EmailProviderFailureCode = typeof EMAIL_PROVIDER_FAILURE_CODES[number];

export const EMAIL_PROVIDER_EVENT_DISPOSITIONS = [
  'applied',
  'unsupported',
  'unknown_delivery',
  'ignored_precedence',
] as const;
export type EmailProviderEventDisposition = typeof EMAIL_PROVIDER_EVENT_DISPOSITIONS[number];

export const RESEND_RECONCILIATION_EVENT_TYPES = [
  'email.delivered',
  'email.delivery_delayed',
  'email.failed',
  'email.bounced',
  'email.complained',
  'email.suppressed',
] as const;
export type ResendReconciliationEventType = typeof RESEND_RECONCILIATION_EVENT_TYPES[number];
