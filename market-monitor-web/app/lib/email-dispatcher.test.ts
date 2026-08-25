import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEmailConfiguration } from './server/email/config.ts';
import {
  ForecastEmailDispatcherService,
  type BeginEmailProviderAttemptResult,
  type CompleteEmailProviderResult,
  type EmailDispatchCandidate,
  type EmailDispatchClaim,
  type EmailDispatchContext,
  type EmailDispatcherRepository,
  type EmailDispatcherRuntime,
  type EmailProviderAdapter,
} from './server/email/dispatcher.ts';
import { NOTIFICATION_PREFERENCE_SCHEMA_VERSION } from './server/notifications/preference.ts';
import {
  FORECAST_EMAIL_CAPABILITY_VERSION,
  FORECAST_EMAIL_CONSENT_VERSION,
} from './server/email/types.ts';
import type { ResendProviderIdentity, ResendSendResult } from './server/email/resend.ts';

const NOW = '2026-08-25T12:00:00.000Z';
const CUTOFF = NOW;
const OUTBOX_CREATED_AT = '2026-08-25T11:00:00.000Z';
const IDENTITY: ResendProviderIdentity = {
  idempotencyKey: `northstar-email-v1-${'a'.repeat(64)}`,
  canonicalRequestHash: 'b'.repeat(64),
};

function recipient() {
  return {
    id: 'recipient_1', profileId: 1, revision: 1,
    canonicalEmail: 'person@example.com', maskedEmail: 'p***@e***.com',
    lifecycle: 'verified' as const,
    verificationRequestedAt: '2026-08-25T09:00:00.000Z',
    verifiedAt: '2026-08-25T10:00:00.000Z', revokedAt: null,
    suppressionState: 'none' as const, suppressionReason: null, suppressedAt: null,
    createdAt: '2026-08-25T09:00:00.000Z', updatedAt: '2026-08-25T10:00:00.000Z',
  };
}

function preference() {
  return {
    profileId: 1, schemaVersion: NOTIFICATION_PREFERENCE_SCHEMA_VERSION, revision: 1,
    masterConsent: true,
    categories: { target_hit: true, invalidated: true, expired: true, needs_review: true },
    timeZone: 'UTC', quietHours: null,
    createdAt: '2026-08-25T09:00:00.000Z', updatedAt: '2026-08-25T09:00:00.000Z',
  };
}

function consent(overrides: Record<string, unknown> = {}) {
  return {
    profileId: 1, revision: 1, recipientId: 'recipient_1',
    schemaVersion: FORECAST_EMAIL_CONSENT_VERSION,
    masterConsent: true,
    categories: { target_hit: true, invalidated: true, expired: true, needs_review: true },
    source: 'operator' as const,
    consentedAt: '2026-08-25T10:00:00.000Z', revokedAt: null,
    createdAt: '2026-08-25T10:00:00.000Z',
    ...overrides,
  };
}

function capability() {
  return {
    id: 'A'.repeat(24), tokenHash: 'c'.repeat(64),
    tokenVersion: FORECAST_EMAIL_CAPABILITY_VERSION,
    purpose: 'unsubscribe' as const, recipientId: 'recipient_1', consentRevision: 1,
    createdAt: '2026-08-25T10:00:00.000Z', expiresAt: null,
    consumedAt: null, revokedAt: null,
  };
}

function context(overrides: Partial<EmailDispatchContext> = {}): EmailDispatchContext {
  return {
    category: 'target_hit',
    payload: { opaque: true },
    availableAt: OUTBOX_CREATED_AT,
    outboxCreatedAt: OUTBOX_CREATED_AT,
    claimValid: true,
    supportedTemplate: true,
    currentRecipient: recipient(),
    notificationPreference: preference(),
    emailConsent: consent(),
    unsubscribeCapability: capability(),
    existingDelivery: null,
    ...overrides,
  };
}

function delivery(overrides: Partial<NonNullable<EmailDispatchContext['existingDelivery']>> = {}) {
  return {
    id: 'delivery_1', recipientId: 'recipient_1',
    templateVersion: 'northstar-forecast-target-hit-1.0.0',
    contentHash: 'd'.repeat(64),
    idempotencyKey: IDENTITY.idempotencyKey,
    canonicalRequestHash: IDENTITY.canonicalRequestHash,
    state: 'ambiguous' as const,
    requestStartedAt: '2026-08-25T11:30:00.000Z',
    safeRetryUntil: '2026-08-26T11:30:00.000Z',
    providerEmailId: null,
    ...overrides,
  };
}

class Runtime implements EmailDispatcherRuntime {
  instant = NOW;
  elapsed = 0;
  sequence = 0;

  now() { return this.instant; }
  elapsedMs() { return this.elapsed; }
  leaseExpiresAt(acquiredAt: string) {
    return new Date(Date.parse(acquiredAt) + 60_000).toISOString();
  }
  id(kind: Parameters<EmailDispatcherRuntime['id']>[0]) {
    this.sequence += 1;
    return `${kind}_${this.sequence}`;
  }
}

class FakeRepository implements EmailDispatcherRepository {
  candidates: EmailDispatchCandidate[] = [{ eligibleAt: OUTBOX_CREATED_AT, outboxId: 'outbox_1' }];
  value = context();
  claimAllowed = true;
  beginDisposition: BeginEmailProviderAttemptResult['disposition'] = 'ready';
  providerCompletion: CompleteEmailProviderResult = {
    disposition: 'retry_scheduled', nextAttemptAt: '2026-08-25T12:01:00.000Z',
  };
  acceptance: 'accepted' | 'accepted_claim_lost' | 'integrity_conflict' = 'accepted';
  selected = 0;
  previews = 0;
  claims = 0;
  policyCompletions = 0;
  begins = 0;
  renewals = 0;
  recoveries = 0;
  acceptances = 0;
  providerCompletions = 0;
  integrityCompletions = 0;
  unexpectedCompletions = 0;
  lastBeginIdentity: ResendProviderIdentity | null = null;

  async selectCandidates() { this.selected += 1; return this.candidates; }
  async previewContext() { this.previews += 1; return this.value; }
  async claimCandidate(input: Parameters<EmailDispatcherRepository['claimCandidate']>[0]) {
    this.claims += 1;
    if (!this.claimAllowed) return null;
    return {
      outboxId: input.outboxId, intentId: 'intent_1',
      notificationAttemptId: input.notificationAttemptId, notificationAttemptNumber: 1,
      category: this.value.category, payload: this.value.payload,
      availableAt: this.value.availableAt, outboxCreatedAt: this.value.outboxCreatedAt,
      leaseExpiresAt: input.leaseExpiresAt,
    } satisfies EmailDispatchClaim;
  }
  async loadClaimContext() { return this.value; }
  async renewClaim() { this.renewals += 1; return true; }
  async completePolicyOutcome() { this.policyCompletions += 1; return true; }
  async beginProviderAttempt(
    input: Parameters<EmailDispatcherRepository['beginProviderAttempt']>[0],
  ): Promise<BeginEmailProviderAttemptResult> {
    this.begins += 1;
    this.lastBeginIdentity = input.identity;
    const persisted = this.value.existingDelivery ?? delivery({
      id: input.deliveryId,
      templateVersion: input.templateVersion,
      contentHash: input.contentHash,
      idempotencyKey: input.identity.idempotencyKey,
      canonicalRequestHash: input.identity.canonicalRequestHash,
      state: 'request_started',
      requestStartedAt: input.startedAt,
    });
    if (this.beginDisposition === 'ready') {
      return { disposition: 'ready', delivery: persisted, providerAttemptId: input.providerAttemptId };
    }
    if (this.beginDisposition === 'already_accepted') {
      return { disposition: 'already_accepted', delivery: delivery({ state: 'provider_accepted' }) };
    }
    return { disposition: this.beginDisposition, delivery: persisted } as BeginEmailProviderAttemptResult;
  }
  async finalizeAcceptedRecovery() { this.recoveries += 1; return true; }
  async recordProviderAcceptance() { this.acceptances += 1; return this.acceptance; }
  async completeProviderResult() { this.providerCompletions += 1; return this.providerCompletion; }
  async completeIntegrityFailure() {
    this.integrityCompletions += 1;
    return { disposition: 'dead_letter' as const, nextAttemptAt: null };
  }
  async completeUnexpected() {
    this.unexpectedCompletions += 1;
    return { disposition: 'retry_scheduled' as const, nextAttemptAt: '2026-08-25T12:01:00.000Z' };
  }
}

class Adapter implements EmailProviderAdapter {
  readonly kind = 'resend-email';
  readonly version = 'northstar-resend-adapter-1.0.0';
  calls = 0;
  input: Parameters<EmailProviderAdapter['send']>[0] | null = null;
  result: ResendSendResult = { disposition: 'accepted', providerEmailId: 'provider_1' };

  async send(input: Parameters<EmailProviderAdapter['send']>[0]) {
    this.calls += 1;
    this.input = input;
    return this.result;
  }
}

function configuration(enabled = true) {
  return parseEmailConfiguration({
    environment: 'staging', dispatchEnabled: enabled,
    resendApiKey: 're_test_key', capabilitySecret: 'A'.repeat(43),
    from: 'Northstar <journal@example.com>', publicAppUrl: 'https://northstar.example',
    providerTimeoutMs: 1_000, providerResponseMaxBytes: 1_024,
    dispatcherLimit: 10,
  });
}

function dependencies() {
  return {
    materializeCapability: async () => `v1.${'A'.repeat(24)}.${'B'.repeat(43)}`,
    render: async () => ({
      templateId: 'target_hit' as const,
      templateVersion: 'northstar-forecast-target-hit-1.0.0' as const,
      locale: 'en-US' as const,
      subject: 'Subject', text: 'Text', html: '<p>Text</p>',
      headers: {
        'List-Unsubscribe': '<https://northstar.example/email/unsubscribe?token=x>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' as const,
      },
      contentHash: 'd'.repeat(64),
    }),
    createIdentity: async () => IDENTITY,
  };
}

test('dispatcher defaults to a read-only dry run and never claims or calls the provider', async () => {
  const repository = new FakeRepository();
  const adapter = new Adapter();
  const report = await new ForecastEmailDispatcherService(
    repository, adapter, configuration(), new Runtime(), dependencies(),
  ).dispatch({ profileId: 1, cutoff: CUTOFF });

  assert.equal(report.mode, 'dry_run');
  assert.equal(report.items[0].disposition, 'dry_run_candidate');
  assert.equal(report.items[0].policyDecision, 'eligible');
  assert.equal(repository.previews, 1);
  assert.equal(repository.claims, 0);
  assert.equal(repository.begins, 0);
  assert.equal(adapter.calls, 0);
});

test('explicit live send remains inert when the configuration kill switch is disabled', async () => {
  const repository = new FakeRepository();
  const adapter = new Adapter();
  const report = await new ForecastEmailDispatcherService(
    repository, adapter, configuration(false), new Runtime(), dependencies(),
  ).dispatch({ profileId: 1, cutoff: CUTOFF, sendLive: true });

  assert.equal(report.disposition, 'configuration_disabled');
  assert.equal(repository.selected, 0);
  assert.equal(repository.claims, 0);
  assert.equal(adapter.calls, 0);
});

test('live delivery rechecks policy, persists delivery and attempt, then records provider acceptance', async () => {
  const repository = new FakeRepository();
  const adapter = new Adapter();
  const report = await new ForecastEmailDispatcherService(
    repository, adapter, configuration(), new Runtime(), dependencies(),
  ).dispatch({ profileId: 1, cutoff: CUTOFF, sendLive: true });

  assert.equal(report.items[0].disposition, 'sent_request_accepted');
  assert.equal(report.acceptedCount, 1);
  assert.equal(repository.claims, 1);
  assert.equal(repository.renewals, 1);
  assert.equal(repository.begins, 1);
  assert.equal(adapter.calls, 1);
  assert.equal(repository.acceptances, 1);
  assert.deepEqual(repository.lastBeginIdentity, IDENTITY);
  assert.equal(adapter.input?.idempotencyKey, IDENTITY.idempotencyKey);
});

test('consent revoked after claim is terminally suppressed before any provider persistence or call', async () => {
  const repository = new FakeRepository();
  repository.value = context({ emailConsent: consent({ masterConsent: false, revokedAt: NOW }) });
  const adapter = new Adapter();
  const report = await new ForecastEmailDispatcherService(
    repository, adapter, configuration(), new Runtime(), dependencies(),
  ).dispatch({ profileId: 1, cutoff: CUTOFF, sendLive: true });

  assert.equal(report.items[0].disposition, 'suppressed');
  assert.equal(report.items[0].policyDecision, 'suppressed_email_consent');
  assert.equal(repository.policyCompletions, 1);
  assert.equal(repository.begins, 0);
  assert.equal(adapter.calls, 0);
});

test('quiet hours introduced after claim defer the item without calling the provider', async () => {
  const repository = new FakeRepository();
  repository.value = context({
    notificationPreference: {
      ...preference(), quietHours: { start: '11:00', end: '13:00' },
    },
  });
  const adapter = new Adapter();
  const report = await new ForecastEmailDispatcherService(
    repository, adapter, configuration(), new Runtime(), dependencies(),
  ).dispatch({ profileId: 1, cutoff: CUTOFF, sendLive: true });

  assert.equal(report.items[0].disposition, 'deferred_quiet_hours');
  assert.equal(report.items[0].nextAttemptAt, '2026-08-25T13:00:00.000Z');
  assert.equal(repository.policyCompletions, 1);
  assert.equal(adapter.calls, 0);
});

test('durable provider acceptance is finalized after takeover without a second send', async () => {
  const repository = new FakeRepository();
  repository.value = context({
    existingDelivery: delivery({
      state: 'provider_accepted', providerEmailId: 'provider_1',
    }),
  });
  const adapter = new Adapter();
  const report = await new ForecastEmailDispatcherService(
    repository, adapter, configuration(), new Runtime(), dependencies(),
  ).dispatch({ profileId: 1, cutoff: CUTOFF, sendLive: true });

  assert.equal(report.items[0].disposition, 'accepted_recovery');
  assert.equal(repository.recoveries, 1);
  assert.equal(repository.begins, 0);
  assert.equal(adapter.calls, 0);
});

test('ambiguous delivery retries with the exact persisted provider identity', async () => {
  const repository = new FakeRepository();
  repository.value = context({ existingDelivery: delivery() });
  const adapter = new Adapter();
  adapter.result = { disposition: 'ambiguous', classification: 'provider_timeout' };
  const report = await new ForecastEmailDispatcherService(
    repository, adapter, configuration(), new Runtime(), dependencies(),
  ).dispatch({ profileId: 1, cutoff: CUTOFF, sendLive: true });

  assert.equal(report.items[0].disposition, 'retry_scheduled');
  assert.equal(report.items[0].providerClassification, 'provider_timeout');
  assert.equal(repository.providerCompletions, 1);
  assert.equal(adapter.calls, 1);
  assert.equal(adapter.input?.idempotencyKey, delivery().idempotencyKey);
  assert.equal(adapter.input?.canonicalRequestHash, delivery().canonicalRequestHash);
});

test('an ambiguous delivery beyond the provider window dead-letters without another send', async () => {
  const repository = new FakeRepository();
  repository.value = context({ existingDelivery: delivery() });
  repository.beginDisposition = 'safe_retry_window_expired';
  const adapter = new Adapter();
  const report = await new ForecastEmailDispatcherService(
    repository, adapter, configuration(), new Runtime(), dependencies(),
  ).dispatch({ profileId: 1, cutoff: CUTOFF, sendLive: true });

  assert.equal(report.items[0].disposition, 'dead_letter');
  assert.equal(report.items[0].providerClassification, 'safe_retry_window_expired');
  assert.equal(repository.integrityCompletions, 1);
  assert.equal(adapter.calls, 0);
});

test('retry requires enough provider safe window for timeout plus reserve', async () => {
  const repository = new FakeRepository();
  repository.value = context({
    existingDelivery: delivery({ safeRetryUntil: '2026-08-25T12:00:01.500Z' }),
  });
  const adapter = new Adapter();
  const report = await new ForecastEmailDispatcherService(
    repository, adapter, configuration(), new Runtime(), dependencies(),
  ).dispatch({ profileId: 1, cutoff: CUTOFF, sendLive: true });

  assert.equal(report.items[0].disposition, 'dead_letter');
  assert.equal(report.items[0].providerClassification, 'safe_retry_window_expired');
  assert.equal(repository.integrityCompletions, 1);
  assert.equal(repository.renewals, 0);
  assert.equal(repository.begins, 0);
  assert.equal(adapter.calls, 0);
});

test('claim conflicts are isolated and never reach the provider', async () => {
  const repository = new FakeRepository();
  repository.claimAllowed = false;
  const adapter = new Adapter();
  const report = await new ForecastEmailDispatcherService(
    repository, adapter, configuration(), new Runtime(), dependencies(),
  ).dispatch({ profileId: 1, cutoff: CUTOFF, sendLive: true });

  assert.equal(report.items[0].disposition, 'claim_conflict');
  assert.equal(report.claimConflictCount, 1);
  assert.equal(adapter.calls, 0);
});

test('runtime reserve stops before a claim or provider call', async () => {
  const repository = new FakeRepository();
  const runtime = new Runtime();
  runtime.elapsed = 1_000;
  const adapter = new Adapter();
  const report = await new ForecastEmailDispatcherService(
    repository, adapter, configuration(), runtime, dependencies(),
  ).dispatch({ profileId: 1, cutoff: CUTOFF, sendLive: true, maxRuntimeMs: 2_000 });

  assert.equal(report.disposition, 'runtime_budget_reached');
  assert.equal(repository.claims, 0);
  assert.equal(adapter.calls, 0);
});

test('candidate pages must preserve the stable keyset order and bound', async () => {
  const repository = new FakeRepository();
  repository.candidates = [
    { eligibleAt: OUTBOX_CREATED_AT, outboxId: 'outbox_2' },
    { eligibleAt: OUTBOX_CREATED_AT, outboxId: 'outbox_1' },
  ];
  const adapter = new Adapter();
  await assert.rejects(
    new ForecastEmailDispatcherService(
      repository, adapter, configuration(), new Runtime(), dependencies(),
    ).dispatch({ profileId: 1, cutoff: CUTOFF }),
    /invalid or unstable/u,
  );
  assert.equal(adapter.calls, 0);
});
