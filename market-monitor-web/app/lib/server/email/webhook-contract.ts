import {
  RESEND_RECONCILIATION_EVENT_TYPES,
  type EmailReconciliationState,
  type ResendReconciliationEventType,
} from './types.ts';

const WEBHOOK_KEYS = new Set(['type', 'created_at', 'data']);
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,99}$/u;
const PROVIDER_EMAIL_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/u;
const CANONICAL_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export type ParsedResendWebhookEvent = {
  type: string;
  occurredAt: string;
  providerEmailId: string | null;
  supported: boolean;
  reconciliationState: EmailReconciliationState | null;
  suppressionReason: 'hard_bounce' | 'complaint' | 'provider_suppressed' | null;
  revokeConsent: boolean;
};

export class ResendWebhookContractError extends Error {
  constructor() {
    super('Invalid webhook event.');
    this.name = 'ResendWebhookContractError';
  }
}

function invalid(): never {
  throw new ResendWebhookContractError();
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalInstant(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL_INSTANT_PATTERN.test(value)) invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) invalid();
  return value;
}

function supportedType(value: string): value is ResendReconciliationEventType {
  return RESEND_RECONCILIATION_EVENT_TYPES.includes(value as ResendReconciliationEventType);
}

function mapping(type: ResendReconciliationEventType): Pick<
  ParsedResendWebhookEvent,
  'reconciliationState' | 'suppressionReason' | 'revokeConsent'
> {
  switch (type) {
    case 'email.delivery_delayed':
      return { reconciliationState: 'delayed', suppressionReason: null, revokeConsent: false };
    case 'email.delivered':
      return { reconciliationState: 'delivered', suppressionReason: null, revokeConsent: false };
    case 'email.failed':
      return { reconciliationState: 'failed', suppressionReason: null, revokeConsent: false };
    case 'email.bounced':
      return { reconciliationState: 'bounced', suppressionReason: 'hard_bounce', revokeConsent: false };
    case 'email.complained':
      return { reconciliationState: 'complained', suppressionReason: 'complaint', revokeConsent: true };
    case 'email.suppressed':
      return {
        reconciliationState: 'suppressed',
        suppressionReason: 'provider_suppressed',
        revokeConsent: false,
      };
  }
}

/**
 * Parses only the signed provider result. Unneeded provider fields may evolve,
 * but the trusted top-level envelope and every field used for mutation are
 * deliberately strict and bounded.
 */
export function parseResendWebhookEvent(value: unknown): ParsedResendWebhookEvent {
  if (!plainObject(value) || Object.keys(value).some((key) => !WEBHOOK_KEYS.has(key))) invalid();
  if (typeof value.type !== 'string' || !EVENT_TYPE_PATTERN.test(value.type)) invalid();
  const eventType = value.type;
  const occurredAt = canonicalInstant(value.created_at);
  if (!plainObject(value.data)) invalid();

  const rawProviderEmailId = value.data.email_id;
  const providerEmailId = rawProviderEmailId === undefined
    ? null
    : typeof rawProviderEmailId === 'string' && PROVIDER_EMAIL_ID_PATTERN.test(rawProviderEmailId)
      ? rawProviderEmailId
      : invalid();
  const supported = supportedType(eventType);
  if (supported && providerEmailId === null) invalid();
  const eventMapping = supported ? mapping(eventType) : null;
  return {
    type: eventType,
    occurredAt,
    providerEmailId,
    supported,
    reconciliationState: eventMapping?.reconciliationState ?? null,
    suppressionReason: eventMapping?.suppressionReason ?? null,
    revokeConsent: eventMapping?.revokeConsent ?? false,
  };
}
