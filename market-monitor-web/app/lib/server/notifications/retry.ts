import { Temporal } from '@js-temporal/polyfill';
import { NOTIFICATION_RETRY_POLICY_VERSION } from './contract.ts';
import { isCanonicalNotificationInstant } from './preference.ts';

export const NOTIFICATION_MAX_ATTEMPTS = 6;
export const NOTIFICATION_RETRY_DELAYS_MS = [
  60_000,
  4 * 60_000,
  16 * 60_000,
  64 * 60_000,
  256 * 60_000,
] as const;

export const NOTIFICATION_RETRYABLE_FAILURES = [
  'provider_unavailable',
  'provider_timeout',
  'rate_limited',
  'temporary_provider_error',
  'adapter_exception',
] as const;

export const NOTIFICATION_TERMINAL_FAILURES = [
  'invalid_recipient',
  'invalid_payload',
  'unauthorized',
  'provider_rejected',
  'unsupported_channel',
  'configuration_error',
] as const;

export type NotificationRetryableFailure = typeof NOTIFICATION_RETRYABLE_FAILURES[number];
export type NotificationTerminalFailure = typeof NOTIFICATION_TERMINAL_FAILURES[number];
export type NotificationDeliveryFailure = NotificationRetryableFailure | NotificationTerminalFailure;

export type NotificationRetryInput = {
  policyVersion: string;
  completedAttemptNumber: number;
  completedAt: string;
  failure: NotificationDeliveryFailure;
};

export type NotificationRetryDecision = {
  policyVersion: typeof NOTIFICATION_RETRY_POLICY_VERSION;
  completedAttemptNumber: number;
  maximumAttempts: typeof NOTIFICATION_MAX_ATTEMPTS;
  disposition: 'retry_scheduled';
  reason: 'retryable_failure';
  delayMs: number;
  nextAttemptAt: string;
} | {
  policyVersion: typeof NOTIFICATION_RETRY_POLICY_VERSION;
  completedAttemptNumber: number;
  maximumAttempts: typeof NOTIFICATION_MAX_ATTEMPTS;
  disposition: 'dead_letter';
  reason: 'terminal_failure' | 'attempts_exhausted';
  delayMs: null;
  nextAttemptAt: null;
};

export class NotificationRetryPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationRetryPolicyError';
  }
}

function isRetryableFailure(value: unknown): value is NotificationRetryableFailure {
  return typeof value === 'string'
    && NOTIFICATION_RETRYABLE_FAILURES.includes(value as NotificationRetryableFailure);
}

function isTerminalFailure(value: unknown): value is NotificationTerminalFailure {
  return typeof value === 'string'
    && NOTIFICATION_TERMINAL_FAILURES.includes(value as NotificationTerminalFailure);
}

/** Pure retry calculation. Version 1 intentionally has no jitter. */
export function calculateNotificationRetry(input: NotificationRetryInput): NotificationRetryDecision {
  if (input.policyVersion !== NOTIFICATION_RETRY_POLICY_VERSION) {
    throw new NotificationRetryPolicyError('Notification retry policy version is unsupported.');
  }
  if (!Number.isSafeInteger(input.completedAttemptNumber) || input.completedAttemptNumber <= 0
    || input.completedAttemptNumber > NOTIFICATION_MAX_ATTEMPTS) {
    throw new NotificationRetryPolicyError('Completed notification attempt number is invalid.');
  }
  if (!isCanonicalNotificationInstant(input.completedAt)) {
    throw new NotificationRetryPolicyError('Notification attempt completion time is invalid.');
  }
  if (!isRetryableFailure(input.failure) && !isTerminalFailure(input.failure)) {
    throw new NotificationRetryPolicyError('Notification delivery failure classification is unsupported.');
  }
  const common = {
    policyVersion: NOTIFICATION_RETRY_POLICY_VERSION,
    completedAttemptNumber: input.completedAttemptNumber,
    maximumAttempts: NOTIFICATION_MAX_ATTEMPTS,
  } as const;
  if (isTerminalFailure(input.failure)) {
    return {
      ...common,
      disposition: 'dead_letter',
      reason: 'terminal_failure',
      delayMs: null,
      nextAttemptAt: null,
    };
  }
  if (input.completedAttemptNumber >= NOTIFICATION_MAX_ATTEMPTS) {
    return {
      ...common,
      disposition: 'dead_letter',
      reason: 'attempts_exhausted',
      delayMs: null,
      nextAttemptAt: null,
    };
  }

  const delayMs = NOTIFICATION_RETRY_DELAYS_MS[input.completedAttemptNumber - 1];
  if (delayMs === undefined) throw new NotificationRetryPolicyError('Notification retry delay is unavailable.');
  const nextAttempt = Temporal.Instant.from(input.completedAt).add({ milliseconds: delayMs });
  return {
    ...common,
    disposition: 'retry_scheduled',
    reason: 'retryable_failure',
    delayMs,
    nextAttemptAt: nextAttempt.toString({ smallestUnit: 'millisecond' }),
  };
}
