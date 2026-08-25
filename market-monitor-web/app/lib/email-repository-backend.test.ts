import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { forecastInitializationStatements } from '../../db/forecast-initialization.ts';
import {
  D1EmailRepository,
  D1VerificationEmailRepository,
} from './server/email/repository.ts';
import { D1EmailWebhookRepository } from './server/email/webhook-repository.ts';
import { FORECAST_EMAIL_CAPABILITY_VERSION } from './server/email/types.ts';

const NOW = '2026-08-25T12:00:00.000Z';
const HASH = 'a'.repeat(64);
const REQUEST_HASH = 'b'.repeat(64);

class SQLitePrepared {
  private bindings: Array<string | number | null> = [];
  private readonly database: DatabaseSync;
  private readonly sql: string;
  constructor(database: DatabaseSync, sql: string) {
    this.database = database;
    this.sql = sql;
  }
  bind(...values: Array<string | number | null>) {
    const statement = new SQLitePrepared(this.database, this.sql);
    statement.bindings = values;
    return statement;
  }
  async first<T>() {
    return (this.database.prepare(this.sql).get(...this.bindings) ?? null) as T | null;
  }
  async all<T>() {
    return { success: true, results: this.database.prepare(this.sql).all(...this.bindings) as T[], meta: {} };
  }
  async run() { return this.execute(); }
  execute() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, results: [], meta: { changes: result.changes } };
  }
}

class SQLiteD1 {
  private readonly database: DatabaseSync;
  constructor(database: DatabaseSync) {
    this.database = database;
  }
  prepare(sql: string) { return new SQLitePrepared(this.database, sql); }
  async batch(statements: SQLitePrepared[]) {
    this.database.exec('BEGIN');
    try {
      const results = statements.map((statement) => statement.execute());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(`CREATE TABLE investment_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, base_currency TEXT NOT NULL,
    cash_balance REAL NOT NULL, created_at TEXT NOT NULL
  ); CREATE TABLE positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, symbol TEXT NOT NULL,
    company_name TEXT NOT NULL, shares REAL NOT NULL, average_cost REAL NOT NULL,
    created_at TEXT NOT NULL
  ); CREATE TABLE watchlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, symbol TEXT NOT NULL,
    company_name TEXT NOT NULL, created_at TEXT NOT NULL
  ); INSERT INTO investment_profiles VALUES (1, 'Mine', 'USD', 0, '${NOW}')`);
  for (const statement of forecastInitializationStatements()) database.exec(statement);
  const d1 = new SQLiteD1(database) as unknown as D1Database;
  return {
    database,
    recipient: new D1EmailRepository(d1),
    verification: new D1VerificationEmailRepository(d1),
    webhook: new D1EmailWebhookRepository(d1),
  };
}

function pendingRecipient() {
  return {
    id: 'recipient_1', profileId: 1, revision: 1,
    canonicalEmail: 'person@example.test', maskedEmail: 'p***@example.test',
    lifecycle: 'pending' as const, verificationRequestedAt: null,
    verifiedAt: null, revokedAt: null, suppressionState: 'none' as const,
    suppressionReason: null, suppressedAt: null, createdAt: NOW, updatedAt: NOW,
  };
}

function disabledConsent() {
  return {
    profileId: 1, revision: 1, recipientId: 'recipient_1',
    schemaVersion: 'forecast-email-consent-1.0.0' as const,
    masterConsent: false,
    categories: { target_hit: false, invalidated: false, expired: false, needs_review: false },
    source: 'internal' as const, consentedAt: null, revokedAt: NOW, createdAt: NOW,
  };
}

function verificationCapability() {
  return {
    id: 'capability_1', profileId: 1, recipientId: 'recipient_1',
    purpose: 'verification' as const, tokenHash: HASH,
    tokenVersion: FORECAST_EMAIL_CAPABILITY_VERSION, state: 'active' as const,
    consentRevision: null, expiresAt: '2026-08-26T12:00:00.000Z',
    consumedAt: null, revokedAt: null, attemptCount: 0, lastAttemptAt: null,
    createdAt: NOW,
  };
}

async function seedPendingRecipient() {
  const runtime = fixture();
  assert.equal(await runtime.recipient.replaceRecipient({
    profileId: 1, expectedRecipientId: null, expectedConsentRevision: 0,
    recipient: pendingRecipient(), disabledConsent: disabledConsent(),
  }), true);
  assert.equal(await runtime.recipient.storeVerificationCapability({
    profileId: 1, expectedRecipientId: 'recipient_1', requestedAt: NOW,
    capability: verificationCapability(),
  }), true);
  return runtime;
}

test('D1 recipient persistence keeps capability consent bindings and single-use verification atomic', async () => {
  const runtime = await seedPendingRecipient();
  const loaded = await runtime.recipient.loadCapabilityForAttempt({
    profileId: 1, capabilityId: 'capability_1', purpose: 'verification',
    attemptedAt: '2026-08-25T12:01:00.000Z', maximumAttempts: 5,
  });
  assert.equal(loaded?.consentRevision, null);
  assert.equal(loaded?.attemptCount, 1);
  assert.equal(await runtime.recipient.consumeVerification({
    profileId: 1, recipientId: 'recipient_1', capabilityId: 'capability_1',
    tokenHash: HASH, confirmedAt: '2026-08-25T12:02:00.000Z',
  }), true);
  assert.equal(await runtime.recipient.consumeVerification({
    profileId: 1, recipientId: 'recipient_1', capabilityId: 'capability_1',
    tokenHash: HASH, confirmedAt: '2026-08-25T12:03:00.000Z',
  }), false);
  const state = await runtime.recipient.readRecipientState(1);
  assert.equal(state.currentRecipient?.lifecycle, 'verified');
  assert.equal(state.currentConsent?.masterConsent, false);
});

test('verification provider crash is ambiguous without an illegal next-attempt timestamp and reuses identity', async () => {
  const runtime = await seedPendingRecipient();
  const first = await runtime.verification.beginProviderAttempt({
    profileId: 1, recipientId: 'recipient_1', capabilityId: 'capability_1',
    deliveryId: 'delivery_1', providerAttemptId: 'provider_attempt_1',
    templateVersion: 'verification-template-1.0.0', locale: 'en', contentHash: HASH,
    identity: { idempotencyKey: 'northstar-email-v1-test', canonicalRequestHash: REQUEST_HASH },
    startedAt: '2026-08-25T12:01:00.000Z',
    minimumSafeRetryUntil: '2026-08-25T12:02:00.000Z',
  });
  assert.equal(first.disposition, 'ready');
  const completion = await runtime.verification.completeUnexpected({
    profileId: 1, recipientId: 'recipient_1', capabilityId: 'capability_1',
    deliveryId: 'delivery_1', providerAttemptId: 'provider_attempt_1',
    completedAt: '2026-08-25T12:02:00.000Z',
  });
  assert.equal(completion.disposition, 'retry_scheduled');
  const ambiguous = runtime.database.prepare(`SELECT state, next_attempt_at AS nextAttemptAt
    FROM forecast_email_provider_attempts WHERE id = 'provider_attempt_1'`).get();
  assert.deepEqual({ ...ambiguous }, { state: 'ambiguous', nextAttemptAt: null });

  const replay = await runtime.verification.beginProviderAttempt({
    profileId: 1, recipientId: 'recipient_1', capabilityId: 'capability_1',
    deliveryId: 'delivery_1', providerAttemptId: 'provider_attempt_2',
    templateVersion: 'verification-template-1.0.0', locale: 'en', contentHash: HASH,
    identity: { idempotencyKey: 'northstar-email-v1-test', canonicalRequestHash: REQUEST_HASH },
    startedAt: '2026-08-25T12:03:00.000Z',
    minimumSafeRetryUntil: '2026-08-25T12:04:00.000Z',
  });
  assert.equal(replay.disposition, 'ready');
  assert.equal(replay.delivery.idempotencyKey, 'northstar-email-v1-test');
  assert.equal(runtime.database.prepare(`SELECT count(*) AS count
    FROM forecast_email_deliveries`).get()?.count, 1);
});

test('verification context inspection is read-only for an expired active capability', async () => {
  const runtime = await seedPendingRecipient();
  runtime.database.prepare(`UPDATE forecast_email_capabilities
    SET expires_at = '2026-08-25T12:00:30.000Z' WHERE id = 'capability_1'`).run();
  const context = await runtime.verification.loadVerificationContext({
    profileId: 1, checkedAt: '2026-08-25T12:01:00.000Z',
  });
  assert.equal(context.capability?.state, 'active');
  assert.equal(context.capability?.record.expiresAt, '2026-08-25T12:00:30.000Z');
  assert.equal(runtime.database.prepare(`SELECT state FROM forecast_email_capabilities
    WHERE id = 'capability_1'`).get()?.state, 'active');
});

test('verification acceptance finalization reconciles a webhook persisted before the provider response', async () => {
  const runtime = await seedPendingRecipient();
  const identity = {
    idempotencyKey: 'northstar-email-v1-early-webhook',
    canonicalRequestHash: REQUEST_HASH,
  };
  assert.equal((await runtime.verification.beginProviderAttempt({
    profileId: 1, recipientId: 'recipient_1', capabilityId: 'capability_1',
    deliveryId: 'delivery_early', providerAttemptId: 'provider_attempt_early',
    templateVersion: 'verification-template-1.0.0', locale: 'en', contentHash: HASH,
    identity, startedAt: '2026-08-25T12:01:00.000Z',
    minimumSafeRetryUntil: '2026-08-25T12:02:00.000Z',
  })).disposition, 'ready');
  const providerEmailId = 'provider-email-before-acceptance';
  assert.equal((await runtime.webhook.persistResendWebhook({
    id: 'event_early', providerEventId: 'event_early', providerEmailId,
    eventType: 'email.failed', supported: true, payloadHash: 'd'.repeat(64),
    occurredAt: '2026-08-25T12:01:30.000Z', receivedAt: '2026-08-25T12:01:31.000Z',
    reconciliationState: 'failed', suppressionReason: null, revokeConsent: false,
  })).disposition, 'unknown_delivery');
  assert.equal(await runtime.verification.recordProviderAcceptance({
    profileId: 1, recipientId: 'recipient_1', capabilityId: 'capability_1',
    deliveryId: 'delivery_early', providerAttemptId: 'provider_attempt_early',
    identity, providerEmailId, acceptedAt: '2026-08-25T12:02:00.000Z',
  }), 'accepted');
  assert.deepEqual({ ...runtime.database.prepare(`SELECT reconciliation_state AS state,
      reconciliation_event_at AS eventAt FROM forecast_email_deliveries
      WHERE id = 'delivery_early'`).get() }, {
    state: 'failed', eventAt: '2026-08-25T12:01:30.000Z',
  });
  assert.equal(runtime.database.prepare(`SELECT handling_state AS state
    FROM forecast_email_provider_events WHERE id = 'event_early'`).get()?.state, 'applied');
  runtime.database.close();
});

test('forecast provider boundary atomically rejects recipient suppression and consent revocation races', async () => {
  const runtime = await seedPendingRecipient();
  assert.equal(await runtime.recipient.consumeVerification({
    profileId: 1, recipientId: 'recipient_1', capabilityId: 'capability_1',
    tokenHash: HASH, confirmedAt: '2026-08-25T12:01:00.000Z',
  }), true);
  assert.equal(await runtime.recipient.enableEmailConsent({
    profileId: 1,
    expectedRecipientId: 'recipient_1',
    expectedEmailConsentRevision: 1,
    expectedNotificationPreferenceRevision: 0,
    emailConsent: {
      profileId: 1, revision: 2, recipientId: 'recipient_1',
      schemaVersion: 'forecast-email-consent-1.0.0', masterConsent: true,
      categories: { target_hit: true, invalidated: true, expired: true, needs_review: true },
      source: 'operator', consentedAt: '2026-08-25T12:02:00.000Z', revokedAt: null,
      createdAt: '2026-08-25T12:02:00.000Z',
    },
    notificationPreference: {
      profileId: 1, revision: 1,
      schemaVersion: 'forecast-notification-preferences-1.0.0', masterConsent: true,
      categories: { target_hit: true, invalidated: true, expired: true, needs_review: true },
      timeZone: 'UTC', quietHours: null,
      createdAt: '2026-08-25T12:02:00.000Z', updatedAt: '2026-08-25T12:02:00.000Z',
    },
    unsubscribeCapability: {
      id: 'unsubscribe_1', profileId: 1, recipientId: 'recipient_1',
      purpose: 'unsubscribe', tokenHash: 'c'.repeat(64),
      tokenVersion: FORECAST_EMAIL_CAPABILITY_VERSION, state: 'active',
      consentRevision: 2, expiresAt: null, consumedAt: null, revokedAt: null,
      attemptCount: 0, lastAttemptAt: null, createdAt: '2026-08-25T12:02:00.000Z',
    },
  }), true);

  runtime.database.exec(`INSERT INTO forecasts
    (profile_id, symbol, direction, confidence, thesis, supporting_evidence,
     counter_evidence, setup_tag, evaluation_date, target_kind, target_price,
     status, activated_at, market_data_as_of, activation_price, activation_currency,
     market_provider, created_at, updated_at)
    VALUES (1, 'AAPL', 'bullish', 80, 'thesis', 'support', 'counter', 'manual',
      '2026-09-01', 'price', 200, 'target_hit', '${NOW}', '${NOW}', 100, 'USD',
      'test', '${NOW}', '${NOW}');
    INSERT INTO evaluation_runs
    (profile_id, forecast_id, result_kind, reason_code, explanation, evaluator_version,
     ruleset_version, evaluated_through, evaluation_cutoff, evidence_json, warnings_json,
     input_fingerprint, created_at)
    VALUES (1, 1, 'target_hit', 'target_hit', 'done', 'test-evaluator', 'test-rules',
      '${NOW}', '${NOW}', '{}', '[]', '${'d'.repeat(64)}', '${NOW}');
    INSERT INTO forecast_review_items
    (profile_id, forecast_id, evaluation_run_id, review_kind, acknowledged_at, created_at)
    VALUES (1, 1, 1, 'resolved', NULL, '${NOW}');
    INSERT INTO forecast_notification_intents
    (id, profile_id, forecast_id, evaluation_run_id, review_item_id, analysis_snapshot_id,
     category, dedup_contract_version, projector_version, payload_schema_version,
     dedup_key, payload_json, payload_fingerprint, event_occurred_at, created_at)
    VALUES ('intent_1', 1, 1, 1, 1, NULL, 'target_hit', 'dedup-v1', 'projector-v1',
      'payload-v1', '${'e'.repeat(64)}', '{}', '${'f'.repeat(64)}',
      '2026-08-25T12:03:00.000Z', '2026-08-25T12:03:00.000Z');
    INSERT INTO forecast_notification_policy_decisions
    (id, intent_id, profile_id, policy_version, preference_revision, decision,
     reason_code, decided_at, earliest_eligible_at, warnings_json, created_at)
    VALUES ('policy_1', 'intent_1', 1, 'policy-v1', 1, 'eligible', 'eligible',
      '2026-08-25T12:03:00.000Z', NULL, '[]', '2026-08-25T12:03:00.000Z');
    INSERT INTO forecast_notification_outbox
    (id, intent_id, policy_decision_id, profile_id, retry_policy_version,
     quiet_hours_policy_version, state, available_at, attempt_count, created_at, updated_at)
    VALUES ('outbox_1', 'intent_1', 'policy_1', 1, 'retry-v1', 'quiet-v1', 'pending',
      '2026-08-25T12:03:00.000Z', 0, '2026-08-25T12:03:00.000Z',
      '2026-08-25T12:03:00.000Z');`);
  const claim = await runtime.recipient.claimCandidate({
    profileId: 1, outboxId: 'outbox_1', notificationAttemptId: 'notification_attempt_1',
    ownerToken: 'owner_1', claimedAt: '2026-08-25T12:04:00.000Z',
    leaseExpiresAt: '2026-08-25T12:20:00.000Z', adapterKind: 'resend',
    adapterVersion: 'resend-v1',
  });
  assert.ok(claim);
  const begin = (suffix: string) => runtime.recipient.beginProviderAttempt({
    profileId: 1, claim, ownerToken: 'owner_1',
    preSendDecisionId: `pre_send_${suffix}`, deliveryId: `delivery_${suffix}`,
    providerAttemptId: `provider_attempt_${suffix}`, recipientId: 'recipient_1',
    unsubscribeCapabilityId: 'unsubscribe_1', notificationPreferenceRevision: 1,
    emailConsentRevision: 2, templateKind: 'target_hit', templateVersion: 'target-hit-v1',
    locale: 'en', contentHash: HASH,
    identity: { idempotencyKey: `northstar-email-${suffix}`, canonicalRequestHash: REQUEST_HASH },
    startedAt: '2026-08-25T12:05:00.000Z',
  });

  runtime.database.prepare(`UPDATE forecast_email_recipients
    SET suppression_state = 'suppressed', suppression_reason = 'hard_bounce',
      suppressed_at = ?, updated_at = ? WHERE id = 'recipient_1'`).run(NOW, NOW);
  assert.equal((await begin('suppressed')).disposition, 'claim_lost');
  runtime.database.prepare(`UPDATE forecast_email_recipients SET suppression_state = 'none',
    suppression_reason = NULL, suppressed_at = NULL WHERE id = 'recipient_1'`).run();
  assert.equal(await runtime.recipient.disableEmailConsent({
    profileId: 1, expectedRecipientId: 'recipient_1', expectedConsentRevision: 2,
    consent: {
      profileId: 1, revision: 3, recipientId: 'recipient_1',
      schemaVersion: 'forecast-email-consent-1.0.0', masterConsent: false,
      categories: { target_hit: false, invalidated: false, expired: false, needs_review: false },
      source: 'operator', consentedAt: null, revokedAt: '2026-08-25T12:05:00.000Z',
      createdAt: '2026-08-25T12:05:00.000Z',
    },
  }), true);
  assert.equal((await begin('revoked')).disposition, 'claim_lost');
  assert.equal(runtime.database.prepare(`SELECT count(*) AS count
    FROM forecast_email_pre_send_decisions`).get()?.count, 0);
  assert.equal(runtime.database.prepare(`SELECT count(*) AS count
    FROM forecast_email_deliveries`).get()?.count, 0);
  assert.equal(runtime.database.prepare(`SELECT count(*) AS count
    FROM forecast_email_provider_attempts`).get()?.count, 0);
  runtime.database.close();
});
