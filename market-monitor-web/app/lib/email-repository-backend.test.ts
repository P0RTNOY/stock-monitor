import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { forecastInitializationStatements } from '../../db/forecast-initialization.ts';
import {
  D1EmailRepository,
  D1VerificationEmailRepository,
} from './server/email/repository.ts';
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
  return { database, recipient: new D1EmailRepository(d1), verification: new D1VerificationEmailRepository(d1) };
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
