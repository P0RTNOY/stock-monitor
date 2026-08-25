import { parseNotificationPayload } from './payload.ts';
import type {
  NotificationOutboxClaim,
  NotificationRepository,
} from './repository.ts';
import type {
  NotificationDeliveryFailure,
  NotificationRetryDecision,
} from './retry.ts';
import {
  NOTIFICATION_RETRYABLE_FAILURES,
  NOTIFICATION_TERMINAL_FAILURES,
} from './retry.ts';
import type { NotificationPayload } from './types.ts';

export type NotificationDeliveryAdapterResult =
  | { disposition: 'succeeded' }
  | { disposition: 'failed'; failure: NotificationDeliveryFailure };

/**
 * A future channel adapter must be injected explicitly. Phase 2C2A ships no
 * implementation and no production invocation path for this interface.
 */
export interface NotificationDeliveryAdapter {
  readonly kind: string;
  readonly version: string;
  deliver(payload: NotificationPayload): Promise<NotificationDeliveryAdapterResult>;
}

export type NotificationDeliveryRuntime = {
  now(): string;
  leaseExpiresAt(acquiredAt: string): string;
  token(kind: 'attempt' | 'owner'): string;
};

export type NotificationDispatchResult =
  | { disposition: 'adapter_not_configured' }
  | { disposition: 'nothing_claimable' }
  | { disposition: 'claim_lost'; claim: NotificationOutboxClaim }
  | { disposition: 'succeeded'; claim: NotificationOutboxClaim }
  | {
    disposition: 'retry_scheduled' | 'dead_letter';
    claim: NotificationOutboxClaim;
    retry: NotificationRetryDecision;
  };

function boundedAdapterIdentity(value: string) {
  return value.length > 0 && value.length <= 100 && value.trim() === value
    && /^[A-Za-z0-9._-]+$/u.test(value);
}

function validAdapterResult(value: unknown): value is NotificationDeliveryAdapterResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.disposition === 'succeeded') return Object.keys(row).length === 1;
  return row.disposition === 'failed' && Object.keys(row).length === 2
    && typeof row.failure === 'string'
    && (
      NOTIFICATION_RETRYABLE_FAILURES.includes(row.failure as never)
      || NOTIFICATION_TERMINAL_FAILURES.includes(row.failure as never)
    );
}

/**
 * Exercises the durable state machine only when a concrete adapter is
 * explicitly supplied. A missing adapter never claims or succeeds an item.
 */
export class NotificationDeliveryService {
  private readonly repository: NotificationRepository;
  private readonly runtime: NotificationDeliveryRuntime;

  constructor(repository: NotificationRepository, runtime: NotificationDeliveryRuntime) {
    this.repository = repository;
    this.runtime = runtime;
  }

  async dispatchOne(
    profileId: number,
    adapter: NotificationDeliveryAdapter | null,
  ): Promise<NotificationDispatchResult> {
    if (adapter === null) return { disposition: 'adapter_not_configured' };
    if (!boundedAdapterIdentity(adapter.kind) || !boundedAdapterIdentity(adapter.version)) {
      throw new Error('NotificationDeliveryAdapterIdentityInvalid');
    }
    const startedAt = this.runtime.now();
    const attemptId = this.runtime.token('attempt');
    const ownerToken = this.runtime.token('owner');
    const claim = await this.repository.claimNext({
      profileId,
      attemptId,
      ownerToken,
      now: startedAt,
      expiresAt: this.runtime.leaseExpiresAt(startedAt),
      adapterKind: adapter.kind,
      adapterVersion: adapter.version,
    });
    if (!claim) return { disposition: 'nothing_claimable' };

    let payload: NotificationPayload | null = null;
    try {
      payload = parseNotificationPayload(JSON.parse(claim.payloadJson) as unknown);
    } catch {
      // A poisoned persisted payload is terminal and must never reach an adapter.
    }
    let result: NotificationDeliveryAdapterResult = payload === null
      ? { disposition: 'failed', failure: 'invalid_payload' }
      : await adapter.deliver(payload).catch(() => ({
        disposition: 'failed' as const,
        failure: 'adapter_exception' as const,
      }));
    if (!validAdapterResult(result)) {
      result = { disposition: 'failed', failure: 'adapter_exception' };
    }
    const completedAt = this.runtime.now();
    if (result.disposition === 'succeeded') {
      const completed = await this.repository.completeSuccess({
        profileId,
        outboxId: claim.outboxId,
        attemptId: claim.attemptId,
        ownerToken,
        completedAt,
      });
      return completed
        ? { disposition: 'succeeded', claim }
        : { disposition: 'claim_lost', claim };
    }
    const retry = await this.repository.completeFailure({
      profileId,
      outboxId: claim.outboxId,
      attemptId: claim.attemptId,
      ownerToken,
      completedAt,
      failure: result.failure,
    });
    return retry
      ? { disposition: retry.disposition, claim, retry }
      : { disposition: 'claim_lost', claim };
  }
}
