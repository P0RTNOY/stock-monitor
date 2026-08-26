import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { forecastInitializationStatements } from '../../db/forecast-initialization.ts';
import { inAppNotificationInitializationStatements } from '../../db/in-app-notification-initialization.ts';
import { IN_APP_PROJECTOR_VERSION, InAppNotificationError } from './server/in-app-notifications/contract.ts';
import { D1InAppNotificationRepository } from './server/in-app-notifications/repository.ts';
import {
  InAppNotificationService,
  type InAppCrypto,
  type InAppRuntime,
} from './server/in-app-notifications/service.ts';
import { NOTIFICATION_PAYLOAD_SCHEMA_VERSION, NOTIFICATION_PROJECTOR_VERSION, NOTIFICATION_DEDUP_VERSION } from './server/notifications/contract.ts';
import {
  canonicalNotificationPayloadJson,
  notificationIntentId,
  notificationPayloadFingerprint,
  notificationSourceDedupKey,
} from './server/notifications/payload.ts';
import type { NotificationCategory, NotificationPayload } from './server/notifications/types.ts';

const NOW = '2026-08-26T10:00:00.000Z';
const CUTOFF = '2026-08-26T12:00:00.000Z';

class SQLitePrepared {
  private bindings: Array<string | number | null> = [];
  private readonly database: DatabaseSync;
  private readonly sql: string;
  constructor(database: DatabaseSync, sql: string) { this.database = database; this.sql = sql; }
  bind(...values: Array<string | number | null>) { const next = new SQLitePrepared(this.database, this.sql); next.bindings = values; return next; }
  async first<T>() { return (this.database.prepare(this.sql).get(...this.bindings) ?? null) as T | null; }
  async all<T>() { return { success: true, results: this.database.prepare(this.sql).all(...this.bindings) as T[], meta: {} }; }
  async run() { return this.execute(); }
  execute() { const value = this.database.prepare(this.sql).run(...this.bindings); return { success: true, results: [], meta: { changes: value.changes, last_row_id: Number(value.lastInsertRowid) } }; }
}

class SQLiteD1 {
  protected readonly database: DatabaseSync;
  constructor(database: DatabaseSync) { this.database = database; }
  prepare(sql: string) { return new SQLitePrepared(this.database, sql); }
  async batch(statements: SQLitePrepared[]) {
    this.database.exec('BEGIN');
    try { const result = statements.map((statement) => statement.execute()); this.database.exec('COMMIT'); return result; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
}

class FailBeforeCheckpointD1 extends SQLiteD1 {
  private fail = true;

  override async batch(statements: SQLitePrepared[]) {
    if (!this.fail || statements.length < 3) return super.batch(statements);
    this.fail = false;
    this.database.exec('BEGIN');
    try {
      for (const statement of statements.slice(0, -1)) statement.execute();
      throw new Error('InjectedCheckpointFailure');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

class Runtime implements InAppRuntime {
  instant = NOW;
  sequence = 0;
  now() { return this.instant; }
  token() { this.sequence += 1; return `in-app-token-${this.sequence}`; }
}

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`CREATE TABLE investment_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, base_currency TEXT NOT NULL DEFAULT 'USD',
    cash_balance REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  )`);
  for (const statement of forecastInitializationStatements()) db.exec(statement);
  for (const statement of inAppNotificationInitializationStatements()) db.exec(statement);
  db.exec(`INSERT INTO investment_profiles VALUES (1, 'Mine', 'USD', 0, '${NOW}');
    INSERT INTO forecasts
      (profile_id, symbol, direction, confidence, thesis, supporting_evidence, counter_evidence,
       setup_tag, evaluation_date, target_kind, target_price, status, activated_at,
       market_data_as_of, activation_price, activation_currency, market_provider, created_at, updated_at)
    VALUES (1, 'AAPL', 'bullish', 80, 'Original thesis', 'support', 'counter', 'manual',
      '2026-09-30', 'price', 150, 'active', '${NOW}', '${NOW}', 100, 'USD', 'test', '${NOW}', '${NOW}')`);
  return db;
}

function services(
  db: DatabaseSync,
  runtime = new Runtime(),
  d1: SQLiteD1 = new SQLiteD1(db),
  cryptoRuntime?: InAppCrypto,
) {
  const repository = new D1InAppNotificationRepository(d1 as unknown as D1Database);
  return {
    repository,
    runtime,
    service: new InAppNotificationService(repository, runtime, cryptoRuntime),
  };
}

async function digest(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hashed].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function payload(category: NotificationCategory, evaluationRunId: number, reviewItemId: number, occurredAt: string): NotificationPayload {
  const terminal = category !== 'needs_review';
  return {
    payloadVersion: NOTIFICATION_PAYLOAD_SCHEMA_VERSION,
    profileId: 1, forecastId: 1, evaluationRunId, reviewItemId, category,
    previousStatus: 'active', resultingStatus: category === 'needs_review' ? 'active' : category,
    symbol: 'AAPL',
    reasonCode: category === 'target_hit' ? 'target_boundary_touched'
      : category === 'invalidated' ? 'invalidation_boundary_touched'
        : category === 'expired' ? 'horizon_complete_without_terminal_touch' : 'currency_unverified',
    evaluatedThrough: category === 'expired' ? '2026-09-30' : '2026-08-26',
    triggeringMarketDate: category === 'target_hit' || category === 'invalidated' ? '2026-08-26' : null,
    occurredAt, evaluationCutoff: CUTOFF,
    targetBoundary: category === 'target_hit' ? 150 : null,
    targetRange: null,
    invalidationBoundary: category === 'invalidated' ? 90 : null,
    detectedAt: category === 'target_hit' || category === 'invalidated' ? 'open' : null,
    crossedBoundary: category === 'target_hit' ? 150 : category === 'invalidated' ? 90 : null,
    activationCurrency: 'USD', observedCurrency: terminal && category !== 'expired' ? 'USD' : null,
    analysisSnapshotId: null, evaluatorVersion: 'forecast-evaluator-1.0.0', rulesetVersion: 'forecast-evaluation-ruleset-1.0.0',
  };
}

let sourceSequence = 0;
async function insertSource(db: DatabaseSync, category: NotificationCategory = 'needs_review', options: {
  occurredAt?: string; createdAt?: string; payloadVersion?: string; corruptFingerprint?: boolean;
} = {}) {
  sourceSequence += 1;
  const createdAt = options.createdAt ?? `2026-08-26T10:${String(sourceSequence).padStart(2, '0')}:00.000Z`;
  const evaluation = db.prepare(`INSERT INTO evaluation_runs
    (profile_id, forecast_id, result_kind, reason_code, explanation, evaluator_version,
     ruleset_version, evaluated_through, evaluation_cutoff, evidence_json, warnings_json,
     input_fingerprint, created_at)
    VALUES (1, 1, ?, ?, 'safe explanation', 'forecast-evaluator-1.0.0',
      'forecast-evaluation-ruleset-1.0.0', '2026-08-26', ?, '{}', '[]', ?, ?)`)
    .run(category, category === 'needs_review' ? 'currency_unverified' : `${category}_reason`, CUTOFF, sourceSequence.toString(16).padStart(64, '0'), createdAt);
  const evaluationRunId = Number(evaluation.lastInsertRowid);
  const review = db.prepare(`INSERT INTO forecast_review_items
    (profile_id, forecast_id, evaluation_run_id, review_kind, acknowledged_at, created_at)
    VALUES (1, 1, ?, ?, NULL, ?)`).run(evaluationRunId, category === 'needs_review' ? 'needs_review' : 'resolved', createdAt);
  const reviewItemId = Number(review.lastInsertRowid);
  const value = payload(category, evaluationRunId, reviewItemId, options.occurredAt ?? createdAt);
  const json = canonicalNotificationPayloadJson(value);
  const [id, dedupKey, fingerprint] = await Promise.all([
    notificationIntentId(value), notificationSourceDedupKey(value), notificationPayloadFingerprint(value),
  ]);
  db.prepare(`INSERT INTO forecast_notification_intents
    (id, profile_id, forecast_id, evaluation_run_id, review_item_id, analysis_snapshot_id,
     category, dedup_contract_version, projector_version, payload_schema_version, dedup_key,
     payload_json, payload_fingerprint, event_occurred_at, created_at)
    VALUES (?, 1, 1, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, evaluationRunId, reviewItemId, category, NOTIFICATION_DEDUP_VERSION,
      NOTIFICATION_PROJECTOR_VERSION, options.payloadVersion ?? NOTIFICATION_PAYLOAD_SCHEMA_VERSION,
      dedupKey, json, options.corruptFingerprint ? '0'.repeat(64) : fingerprint,
      value.occurredAt, createdAt);
  return { id, evaluationRunId };
}

async function insertSiblingIntent(
  db: DatabaseSync,
  evaluationRunId: number,
  category: NotificationCategory,
  createdAt = '2026-08-26T11:30:00.000Z',
) {
  const review = db.prepare(`SELECT id FROM forecast_review_items WHERE evaluation_run_id = ?`)
    .get(evaluationRunId) as { id: number };
  const value = payload(category, evaluationRunId, Number(review.id), createdAt);
  const json = canonicalNotificationPayloadJson(value);
  const [id, dedupKey, fingerprint] = await Promise.all([
    notificationIntentId(value), notificationSourceDedupKey(value), notificationPayloadFingerprint(value),
  ]);
  db.prepare(`INSERT INTO forecast_notification_intents
    (id, profile_id, forecast_id, evaluation_run_id, review_item_id, analysis_snapshot_id,
     category, dedup_contract_version, projector_version, payload_schema_version, dedup_key,
     payload_json, payload_fingerprint, event_occurred_at, created_at)
    VALUES (?, 1, 1, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, evaluationRunId, review.id, category, NOTIFICATION_DEDUP_VERSION,
      NOTIFICATION_PROJECTOR_VERSION, NOTIFICATION_PAYLOAD_SCHEMA_VERSION,
      dedupKey, json, fingerprint, value.occurredAt, createdAt);
  return id;
}

async function baseline(service: InAppNotificationService) {
  const preview = await service.project({ profileId: 1, cutoff: CUTOFF }, 1);
  assert.equal(preview.disposition, 'baseline_would_be_established');
  return service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit' }, 1);
}

function count(db: DatabaseSync, table: string) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
}

test('first commit establishes an intent baseline and all four later categories materialize independently', async () => {
  const db = database();
  const { service } = services(db);
  const established = await baseline(service);
  assert.equal(established.baselineEvaluationRunId, 0);
  for (const category of ['target_hit', 'invalidated', 'expired', 'needs_review'] as const) await insertSource(db, category);
  const report = await service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit', limit: 10 }, 1);
  assert.equal(report.materializedCount, 4);
  assert.equal(count(db, 'forecast_in_app_notification_entries'), 4);
  assert.equal(count(db, 'forecast_notification_outbox'), 0);
  assert.deepEqual(db.prepare(`SELECT DISTINCT state FROM forecast_in_app_notification_entries`).all().map((row) => ({ ...row })), [{ state: 'unread' }]);
  db.close();
});

test('malformed and unsupported intents are isolated durably without creating entries', async () => {
  const db = database();
  const { service } = services(db);
  await baseline(service);
  await insertSource(db, 'needs_review', { corruptFingerprint: true });
  await insertSource(db, 'needs_review', { payloadVersion: 'future-payload-v9' });
  const report = await service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit' }, 1);
  assert.equal(report.invalidSourceCount, 1);
  assert.equal(report.unsupportedSourceCount, 1);
  assert.equal(count(db, 'forecast_in_app_notification_entries'), 0);
  assert.equal(count(db, 'forecast_in_app_notification_projection_items'), 2);
  const checkpoint = db.prepare(`SELECT last_evaluation_run_id AS lastId FROM forecast_in_app_notification_projection_checkpoints`).get();
  assert.equal(checkpoint?.lastId, report.endingEvaluationRunId);
  db.close();
});

test('composite checkpoint traverses same-evaluation siblings and bounded pages without loss', async () => {
  const db = database();
  const { service } = services(db);
  await baseline(service);
  const first = await insertSource(db, 'needs_review');
  await insertSiblingIntent(db, first.evaluationRunId, 'target_hit');
  await insertSource(db, 'expired');
  for (let page = 0; page < 3; page += 1) {
    const report = await service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit', limit: 1 }, 1);
    assert.equal(report.selectedCount, 1);
  }
  const replay = await service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit', limit: 1 }, 1);
  assert.equal(replay.selectedCount, 0);
  assert.equal(count(db, 'forecast_in_app_notification_entries'), 3);
  assert.equal(count(db, 'forecast_in_app_notification_projection_items'), 3);
  const checkpoint = db.prepare(`SELECT last_evaluation_run_id AS evaluationRunId,
    last_intent_id AS intentId FROM forecast_in_app_notification_projection_checkpoints`).get();
  assert.equal(checkpoint?.evaluationRunId, 2);
  assert.equal(typeof checkpoint?.intentId, 'string');
  db.close();
});

test('crypto failure stops projection without poison classification or checkpoint advancement', async () => {
  const db = database();
  const normal = services(db);
  await baseline(normal.service);
  await insertSource(db);
  const before = db.prepare(`SELECT last_evaluation_run_id AS evaluationRunId,
    last_intent_id AS intentId FROM forecast_in_app_notification_projection_checkpoints`).get();
  const failingCrypto: InAppCrypto = {
    sha256: digest,
    notificationPayloadFingerprint: async () => { throw new Error('InjectedCryptoFailure'); },
  };
  const failing = services(db, new Runtime(), new SQLiteD1(db), failingCrypto);
  await assert.rejects(
    () => failing.service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit' }, 1),
    /InjectedCryptoFailure/u,
  );
  assert.deepEqual(db.prepare(`SELECT last_evaluation_run_id AS evaluationRunId,
    last_intent_id AS intentId FROM forecast_in_app_notification_projection_checkpoints`).get(), before);
  assert.equal(count(db, 'forecast_in_app_notification_projection_items'), 0);
  assert.equal(count(db, 'forecast_in_app_notification_entries'), 0);
  await normal.service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit' }, 1);
  assert.equal(count(db, 'forecast_in_app_notification_entries'), 1);
  db.close();
});

test('malformed source creation time is isolated and cannot starve a later valid intent', async () => {
  const db = database();
  const { service } = services(db);
  await baseline(service);
  const malformed = await insertSource(db);
  db.prepare(`UPDATE forecast_notification_intents SET created_at = 'not-a-time' WHERE id = ?`)
    .run(malformed.id);
  await insertSource(db);
  const report = await service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit', limit: 10 }, 1);
  assert.equal(report.invalidSourceCount, 1);
  assert.equal(report.materializedCount, 1);
  assert.equal(count(db, 'forecast_in_app_notification_projection_items'), 2);
  assert.equal(count(db, 'forecast_in_app_notification_entries'), 1);
  db.close();
});

test('oversized malformed source identity is isolated without poisoning composite progress', async () => {
  const db = database();
  const { service } = services(db);
  await baseline(service);
  const malformed = await insertSource(db);
  const oversizedId = `malformed-${'x'.repeat(240)}`;
  db.prepare(`UPDATE forecast_notification_intents SET id = ? WHERE id = ?`)
    .run(oversizedId, malformed.id);
  await insertSource(db);
  const report = await service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit', limit: 10 }, 1);
  assert.equal(report.invalidSourceCount, 1);
  assert.equal(report.materializedCount, 1);
  assert.deepEqual(db.prepare(`SELECT classification, reason_code AS reasonCode
    FROM forecast_in_app_notification_projection_items ORDER BY evaluation_run_id`).all().map((row) => ({ ...row })), [
    { classification: 'malformed_source', reasonCode: 'source_intent_id_invalid' },
    { classification: 'materialized', reasonCode: 'trusted_intent_materialized' },
  ]);
  const checkpoint = db.prepare(`SELECT last_evaluation_run_id AS evaluationRunId,
    last_intent_id AS intentId FROM forecast_in_app_notification_projection_checkpoints`).get();
  assert.equal(checkpoint?.evaluationRunId, 2);
  assert.match(String(checkpoint?.intentId), /^[a-f0-9]{64}$/u);
  db.close();
});

test('transaction rollback recovers a crash after entry work but before checkpoint advancement', async () => {
  const db = database();
  const normal = services(db);
  await baseline(normal.service);
  await insertSource(db);
  const failing = services(db, new Runtime(), new FailBeforeCheckpointD1(db));
  await assert.rejects(
    () => failing.service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit' }, 1),
    /InjectedCheckpointFailure/u,
  );
  assert.equal(count(db, 'forecast_in_app_notification_entries'), 0);
  assert.equal(count(db, 'forecast_in_app_notification_projection_items'), 0);
  const recovered = await normal.service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit' }, 1);
  assert.equal(recovered.materializedCount, 1);
  assert.equal(count(db, 'forecast_in_app_notification_entries'), 1);
  db.close();
});

test('existing-entry replay is durably classified as a duplicate without resetting state', async () => {
  const db = database();
  const { service } = services(db);
  await baseline(service); await insertSource(db);
  await service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit' }, 1);
  const entry = (await service.list(1, { state: 'all', category: 'all', limit: 20 })).items[0];
  await service.setState(1, entry.id, 'read');
  db.exec(`DELETE FROM forecast_in_app_notification_projection_items;
    UPDATE forecast_in_app_notification_projection_checkpoints
    SET last_evaluation_run_id = baseline_evaluation_run_id,
      last_intent_id = baseline_intent_id`);
  const replay = await service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit' }, 1);
  assert.equal(replay.duplicateCount, 1);
  assert.equal(replay.materializedCount, 0);
  assert.equal((await service.get(1, entry.id)).state, 'read');
  assert.equal(count(db, 'forecast_in_app_notification_entries'), 1);
  assert.deepEqual(db.prepare(`SELECT classification FROM forecast_in_app_notification_projection_items`).all().map((row) => ({ ...row })), [
    { classification: 'duplicate' },
  ]);
  db.close();
});

test('concurrent projectors remain idempotent under lease and database uniqueness', async () => {
  const db = database();
  const first = services(db);
  const second = services(db);
  await baseline(first.service);
  await insertSource(db);
  const reports = await Promise.all([
    first.service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit' }, 1),
    second.service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit' }, 1),
  ]);
  assert.equal(count(db, 'forecast_in_app_notification_entries'), 1);
  assert.equal(count(db, 'forecast_in_app_notification_projection_items'), 1);
  assert.ok(reports.some((report) => report.disposition === 'page_completed'));
  db.close();
});

test('read and unread are idempotent, append audit events only on change, and preserve first_read_at', async () => {
  const db = database();
  const runtime = new Runtime();
  const { service } = services(db, runtime);
  await baseline(service);
  await insertSource(db);
  await service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit' }, 1);
  const entry = (await service.list(1, { state: 'all', category: 'all', limit: 20 })).items[0];
  runtime.instant = '2026-08-26T11:00:00.000Z';
  await service.setState(1, entry.id, 'read');
  await service.setState(1, entry.id, 'read');
  const firstRead = db.prepare(`SELECT first_read_at AS firstRead FROM forecast_in_app_notification_entries`).get()?.firstRead;
  runtime.instant = '2026-08-26T11:05:00.000Z';
  await service.setState(1, entry.id, 'unread');
  await service.setState(1, entry.id, 'unread');
  assert.equal(count(db, 'forecast_in_app_notification_state_events'), 2);
  assert.throws(() => db.prepare(`UPDATE forecast_in_app_notification_state_events SET affected_count = 2`).run(), /append-only/u);
  assert.throws(() => db.prepare(`DELETE FROM forecast_in_app_notification_state_events`).run(), /append-only/u);
  assert.equal(db.prepare(`SELECT first_read_at AS firstRead FROM forecast_in_app_notification_entries`).get()?.firstRead, firstRead);
  await assert.rejects(() => service.setState(2, entry.id, 'read'), (error) => error instanceof InAppNotificationError && error.status === 404);
  db.close();
});

test('profile-scoped list/get and concurrent state changes preserve isolation and audit order', async () => {
  const db = database();
  db.exec(`INSERT INTO investment_profiles VALUES (2, 'Other', 'USD', 0, '${NOW}')`);
  const { service } = services(db);
  await baseline(service); await insertSource(db);
  await service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit' }, 1);
  const entry = (await service.list(1, { state: 'all', category: 'all', limit: 20 })).items[0];
  const tenantAUnread = await service.unreadCount(1);
  assert.equal((await service.list(2, { state: 'all', category: 'all', limit: 20 })).items.length, 0);
  assert.equal((await service.unreadCount(2)).unreadCount, 0);
  await assert.rejects(() => service.get(2, entry.id), (error) => (
    error instanceof InAppNotificationError && error.status === 404
  ));
  await assert.rejects(
    () => service.markAllRead(2, tenantAUnread.markAllReadToken),
    (error) => error instanceof InAppNotificationError && error.status === 400,
  );
  assert.equal((await service.unreadCount(2)).unreadCount, 0);
  assert.equal((await service.get(1, entry.id)).state, 'unread');
  await Promise.all([
    service.setState(1, entry.id, 'read'),
    service.setState(1, entry.id, 'unread'),
  ]);
  assert.equal((await service.get(1, entry.id)).state, 'unread');
  assert.equal(count(db, 'forecast_in_app_notification_state_events'), 2);
  assert.throws(() => db.prepare(`INSERT INTO forecast_in_app_notification_entries
    (id,profile_id,source_intent_id,forecast_id,evaluation_run_id,review_item_id,
     analysis_snapshot_id,category,symbol,occurred_at,presentation_version,presentation_json,
     presentation_fingerprint,deep_link_kind,state,first_read_at,state_updated_at,created_at,updated_at)
    SELECT ?,profile_id,source_intent_id,forecast_id,evaluation_run_id,review_item_id,
      analysis_snapshot_id,category,symbol,occurred_at,presentation_version,presentation_json,
      presentation_fingerprint,deep_link_kind,state,first_read_at,state_updated_at,created_at,updated_at
    FROM forecast_in_app_notification_entries WHERE id = ?`).run('f'.repeat(64), entry.id), /UNIQUE/u);
  db.close();
});

test('mark-all uses the server high water and leaves a later projected entry unread', async () => {
  const db = database();
  const { service } = services(db);
  await baseline(service);
  await insertSource(db); await insertSource(db);
  await service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit' }, 1);
  const snapshot = await service.unreadCount(1);
  await insertSource(db);
  await service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit' }, 1);
  const result = await service.markAllRead(1, snapshot.markAllReadToken);
  assert.equal(result.changedCount, 2);
  assert.equal(result.unreadCount, 1);
  assert.deepEqual(db.prepare(`SELECT state, COUNT(*) AS count FROM forecast_in_app_notification_entries GROUP BY state ORDER BY state`).all().map((row) => ({ ...row })), [
    { state: 'read', count: 2 }, { state: 'unread', count: 1 },
  ]);
  assert.equal(count(db, 'forecast_in_app_notification_state_events'), 1);
  db.close();
});

test('descending timestamp and ID cursor pagination has no duplicates or gaps under ties', async () => {
  const db = database();
  const { service } = services(db);
  await baseline(service);
  for (let index = 0; index < 5; index += 1) await insertSource(db, 'needs_review', { occurredAt: '2026-08-26T10:30:00.000Z' });
  await service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit', limit: 10 }, 1);
  const first = await service.list(1, { state: 'all', category: 'all', limit: 2 });
  const second = await service.list(1, { state: 'all', category: 'all', limit: 2, cursor: first.nextCursor ?? undefined });
  const third = await service.list(1, { state: 'all', category: 'all', limit: 2, cursor: second.nextCursor ?? undefined });
  const ids = [...first.items, ...second.items, ...third.items].map((entry) => entry.id);
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5);
  await assert.rejects(() => service.list(1, { state: 'unread', category: 'all', limit: 2, cursor: first.nextCursor ?? undefined }), InAppNotificationError);
  db.close();
});

test('historical commit does not move the forward checkpoint or reset read state on replay', async () => {
  const db = database();
  const { service } = services(db);
  const historical = await insertSource(db);
  await baseline(service);
  const checkpointBefore = db.prepare(`SELECT last_evaluation_run_id AS lastId FROM forecast_in_app_notification_projection_checkpoints`).get()?.lastId;
  const preview = await service.backfill({
    profileId: 1, cutoff: CUTOFF, fromEvaluationRunId: historical.evaluationRunId,
    throughEvaluationRunId: historical.evaluationRunId, limit: 1,
  }, 1);
  assert.equal(preview.mode, 'dry_run');
  assert.equal(preview.selectedCount, 1);
  assert.equal(count(db, 'forecast_in_app_notification_entries'), 0);
  assert.equal(count(db, 'forecast_in_app_notification_projection_items'), 0);
  await service.backfill({ profileId: 1, cutoff: CUTOFF, mode: 'commit', fromEvaluationRunId: historical.evaluationRunId, throughEvaluationRunId: historical.evaluationRunId }, 1);
  const entry = (await service.list(1, { state: 'all', category: 'all', limit: 20 })).items[0];
  await service.setState(1, entry.id, 'read');
  await service.backfill({ profileId: 1, cutoff: CUTOFF, mode: 'commit', fromEvaluationRunId: historical.evaluationRunId, throughEvaluationRunId: historical.evaluationRunId }, 1);
  assert.equal((await service.get(1, entry.id)).state, 'read');
  assert.equal(db.prepare(`SELECT last_evaluation_run_id AS lastId FROM forecast_in_app_notification_projection_checkpoints`).get()?.lastId, checkpointBefore);
  assert.equal(count(db, 'forecast_in_app_notification_entries'), 1);
  db.close();
});

test('presentation is immutable even when the current forecast changes', async () => {
  const db = database();
  const { service } = services(db);
  await baseline(service); await insertSource(db); await service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit' }, 1);
  const before = db.prepare(`SELECT presentation_json AS presentation FROM forecast_in_app_notification_entries`).get()?.presentation;
  db.prepare(`UPDATE forecasts SET thesis = 'Changed mutable thesis' WHERE id = 1`).run();
  assert.equal(db.prepare(`SELECT presentation_json AS presentation FROM forecast_in_app_notification_entries`).get()?.presentation, before);
  assert.throws(() => db.prepare(`UPDATE forecast_in_app_notification_entries SET symbol = 'MSFT'`).run(), /immutable/u);
  db.close();
});

test('reads reject unsupported or fingerprint-corrupted stored presentation snapshots', async () => {
  const db = database();
  const { service } = services(db);
  await baseline(service); await insertSource(db);
  await service.project({ profileId: 1, cutoff: CUTOFF, mode: 'commit' }, 1);
  const id = (db.prepare(`SELECT id FROM forecast_in_app_notification_entries`).get() as { id: string }).id;
  db.exec('DROP TRIGGER forecast_in_app_entries_immutable_presentation');
  db.prepare(`UPDATE forecast_in_app_notification_entries SET presentation_version = 'future-v9' WHERE id = ?`).run(id);
  await assert.rejects(() => service.get(1, id), /InAppStoredPresentationInvalid/u);
  db.prepare(`UPDATE forecast_in_app_notification_entries
    SET presentation_version = ?, presentation_fingerprint = ? WHERE id = ?`)
    .run('forecast-in-app-presentation-1.0.0', '0'.repeat(64), id);
  await assert.rejects(() => service.get(1, id), /InAppStoredPresentationFingerprintMismatch/u);
  db.close();
});

test('runtime DDL and additive 0008 migration agree for in-app tables and triggers', () => {
  const runtime = database();
  const migrated = new DatabaseSync(':memory:');
  migrated.exec('PRAGMA foreign_keys = OFF');
  for (const name of ['0000_spotty_sugar_man.sql', '0001_kind_warbound.sql', '0002_quiet_gamora.sql', '0003_great_xavin.sql', '0004_clean_next_avengers.sql', '0005_thin_ikaris.sql', '0006_late_wasp.sql', '0007_late_amphibian.sql', '0008_vengeful_the_watchers.sql']) {
    const sql = readFileSync(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) migrated.exec(statement);
  }
  const tables = ['forecast_in_app_notification_projection_checkpoints', 'forecast_in_app_notification_entries', 'forecast_in_app_notification_projection_items', 'forecast_in_app_notification_state_events'];
  for (const table of tables) {
    assert.deepEqual(runtime.prepare(`PRAGMA table_info(${table})`).all(), migrated.prepare(`PRAGMA table_info(${table})`).all(), `${table} columns`);
    const indexNames = (db: DatabaseSync) => db.prepare(`PRAGMA index_list(${table})`).all().map((row) => row.name).sort();
    assert.deepEqual(indexNames(runtime), indexNames(migrated), `${table} indexes`);
    assert.deepEqual(runtime.prepare(`PRAGMA foreign_key_list(${table})`).all(), migrated.prepare(`PRAGMA foreign_key_list(${table})`).all(), `${table} foreign keys`);
  }
  assert.deepEqual(runtime.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name='forecast_in_app_entries_immutable_presentation'`).all().map((row) => ({ ...row })), [{ name: 'forecast_in_app_entries_immutable_presentation' }]);
  assert.deepEqual(migrated.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name='forecast_in_app_entries_immutable_presentation'`).all().map((row) => ({ ...row })), [{ name: 'forecast_in_app_entries_immutable_presentation' }]);
  const triggers = (db: DatabaseSync) => db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'forecast_in_app_%' ORDER BY name`).all().map((row) => row.name);
  assert.deepEqual(triggers(runtime), triggers(migrated));
  runtime.close(); migrated.close();
});

test('0008 is additive and preserves populated Phase 2C2A/2C2B evidence', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of ['0000_spotty_sugar_man.sql', '0001_kind_warbound.sql', '0002_quiet_gamora.sql', '0003_great_xavin.sql', '0004_clean_next_avengers.sql', '0005_thin_ikaris.sql', '0006_late_wasp.sql', '0007_late_amphibian.sql']) {
    const sql = readFileSync(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) db.exec(statement);
  }
  db.exec(`INSERT INTO investment_profiles VALUES (1, 'Mine', 'USD', 0, '${NOW}');
    INSERT INTO forecasts
      (profile_id,symbol,direction,confidence,thesis,supporting_evidence,counter_evidence,setup_tag,
       evaluation_date,target_kind,target_price,status,activated_at,market_data_as_of,activation_price,
       activation_currency,market_provider,created_at,updated_at)
    VALUES (1,'AAPL','bullish',80,'thesis','support','counter','manual','2026-09-30','price',150,
      'active','${NOW}','${NOW}',100,'USD','test','${NOW}','${NOW}');
    INSERT INTO evaluation_runs
      (profile_id,forecast_id,result_kind,reason_code,explanation,evaluator_version,ruleset_version,
       evaluated_through,evaluation_cutoff,evidence_json,warnings_json,input_fingerprint,created_at)
    VALUES (1,1,'needs_review','currency_unverified','safe','evaluator-v1','ruleset-v1','2026-08-26',
      '${CUTOFF}','{}','[]','${'1'.repeat(64)}','${NOW}');
    INSERT INTO forecast_review_items
      (profile_id,forecast_id,evaluation_run_id,review_kind,acknowledged_at,created_at)
    VALUES (1,1,1,'needs_review',NULL,'${NOW}');
    INSERT INTO forecast_notification_preference_revisions
      (profile_id,revision,preference_version,master_consent,target_hit_enabled,invalidated_enabled,
       expired_enabled,needs_review_enabled,timezone,quiet_hours_start,quiet_hours_end,change_source,
       change_reason,created_at)
    VALUES (1,1,'preferences-v1',1,1,1,1,1,'UTC',NULL,NULL,'operator','migration','${NOW}');
    INSERT INTO forecast_notification_preferences VALUES (1,1,'${NOW}','${NOW}');
    INSERT INTO forecast_notification_intents
      (id,profile_id,forecast_id,evaluation_run_id,review_item_id,analysis_snapshot_id,category,
       dedup_contract_version,projector_version,payload_schema_version,dedup_key,payload_json,
       payload_fingerprint,event_occurred_at,created_at)
    VALUES ('intent-preserved',1,1,1,1,NULL,'needs_review','dedup-v1','projector-v1','payload-v1',
      '${'2'.repeat(64)}','{}','${'3'.repeat(64)}','${NOW}','${NOW}');
    INSERT INTO forecast_notification_policy_decisions
      (id,intent_id,profile_id,policy_version,preference_revision,decision,reason_code,decided_at,
       earliest_eligible_at,warnings_json,created_at)
    VALUES ('policy-preserved','intent-preserved',1,'policy-v1',1,'eligible','eligible','${NOW}',NULL,'[]','${NOW}');
    INSERT INTO forecast_notification_outbox
      (id,intent_id,policy_decision_id,profile_id,retry_policy_version,quiet_hours_policy_version,state,
       available_at,attempt_count,lease_token,lease_expires_at,last_attempt_at,succeeded_at,
       dead_lettered_at,suppressed_at,suppression_reason,last_failure_category,created_at,updated_at)
    VALUES ('outbox-preserved','intent-preserved','policy-preserved',1,'retry-v1','quiet-v1','succeeded',
      NULL,1,NULL,NULL,'${NOW}','${NOW}',NULL,NULL,NULL,NULL,'${NOW}','${NOW}');
    INSERT INTO forecast_notification_delivery_attempts
      (id,outbox_id,profile_id,attempt_number,owner_token,state,retry_policy_version,adapter_kind,
       adapter_version,started_at,finished_at,failure_classification,redacted_error_category,
       next_attempt_at,created_at)
    VALUES ('attempt-preserved','outbox-preserved',1,1,'owner-preserved','succeeded','retry-v1',
      'resend','resend-v1','${NOW}','${NOW}',NULL,NULL,NULL,'${NOW}');
    INSERT INTO forecast_email_recipients VALUES ('recipient',1,1,'person@example.test','p***@example.test','verified','${NOW}','${NOW}',NULL,'none',NULL,NULL,'${NOW}','${NOW}');
    INSERT INTO forecast_email_consent_revisions VALUES (1,1,'recipient',1,1,1,1,1,'operator','${NOW}',NULL,'${NOW}');
    INSERT INTO forecast_email_consents VALUES (1,1,'recipient','${NOW}','${NOW}');
    INSERT INTO forecast_email_provider_events VALUES ('provider-event','resend','evt-1','email-1',NULL,NULL,'email.delivered',1,'${'a'.repeat(64)}','${NOW}','${NOW}','unknown_delivery','${NOW}')`);
  const before = {
    intent: count(db, 'forecast_notification_intents'),
    outbox: count(db, 'forecast_notification_outbox'),
    attempt: count(db, 'forecast_notification_delivery_attempts'),
    recipient: count(db, 'forecast_email_recipients'),
    consent: count(db, 'forecast_email_consent_revisions'),
    providerEvent: count(db, 'forecast_email_provider_events'),
  };
  const migration = readFileSync(new URL('../../drizzle/0008_vengeful_the_watchers.sql', import.meta.url), 'utf8');
  db.exec('BEGIN');
  try { for (const statement of migration.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) db.exec(statement); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
  assert.deepEqual({
    intent: count(db, 'forecast_notification_intents'),
    outbox: count(db, 'forecast_notification_outbox'),
    attempt: count(db, 'forecast_notification_delivery_attempts'),
    recipient: count(db, 'forecast_email_recipients'),
    consent: count(db, 'forecast_email_consent_revisions'),
    providerEvent: count(db, 'forecast_email_provider_events'),
  }, before);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(count(db, 'forecast_in_app_notification_entries'), 0);
  db.close();
});

test.after(() => { void IN_APP_PROJECTOR_VERSION; });
