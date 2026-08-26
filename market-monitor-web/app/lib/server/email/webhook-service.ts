import { parseResendWebhookEvent } from './webhook-contract.ts';
import type {
  EmailWebhookRepository,
  ResendWebhookPersistenceResult,
} from './webhook-repository.ts';
import { authorize } from '../auth/policy.ts';
import type { ResendProviderPrincipal } from '../auth/types.ts';

export type SafeWebhookLogger = {
  log(event: {
    event: 'resend_webhook_unsupported';
    eventType: string;
  }): void;
};

export type ResendWebhookServiceInput = {
  webhookId: string;
  verifiedPayload: unknown;
  rawBody: string;
  receivedAt: string;
};

export type ResendWebhookServiceResult = ResendWebhookPersistenceResult | {
  disposition: 'unsupported_unmapped';
};

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  ));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class ResendWebhookService {
  private readonly repository: EmailWebhookRepository;
  private readonly logger: SafeWebhookLogger;

  constructor(repository: EmailWebhookRepository, logger: SafeWebhookLogger) {
    this.repository = repository;
    this.logger = logger;
  }

  async process(
    principal: ResendProviderPrincipal,
    input: ResendWebhookServiceInput,
  ): Promise<ResendWebhookServiceResult> {
    if (!authorize(principal, 'resend_webhook_reconcile', {
      providerEventId: input.webhookId,
    }).allowed) throw new Error('ResendProviderAuthorizationDenied');
    const event = parseResendWebhookEvent(input.verifiedPayload);
    // Open/click and all other non-reconciliation events are deliberately not
    // tracked. A bounded, PII-free classification is enough to acknowledge a
    // correctly signed event without creating recipient activity history.
    if (!event.supported || event.providerEmailId === null) {
      this.logger.log({ event: 'resend_webhook_unsupported', eventType: event.type });
      return { disposition: 'unsupported_unmapped' };
    }
    const [id, payloadHash] = await Promise.all([
      sha256(`northstar:resend-webhook-event:v1:${input.webhookId}`),
      sha256(input.rawBody),
    ]);
    return this.repository.persistResendWebhook({
      id,
      providerEventId: input.webhookId,
      providerEmailId: event.providerEmailId,
      eventType: event.type,
      supported: event.supported,
      payloadHash,
      occurredAt: event.occurredAt,
      receivedAt: input.receivedAt,
      reconciliationState: event.reconciliationState,
      suppressionReason: event.suppressionReason,
      revokeConsent: event.revokeConsent,
    });
  }
}
