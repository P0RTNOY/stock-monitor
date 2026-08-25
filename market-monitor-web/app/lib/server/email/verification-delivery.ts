import { isCanonicalUtcInstant } from '../coordinator/contract.ts';
import {
  decodeEmailCapabilitySecret,
  requireLiveEmailConfiguration,
  type EmailConfiguration,
  type LiveEmailConfiguration,
} from './config.ts';
import {
  materializeEmailCapability,
  type PersistedEmailCapability,
} from './capability.ts';
import {
  EMAIL_DISPATCH_PROVIDER_RESERVE_MS,
  type EmailDispatchDelivery,
  type EmailProviderAdapter,
} from './dispatcher.ts';
import { parsePublicAppBaseUrl } from './links.ts';
import {
  createResendProviderIdentity,
  type ResendEmailRequest,
  type ResendProviderIdentity,
  type ResendSendResult,
} from './resend.ts';
import { renderVerificationEmail, type RenderedVerificationEmail } from './templates.ts';
import type { EmailRecipient } from './types.ts';

export const EMAIL_VERIFICATION_DELIVERY_VERSION = 'forecast-email-verification-delivery-1.0.0' as const;

export type VerificationDeliveryContext = {
  recipient: EmailRecipient | null;
  capability: {
    state: 'active' | 'consumed' | 'revoked' | 'expired';
    record: PersistedEmailCapability;
  } | null;
  existingDelivery: EmailDispatchDelivery | null;
};

export type BeginVerificationProviderAttemptResult =
  | { disposition: 'ready'; delivery: EmailDispatchDelivery; providerAttemptId: string }
  | { disposition: 'already_accepted'; delivery: EmailDispatchDelivery }
  | { disposition: 'safe_retry_window_expired'; delivery: EmailDispatchDelivery }
  | { disposition: 'integrity_conflict'; delivery: EmailDispatchDelivery | null }
  | { disposition: 'attempt_conflict'; delivery: EmailDispatchDelivery | null }
  | { disposition: 'context_changed'; delivery: EmailDispatchDelivery | null };

export type VerificationProviderCompletion = {
  disposition: 'retry_scheduled' | 'dead_letter' | 'attempt_lost';
  nextAttemptAt: string | null;
};

export interface VerificationEmailDeliveryRepository {
  loadVerificationContext(input: {
    profileId: number;
    checkedAt: string;
  }): Promise<VerificationDeliveryContext>;
  beginProviderAttempt(input: {
    profileId: number;
    recipientId: string;
    capabilityId: string;
    deliveryId: string;
    providerAttemptId: string;
    templateVersion: string;
    locale: string;
    contentHash: string;
    identity: ResendProviderIdentity;
    startedAt: string;
    minimumSafeRetryUntil: string;
  }): Promise<BeginVerificationProviderAttemptResult>;
  finalizeAcceptedRecovery(input: {
    profileId: number;
    recipientId: string;
    capabilityId: string;
    deliveryId: string;
    completedAt: string;
  }): Promise<boolean>;
  recordProviderAcceptance(input: {
    profileId: number;
    recipientId: string;
    capabilityId: string;
    deliveryId: string;
    providerAttemptId: string;
    identity: ResendProviderIdentity;
    providerEmailId: string;
    acceptedAt: string;
  }): Promise<'accepted' | 'accepted_context_changed' | 'integrity_conflict'>;
  completeProviderResult(input: {
    profileId: number;
    recipientId: string;
    capabilityId: string;
    deliveryId: string;
    providerAttemptId: string;
    result: Exclude<ResendSendResult, { disposition: 'accepted' }>;
    completedAt: string;
  }): Promise<VerificationProviderCompletion>;
  completeIntegrityFailure(input: {
    profileId: number;
    recipientId: string;
    capabilityId: string;
    deliveryId: string | null;
    completedAt: string;
    classification: 'idempotency_integrity_failure' | 'safe_retry_window_expired';
  }): Promise<VerificationProviderCompletion>;
  completeUnexpected(input: {
    profileId: number;
    recipientId: string;
    capabilityId: string;
    deliveryId: string;
    providerAttemptId: string;
    completedAt: string;
  }): Promise<VerificationProviderCompletion>;
}

export type VerificationEmailDeliveryRuntime = {
  now(): string;
  id(kind: 'verification_delivery' | 'verification_provider_attempt'): string;
};

export type SendVerificationEmailInput = {
  profileId: number;
  sendLive?: boolean;
};

export type VerificationEmailDeliveryDisposition =
  | 'dry_run_candidate'
  | 'configuration_disabled'
  | 'recipient_missing'
  | 'recipient_not_pending'
  | 'capability_missing'
  | 'capability_inactive'
  | 'capability_expired'
  | 'sent_request_accepted'
  | 'accepted_recovery'
  | 'duplicate_replayed'
  | 'retry_scheduled'
  | 'dead_letter'
  | 'attempt_conflict'
  | 'attempt_lost'
  | 'context_changed'
  | 'unexpected_error';

export type VerificationEmailDeliveryReport = {
  serviceVersion: typeof EMAIL_VERIFICATION_DELIVERY_VERSION;
  mode: 'dry_run' | 'live';
  disposition: VerificationEmailDeliveryDisposition;
  providerClassification: string | null;
  nextAttemptAt: string | null;
  providerCalled: boolean;
};

export class VerificationEmailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationEmailDeliveryError';
  }
}

type VerificationDeliveryDependencies = {
  render?: typeof renderVerificationEmail;
  createIdentity?: typeof createResendProviderIdentity;
  materializeCapability?: typeof materializeEmailCapability;
};

function validId(value: string) {
  return value.length > 0 && value.length <= 200 && value.trim() === value
    && /^[A-Za-z0-9._:-]+$/u.test(value);
}

function configurationShapeIsComplete(configuration: EmailConfiguration) {
  try {
    requireLiveEmailConfiguration({ ...configuration, dispatchEnabled: true });
    return true;
  } catch {
    return false;
  }
}

function contextDisposition(
  context: VerificationDeliveryContext,
  checkedAt: string,
): VerificationEmailDeliveryDisposition | null {
  if (!context.recipient) return 'recipient_missing';
  if (context.recipient.lifecycle !== 'pending') return 'recipient_not_pending';
  if (!context.capability) return 'capability_missing';
  if (context.capability.state === 'expired'
    || (context.capability.record.expiresAt !== null
      && checkedAt >= context.capability.record.expiresAt)) return 'capability_expired';
  if (context.capability.state !== 'active') return 'capability_inactive';
  if (context.capability.record.purpose !== 'verification'
    || context.capability.record.recipientId !== context.recipient.id
    || context.capability.record.consentRevision !== null
    || context.capability.record.expiresAt === null) return 'capability_inactive';
  if (context.existingDelivery
    && context.existingDelivery.recipientId !== context.recipient.id) return 'context_changed';
  return null;
}

function completionReport(
  result: Exclude<ResendSendResult, { disposition: 'accepted' }>,
  completion: VerificationProviderCompletion,
): VerificationEmailDeliveryReport {
  return {
    serviceVersion: EMAIL_VERIFICATION_DELIVERY_VERSION,
    mode: 'live',
    disposition: completion.disposition,
    providerClassification: result.classification,
    nextAttemptAt: completion.nextAttemptAt,
    providerCalled: true,
  };
}

export class VerificationEmailDeliveryService {
  private readonly repository: VerificationEmailDeliveryRepository;
  private readonly adapter: EmailProviderAdapter;
  private readonly configuration: EmailConfiguration;
  private readonly runtime: VerificationEmailDeliveryRuntime;
  private readonly render: typeof renderVerificationEmail;
  private readonly createIdentity: typeof createResendProviderIdentity;
  private readonly materializeCapability: typeof materializeEmailCapability;

  constructor(
    repository: VerificationEmailDeliveryRepository,
    adapter: EmailProviderAdapter,
    configuration: EmailConfiguration,
    runtime: VerificationEmailDeliveryRuntime,
    dependencies: VerificationDeliveryDependencies = {},
  ) {
    if (!validId(adapter.kind) || !validId(adapter.version)) {
      throw new VerificationEmailDeliveryError('Email provider adapter identity is invalid.');
    }
    this.repository = repository;
    this.adapter = adapter;
    this.configuration = configuration;
    this.runtime = runtime;
    this.render = dependencies.render ?? renderVerificationEmail;
    this.createIdentity = dependencies.createIdentity ?? createResendProviderIdentity;
    this.materializeCapability = dependencies.materializeCapability ?? materializeEmailCapability;
  }

  private now() {
    const value = this.runtime.now();
    if (!isCanonicalUtcInstant(value)) {
      throw new VerificationEmailDeliveryError('Verification delivery runtime returned an invalid instant.');
    }
    return value;
  }

  private id(kind: Parameters<VerificationEmailDeliveryRuntime['id']>[0]) {
    const value = this.runtime.id(kind);
    if (!validId(value)) {
      throw new VerificationEmailDeliveryError('Verification delivery runtime returned an invalid ID.');
    }
    return value;
  }

  private async request(
    context: VerificationDeliveryContext,
    live: LiveEmailConfiguration,
  ): Promise<{ rendered: RenderedVerificationEmail; request: ResendEmailRequest }> {
    if (!context.recipient || !context.capability || context.capability.record.expiresAt === null) {
      throw new VerificationEmailDeliveryError('Verification delivery context is incomplete.');
    }
    const token = await this.materializeCapability(
      context.capability.record,
      decodeEmailCapabilitySecret(live.capabilitySecret),
    );
    const rendered = await this.render({
      publicAppBaseUrl: parsePublicAppBaseUrl(live.publicAppUrl, live.environment),
      verificationToken: token,
      expiresAt: context.capability.record.expiresAt,
    });
    return {
      rendered,
      request: {
        from: live.from,
        to: [context.recipient.canonicalEmail],
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        ...(live.replyTo ? { replyTo: live.replyTo } : {}),
      },
    };
  }

  async send(input: SendVerificationEmailInput): Promise<VerificationEmailDeliveryReport> {
    if (!Number.isSafeInteger(input.profileId) || input.profileId <= 0) {
      throw new VerificationEmailDeliveryError('Trusted verification profile is invalid.');
    }
    if (input.sendLive !== undefined && typeof input.sendLive !== 'boolean') {
      throw new VerificationEmailDeliveryError('Verification live-send flag is invalid.');
    }
    const liveMode = input.sendLive === true;
    if (liveMode && !this.configuration.dispatchEnabled) {
      return {
        serviceVersion: EMAIL_VERIFICATION_DELIVERY_VERSION,
        mode: 'live',
        disposition: 'configuration_disabled',
        providerClassification: null,
        nextAttemptAt: null,
        providerCalled: false,
      };
    }
    const live = liveMode ? requireLiveEmailConfiguration(this.configuration) : null;
    const checkedAt = this.now();
    const context = await this.repository.loadVerificationContext({
      profileId: input.profileId, checkedAt,
    });
    const unavailable = contextDisposition(context, checkedAt);
    if (unavailable) {
      return {
        serviceVersion: EMAIL_VERIFICATION_DELIVERY_VERSION,
        mode: liveMode ? 'live' : 'dry_run',
        disposition: unavailable,
        providerClassification: null,
        nextAttemptAt: null,
        providerCalled: false,
      };
    }
    if (!liveMode) {
      if (!configurationShapeIsComplete(this.configuration)) {
        return {
          serviceVersion: EMAIL_VERIFICATION_DELIVERY_VERSION,
          mode: 'dry_run',
          disposition: 'configuration_disabled',
          providerClassification: 'invalid_configuration',
          nextAttemptAt: null,
          providerCalled: false,
        };
      }
      // Dry-run validates token reconstruction, the versioned template, and
      // provider identity without creating delivery or attempt evidence.
      const dryLive = requireLiveEmailConfiguration({
        ...this.configuration, dispatchEnabled: true,
      });
      const { rendered, request } = await this.request(context, dryLive);
      await this.createIdentity({
        deliveryId: context.existingDelivery?.id ?? 'verification_dry_run',
        templateVersion: rendered.templateVersion,
        environment: dryLive.environment,
        request,
      });
      return {
        serviceVersion: EMAIL_VERIFICATION_DELIVERY_VERSION,
        mode: 'dry_run',
        disposition: 'dry_run_candidate',
        providerClassification: null,
        nextAttemptAt: null,
        providerCalled: false,
      };
    }

    const current = context;
    const recipient = current.recipient as EmailRecipient;
    const capability = current.capability as NonNullable<VerificationDeliveryContext['capability']>;
    if (current.existingDelivery?.state === 'provider_accepted') {
      const finalized = await this.repository.finalizeAcceptedRecovery({
        profileId: input.profileId,
        recipientId: recipient.id,
        capabilityId: capability.record.id,
        deliveryId: current.existingDelivery.id,
        completedAt: this.now(),
      });
      return {
        serviceVersion: EMAIL_VERIFICATION_DELIVERY_VERSION,
        mode: 'live',
        disposition: finalized ? 'accepted_recovery' : 'context_changed',
        providerClassification: null,
        nextAttemptAt: null,
        providerCalled: false,
      };
    }

    let started: {
      deliveryId: string;
      providerAttemptId: string;
    } | null = null;
    let providerCalled = false;
    try {
      const { rendered, request } = await this.request(current, live as LiveEmailConfiguration);
      const deliveryId = current.existingDelivery?.id ?? this.id('verification_delivery');
      const identity = await this.createIdentity({
        deliveryId,
        templateVersion: rendered.templateVersion,
        environment: (live as LiveEmailConfiguration).environment,
        request,
      });
      if (current.existingDelivery
        && (current.existingDelivery.templateVersion !== rendered.templateVersion
          || current.existingDelivery.contentHash !== rendered.contentHash
          || current.existingDelivery.idempotencyKey !== identity.idempotencyKey
          || current.existingDelivery.canonicalRequestHash !== identity.canonicalRequestHash)) {
        const completion = await this.repository.completeIntegrityFailure({
          profileId: input.profileId, recipientId: recipient.id,
          capabilityId: capability.record.id, deliveryId: current.existingDelivery.id,
          completedAt: this.now(), classification: 'idempotency_integrity_failure',
        });
        return {
          serviceVersion: EMAIL_VERIFICATION_DELIVERY_VERSION,
          mode: 'live', disposition: completion.disposition,
          providerClassification: 'idempotency_integrity_failure',
          nextAttemptAt: completion.nextAttemptAt, providerCalled: false,
        };
      }

      const retryCheckedAt = this.now();
      const minimumSafeRetryUntil = new Date(
        Date.parse(retryCheckedAt)
          + (live as LiveEmailConfiguration).providerTimeoutMs
          + EMAIL_DISPATCH_PROVIDER_RESERVE_MS,
      ).toISOString();
      if (current.existingDelivery
        && (current.existingDelivery.safeRetryUntil === null
          || !isCanonicalUtcInstant(current.existingDelivery.safeRetryUntil)
          || current.existingDelivery.safeRetryUntil <= minimumSafeRetryUntil)) {
        const completion = await this.repository.completeIntegrityFailure({
          profileId: input.profileId, recipientId: recipient.id,
          capabilityId: capability.record.id, deliveryId: current.existingDelivery.id,
          completedAt: retryCheckedAt, classification: 'safe_retry_window_expired',
        });
        return {
          serviceVersion: EMAIL_VERIFICATION_DELIVERY_VERSION,
          mode: 'live', disposition: completion.disposition,
          providerClassification: 'safe_retry_window_expired',
          nextAttemptAt: completion.nextAttemptAt, providerCalled: false,
        };
      }

      const providerAttemptId = this.id('verification_provider_attempt');
      const begun = await this.repository.beginProviderAttempt({
        profileId: input.profileId,
        recipientId: recipient.id,
        capabilityId: capability.record.id,
        deliveryId,
        providerAttemptId,
        templateVersion: rendered.templateVersion,
        locale: rendered.locale,
        contentHash: rendered.contentHash,
        identity,
        startedAt: this.now(),
        minimumSafeRetryUntil,
      });
      if (begun.disposition === 'already_accepted') {
        const finalized = await this.repository.finalizeAcceptedRecovery({
          profileId: input.profileId, recipientId: recipient.id,
          capabilityId: capability.record.id, deliveryId: begun.delivery.id,
          completedAt: this.now(),
        });
        return {
          serviceVersion: EMAIL_VERIFICATION_DELIVERY_VERSION,
          mode: 'live', disposition: finalized ? 'duplicate_replayed' : 'context_changed',
          providerClassification: null, nextAttemptAt: null, providerCalled: false,
        };
      }
      if (begun.disposition === 'safe_retry_window_expired') {
        const completion = await this.repository.completeIntegrityFailure({
          profileId: input.profileId, recipientId: recipient.id,
          capabilityId: capability.record.id, deliveryId: begun.delivery.id,
          completedAt: this.now(), classification: 'safe_retry_window_expired',
        });
        return {
          serviceVersion: EMAIL_VERIFICATION_DELIVERY_VERSION,
          mode: 'live', disposition: completion.disposition,
          providerClassification: 'safe_retry_window_expired',
          nextAttemptAt: completion.nextAttemptAt, providerCalled: false,
        };
      }
      if (begun.disposition === 'integrity_conflict') {
        const completion = await this.repository.completeIntegrityFailure({
          profileId: input.profileId, recipientId: recipient.id,
          capabilityId: capability.record.id, deliveryId: begun.delivery?.id ?? null,
          completedAt: this.now(), classification: 'idempotency_integrity_failure',
        });
        return {
          serviceVersion: EMAIL_VERIFICATION_DELIVERY_VERSION,
          mode: 'live', disposition: completion.disposition,
          providerClassification: 'idempotency_integrity_failure',
          nextAttemptAt: completion.nextAttemptAt, providerCalled: false,
        };
      }
      if (begun.disposition === 'attempt_conflict' || begun.disposition === 'context_changed') {
        return {
          serviceVersion: EMAIL_VERIFICATION_DELIVERY_VERSION,
          mode: 'live', disposition: begun.disposition,
          providerClassification: null, nextAttemptAt: null, providerCalled: false,
        };
      }

      // Both the immutable delivery identity and append-only attempt exist
      // before this provider call.
      started = { deliveryId: begun.delivery.id, providerAttemptId: begun.providerAttemptId };
      providerCalled = true;
      const result = await this.adapter.send({ request, ...identity });
      if (result.disposition === 'accepted') {
        const recorded = await this.repository.recordProviderAcceptance({
          profileId: input.profileId, recipientId: recipient.id,
          capabilityId: capability.record.id, deliveryId: begun.delivery.id,
          providerAttemptId: begun.providerAttemptId, identity,
          providerEmailId: result.providerEmailId, acceptedAt: this.now(),
        });
        return {
          serviceVersion: EMAIL_VERIFICATION_DELIVERY_VERSION,
          mode: 'live',
          disposition: recorded === 'accepted'
            ? 'sent_request_accepted'
            : recorded === 'accepted_context_changed' ? 'sent_request_accepted' : 'dead_letter',
          providerClassification: recorded === 'accepted_context_changed'
            ? 'context_changed_after_provider_acceptance'
            : recorded === 'integrity_conflict' ? 'idempotency_integrity_failure' : null,
          nextAttemptAt: null,
          providerCalled: true,
        };
      }
      const completion = await this.repository.completeProviderResult({
        profileId: input.profileId, recipientId: recipient.id,
        capabilityId: capability.record.id, deliveryId: begun.delivery.id,
        providerAttemptId: begun.providerAttemptId, result, completedAt: this.now(),
      });
      return completionReport(result, completion);
    } catch {
      if (started) {
        const completion = await this.repository.completeUnexpected({
          profileId: input.profileId,
          recipientId: recipient.id,
          capabilityId: capability.record.id,
          deliveryId: started.deliveryId,
          providerAttemptId: started.providerAttemptId,
          completedAt: this.now(),
        }).catch(() => ({ disposition: 'attempt_lost' as const, nextAttemptAt: null }));
        return {
          serviceVersion: EMAIL_VERIFICATION_DELIVERY_VERSION,
          mode: 'live', disposition: completion.disposition,
          providerClassification: 'unexpected_verification_delivery_error',
          nextAttemptAt: completion.nextAttemptAt, providerCalled,
        };
      }
      return {
        serviceVersion: EMAIL_VERIFICATION_DELIVERY_VERSION,
        mode: 'live', disposition: 'unexpected_error',
        providerClassification: 'unexpected_verification_delivery_error',
        nextAttemptAt: null, providerCalled,
      };
    }
  }
}
