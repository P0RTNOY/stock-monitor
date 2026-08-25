import { isCanonicalUtcInstant } from '../coordinator/contract.ts';
import type { NotificationCategory } from '../notifications/types.ts';
import type { NotificationPreferenceSnapshot } from '../notifications/preference.ts';
import { decodeEmailCapabilitySecret } from './config.ts';
import {
  type EmailConfiguration,
  type LiveEmailConfiguration,
  requireLiveEmailConfiguration,
} from './config.ts';
import {
  materializeEmailCapability,
  type PersistedEmailCapability,
} from './capability.ts';
import { parsePublicAppBaseUrl } from './links.ts';
import {
  evaluateEmailPreSendPolicy,
  type EmailPreSendPolicyResult,
} from './presend-policy.ts';
import {
  createResendProviderIdentity,
  type ResendEmailRequest,
  type ResendProviderIdentity,
  type ResendSendResult,
} from './resend.ts';
import { renderForecastEmail, type RenderedForecastEmail } from './templates.ts';
import {
  FORECAST_EMAIL_DISPATCHER_VERSION,
  type EmailConsentSnapshot,
  type EmailPreSendDecision,
  type EmailRecipient,
} from './types.ts';

export const EMAIL_DISPATCH_DEFAULT_MAX_RUNTIME_MS = 30_000;
export const EMAIL_DISPATCH_HARD_MAX_RUNTIME_MS = 120_000;
export const EMAIL_DISPATCH_MIN_RUNTIME_MS = 1_000;
export const EMAIL_DISPATCH_PROVIDER_RESERVE_MS = 1_000;

export type EmailDispatchPosition = {
  eligibleAt: string;
  outboxId: string;
};

export type EmailDispatchCandidate = EmailDispatchPosition;

export type EmailDispatchClaim = {
  outboxId: string;
  intentId: string;
  notificationAttemptId: string;
  notificationAttemptNumber: number;
  category: NotificationCategory;
  payload: unknown;
  availableAt: string;
  outboxCreatedAt: string;
  leaseExpiresAt: string;
};

export type EmailDispatchDelivery = {
  id: string;
  recipientId: string;
  templateVersion: string;
  contentHash: string;
  idempotencyKey: string;
  canonicalRequestHash: string;
  state: 'prepared' | 'request_started' | 'provider_accepted' | 'ambiguous'
    | 'terminal_failure' | 'dead_letter';
  requestStartedAt: string | null;
  safeRetryUntil: string | null;
  providerEmailId: string | null;
};

export type EmailDispatchContext = {
  category: NotificationCategory;
  payload: unknown;
  availableAt: string;
  outboxCreatedAt: string;
  claimValid: boolean;
  supportedTemplate: boolean;
  currentRecipient: EmailRecipient | null;
  notificationPreference: NotificationPreferenceSnapshot | null;
  emailConsent: EmailConsentSnapshot | null;
  unsubscribeCapability: PersistedEmailCapability | null;
  existingDelivery: EmailDispatchDelivery | null;
};

export type BeginEmailProviderAttemptResult =
  | { disposition: 'ready'; delivery: EmailDispatchDelivery; providerAttemptId: string }
  | { disposition: 'already_accepted'; delivery: EmailDispatchDelivery }
  | { disposition: 'safe_retry_window_expired'; delivery: EmailDispatchDelivery }
  | { disposition: 'integrity_conflict'; delivery: EmailDispatchDelivery | null }
  | { disposition: 'claim_lost'; delivery: EmailDispatchDelivery | null };

export type CompleteEmailProviderResult = {
  disposition: 'retry_scheduled' | 'dead_letter' | 'claim_lost';
  nextAttemptAt: string | null;
};

export interface EmailDispatcherRepository {
  selectCandidates(input: {
    profileId: number;
    cutoff: string;
    after: EmailDispatchPosition | null;
    limit: number;
  }): Promise<EmailDispatchCandidate[]>;
  previewContext(input: {
    profileId: number;
    outboxId: string;
    checkedAt: string;
  }): Promise<EmailDispatchContext | null>;
  claimCandidate(input: {
    profileId: number;
    outboxId: string;
    notificationAttemptId: string;
    ownerToken: string;
    claimedAt: string;
    leaseExpiresAt: string;
    adapterKind: string;
    adapterVersion: string;
  }): Promise<EmailDispatchClaim | null>;
  loadClaimContext(input: {
    profileId: number;
    outboxId: string;
    notificationAttemptId: string;
    ownerToken: string;
    checkedAt: string;
  }): Promise<EmailDispatchContext | null>;
  renewClaim(input: {
    profileId: number;
    outboxId: string;
    ownerToken: string;
    renewedAt: string;
    leaseExpiresAt: string;
  }): Promise<boolean>;
  completePolicyOutcome(input: {
    profileId: number;
    outboxId: string;
    notificationAttemptId: string;
    ownerToken: string;
    preSendDecisionId: string;
    checkedAt: string;
    policy: EmailPreSendPolicyResult;
  }): Promise<boolean>;
  beginProviderAttempt(input: {
    profileId: number;
    claim: EmailDispatchClaim;
    ownerToken: string;
    preSendDecisionId: string;
    deliveryId: string;
    providerAttemptId: string;
    recipientId: string;
    unsubscribeCapabilityId: string;
    notificationPreferenceRevision: number;
    emailConsentRevision: number;
    templateKind: NotificationCategory;
    templateVersion: string;
    locale: string;
    contentHash: string;
    identity: ResendProviderIdentity;
    startedAt: string;
  }): Promise<BeginEmailProviderAttemptResult>;
  finalizeAcceptedRecovery(input: {
    profileId: number;
    outboxId: string;
    notificationAttemptId: string;
    ownerToken: string;
    deliveryId: string;
    completedAt: string;
  }): Promise<boolean>;
  recordProviderAcceptance(input: {
    profileId: number;
    outboxId: string;
    notificationAttemptId: string;
    ownerToken: string;
    deliveryId: string;
    providerAttemptId: string;
    identity: ResendProviderIdentity;
    providerEmailId: string;
    acceptedAt: string;
  }): Promise<'accepted' | 'accepted_claim_lost' | 'integrity_conflict'>;
  completeProviderResult(input: {
    profileId: number;
    outboxId: string;
    notificationAttemptId: string;
    ownerToken: string;
    deliveryId: string;
    providerAttemptId: string;
    result: Exclude<ResendSendResult, { disposition: 'accepted' }>;
    completedAt: string;
  }): Promise<CompleteEmailProviderResult>;
  completeIntegrityFailure(input: {
    profileId: number;
    outboxId: string;
    notificationAttemptId: string;
    ownerToken: string;
    deliveryId: string | null;
    completedAt: string;
    classification: 'idempotency_integrity_failure' | 'safe_retry_window_expired';
  }): Promise<CompleteEmailProviderResult>;
  completeUnexpected(input: {
    profileId: number;
    outboxId: string;
    notificationAttemptId: string;
    ownerToken: string;
    completedAt: string;
  }): Promise<CompleteEmailProviderResult>;
}

export type EmailDispatcherRuntime = {
  now(): string;
  elapsedMs(startedAt: string): number;
  leaseExpiresAt(acquiredAt: string): string;
  id(kind: 'notification_attempt' | 'owner' | 'pre_send_decision'
    | 'email_delivery' | 'provider_attempt'): string;
};

export type EmailProviderAdapter = {
  readonly kind: string;
  readonly version: string;
  send(input: ResendProviderIdentity & { request: ResendEmailRequest }): Promise<ResendSendResult>;
};

export type ForecastEmailDispatchInput = {
  profileId: number;
  cutoff: string;
  limit?: number;
  maxRuntimeMs?: number;
  sendLive?: boolean;
};

export type EmailDispatchItemDisposition =
  | 'dry_run_candidate'
  | 'sent_request_accepted'
  | 'accepted_recovery'
  | 'deferred_quiet_hours'
  | 'suppressed'
  | 'duplicate_replayed'
  | 'claim_conflict'
  | 'retry_scheduled'
  | 'dead_letter'
  | 'claim_lost'
  | 'unexpected_error';

export type ForecastEmailDispatchItemReport = {
  outboxId: string;
  disposition: EmailDispatchItemDisposition;
  policyDecision: EmailPreSendDecision | null;
  providerClassification: string | null;
  nextAttemptAt: string | null;
};

export type ForecastEmailDispatchReport = {
  dispatcherVersion: typeof FORECAST_EMAIL_DISPATCHER_VERSION;
  mode: 'dry_run' | 'live';
  cutoff: string;
  disposition: 'completed' | 'configuration_disabled' | 'runtime_budget_reached';
  selectedCount: number;
  attemptedCount: number;
  acceptedCount: number;
  deferredCount: number;
  suppressedCount: number;
  retryScheduledCount: number;
  deadLetterCount: number;
  claimConflictCount: number;
  unexpectedErrorCount: number;
  durationMs: number;
  items: ForecastEmailDispatchItemReport[];
};

export class EmailDispatcherContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailDispatcherContractError';
  }
}

type DispatcherDependencies = {
  render?: typeof renderForecastEmail;
  createIdentity?: typeof createResendProviderIdentity;
  materializeCapability?: typeof materializeEmailCapability;
};

function positiveInteger(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || typeof value !== 'number'
    || value < minimum || value > maximum) {
    throw new EmailDispatcherContractError(`${label} is invalid.`);
  }
  return value;
}

function validId(value: string) {
  return value.length > 0 && value.length <= 200 && value.trim() === value
    && /^[A-Za-z0-9._:-]+$/u.test(value);
}

function comparePosition(left: EmailDispatchPosition, right: EmailDispatchPosition) {
  return left.eligibleAt.localeCompare(right.eligibleAt) || left.outboxId.localeCompare(right.outboxId);
}

function validateCandidates(candidates: EmailDispatchCandidate[], cutoff: string, limit: number) {
  if (!Array.isArray(candidates) || candidates.length > limit) {
    throw new EmailDispatcherContractError('Email candidate page exceeds its bound.');
  }
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate || !isCanonicalUtcInstant(candidate.eligibleAt)
      || candidate.eligibleAt > cutoff || !validId(candidate.outboxId)
      || (index > 0 && comparePosition(candidates[index - 1], candidate) >= 0)) {
      throw new EmailDispatcherContractError('Email candidate page is invalid or unstable.');
    }
  }
}

function policyInput(
  context: EmailDispatchContext,
  checkedAt: string,
  cutoff: string,
  configurationValid: boolean,
) {
  return {
    checkedAt,
    cutoff,
    category: context.category,
    availableAt: context.availableAt,
    outboxCreatedAt: context.outboxCreatedAt,
    claimValid: context.claimValid,
    supportedTemplate: context.supportedTemplate,
    configurationValid: configurationValid && context.unsubscribeCapability !== null,
    providerAlreadyAccepted: context.existingDelivery?.state === 'provider_accepted',
    preparedRecipientId: context.existingDelivery?.recipientId ?? null,
    currentRecipient: context.currentRecipient,
    notificationPreference: context.notificationPreference,
    emailConsent: context.emailConsent,
  };
}

function liveConfigurationIsComplete(configuration: EmailConfiguration) {
  try {
    requireLiveEmailConfiguration(configuration);
    return true;
  } catch {
    return false;
  }
}

function suppressionDisposition(decision: EmailPreSendDecision): EmailDispatchItemDisposition {
  return decision === 'deferred_quiet_hours' ? 'deferred_quiet_hours' : 'suppressed';
}

function providerReport(
  outboxId: string,
  result: Exclude<ResendSendResult, { disposition: 'accepted' }>,
  completed: CompleteEmailProviderResult,
): ForecastEmailDispatchItemReport {
  return {
    outboxId,
    disposition: completed.disposition,
    policyDecision: 'eligible',
    providerClassification: result.classification,
    nextAttemptAt: completed.nextAttemptAt,
  };
}

export class ForecastEmailDispatcherService {
  private readonly repository: EmailDispatcherRepository;
  private readonly adapter: EmailProviderAdapter;
  private readonly configuration: EmailConfiguration;
  private readonly runtime: EmailDispatcherRuntime;
  private readonly render: typeof renderForecastEmail;
  private readonly createIdentity: typeof createResendProviderIdentity;
  private readonly materializeCapability: typeof materializeEmailCapability;

  constructor(
    repository: EmailDispatcherRepository,
    adapter: EmailProviderAdapter,
    configuration: EmailConfiguration,
    runtime: EmailDispatcherRuntime,
    dependencies: DispatcherDependencies = {},
  ) {
    if (!validId(adapter.kind) || !validId(adapter.version)) {
      throw new EmailDispatcherContractError('Email provider adapter identity is invalid.');
    }
    this.repository = repository;
    this.adapter = adapter;
    this.configuration = configuration;
    this.runtime = runtime;
    this.render = dependencies.render ?? renderForecastEmail;
    this.createIdentity = dependencies.createIdentity ?? createResendProviderIdentity;
    this.materializeCapability = dependencies.materializeCapability ?? materializeEmailCapability;
  }

  private now() {
    const value = this.runtime.now();
    if (!isCanonicalUtcInstant(value)) {
      throw new EmailDispatcherContractError('Email dispatcher runtime returned an invalid instant.');
    }
    return value;
  }

  private id(kind: Parameters<EmailDispatcherRuntime['id']>[0]) {
    const value = this.runtime.id(kind);
    if (!validId(value)) throw new EmailDispatcherContractError('Email dispatcher runtime returned an invalid ID.');
    return value;
  }

  private leaseExpiry(acquiredAt: string) {
    const value = this.runtime.leaseExpiresAt(acquiredAt);
    if (!isCanonicalUtcInstant(value) || value <= acquiredAt) {
      throw new EmailDispatcherContractError('Email dispatcher runtime returned an invalid lease expiry.');
    }
    return value;
  }

  private async renderRequest(
    context: EmailDispatchContext,
    live: LiveEmailConfiguration,
  ): Promise<{ rendered: RenderedForecastEmail; request: ResendEmailRequest }> {
    if (!context.currentRecipient || !context.unsubscribeCapability) {
      throw new EmailDispatcherContractError('Eligible email context is incomplete.');
    }
    const token = await this.materializeCapability(
      context.unsubscribeCapability,
      decodeEmailCapabilitySecret(live.capabilitySecret),
    );
    const rendered = await this.render({
      payload: context.payload,
      publicAppBaseUrl: parsePublicAppBaseUrl(live.publicAppUrl, live.environment),
      unsubscribeToken: token,
    });
    const request: ResendEmailRequest = {
      from: live.from,
      to: [context.currentRecipient.canonicalEmail],
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      ...(live.replyTo ? { replyTo: live.replyTo } : {}),
      headers: rendered.headers,
    };
    return { rendered, request };
  }

  private async dryRunCandidate(
    profileId: number,
    candidate: EmailDispatchCandidate,
    cutoff: string,
  ): Promise<ForecastEmailDispatchItemReport> {
    const checkedAt = this.now();
    const context = await this.repository.previewContext({
      profileId, outboxId: candidate.outboxId, checkedAt,
    });
    if (!context) {
      return {
        outboxId: candidate.outboxId, disposition: 'claim_conflict',
        policyDecision: null, providerClassification: null, nextAttemptAt: null,
      };
    }
    const policy = evaluateEmailPreSendPolicy(
      policyInput(context, checkedAt, cutoff, liveConfigurationIsComplete(this.configuration)),
      profileId,
    );
    return {
      outboxId: candidate.outboxId,
      disposition: 'dry_run_candidate',
      policyDecision: policy.decision,
      providerClassification: null,
      nextAttemptAt: policy.nextAvailableAt,
    };
  }

  private async liveCandidate(
    profileId: number,
    candidate: EmailDispatchCandidate,
    cutoff: string,
    live: LiveEmailConfiguration,
  ): Promise<ForecastEmailDispatchItemReport> {
    const claimedAt = this.now();
    const ownerToken = this.id('owner');
    const notificationAttemptId = this.id('notification_attempt');
    const claimLeaseExpiresAt = this.leaseExpiry(claimedAt);
    const claim = await this.repository.claimCandidate({
      profileId,
      outboxId: candidate.outboxId,
      notificationAttemptId,
      ownerToken,
      claimedAt,
      leaseExpiresAt: claimLeaseExpiresAt,
      adapterKind: this.adapter.kind,
      adapterVersion: this.adapter.version,
    });
    if (!claim) {
      return {
        outboxId: candidate.outboxId, disposition: 'claim_conflict',
        policyDecision: null, providerClassification: null, nextAttemptAt: null,
      };
    }

    const preSendDecisionId = this.id('pre_send_decision');
    try {
      const checkedAt = this.now();
      const context = await this.repository.loadClaimContext({
        profileId,
        outboxId: claim.outboxId,
        notificationAttemptId: claim.notificationAttemptId,
        ownerToken,
        checkedAt,
      });
      if (!context) {
        return {
          outboxId: claim.outboxId, disposition: 'claim_lost',
          policyDecision: null, providerClassification: null, nextAttemptAt: null,
        };
      }
      const policy = evaluateEmailPreSendPolicy(
        policyInput(context, checkedAt, cutoff, true), profileId,
      );

      if (policy.decision === 'suppressed_already_accepted' && context.existingDelivery) {
        const finalized = await this.repository.finalizeAcceptedRecovery({
          profileId,
          outboxId: claim.outboxId,
          notificationAttemptId: claim.notificationAttemptId,
          ownerToken,
          deliveryId: context.existingDelivery.id,
          completedAt: this.now(),
        });
        return {
          outboxId: claim.outboxId,
          disposition: finalized ? 'accepted_recovery' : 'claim_lost',
          policyDecision: policy.decision,
          providerClassification: null,
          nextAttemptAt: null,
        };
      }
      if (policy.decision !== 'eligible') {
        const completed = await this.repository.completePolicyOutcome({
          profileId,
          outboxId: claim.outboxId,
          notificationAttemptId: claim.notificationAttemptId,
          ownerToken,
          preSendDecisionId,
          checkedAt,
          policy,
        });
        return {
          outboxId: claim.outboxId,
          disposition: completed ? suppressionDisposition(policy.decision) : 'claim_lost',
          policyDecision: policy.decision,
          providerClassification: null,
          nextAttemptAt: policy.nextAvailableAt,
        };
      }
      if (policy.recipientId === null || policy.notificationPreferenceRevision === null
        || policy.emailConsentRevision === null || !context.unsubscribeCapability) {
        throw new EmailDispatcherContractError('Eligible pre-send policy is incomplete.');
      }

      const { rendered, request } = await this.renderRequest(context, live);
      const deliveryId = context.existingDelivery?.id ?? this.id('email_delivery');
      const identity = await this.createIdentity({
        deliveryId,
        templateVersion: rendered.templateVersion,
        environment: live.environment,
        request,
      });
      if (context.existingDelivery
        && (context.existingDelivery.recipientId !== policy.recipientId
          || context.existingDelivery.templateVersion !== rendered.templateVersion
          || context.existingDelivery.contentHash !== rendered.contentHash
          || context.existingDelivery.idempotencyKey !== identity.idempotencyKey
          || context.existingDelivery.canonicalRequestHash !== identity.canonicalRequestHash)) {
        const mismatch: Exclude<ResendSendResult, { disposition: 'accepted' }> = {
          disposition: 'terminal', classification: 'idempotency_integrity_failure',
        };
        const completed = await this.repository.completeIntegrityFailure({
          profileId, outboxId: claim.outboxId,
          notificationAttemptId: claim.notificationAttemptId,
          ownerToken, deliveryId: context.existingDelivery.id,
          completedAt: this.now(), classification: 'idempotency_integrity_failure',
        });
        return providerReport(claim.outboxId, mismatch, completed);
      }

      const retryCheckedAt = this.now();
      const requiredSafeRetryUntil = Date.parse(retryCheckedAt)
        + live.providerTimeoutMs + EMAIL_DISPATCH_PROVIDER_RESERVE_MS;
      if (context.existingDelivery
        && (context.existingDelivery.safeRetryUntil === null
          || !isCanonicalUtcInstant(context.existingDelivery.safeRetryUntil)
          || Date.parse(context.existingDelivery.safeRetryUntil) <= requiredSafeRetryUntil)) {
        const expired: Exclude<ResendSendResult, { disposition: 'accepted' }> = {
          disposition: 'terminal', classification: 'idempotency_integrity_failure',
        };
        const completed = await this.repository.completeIntegrityFailure({
          profileId, outboxId: claim.outboxId,
          notificationAttemptId: claim.notificationAttemptId,
          ownerToken, deliveryId: context.existingDelivery.id,
          completedAt: retryCheckedAt, classification: 'safe_retry_window_expired',
        });
        return {
          ...providerReport(claim.outboxId, expired, completed),
          providerClassification: 'safe_retry_window_expired',
        };
      }

      const renewedAt = this.now();
      const leaseExpiresAt = this.leaseExpiry(renewedAt);
      if (Date.parse(leaseExpiresAt) - Date.parse(renewedAt)
        <= live.providerTimeoutMs + EMAIL_DISPATCH_PROVIDER_RESERVE_MS
        || !await this.repository.renewClaim({
          profileId,
          outboxId: claim.outboxId,
          ownerToken,
          renewedAt,
          leaseExpiresAt,
        })) {
        return {
          outboxId: claim.outboxId, disposition: 'claim_lost',
          policyDecision: 'eligible', providerClassification: null, nextAttemptAt: null,
        };
      }

      const providerAttemptId = this.id('provider_attempt');
      const begun = await this.repository.beginProviderAttempt({
        profileId,
        claim,
        ownerToken,
        preSendDecisionId,
        deliveryId,
        providerAttemptId,
        recipientId: policy.recipientId,
        unsubscribeCapabilityId: context.unsubscribeCapability.id,
        notificationPreferenceRevision: policy.notificationPreferenceRevision,
        emailConsentRevision: policy.emailConsentRevision,
        templateKind: context.category,
        templateVersion: rendered.templateVersion,
        locale: rendered.locale,
        contentHash: rendered.contentHash,
        identity,
        startedAt: this.now(),
      });
      if (begun.disposition === 'already_accepted') {
        const finalized = await this.repository.finalizeAcceptedRecovery({
          profileId, outboxId: claim.outboxId,
          notificationAttemptId: claim.notificationAttemptId, ownerToken,
          deliveryId: begun.delivery.id, completedAt: this.now(),
        });
        return {
          outboxId: claim.outboxId,
          disposition: finalized ? 'duplicate_replayed' : 'claim_lost',
          policyDecision: 'eligible', providerClassification: null, nextAttemptAt: null,
        };
      }
      if (begun.disposition === 'safe_retry_window_expired') {
        const expired: Exclude<ResendSendResult, { disposition: 'accepted' }> = {
          disposition: 'terminal', classification: 'idempotency_integrity_failure',
        };
        const completed = await this.repository.completeIntegrityFailure({
          profileId, outboxId: claim.outboxId,
          notificationAttemptId: claim.notificationAttemptId, ownerToken,
          deliveryId: begun.delivery.id, completedAt: this.now(),
          classification: 'safe_retry_window_expired',
        });
        return {
          ...providerReport(claim.outboxId, expired, completed),
          providerClassification: 'safe_retry_window_expired',
        };
      }
      if (begun.disposition === 'integrity_conflict') {
        const conflict: Exclude<ResendSendResult, { disposition: 'accepted' }> = {
          disposition: 'terminal', classification: 'idempotency_integrity_failure',
        };
        const completed = await this.repository.completeIntegrityFailure({
          profileId, outboxId: claim.outboxId,
          notificationAttemptId: claim.notificationAttemptId,
          ownerToken, deliveryId: begun.delivery?.id ?? null,
          completedAt: this.now(), classification: 'idempotency_integrity_failure',
        });
        return providerReport(claim.outboxId, conflict, completed);
      }
      if (begun.disposition === 'claim_lost') {
        return {
          outboxId: claim.outboxId, disposition: 'claim_lost', policyDecision: 'eligible',
          providerClassification: null, nextAttemptAt: null,
        };
      }

      // The provider boundary is reached only after the immutable delivery and
      // append-only provider attempt have been durably started.
      const providerResult = await this.adapter.send({ request, ...identity });
      const completedAt = this.now();
      if (providerResult.disposition === 'accepted') {
        const recorded = await this.repository.recordProviderAcceptance({
          profileId, outboxId: claim.outboxId,
          notificationAttemptId: claim.notificationAttemptId, ownerToken,
          deliveryId: begun.delivery.id, providerAttemptId: begun.providerAttemptId,
          identity, providerEmailId: providerResult.providerEmailId, acceptedAt: completedAt,
        });
        return {
          outboxId: claim.outboxId,
          disposition: recorded === 'accepted'
            ? 'sent_request_accepted'
            : recorded === 'accepted_claim_lost' ? 'sent_request_accepted' : 'dead_letter',
          policyDecision: 'eligible',
          providerClassification: recorded === 'integrity_conflict'
            ? 'idempotency_integrity_failure'
            : recorded === 'accepted_claim_lost' ? 'claim_lost_after_provider_acceptance' : null,
          nextAttemptAt: null,
        };
      }
      const completed = await this.repository.completeProviderResult({
        profileId, outboxId: claim.outboxId,
        notificationAttemptId: claim.notificationAttemptId, ownerToken,
        deliveryId: begun.delivery.id, providerAttemptId: begun.providerAttemptId,
        result: providerResult, completedAt,
      });
      return providerReport(claim.outboxId, providerResult, completed);
    } catch {
      const completed = await this.repository.completeUnexpected({
        profileId,
        outboxId: claim.outboxId,
        notificationAttemptId: claim.notificationAttemptId,
        ownerToken,
        completedAt: this.now(),
      }).catch(() => ({ disposition: 'claim_lost' as const, nextAttemptAt: null }));
      return {
        outboxId: claim.outboxId,
        disposition: completed.disposition === 'claim_lost'
          ? 'claim_lost' : completed.disposition,
        policyDecision: null,
        providerClassification: 'unexpected_dispatch_error',
        nextAttemptAt: completed.nextAttemptAt,
      };
    }
  }

  async dispatch(input: ForecastEmailDispatchInput): Promise<ForecastEmailDispatchReport> {
    if (!Number.isSafeInteger(input.profileId) || input.profileId <= 0) {
      throw new EmailDispatcherContractError('Trusted email dispatch profile is invalid.');
    }
    if (!isCanonicalUtcInstant(input.cutoff)) {
      throw new EmailDispatcherContractError('Email dispatch cutoff must be canonical UTC.');
    }
    if (typeof input.sendLive !== 'undefined' && typeof input.sendLive !== 'boolean') {
      throw new EmailDispatcherContractError('Email dispatch live-send flag is invalid.');
    }
    const limit = positiveInteger(
      input.limit ?? this.configuration.dispatcherLimit,
      'Email dispatch limit', 1, this.configuration.dispatcherLimit,
    );
    const maxRuntimeMs = positiveInteger(
      input.maxRuntimeMs ?? EMAIL_DISPATCH_DEFAULT_MAX_RUNTIME_MS,
      'Email dispatch runtime budget',
      EMAIL_DISPATCH_MIN_RUNTIME_MS,
      EMAIL_DISPATCH_HARD_MAX_RUNTIME_MS,
    );
    const sendLive = input.sendLive === true;
    const startedAt = this.now();
    if (sendLive && !this.configuration.dispatchEnabled) {
      return {
        dispatcherVersion: FORECAST_EMAIL_DISPATCHER_VERSION,
        mode: 'live',
        cutoff: input.cutoff,
        disposition: 'configuration_disabled',
        selectedCount: 0,
        attemptedCount: 0,
        acceptedCount: 0,
        deferredCount: 0,
        suppressedCount: 0,
        retryScheduledCount: 0,
        deadLetterCount: 0,
        claimConflictCount: 0,
        unexpectedErrorCount: 0,
        durationMs: this.runtime.elapsedMs(startedAt),
        items: [],
      };
    }
    const live = sendLive ? requireLiveEmailConfiguration(this.configuration) : null;
    const candidates = await this.repository.selectCandidates({
      profileId: input.profileId,
      cutoff: input.cutoff,
      after: null,
      limit,
    });
    validateCandidates(candidates, input.cutoff, limit);

    const items: ForecastEmailDispatchItemReport[] = [];
    let budgetReached = false;
    for (const candidate of candidates) {
      const reserve = sendLive
        ? this.configuration.providerTimeoutMs + EMAIL_DISPATCH_PROVIDER_RESERVE_MS
        : 0;
      if (this.runtime.elapsedMs(startedAt) + reserve >= maxRuntimeMs) {
        budgetReached = true;
        break;
      }
      try {
        items.push(sendLive
          ? await this.liveCandidate(input.profileId, candidate, input.cutoff, live as LiveEmailConfiguration)
          : await this.dryRunCandidate(input.profileId, candidate, input.cutoff));
      } catch {
        items.push({
          outboxId: candidate.outboxId,
          disposition: 'unexpected_error',
          policyDecision: null,
          providerClassification: 'unexpected_dispatch_error',
          nextAttemptAt: null,
        });
      }
    }

    const count = (values: EmailDispatchItemDisposition[]) => items.filter(
      (item) => values.includes(item.disposition),
    ).length;
    return {
      dispatcherVersion: FORECAST_EMAIL_DISPATCHER_VERSION,
      mode: sendLive ? 'live' : 'dry_run',
      cutoff: input.cutoff,
      disposition: budgetReached ? 'runtime_budget_reached' : 'completed',
      selectedCount: candidates.length,
      attemptedCount: sendLive ? items.filter((item) => item.disposition !== 'claim_conflict').length : 0,
      acceptedCount: count(['sent_request_accepted', 'accepted_recovery', 'duplicate_replayed']),
      deferredCount: count(['deferred_quiet_hours']),
      suppressedCount: count(['suppressed']),
      retryScheduledCount: count(['retry_scheduled']),
      deadLetterCount: count(['dead_letter']),
      claimConflictCount: count(['claim_conflict', 'claim_lost']),
      unexpectedErrorCount: items.filter((item) => item.disposition === 'unexpected_error'
        || item.providerClassification === 'unexpected_dispatch_error').length,
      durationMs: this.runtime.elapsedMs(startedAt),
      items,
    };
  }
}
