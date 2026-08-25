import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Webhook } from 'standardwebhooks';
import { createResendWebhookHandler } from './server/email/webhook-http.ts';
import type {
  EmailWebhookRepository,
  ResendWebhookPersistenceInput,
  ResendWebhookPersistenceResult,
} from './server/email/webhook-repository.ts';
import { D1EmailWebhookRepository } from './server/email/webhook-repository.ts';
import { ResendWebhookService, type SafeWebhookLogger } from './server/email/webhook-service.ts';

const SECRET = `whsec_${Buffer.from('northstar-webhook-signing-secret-v1').toString('base64')}`;
const MAX_BODY_BYTES = 64 * 1024;
const RECEIVED_AT = '2026-08-25T18:00:00.000Z';

class RecordingRepository implements EmailWebhookRepository {
  readonly inputs: ResendWebhookPersistenceInput[] = [];
  result: ResendWebhookPersistenceResult = { disposition: 'applied' };
  failure: Error | null = null;

  async persistResendWebhook(input: ResendWebhookPersistenceInput) {
    if (this.failure) throw this.failure;
    this.inputs.push(input);
    return this.result;
  }
}

class RecordingLogger implements SafeWebhookLogger {
  readonly events: Parameters<SafeWebhookLogger['log']>[0][] = [];
  log(event: Parameters<SafeWebhookLogger['log']>[0]) { this.events.push(event); }
}

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
    return {
      success: true,
      results: this.database.prepare(this.sql).all(...this.bindings) as T[],
      meta: {},
    };
  }

  async run() { return this.execute(); }

  execute() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return {
      success: true,
      results: [],
      meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) },
    };
  }
}

class SQLiteD1 {
  private readonly database: DatabaseSync;
  constructor(database: DatabaseSync) { this.database = database; }
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

function webhookDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE forecast_email_recipients (
    id TEXT PRIMARY KEY, profile_id INTEGER NOT NULL,
    suppression_state TEXT NOT NULL, suppression_reason TEXT, suppressed_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE forecast_email_deliveries (
    id TEXT PRIMARY KEY, profile_id INTEGER NOT NULL, recipient_id TEXT NOT NULL,
    provider TEXT NOT NULL, provider_email_id TEXT UNIQUE,
    reconciliation_state TEXT NOT NULL, reconciliation_event_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE forecast_email_provider_events (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_event_id TEXT NOT NULL,
    provider_email_id TEXT NOT NULL, delivery_id TEXT, profile_id INTEGER,
    event_type TEXT NOT NULL, supported INTEGER NOT NULL, payload_hash TEXT NOT NULL,
    event_occurred_at TEXT NOT NULL, received_at TEXT NOT NULL,
    handling_state TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(provider, provider_event_id)
  );
  CREATE TABLE forecast_email_suppression_events (
    id TEXT PRIMARY KEY, profile_id INTEGER NOT NULL, recipient_id TEXT NOT NULL,
    provider_event_id TEXT UNIQUE, action TEXT NOT NULL, reason TEXT NOT NULL,
    occurred_at TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE forecast_email_consent_revisions (
    profile_id INTEGER NOT NULL, revision INTEGER NOT NULL, recipient_id TEXT NOT NULL,
    master_consent INTEGER NOT NULL, target_hit_enabled INTEGER NOT NULL,
    invalidated_enabled INTEGER NOT NULL, expired_enabled INTEGER NOT NULL,
    needs_review_enabled INTEGER NOT NULL, consent_source TEXT NOT NULL,
    consented_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY(profile_id, revision)
  );
  CREATE TABLE forecast_email_consents (
    profile_id INTEGER PRIMARY KEY, current_revision INTEGER NOT NULL,
    recipient_id TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  INSERT INTO forecast_email_recipients VALUES
    ('recipient_1', 1, 'none', NULL, NULL, '2026-08-25T17:00:00.000Z');
  INSERT INTO forecast_email_deliveries VALUES
    ('delivery_1', 1, 'recipient_1', 'resend',
     '56761188-7520-42d8-8898-ff6fc54ce618', 'none', NULL,
     '2026-08-25T17:00:00.000Z');
  INSERT INTO forecast_email_consent_revisions VALUES
    (1, 1, 'recipient_1', 1, 1, 1, 1, 1, 'operator',
     '2026-08-25T17:00:00.000Z', NULL, '2026-08-25T17:00:00.000Z');
  INSERT INTO forecast_email_consents VALUES
    (1, 1, 'recipient_1', '2026-08-25T17:00:00.000Z');`);
  return database;
}

function officialEvent(
  type: string,
  providerEmailId: string | null = '56761188-7520-42d8-8898-ff6fc54ce618',
  occurredAt = '2026-08-25T17:59:00.000Z',
) {
  return JSON.stringify({
    type,
    created_at: occurredAt,
    data: {
      ...(providerEmailId === null ? {} : { email_id: providerEmailId }),
      from: 'Northstar <journal@example.test>',
      to: ['recipient@example.test'],
      subject: 'Private forecast subject',
      tags: { category: 'private-provider-tag' },
    },
  });
}

function signedHeaders(rawBody: string, epochSeconds: number, webhookId = 'msg_webhook_001') {
  const signature = new Webhook(SECRET).sign(webhookId, new Date(epochSeconds * 1_000), rawBody);
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'svix-id': webhookId,
    'svix-timestamp': String(epochSeconds),
    'svix-signature': signature,
  };
}

function request(rawBody: string, epochSeconds: number, init: {
  headers?: Record<string, string>;
  signedBody?: string;
  webhookId?: string;
} = {}) {
  return new Request('https://northstar.example/api/webhooks/resend', {
    method: 'POST',
    headers: {
      ...signedHeaders(init.signedBody ?? rawBody, epochSeconds, init.webhookId),
      ...init.headers,
    },
    body: rawBody,
  });
}

function d1Harness(database: DatabaseSync) {
  const logger = new RecordingLogger();
  const epochSeconds = Math.floor(Date.now() / 1_000);
  const repository = new D1EmailWebhookRepository(
    new SQLiteD1(database) as unknown as D1Database,
  );
  const handler = createResendWebhookHandler({
    webhookSecret: SECRET,
    maxBodyBytes: MAX_BODY_BYTES,
    now: () => RECEIVED_AT,
    nowEpochSeconds: () => epochSeconds,
    async service() { return new ResendWebhookService(repository, logger); },
  });
  return { handler, logger, epochSeconds };
}

function harness(options: {
  repository?: RecordingRepository;
  logger?: RecordingLogger;
  epochSeconds?: number;
  secret?: string | null;
} = {}) {
  const repository = options.repository ?? new RecordingRepository();
  const logger = options.logger ?? new RecordingLogger();
  const epochSeconds = options.epochSeconds ?? Math.floor(Date.now() / 1_000);
  let serviceCalls = 0;
  const handler = createResendWebhookHandler({
    webhookSecret: options.secret === undefined ? SECRET : options.secret,
    maxBodyBytes: MAX_BODY_BYTES,
    now: () => RECEIVED_AT,
    nowEpochSeconds: () => epochSeconds,
    async service() {
      serviceCalls += 1;
      return new ResendWebhookService(repository, logger);
    },
  });
  return { repository, logger, epochSeconds, handler, serviceCalls: () => serviceCalls };
}

test('a valid signed delivery event is verified before a PII-free persistence call', async () => {
  const runtime = harness();
  const rawBody = officialEvent('email.delivered');
  const response = await runtime.handler(request(rawBody, runtime.epochSeconds));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(runtime.serviceCalls(), 1);
  assert.equal(runtime.repository.inputs.length, 1);
  const persisted = runtime.repository.inputs[0];
  assert.equal(persisted.eventType, 'email.delivered');
  assert.equal(persisted.reconciliationState, 'delivered');
  assert.equal(persisted.supported, true);
  assert.match(persisted.id, /^[a-f0-9]{64}$/u);
  assert.match(persisted.payloadHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(persisted).sort(), [
    'eventType', 'id', 'occurredAt', 'payloadHash', 'providerEmailId',
    'providerEventId', 'receivedAt', 'reconciliationState', 'revokeConsent',
    'supported', 'suppressionReason',
  ].sort());
  const persistenceJson = JSON.stringify(persisted);
  assert.doesNotMatch(persistenceJson, /recipient@example\.test|Private forecast subject|private-provider-tag/u);
});

test('supported Resend delivery events map to frozen reconciliation and suppression actions', async () => {
  const cases = [
    ['email.delivery_delayed', 'delayed', null, false],
    ['email.delivered', 'delivered', null, false],
    ['email.failed', 'failed', null, false],
    ['email.bounced', 'bounced', 'hard_bounce', false],
    ['email.complained', 'complained', 'complaint', true],
    ['email.suppressed', 'suppressed', 'provider_suppressed', false],
  ] as const;
  for (const [type, state, suppression, revokeConsent] of cases) {
    const runtime = harness();
    const rawBody = officialEvent(type);
    const response = await runtime.handler(request(rawBody, runtime.epochSeconds));
    assert.equal(response.status, 200, type);
    assert.equal(runtime.repository.inputs[0].reconciliationState, state, type);
    assert.equal(runtime.repository.inputs[0].suppressionReason, suppression, type);
    assert.equal(runtime.repository.inputs[0].revokeConsent, revokeConsent, type);
  }
});

test('modified raw body, stale signatures, and missing headers fail before service construction', async () => {
  {
    const runtime = harness();
    const original = officialEvent('email.delivered');
    const modified = original.replace('email.delivered', 'email.bounced');
    const response = await runtime.handler(request(modified, runtime.epochSeconds, { signedBody: original }));
    assert.equal(response.status, 400);
    assert.equal(runtime.serviceCalls(), 0);
  }
  {
    const runtime = harness();
    const stale = runtime.epochSeconds - 301;
    const rawBody = officialEvent('email.delivered');
    const response = await runtime.handler(request(rawBody, stale));
    assert.equal(response.status, 400);
    assert.equal(runtime.serviceCalls(), 0);
  }
  {
    const runtime = harness();
    const rawBody = officialEvent('email.delivered');
    const response = await runtime.handler(request(rawBody, runtime.epochSeconds, {
      headers: { 'svix-signature': '' },
    }));
    assert.equal(response.status, 400);
    assert.equal(runtime.serviceCalls(), 0);
  }
});

test('strict media, declared length, streamed length, and UTF-8 bounds apply before verification', async () => {
  {
    const runtime = harness();
    const rawBody = officialEvent('email.delivered');
    const response = await runtime.handler(request(rawBody, runtime.epochSeconds, {
      headers: { 'Content-Type': 'text/plain' },
    }));
    assert.equal(response.status, 415);
    assert.equal(runtime.serviceCalls(), 0);
  }
  {
    const runtime = harness();
    const rawBody = officialEvent('email.delivered');
    const response = await runtime.handler(request(rawBody, runtime.epochSeconds, {
      headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) },
    }));
    assert.equal(response.status, 413);
    assert.equal(runtime.serviceCalls(), 0);
  }
  {
    const runtime = harness();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_BODY_BYTES));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() { cancelled = true; },
    });
    const streamed = new Request('https://northstar.example/api/webhooks/resend', {
      method: 'POST',
      headers: signedHeaders('{}', runtime.epochSeconds),
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const response = await runtime.handler(streamed);
    assert.equal(response.status, 413);
    assert.equal(cancelled, true);
    assert.equal(runtime.serviceCalls(), 0);
  }
  {
    const runtime = harness();
    const invalidUtf8 = new Uint8Array([0xc3, 0x28]);
    const invalid = new Request('https://northstar.example/api/webhooks/resend', {
      method: 'POST',
      headers: signedHeaders('not-the-decoded-body', runtime.epochSeconds),
      body: invalidUtf8,
    });
    const response = await runtime.handler(invalid);
    assert.equal(response.status, 400);
    assert.equal(runtime.serviceCalls(), 0);
  }
});

test('signed malformed envelopes are rejected and signed unknown events are safely acknowledged', async () => {
  {
    const runtime = harness();
    const rawBody = JSON.stringify({
      type: 'email.delivered',
      created_at: '2026-08-25T17:59:00.000Z',
      data: { email_id: 'valid-id' },
      unexpected: true,
    });
    const response = await runtime.handler(request(rawBody, runtime.epochSeconds));
    assert.equal(response.status, 400);
    assert.equal(runtime.repository.inputs.length, 0);
  }
  {
    const runtime = harness();
    const rawBody = officialEvent('email.opened');
    const response = await runtime.handler(request(rawBody, runtime.epochSeconds));
    assert.equal(response.status, 200);
    assert.equal(runtime.repository.inputs.length, 0);
    assert.deepEqual(runtime.logger.events, [{
      event: 'resend_webhook_unsupported',
      eventType: 'email.opened',
    }]);
  }
  {
    const runtime = harness();
    const rawBody = officialEvent('domain.updated', null);
    const response = await runtime.handler(request(rawBody, runtime.epochSeconds));
    assert.equal(response.status, 200);
    assert.equal(runtime.repository.inputs.length, 0);
    assert.deepEqual(runtime.logger.events, [{
      event: 'resend_webhook_unsupported',
      eventType: 'domain.updated',
    }]);
  }
});

test('configuration and persistence failures are generic and never claim acceptance', async () => {
  {
    const runtime = harness({ secret: null });
    const rawBody = officialEvent('email.delivered');
    const response = await runtime.handler(request(rawBody, runtime.epochSeconds));
    assert.equal(response.status, 503);
    assert.equal(await response.text(), 'Webhook unavailable.');
    assert.equal(runtime.serviceCalls(), 0);
  }
  {
    const repository = new RecordingRepository();
    repository.failure = new Error('database contains recipient@example.test');
    const runtime = harness({ repository });
    const rawBody = officialEvent('email.delivered');
    const response = await runtime.handler(request(rawBody, runtime.epochSeconds));
    assert.equal(response.status, 503);
    assert.equal(await response.text(), 'Webhook unavailable.');
  }
});

test('D1 reconciliation applies delivery once and database uniqueness absorbs retries', async () => {
  const database = webhookDatabase();
  const runtime = d1Harness(database);
  const rawBody = officialEvent('email.delivered');
  const first = await runtime.handler(request(rawBody, runtime.epochSeconds, {
    webhookId: 'msg_delivery_replay',
  }));
  const replay = await runtime.handler(request(rawBody, runtime.epochSeconds, {
    webhookId: 'msg_delivery_replay',
  }));
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.deepEqual({ ...database.prepare(`SELECT reconciliation_state AS state,
      reconciliation_event_at AS eventAt FROM forecast_email_deliveries`).get() }, {
    state: 'delivered', eventAt: '2026-08-25T17:59:00.000Z',
  });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM forecast_email_provider_events').get()?.count, 1);
  assert.equal(database.prepare('SELECT handling_state AS state FROM forecast_email_provider_events').get()?.state,
    'applied');
  database.close();
});

test('D1 reconciliation records an unknown provider email without revealing or mutating delivery state', async () => {
  const database = webhookDatabase();
  const runtime = d1Harness(database);
  const rawBody = officialEvent('email.failed', 'unknown-provider-email-id');
  const response = await runtime.handler(request(rawBody, runtime.epochSeconds, {
    webhookId: 'msg_unknown_delivery',
  }));
  assert.equal(response.status, 200);
  assert.equal(database.prepare('SELECT reconciliation_state AS state FROM forecast_email_deliveries').get()?.state,
    'none');
  assert.deepEqual({ ...database.prepare(`SELECT handling_state AS handlingState,
      delivery_id AS deliveryId, profile_id AS profileId
      FROM forecast_email_provider_events`).get() }, {
    handlingState: 'unknown_delivery', deliveryId: null, profileId: null,
  });
  database.close();
});

test('D1 reconciliation applies a supported webhook that arrived before provider acceptance was persisted', async () => {
  const database = webhookDatabase();
  database.prepare(`UPDATE forecast_email_deliveries SET provider_email_id = NULL`).run();
  const runtime = d1Harness(database);
  const providerEmailId = '56761188-7520-42d8-8898-ff6fc54ce618';
  const rawBody = officialEvent(
    'email.failed', providerEmailId, '2026-08-25T17:59:00.000Z',
  );
  const first = await runtime.handler(request(rawBody, runtime.epochSeconds, {
    webhookId: 'msg_before_acceptance',
  }));
  assert.equal(first.status, 200);
  assert.equal(database.prepare(`SELECT handling_state AS state
    FROM forecast_email_provider_events`).get()?.state, 'unknown_delivery');

  database.prepare(`UPDATE forecast_email_deliveries SET provider_email_id = ?
    WHERE id = 'delivery_1'`).run(providerEmailId);
  const repository = new D1EmailWebhookRepository(
    new SQLiteD1(database) as unknown as D1Database,
  );
  await repository.reconcilePendingForProviderEmail(providerEmailId);

  assert.deepEqual({ ...database.prepare(`SELECT reconciliation_state AS state,
      reconciliation_event_at AS eventAt FROM forecast_email_deliveries`).get() }, {
    state: 'failed', eventAt: '2026-08-25T17:59:00.000Z',
  });
  assert.deepEqual({ ...database.prepare(`SELECT handling_state AS handlingState,
      delivery_id AS deliveryId, profile_id AS profileId
      FROM forecast_email_provider_events`).get() }, {
    handlingState: 'applied', deliveryId: 'delivery_1', profileId: 1,
  });
  const replay = await runtime.handler(request(rawBody, runtime.epochSeconds, {
    webhookId: 'msg_before_acceptance',
  }));
  assert.equal(replay.status, 200);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count
    FROM forecast_email_provider_events`).get()?.count, 1);
  database.close();
});

test('D1 precedence orders delivered versus failed by occurrence time, failure wins ties, and delayed cannot downgrade', async () => {
  {
    const database = webhookDatabase();
    const runtime = d1Harness(database);
    for (const [webhookId, body] of [
      ['msg_delivered_first', officialEvent('email.delivered', undefined,
        '2026-08-25T17:58:00.000Z')],
      ['msg_delayed_later', officialEvent('email.delivery_delayed', undefined,
        '2026-08-25T18:00:00.000Z')],
      ['msg_failed_later', officialEvent('email.failed', undefined,
        '2026-08-25T18:01:00.000Z')],
    ] as const) {
      assert.equal((await runtime.handler(request(body, runtime.epochSeconds, { webhookId }))).status, 200);
    }
    assert.equal(database.prepare('SELECT reconciliation_state AS state FROM forecast_email_deliveries').get()?.state,
      'failed');
    assert.deepEqual(database.prepare(`SELECT event_type AS type, handling_state AS state
      FROM forecast_email_provider_events ORDER BY event_occurred_at`).all().map((row) => ({ ...row })), [
      { type: 'email.delivered', state: 'applied' },
      { type: 'email.delivery_delayed', state: 'ignored_precedence' },
      { type: 'email.failed', state: 'applied' },
    ]);
    database.close();
  }
  {
    const database = webhookDatabase();
    const runtime = d1Harness(database);
    const failed = officialEvent('email.failed', undefined, '2026-08-25T17:58:00.000Z');
    const delivered = officialEvent('email.delivered', undefined, '2026-08-25T18:01:00.000Z');
    await runtime.handler(request(failed, runtime.epochSeconds, { webhookId: 'msg_failed_first' }));
    await runtime.handler(request(delivered, runtime.epochSeconds, { webhookId: 'msg_delivered_later' }));
    assert.equal(database.prepare('SELECT reconciliation_state AS state FROM forecast_email_deliveries').get()?.state,
      'delivered');
    assert.equal(database.prepare(`SELECT handling_state AS state FROM forecast_email_provider_events
      WHERE event_type = 'email.delivered'`).get()?.state, 'applied');
    database.close();
  }
  {
    const database = webhookDatabase();
    const runtime = d1Harness(database);
    const occurredAt = '2026-08-25T17:58:00.000Z';
    const delivered = officialEvent('email.delivered', undefined, occurredAt);
    const failed = officialEvent('email.failed', undefined, occurredAt);
    await runtime.handler(request(delivered, runtime.epochSeconds, { webhookId: 'msg_delivered_tie' }));
    await runtime.handler(request(failed, runtime.epochSeconds, { webhookId: 'msg_failed_tie' }));
    assert.equal(database.prepare('SELECT reconciliation_state AS state FROM forecast_email_deliveries').get()?.state,
      'failed');
    database.close();
  }
});

test('D1 bounce overrides delivery and appends durable recipient suppression evidence', async () => {
  const database = webhookDatabase();
  const runtime = d1Harness(database);
  const delivered = officialEvent('email.delivered', undefined, '2026-08-25T17:58:00.000Z');
  const bounced = officialEvent('email.bounced', undefined, '2026-08-25T18:01:00.000Z');
  await runtime.handler(request(delivered, runtime.epochSeconds, { webhookId: 'msg_before_bounce' }));
  await runtime.handler(request(bounced, runtime.epochSeconds, { webhookId: 'msg_hard_bounce' }));
  assert.equal(database.prepare('SELECT reconciliation_state AS state FROM forecast_email_deliveries').get()?.state,
    'bounced');
  assert.deepEqual({ ...database.prepare(`SELECT suppression_state AS state,
      suppression_reason AS reason, suppressed_at AS suppressedAt
      FROM forecast_email_recipients`).get() }, {
    state: 'suppressed', reason: 'hard_bounce', suppressedAt: '2026-08-25T18:01:00.000Z',
  });
  assert.deepEqual({ ...database.prepare(`SELECT action, reason, occurred_at AS occurredAt
      FROM forecast_email_suppression_events`).get() }, {
    action: 'suppressed', reason: 'hard_bounce', occurredAt: '2026-08-25T18:01:00.000Z',
  });
  database.close();
});

test('D1 permanent suppression evidence is ordered across bounce and provider-suppressed event types', async () => {
  {
    const database = webhookDatabase();
    const runtime = d1Harness(database);
    await runtime.handler(request(officialEvent('email.suppressed', undefined,
      '2026-08-25T18:02:00.000Z'), runtime.epochSeconds, { webhookId: 'msg_new_suppressed' }));
    await runtime.handler(request(officialEvent('email.bounced', undefined,
      '2026-08-25T18:01:00.000Z'), runtime.epochSeconds, { webhookId: 'msg_old_bounced' }));
    assert.equal(database.prepare(`SELECT reconciliation_state AS state
      FROM forecast_email_deliveries`).get()?.state, 'suppressed');
    assert.equal(database.prepare(`SELECT handling_state AS state
      FROM forecast_email_provider_events WHERE event_type = 'email.bounced'`).get()?.state,
    'ignored_precedence');
    database.close();
  }
  {
    const database = webhookDatabase();
    const runtime = d1Harness(database);
    await runtime.handler(request(officialEvent('email.bounced', undefined,
      '2026-08-25T18:02:00.000Z'), runtime.epochSeconds, { webhookId: 'msg_new_bounced' }));
    await runtime.handler(request(officialEvent('email.suppressed', undefined,
      '2026-08-25T18:01:00.000Z'), runtime.epochSeconds, { webhookId: 'msg_old_suppressed' }));
    assert.equal(database.prepare(`SELECT reconciliation_state AS state
      FROM forecast_email_deliveries`).get()?.state, 'bounced');
    assert.equal(database.prepare(`SELECT handling_state AS state
      FROM forecast_email_provider_events WHERE event_type = 'email.suppressed'`).get()?.state,
    'ignored_precedence');
    database.close();
  }
});

test('D1 complaint suppresses recipient and atomically appends a disabled consent revision', async () => {
  const database = webhookDatabase();
  const runtime = d1Harness(database);
  const complained = officialEvent('email.complained', undefined, '2026-08-25T18:02:00.000Z');
  const response = await runtime.handler(request(complained, runtime.epochSeconds, {
    webhookId: 'msg_complaint',
  }));
  assert.equal(response.status, 200);
  assert.equal(database.prepare('SELECT reconciliation_state AS state FROM forecast_email_deliveries').get()?.state,
    'complained');
  assert.deepEqual({ ...database.prepare(`SELECT suppression_state AS state,
      suppression_reason AS reason FROM forecast_email_recipients`).get() }, {
    state: 'suppressed', reason: 'complaint',
  });
  assert.deepEqual({ ...database.prepare(`SELECT current_revision AS revision,
      recipient_id AS recipientId FROM forecast_email_consents`).get() }, {
    revision: 2, recipientId: 'recipient_1',
  });
  assert.deepEqual(database.prepare(`SELECT revision, master_consent AS masterConsent,
      target_hit_enabled AS targetHit, invalidated_enabled AS invalidated,
      expired_enabled AS expired, needs_review_enabled AS needsReview,
      consent_source AS source, consented_at AS consentedAt, revoked_at AS revokedAt
      FROM forecast_email_consent_revisions ORDER BY revision`).all().map((row) => ({ ...row })), [
    {
      revision: 1, masterConsent: 1, targetHit: 1, invalidated: 1,
      expired: 1, needsReview: 1, source: 'operator',
      consentedAt: '2026-08-25T17:00:00.000Z', revokedAt: null,
    },
    {
      revision: 2, masterConsent: 0, targetHit: 0, invalidated: 0,
      expired: 0, needsReview: 0, source: 'provider_complaint',
      consentedAt: null, revokedAt: '2026-08-25T18:02:00.000Z',
    },
  ]);
  const replay = await runtime.handler(request(complained, runtime.epochSeconds, {
    webhookId: 'msg_complaint',
  }));
  assert.equal(replay.status, 200);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM forecast_email_consent_revisions').get()?.count, 2);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM forecast_email_suppression_events').get()?.count, 1);
  const laterComplaint = officialEvent(
    'email.complained', undefined, '2026-08-25T18:03:00.000Z',
  );
  await runtime.handler(request(laterComplaint, runtime.epochSeconds, {
    webhookId: 'msg_complaint_followup',
  }));
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM forecast_email_consent_revisions').get()?.count, 2);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM forecast_email_suppression_events').get()?.count, 2);
  database.close();
});

test('signed open and click events are acknowledged without tracking or delivery mutation', async () => {
  const database = webhookDatabase();
  const runtime = d1Harness(database);
  for (const [webhookId, type] of [
    ['msg_opened', 'email.opened'],
    ['msg_clicked', 'email.clicked'],
  ] as const) {
    const rawBody = officialEvent(type);
    assert.equal((await runtime.handler(request(rawBody, runtime.epochSeconds, { webhookId }))).status, 200);
  }
  assert.equal(database.prepare('SELECT reconciliation_state AS state FROM forecast_email_deliveries').get()?.state,
    'none');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM forecast_email_provider_events').get()?.count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM forecast_email_suppression_events').get()?.count, 0);
  assert.deepEqual(runtime.logger.events.map((event) => event.eventType), ['email.opened', 'email.clicked']);
  database.close();
});
