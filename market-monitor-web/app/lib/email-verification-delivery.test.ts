import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEmailConfiguration } from './server/email/config.ts';
import type { EmailProviderAdapter } from './server/email/dispatcher.ts';
import type { ResendProviderIdentity, ResendSendResult } from './server/email/resend.ts';
import { FORECAST_EMAIL_CAPABILITY_VERSION } from './server/email/types.ts';
import {
  VerificationEmailDeliveryService,
  type BeginVerificationProviderAttemptResult,
  type VerificationDeliveryContext,
  type VerificationEmailDeliveryRepository,
  type VerificationEmailDeliveryRuntime,
  type VerificationProviderCompletion,
} from './server/email/verification-delivery.ts';

const NOW = '2026-08-25T12:00:00.000Z';
const IDENTITY: ResendProviderIdentity = {
  idempotencyKey: `northstar-email-v1-${'a'.repeat(64)}`,
  canonicalRequestHash: 'b'.repeat(64),
};

function recipient(lifecycle: 'pending' | 'verified' = 'pending') {
  return {
    id: 'recipient_1', profileId: 1, revision: 1,
    canonicalEmail: 'person@example.com', maskedEmail: 'p***@e***.com', lifecycle,
    verificationRequestedAt: '2026-08-25T11:00:00.000Z',
    verifiedAt: lifecycle === 'verified' ? '2026-08-25T11:30:00.000Z' : null,
    revokedAt: null, suppressionState: 'none' as const, suppressionReason: null,
    suppressedAt: null, createdAt: '2026-08-25T11:00:00.000Z', updatedAt: NOW,
  };
}

function capability() {
  return {
    state: 'active' as const,
    record: {
      id: 'A'.repeat(24), tokenHash: 'c'.repeat(64),
      tokenVersion: FORECAST_EMAIL_CAPABILITY_VERSION,
      purpose: 'verification' as const, recipientId: 'recipient_1', consentRevision: null,
      createdAt: '2026-08-25T11:00:00.000Z', expiresAt: '2026-08-26T11:00:00.000Z',
      consumedAt: null, revokedAt: null,
    },
  };
}

function delivery(overrides: Partial<NonNullable<VerificationDeliveryContext['existingDelivery']>> = {}) {
  return {
    id: 'verification_delivery_1', recipientId: 'recipient_1',
    templateVersion: 'northstar-email-verification-1.0.0', contentHash: 'd'.repeat(64),
    idempotencyKey: IDENTITY.idempotencyKey,
    canonicalRequestHash: IDENTITY.canonicalRequestHash,
    state: 'ambiguous' as const, requestStartedAt: '2026-08-25T11:30:00.000Z',
    safeRetryUntil: '2026-08-26T11:30:00.000Z', providerEmailId: null,
    ...overrides,
  };
}

function context(overrides: Partial<VerificationDeliveryContext> = {}): VerificationDeliveryContext {
  return { recipient: recipient(), capability: capability(), existingDelivery: null, ...overrides };
}

class Runtime implements VerificationEmailDeliveryRuntime {
  sequence = 0;
  now() { return NOW; }
  id(kind: Parameters<VerificationEmailDeliveryRuntime['id']>[0]) {
    this.sequence += 1;
    return `${kind}_${this.sequence}`;
  }
}

class FakeRepository implements VerificationEmailDeliveryRepository {
  value = context();
  beginDisposition: BeginVerificationProviderAttemptResult['disposition'] = 'ready';
  completion: VerificationProviderCompletion = {
    disposition: 'retry_scheduled', nextAttemptAt: '2026-08-25T12:01:00.000Z',
  };
  acceptance: 'accepted' | 'accepted_context_changed' | 'integrity_conflict' = 'accepted';
  loads = 0;
  begins = 0;
  recoveries = 0;
  acceptances = 0;
  providerCompletions = 0;
  integrityCompletions = 0;
  unexpectedCompletions = 0;
  lastBegin: Parameters<VerificationEmailDeliveryRepository['beginProviderAttempt']>[0] | null = null;

  async loadVerificationContext() { this.loads += 1; return this.value; }
  async beginProviderAttempt(
    input: Parameters<VerificationEmailDeliveryRepository['beginProviderAttempt']>[0],
  ): Promise<BeginVerificationProviderAttemptResult> {
    this.begins += 1;
    this.lastBegin = input;
    const persisted = this.value.existingDelivery ?? delivery({
      id: input.deliveryId, templateVersion: input.templateVersion,
      contentHash: input.contentHash, idempotencyKey: input.identity.idempotencyKey,
      canonicalRequestHash: input.identity.canonicalRequestHash,
      state: 'request_started', requestStartedAt: input.startedAt,
    });
    if (this.beginDisposition === 'ready') {
      return { disposition: 'ready', delivery: persisted, providerAttemptId: input.providerAttemptId };
    }
    if (this.beginDisposition === 'already_accepted') {
      return { disposition: 'already_accepted', delivery: delivery({ state: 'provider_accepted' }) };
    }
    return { disposition: this.beginDisposition, delivery: persisted } as BeginVerificationProviderAttemptResult;
  }
  async finalizeAcceptedRecovery() { this.recoveries += 1; return true; }
  async recordProviderAcceptance() { this.acceptances += 1; return this.acceptance; }
  async completeProviderResult() { this.providerCompletions += 1; return this.completion; }
  async completeIntegrityFailure() {
    this.integrityCompletions += 1;
    return { disposition: 'dead_letter' as const, nextAttemptAt: null };
  }
  async completeUnexpected() { this.unexpectedCompletions += 1; return this.completion; }
}

class Adapter implements EmailProviderAdapter {
  readonly kind = 'resend-email';
  readonly version = 'northstar-resend-adapter-1.0.0';
  calls = 0;
  result: ResendSendResult = { disposition: 'accepted', providerEmailId: 'provider_1' };
  beforeSend: (() => void) | null = null;
  input: Parameters<EmailProviderAdapter['send']>[0] | null = null;

  async send(input: Parameters<EmailProviderAdapter['send']>[0]) {
    this.calls += 1;
    this.input = input;
    this.beforeSend?.();
    return this.result;
  }
}

function configuration(enabled = true) {
  return parseEmailConfiguration({
    environment: 'staging', dispatchEnabled: enabled,
    resendApiKey: 're_test_key', capabilitySecret: 'A'.repeat(43),
    from: 'Northstar <journal@example.com>', publicAppUrl: 'https://northstar.example',
    providerTimeoutMs: 1_000, providerResponseMaxBytes: 1_024, dispatcherLimit: 10,
  });
}

function dependencies() {
  return {
    materializeCapability: async () => `v1.${'A'.repeat(24)}.${'B'.repeat(43)}`,
    render: async () => ({
      templateId: 'verification' as const,
      templateVersion: 'northstar-email-verification-1.0.0' as const,
      locale: 'en-US' as const, subject: 'Verify', text: 'Verify text',
      html: '<p>Verify</p>', headers: {} as Readonly<Record<string, never>>,
      contentHash: 'd'.repeat(64),
    }),
    createIdentity: async () => IDENTITY,
  };
}

test('verification delivery defaults to a read-only dry run', async () => {
  const repository = new FakeRepository();
  const adapter = new Adapter();
  const report = await new VerificationEmailDeliveryService(
    repository, adapter, configuration(), new Runtime(), dependencies(),
  ).send({ profileId: 1 });

  assert.equal(report.mode, 'dry_run');
  assert.equal(report.disposition, 'dry_run_candidate');
  assert.equal(repository.loads, 1);
  assert.equal(repository.begins, 0);
  assert.equal(adapter.calls, 0);
});

test('explicit live verification remains inert behind the kill switch', async () => {
  const repository = new FakeRepository();
  const adapter = new Adapter();
  const report = await new VerificationEmailDeliveryService(
    repository, adapter, configuration(false), new Runtime(), dependencies(),
  ).send({ profileId: 1, sendLive: true });

  assert.equal(report.disposition, 'configuration_disabled');
  assert.equal(repository.loads, 0);
  assert.equal(repository.begins, 0);
  assert.equal(adapter.calls, 0);
});

test('live verification persists immutable delivery and attempt before network', async () => {
  const repository = new FakeRepository();
  const adapter = new Adapter();
  adapter.beforeSend = () => assert.equal(repository.begins, 1);
  const report = await new VerificationEmailDeliveryService(
    repository, adapter, configuration(), new Runtime(), dependencies(),
  ).send({ profileId: 1, sendLive: true });

  assert.equal(report.disposition, 'sent_request_accepted');
  assert.equal(repository.begins, 1);
  assert.equal(repository.acceptances, 1);
  assert.equal(adapter.calls, 1);
  assert.deepEqual(repository.lastBegin?.identity, IDENTITY);
});

test('verification only sends for the current pending recipient and active capability', async () => {
  const repository = new FakeRepository();
  repository.value = context({ recipient: recipient('verified') });
  const adapter = new Adapter();
  const verified = await new VerificationEmailDeliveryService(
    repository, adapter, configuration(), new Runtime(), dependencies(),
  ).send({ profileId: 1, sendLive: true });
  assert.equal(verified.disposition, 'recipient_not_pending');

  repository.value = context({ capability: { ...capability(), state: 'consumed' } });
  const consumed = await new VerificationEmailDeliveryService(
    repository, adapter, configuration(), new Runtime(), dependencies(),
  ).send({ profileId: 1, sendLive: true });
  assert.equal(consumed.disposition, 'capability_inactive');
  assert.equal(repository.begins, 0);
  assert.equal(adapter.calls, 0);
});

test('accepted verification evidence is finalized without a duplicate provider call', async () => {
  const repository = new FakeRepository();
  repository.value = context({
    existingDelivery: delivery({ state: 'provider_accepted', providerEmailId: 'provider_1' }),
  });
  const adapter = new Adapter();
  const report = await new VerificationEmailDeliveryService(
    repository, adapter, configuration(), new Runtime(), dependencies(),
  ).send({ profileId: 1, sendLive: true });

  assert.equal(report.disposition, 'accepted_recovery');
  assert.equal(repository.recoveries, 1);
  assert.equal(repository.begins, 0);
  assert.equal(adapter.calls, 0);
});

test('ambiguous verification retries with the exact persisted provider identity', async () => {
  const repository = new FakeRepository();
  repository.value = context({ existingDelivery: delivery() });
  const adapter = new Adapter();
  adapter.result = { disposition: 'ambiguous', classification: 'provider_timeout' };
  const report = await new VerificationEmailDeliveryService(
    repository, adapter, configuration(), new Runtime(), dependencies(),
  ).send({ profileId: 1, sendLive: true });

  assert.equal(report.disposition, 'retry_scheduled');
  assert.equal(repository.providerCompletions, 1);
  assert.equal(adapter.calls, 1);
  assert.equal(adapter.input?.idempotencyKey, delivery().idempotencyKey);
  assert.equal(adapter.input?.canonicalRequestHash, delivery().canonicalRequestHash);
});

test('terminal verification provider result dead-letters durably', async () => {
  const repository = new FakeRepository();
  repository.completion = { disposition: 'dead_letter', nextAttemptAt: null };
  const adapter = new Adapter();
  adapter.result = { disposition: 'terminal', classification: 'provider_rejected' };
  const report = await new VerificationEmailDeliveryService(
    repository, adapter, configuration(), new Runtime(), dependencies(),
  ).send({ profileId: 1, sendLive: true });

  assert.equal(report.disposition, 'dead_letter');
  assert.equal(report.providerClassification, 'provider_rejected');
  assert.equal(repository.providerCompletions, 1);
});

test('verification retry requires enough provider safe window for timeout plus reserve', async () => {
  const repository = new FakeRepository();
  repository.value = context({
    existingDelivery: delivery({ safeRetryUntil: '2026-08-25T12:00:01.500Z' }),
  });
  const adapter = new Adapter();
  const report = await new VerificationEmailDeliveryService(
    repository, adapter, configuration(), new Runtime(), dependencies(),
  ).send({ profileId: 1, sendLive: true });

  assert.equal(report.disposition, 'dead_letter');
  assert.equal(report.providerClassification, 'safe_retry_window_expired');
  assert.equal(repository.integrityCompletions, 1);
  assert.equal(repository.begins, 0);
  assert.equal(adapter.calls, 0);
});

test('verification identity drift dead-letters without calling the provider', async () => {
  const repository = new FakeRepository();
  repository.value = context({
    existingDelivery: delivery({ canonicalRequestHash: 'e'.repeat(64) }),
  });
  const adapter = new Adapter();
  const report = await new VerificationEmailDeliveryService(
    repository, adapter, configuration(), new Runtime(), dependencies(),
  ).send({ profileId: 1, sendLive: true });

  assert.equal(report.disposition, 'dead_letter');
  assert.equal(report.providerClassification, 'idempotency_integrity_failure');
  assert.equal(repository.integrityCompletions, 1);
  assert.equal(repository.begins, 0);
  assert.equal(adapter.calls, 0);
});

test('an adapter exception closes the durable attempt as retryable ambiguity', async () => {
  const repository = new FakeRepository();
  const adapter = new Adapter();
  adapter.send = async () => { adapter.calls += 1; throw new Error('secret provider detail'); };
  const report = await new VerificationEmailDeliveryService(
    repository, adapter, configuration(), new Runtime(), dependencies(),
  ).send({ profileId: 1, sendLive: true });

  assert.equal(report.disposition, 'retry_scheduled');
  assert.equal(report.providerClassification, 'unexpected_verification_delivery_error');
  assert.equal(report.providerCalled, true);
  assert.equal(repository.unexpectedCompletions, 1);
  assert.equal(repository.acceptances, 0);
});
