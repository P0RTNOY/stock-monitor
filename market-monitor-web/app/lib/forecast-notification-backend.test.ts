import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { forecastInitializationStatements } from '../../db/forecast-initialization.ts';
import {
  NOTIFICATION_DEDUP_VERSION,
  NOTIFICATION_PAYLOAD_SCHEMA_VERSION,
  NOTIFICATION_PROJECTOR_VERSION,
} from './server/notifications/contract.ts';
import {
  NOTIFICATION_PREFERENCE_SCHEMA_VERSION,
  type NotificationPreferenceSnapshot,
} from './server/notifications/preference.ts';
import { NotificationDeliveryService } from './server/notifications/delivery.ts';
import { NotificationPreferenceService } from './server/notifications/preference-service.ts';
import { D1NotificationRepository } from './server/notifications/repository.ts';
import {
  NotificationProjectorService,
  type NotificationProjectorRuntime,
} from './server/notifications/service.ts';

const NOW = '2026-08-25T06:30:00.000Z';
const CUTOFF = '2026-08-25T07:00:00.000Z';
const NOTIFICATION_TABLES = [
  'forecast_notification_projection_checkpoints',
  'forecast_notification_preference_revisions',
  'forecast_notification_preferences',
  'forecast_notification_intents',
  'forecast_notification_policy_decisions',
  'forecast_notification_outbox',
  'forecast_notification_projection_items',
  'forecast_notification_delivery_attempts',
] as const;

class SQLitePrepared {
  private bindings: Array<string | number | null> = [];
  private readonly database: DatabaseSync;
  private readonly sql: string;

  constructor(database: DatabaseSync, sql: string) {
    this.database = database;
    this.sql = sql;
  }

  bind(...values: Array<string | number | null>) {
    const prepared = new SQLitePrepared(this.database, this.sql);
    prepared.bindings = values;
    return prepared;
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

class Runtime implements NotificationProjectorRuntime {
  instant = NOW;
  private sequence = 0;

  now() { return this.instant; }
  leaseToken() { this.sequence += 1; return `notification-lease-${this.sequence}`; }
  leaseExpiresAt(acquiredAt: string) {
    return new Date(Date.parse(acquiredAt) + 5 * 60_000).toISOString();
  }
  token(kind: 'attempt' | 'owner') {
    this.sequence += 1;
    return `${kind}-${this.sequence}`;
  }
}

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`CREATE TABLE investment_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, base_currency TEXT NOT NULL,
    cash_balance REAL NOT NULL, created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, symbol TEXT NOT NULL,
    company_name TEXT NOT NULL, shares REAL NOT NULL, average_cost REAL NOT NULL, created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE watchlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, symbol TEXT NOT NULL,
    company_name TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  for (const statement of forecastInitializationStatements()) db.exec(statement);
  db.exec(`INSERT INTO investment_profiles VALUES
    (1, 'Mine', 'USD', 0, '2026-01-01T00:00:00.000Z'),
    (2, 'Other', 'USD', 0, '2026-01-01T00:00:00.000Z')`);
  return db;
}

function d1(db: DatabaseSync) {
  return new SQLiteD1(db) as unknown as D1Database;
}

function count(db: DatabaseSync, table: string) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
}

type SourceKind = 'target_hit' | 'invalidated' | 'expired' | 'needs_review' | 'no_change';

function evidence(kind: SourceKind) {
  const triggering = kind === 'expired' || kind === 'no_change'
    ? null : { market_date: '2026-08-24' };
  return {
    activation_currency: 'USD',
    observed_currency: 'USD',
    triggering_observation: triggering,
    target_boundary: 190,
    target_range: null,
    invalidation_boundary: 150,
    detected_at: triggering ? 'within_bar' : null,
    crossed_boundary: kind === 'target_hit' ? 190 : kind === 'invalidated' ? 150 : null,
  };
}

function insertSource(db: DatabaseSync, options: {
  profileId?: number;
  kind?: SourceKind;
  createdAt?: string;
  symbol?: string;
  evidenceJson?: string;
  withReview?: boolean;
} = {}) {
  const profileId = options.profileId ?? 1;
  const kind = options.kind ?? 'target_hit';
  const createdAt = options.createdAt ?? NOW;
  const symbol = options.symbol ?? `SYM${String(count(db, 'forecasts') + 1)}`;
  const status = ['target_hit', 'invalidated', 'expired'].includes(kind) ? kind : 'active';
  const forecast = db.prepare(`INSERT INTO forecasts
    (profile_id, symbol, direction, confidence, thesis, supporting_evidence, counter_evidence,
     setup_tag, evaluation_date, target_kind, target_price, invalidation_price, status,
     activated_at, market_data_as_of, activation_price, activation_currency, market_provider,
     resolved_at, resolution_reason, created_at, updated_at)
    VALUES (?, ?, 'bullish', 75, 'Thesis', 'Evidence', 'Counter', 'Rectangle',
      '2026-09-24', 'price', 190, 150, ?, '2026-08-24T09:50:00.000Z',
      '2026-08-24T09:55:00.000Z', 175, 'USD', 'yahoo-finance', ?, ?, ?, ?)`)
    .run(
      profileId, symbol, status,
      status === 'active' ? null : createdAt,
      status === 'active' ? null : `${kind}_reason`,
      createdAt, createdAt,
    );
  const forecastId = Number(forecast.lastInsertRowid);
  const run = db.prepare(`INSERT INTO evaluation_runs
    (profile_id, forecast_id, result_kind, reason_code, explanation,
     evaluator_version, ruleset_version, evaluated_through, evaluation_cutoff,
     evidence_json, warnings_json, input_fingerprint, created_at)
    VALUES (?, ?, ?, ?, 'Trusted evaluation.', 'forecast-evaluator-1.0.0',
      'forecast-evaluation-ruleset-v1', ?, ?, ?, '[]', ?, ?)`)
    .run(
      profileId, forecastId, kind, `${kind}_reason`,
      kind === 'no_change' ? null : '2026-08-24', CUTOFF,
      options.evidenceJson ?? JSON.stringify(evidence(kind)),
      forecastId.toString(16).padStart(64, '0'), createdAt,
    );
  const evaluationRunId = Number(run.lastInsertRowid);
  const withReview = options.withReview ?? kind !== 'no_change';
  let reviewItemId: number | null = null;
  if (withReview) {
    const review = db.prepare(`INSERT INTO forecast_review_items
      (profile_id, forecast_id, evaluation_run_id, review_kind, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .run(profileId, forecastId, evaluationRunId,
        kind === 'needs_review' ? 'needs_review' : 'resolved', createdAt);
    reviewItemId = Number(review.lastInsertRowid);
  }
  return { forecastId, evaluationRunId, reviewItemId };
}

function preference(overrides: Partial<NotificationPreferenceSnapshot> = {}): NotificationPreferenceSnapshot {
  return {
    profileId: 1,
    schemaVersion: NOTIFICATION_PREFERENCE_SCHEMA_VERSION,
    revision: 1,
    masterConsent: true,
    categories: { target_hit: true, invalidated: true, expired: true, needs_review: true },
    timeZone: 'UTC',
    quietHours: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function services(db: DatabaseSync, runtime = new Runtime()) {
  const repository = new D1NotificationRepository(d1(db));
  return { repository, runtime, projector: new NotificationProjectorService(repository, runtime) };
}

function projection(mode: 'dry_run' | 'commit', overrides: Record<string, unknown> = {}) {
  return { profileId: 1, cutoff: CUTOFF, limit: 25, mode, ...overrides };
}

async function establishBaseline(projector: NotificationProjectorService, profileId = 1) {
  return projector.project(projection('commit', { profileId }), profileId);
}

function claimInput(index: number, now: string, expiresAt: string, profileId = 1) {
  return {
    profileId,
    attemptId: `attempt-${index}`,
    ownerToken: `owner-${index}`,
    now,
    expiresAt,
    adapterKind: 'injected_test_adapter',
    adapterVersion: 'test-1.0.0',
  };
}

test('first dry-run is mutation-free and first commit establishes only a historical baseline', async () => {
  const db = database();
  const historical = insertSource(db);
  const { projector, repository } = services(db);
  const beforeChanges = Number(db.prepare('SELECT total_changes() AS count').get()?.count);
  const preview = await projector.project(projection('dry_run'), 1);
  assert.equal(preview.disposition, 'baseline_would_be_established');
  assert.equal(preview.baselineEvaluationRunId, historical.evaluationRunId);
  assert.equal(await repository.getBaseline(1, NOTIFICATION_PROJECTOR_VERSION), null);
  assert.equal(Number(db.prepare('SELECT total_changes() AS count').get()?.count), beforeChanges);

  const committed = await establishBaseline(projector);
  assert.equal(committed.disposition, 'baseline_established');
  assert.equal(committed.materializedCount, 0);
  assert.equal(count(db, 'forecast_notification_projection_checkpoints'), 1);
  assert.equal(count(db, 'forecast_notification_intents'), 0);
  assert.equal(count(db, 'forecast_notification_outbox'), 0);
  const beforeBackfill = Number(db.prepare('SELECT total_changes() AS count').get()?.count);
  const backfill = await projector.previewHistoricalBackfill({
    profileId: 1,
    fromEvaluationRunId: historical.evaluationRunId,
    throughEvaluationRunId: historical.evaluationRunId,
    cutoff: CUTOFF,
    limit: 25,
    includeNeedsReview: false,
  }, 1);
  assert.equal(backfill.mode, 'dry_run');
  assert.deepEqual(backfill.items.map((item) => item.evaluationRunId), [historical.evaluationRunId]);
  assert.equal(backfill.items[0].policyDecision, 'suppressed_historical_cutover');
  assert.equal(Number(db.prepare('SELECT total_changes() AS count').get()?.count), beforeBackfill);
  assert.equal(count(db, 'forecast_notification_intents'), 0);
  db.close();
});

test('projector processes stable bounded pages, isolates malformed sources, and stops at cutoff', async () => {
  const db = database();
  const { projector } = services(db);
  await establishBaseline(projector);
  const target = insertSource(db, { kind: 'target_hit', createdAt: '2026-08-25T06:31:00.000Z' });
  const review = insertSource(db, { kind: 'needs_review', createdAt: '2026-08-25T06:32:00.000Z' });
  const noChange = insertSource(db, { kind: 'no_change', createdAt: '2026-08-25T06:33:00.000Z' });
  const malformed = insertSource(db, {
    kind: 'target_hit', createdAt: '2026-08-25T06:34:00.000Z', evidenceJson: '{broken',
  });
  const future = insertSource(db, { kind: 'expired', createdAt: '2026-08-25T07:00:00.001Z' });

  const first = await projector.project(projection('commit', { limit: 2 }), 1);
  assert.deepEqual(first.items.map((item) => item.evaluationRunId), [target.evaluationRunId, review.evaluationRunId]);
  assert.deepEqual(first.items.map((item) => item.category), ['target_hit', 'needs_review']);
  assert.equal(first.materializedCount, 2);
  assert.equal(first.hasMore, true);

  const second = await projector.project(projection('commit', { limit: 2 }), 1);
  assert.deepEqual(second.items.map((item) => item.evaluationRunId), [noChange.evaluationRunId, malformed.evaluationRunId]);
  assert.deepEqual(second.items.map((item) => item.classification), [
    'excluded_no_change', 'invalid_source_needs_review',
  ]);
  assert.equal(second.excludedCount, 1);
  assert.equal(second.invalidSourceCount, 1);
  assert.equal(count(db, 'forecast_notification_intents'), 2);

  const stopped = await projector.project(projection('commit'), 1);
  assert.equal(stopped.processedCount, 0);
  assert.equal(stopped.stoppedByCutoff, true);
  assert.equal(stopped.endingEvaluationRunId, malformed.evaluationRunId);
  assert.equal(count(db, 'forecast_notification_projection_items'), 4);
  assert.equal(future.evaluationRunId > stopped.endingEvaluationRunId, true);
  db.close();
});

test('replay is idempotent, database uniqueness is authoritative, and profiles are isolated', async () => {
  const db = database();
  const { projector } = services(db);
  await establishBaseline(projector, 1);
  await establishBaseline(projector, 2);
  const own = insertSource(db, { profileId: 1, createdAt: '2026-08-25T06:31:00.000Z' });
  const foreign = insertSource(db, { profileId: 2, createdAt: '2026-08-25T06:32:00.000Z' });

  const first = await projector.project(projection('commit'), 1);
  const replay = await projector.project(projection('commit'), 1);
  assert.equal(first.items[0].evaluationRunId, own.evaluationRunId);
  assert.equal(first.items[0].intentCreated, true);
  assert.equal(replay.processedCount, 0);
  assert.equal(count(db, 'forecast_notification_intents'), 1);
  assert.equal(db.prepare('SELECT profile_id FROM forecast_notification_intents').get()?.profile_id, 1);

  const profileTwo = await projector.project(projection('commit', { profileId: 2 }), 2);
  assert.equal(profileTwo.items[0].evaluationRunId, foreign.evaluationRunId);
  assert.equal(count(db, 'forecast_notification_intents'), 2);
  const existing = db.prepare('SELECT * FROM forecast_notification_intents WHERE profile_id = 1').get() as {
    profile_id: number; forecast_id: number; evaluation_run_id: number; review_item_id: number;
    analysis_snapshot_id: number | null; category: string; dedup_contract_version: string;
    projector_version: string; payload_schema_version: string; dedup_key: string;
    payload_json: string; payload_fingerprint: string; event_occurred_at: string; created_at: string;
  };
  assert.throws(() => db.prepare(`INSERT INTO forecast_notification_intents
    (id, profile_id, forecast_id, evaluation_run_id, review_item_id, analysis_snapshot_id,
     category, dedup_contract_version, projector_version, payload_schema_version,
     dedup_key, payload_json, payload_fingerprint, event_occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      'different-id', existing.profile_id, existing.forecast_id, existing.evaluation_run_id,
      existing.review_item_id, existing.analysis_snapshot_id, existing.category,
      existing.dedup_contract_version, existing.projector_version, existing.payload_schema_version,
      existing.dedup_key, existing.payload_json, existing.payload_fingerprint,
      existing.event_occurred_at, existing.created_at,
    ), /UNIQUE constraint failed/);
  db.close();
});

test('a live projection lease rejects overlap and materializes the source once', async () => {
  const db = database();
  const runtime = new Runtime();
  const binding = d1(db);
  const base = new D1NotificationRepository(binding);
  await new NotificationProjectorService(base, runtime).project(projection('commit'), 1);
  insertSource(db, { createdAt: '2026-08-25T06:31:00.000Z' });

  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  class GatedRepository extends D1NotificationRepository {
    private first = true;
    override async selectSources(profileId: number, after: number, cutoff: string, limit: number) {
      if (this.first) {
        this.first = false;
        entered();
        await gate;
      }
      return super.selectSources(profileId, after, cutoff, limit);
    }
  }
  const repository = new GatedRepository(binding);
  const projector = new NotificationProjectorService(repository, runtime);
  const active = projector.project(projection('commit'), 1);
  await reached;
  const overlap = await projector.project(projection('commit'), 1);
  assert.equal(overlap.disposition, 'overlap_rejected');
  release();
  assert.equal((await active).materializedCount, 1);
  assert.equal(count(db, 'forecast_notification_intents'), 1);
  assert.equal(count(db, 'forecast_notification_outbox'), 1);
  db.close();
});

test('replay recovers crashes before intent persistence and after an orphan intent write', async () => {
  {
    const db = database();
    const runtime = new Runtime();
    const binding = d1(db);
    const repository = new D1NotificationRepository(binding);
    await new NotificationProjectorService(repository, runtime).project(projection('commit'), 1);
    insertSource(db, { createdAt: '2026-08-25T06:31:00.000Z' });
    class CrashBeforeIntentRepository extends D1NotificationRepository {
      override async materialize(
        input: Parameters<D1NotificationRepository['materialize']>[0],
      ): ReturnType<D1NotificationRepository['materialize']> {
        void input;
        throw new Error('simulated_crash_before_intent');
      }
    }
    await assert.rejects(
      new NotificationProjectorService(
        new CrashBeforeIntentRepository(binding), runtime,
      ).project(projection('commit'), 1),
      /simulated_crash_before_intent/u,
    );
    assert.equal(count(db, 'forecast_notification_intents'), 0);
    assert.equal((await repository.getBaseline(1, NOTIFICATION_PROJECTOR_VERSION))?.lastEvaluationRunId, 0);
    assert.equal((await new NotificationProjectorService(repository, runtime)
      .project(projection('commit'), 1)).materializedCount, 1);
    assert.equal(count(db, 'forecast_notification_intents'), 1);
    assert.equal(count(db, 'forecast_notification_outbox'), 1);
    db.close();
  }

  {
    const db = database();
    const runtime = new Runtime();
    const binding = d1(db);
    const repository = new D1NotificationRepository(binding);
    await new NotificationProjectorService(repository, runtime).project(projection('commit'), 1);
    const source = insertSource(db, { createdAt: '2026-08-25T06:31:00.000Z' });
    class CrashAfterIntentRepository extends D1NotificationRepository {
      private crashed = false;

      override async materialize(
        input: Parameters<D1NotificationRepository['materialize']>[0],
      ): ReturnType<D1NotificationRepository['materialize']> {
        if (this.crashed) return super.materialize(input);
        this.crashed = true;
        await binding.prepare(`INSERT INTO forecast_notification_intents
          (id, profile_id, forecast_id, evaluation_run_id, review_item_id,
           analysis_snapshot_id, category, dedup_contract_version, projector_version,
           payload_schema_version, dedup_key, payload_json, payload_fingerprint,
           event_occurred_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            input.intentId, input.profileId, input.payload.forecastId,
            input.payload.evaluationRunId, input.payload.reviewItemId,
            input.payload.analysisSnapshotId, input.payload.category,
            NOTIFICATION_DEDUP_VERSION, input.projectorVersion,
            NOTIFICATION_PAYLOAD_SCHEMA_VERSION, input.dedupKey, input.payloadJson,
            input.payloadFingerprint, input.payload.occurredAt, input.processedAt,
          ).run();
        throw new Error('simulated_crash_after_intent');
      }
    }
    await assert.rejects(
      new NotificationProjectorService(
        new CrashAfterIntentRepository(binding), runtime,
      ).project(projection('commit'), 1),
      /simulated_crash_after_intent/u,
    );
    assert.equal(count(db, 'forecast_notification_intents'), 1);
    assert.equal(count(db, 'forecast_notification_outbox'), 0);
    assert.equal((await repository.getBaseline(1, NOTIFICATION_PROJECTOR_VERSION))?.lastEvaluationRunId, 0);
    const recovered = await new NotificationProjectorService(repository, runtime)
      .project(projection('commit'), 1);
    assert.equal(recovered.items[0].evaluationRunId, source.evaluationRunId);
    assert.equal(recovered.items[0].intentCreated, false);
    assert.equal(count(db, 'forecast_notification_intents'), 1);
    assert.equal(count(db, 'forecast_notification_policy_decisions'), 1);
    assert.equal(count(db, 'forecast_notification_outbox'), 1);
    assert.equal(count(db, 'forecast_notification_projection_items'), 1);
    assert.equal((await repository.getBaseline(1, NOTIFICATION_PROJECTOR_VERSION))?.lastEvaluationRunId,
      source.evaluationRunId);
    db.close();
  }
});

test('preference revisions are append-preserving and do not release an existing suppression', async () => {
  const db = database();
  const { projector, repository } = services(db);
  const preferenceService = new NotificationPreferenceService(repository);
  await establishBaseline(projector);
  const initial = preference({ masterConsent: false });
  assert.deepEqual(await preferenceService.update({
    trustedProfileId: 1, expectedRevision: 0, snapshot: initial,
    changeSource: 'operator', changeReason: 'safe default',
  }), initial);
  insertSource(db, { createdAt: '2026-08-25T06:31:00.000Z' });
  await projector.project(projection('commit'), 1);
  assert.equal(db.prepare('SELECT state FROM forecast_notification_outbox').get()?.state, 'suppressed');

  const enabled = preference({
    revision: 2, masterConsent: true, updatedAt: '2026-08-25T06:32:00.000Z',
  });
  await assert.rejects(preferenceService.update({
    trustedProfileId: 1, expectedRevision: 0, snapshot: enabled,
    changeSource: 'operator', changeReason: 'stale update',
  }), /revision|conflict/iu);
  assert.deepEqual(await preferenceService.update({
    trustedProfileId: 1, expectedRevision: 1, snapshot: enabled,
    changeSource: 'operator', changeReason: 'explicit consent',
  }), enabled);
  const history = await preferenceService.history(1, 10);
  assert.deepEqual(history.map((row) => row.revision), [2, 1]);
  assert.deepEqual(history.map((row) => row.changeReason), ['explicit consent', 'safe default']);
  assert.equal(db.prepare('SELECT state FROM forecast_notification_outbox').get()?.state, 'suppressed');

  insertSource(db, { createdAt: '2026-08-25T06:33:00.000Z' });
  await projector.project(projection('commit'), 1);
  assert.deepEqual(db.prepare(`SELECT state FROM forecast_notification_outbox ORDER BY created_at, id`).all()
    .map((row) => row.state).sort(), ['pending', 'suppressed']);
  assert.deepEqual(db.prepare(`SELECT preference_revision FROM forecast_notification_policy_decisions
    ORDER BY preference_revision`).all().map((row) => row.preference_revision), [1, 2]);
  db.close();
});

test('suppressed and not-yet-available deferred outbox rows cannot be claimed', async () => {
  const db = database();
  const { projector, repository, runtime } = services(db);
  await establishBaseline(projector);
  insertSource(db, { createdAt: '2026-08-25T06:31:00.000Z' });
  await projector.project(projection('commit'), 1);
  assert.equal((await repository.claimNext(claimInput(
    1, '2026-08-25T06:32:00.000Z', '2026-08-25T06:37:00.000Z',
  ))), null);

  assert.equal(await repository.appendPreference(preference({
    timeZone: 'UTC', quietHours: { start: '06:00', end: '08:00' },
  }), 0, 'operator', 'quiet hours'), true);
  runtime.instant = '2026-08-25T06:40:00.000Z';
  insertSource(db, { kind: 'needs_review', createdAt: '2026-08-25T06:39:00.000Z' });
  await projector.project(projection('commit'), 1);
  assert.equal(db.prepare("SELECT state FROM forecast_notification_outbox WHERE state = 'deferred'").get()?.state,
    'deferred');
  assert.equal(await repository.claimNext(claimInput(
    2, '2026-08-25T07:59:59.999Z', '2026-08-25T08:04:59.999Z',
  )), null);
  const due = await repository.claimNext(claimInput(
    3, '2026-08-25T08:00:00.000Z', '2026-08-25T08:05:00.000Z',
  ));
  assert.ok(due);
  assert.equal(due.attemptNumber, 1);
  db.close();
});

test('claims conflict, expire safely, fence stale owners, and append retry/terminal attempts', async () => {
  const db = database();
  const { projector, repository } = services(db);
  await establishBaseline(projector);
  assert.equal(await repository.appendPreference(preference(), 0, 'operator', 'test consent'), true);
  insertSource(db, { createdAt: '2026-08-25T06:31:00.000Z' });
  await projector.project(projection('commit'), 1);

  const first = await repository.claimNext(claimInput(
    1, '2026-08-25T06:32:00.000Z', '2026-08-25T06:37:00.000Z',
  ));
  assert.ok(first);
  assert.equal(await repository.claimNext(claimInput(
    2, '2026-08-25T06:33:00.000Z', '2026-08-25T06:38:00.000Z',
  )), null);
  assert.equal(db.prepare('SELECT state FROM forecast_notification_outbox').get()?.state, 'claimed');
  assert.equal(db.prepare('SELECT succeeded_at FROM forecast_notification_outbox').get()?.succeeded_at, null);

  const takeover = await repository.claimNext(claimInput(
    2, '2026-08-25T06:37:00.000Z', '2026-08-25T06:42:00.000Z',
  ));
  assert.ok(takeover);
  assert.equal(takeover.attemptNumber, 2);
  assert.equal(await repository.completeSuccess({
    profileId: 1, outboxId: first.outboxId, attemptId: first.attemptId,
    ownerToken: 'owner-1', completedAt: '2026-08-25T06:38:00.000Z',
  }), false);
  assert.equal(await repository.completeFailure({
    profileId: 1, outboxId: first.outboxId, attemptId: first.attemptId,
    ownerToken: 'owner-1', completedAt: '2026-08-25T06:38:00.000Z', failure: 'provider_timeout',
  }), null);

  const retry = await repository.completeFailure({
    profileId: 1, outboxId: takeover.outboxId, attemptId: takeover.attemptId,
    ownerToken: 'owner-2', completedAt: '2026-08-25T06:38:00.000Z', failure: 'provider_timeout',
  });
  assert.equal(retry?.disposition, 'retry_scheduled');
  assert.equal(await repository.claimNext(claimInput(
    3, '2026-08-25T06:41:59.999Z', '2026-08-25T06:46:59.999Z',
  )), null);
  const third = await repository.claimNext(claimInput(
    3, '2026-08-25T06:42:00.000Z', '2026-08-25T06:47:00.000Z',
  ));
  assert.ok(third);
  assert.equal(third.attemptNumber, 3);
  const terminal = await repository.completeFailure({
    profileId: 1, outboxId: third.outboxId, attemptId: third.attemptId,
    ownerToken: 'owner-3', completedAt: '2026-08-25T06:43:00.000Z', failure: 'provider_rejected',
  });
  assert.equal(terminal?.disposition, 'dead_letter');
  assert.equal(db.prepare('SELECT state FROM forecast_notification_outbox').get()?.state, 'dead_letter');
  assert.deepEqual((await repository.listAttempts(1, third.outboxId)).map((attempt) => ({
    number: attempt.attemptNumber, state: attempt.state,
  })), [
    { number: 1, state: 'interrupted' },
    { number: 2, state: 'retry_scheduled' },
    { number: 3, state: 'terminal_failure' },
  ]);
  assert.equal(await repository.claimNext(claimInput(
    4, '2026-08-25T07:00:00.000Z', '2026-08-25T07:05:00.000Z',
  )), null);
  db.close();
});

test('six retryable attempts follow deterministic backoff and dead-letter at the cap', async () => {
  const db = database();
  const { projector, repository } = services(db);
  await establishBaseline(projector);
  assert.equal(await repository.appendPreference(preference(), 0, 'operator', 'test consent'), true);
  insertSource(db, { createdAt: '2026-08-25T06:31:00.000Z' });
  await projector.project(projection('commit'), 1);

  let eligibleAt = '2026-08-25T06:32:00.000Z';
  let outboxId = '';
  for (let attemptNumber = 1; attemptNumber <= 6; attemptNumber += 1) {
    const claim = await repository.claimNext(claimInput(
      attemptNumber,
      eligibleAt,
      new Date(Date.parse(eligibleAt) + 5 * 60_000).toISOString(),
    ));
    assert.ok(claim);
    outboxId = claim.outboxId;
    assert.equal(claim.attemptNumber, attemptNumber);
    const decision = await repository.completeFailure({
      profileId: 1,
      outboxId,
      attemptId: claim.attemptId,
      ownerToken: `owner-${attemptNumber}`,
      completedAt: eligibleAt,
      failure: 'provider_timeout',
    });
    assert.ok(decision);
    if (attemptNumber < 6) {
      assert.equal(decision.disposition, 'retry_scheduled');
      assert.ok(decision.nextAttemptAt);
      eligibleAt = decision.nextAttemptAt;
    } else {
      assert.equal(decision.disposition, 'dead_letter');
      assert.equal(decision.reason, 'attempts_exhausted');
    }
  }
  assert.equal(db.prepare('SELECT state FROM forecast_notification_outbox').get()?.state, 'dead_letter');
  const attempts = await repository.listAttempts(1, outboxId);
  assert.equal(attempts.length, 6);
  assert.equal(attempts.at(-1)?.state, 'terminal_failure');
  assert.equal(attempts.at(-1)?.failureClassification, 'retryable');
  assert.equal(await repository.claimNext(claimInput(
    7,
    '2026-08-26T12:00:00.000Z',
    '2026-08-26T12:05:00.000Z',
  )), null);
  db.close();
});

test('success is recorded only after explicit completion and at most once', async () => {
  const db = database();
  const { projector, repository } = services(db);
  await establishBaseline(projector);
  assert.equal(await repository.appendPreference(preference(), 0, 'operator', 'test consent'), true);
  insertSource(db, { createdAt: '2026-08-25T06:31:00.000Z' });
  await projector.project(projection('commit'), 1);
  const claim = await repository.claimNext(claimInput(
    1, '2026-08-25T06:32:00.000Z', '2026-08-25T06:37:00.000Z',
  ));
  assert.ok(claim);
  assert.equal(db.prepare('SELECT state FROM forecast_notification_outbox').get()?.state, 'claimed');
  assert.equal(await repository.completeSuccess({
    profileId: 1, outboxId: claim.outboxId, attemptId: claim.attemptId,
    ownerToken: 'owner-1', completedAt: '2026-08-25T06:33:00.000Z',
  }), true);
  assert.equal(await repository.completeSuccess({
    profileId: 1, outboxId: claim.outboxId, attemptId: claim.attemptId,
    ownerToken: 'owner-1', completedAt: '2026-08-25T06:34:00.000Z',
  }), false);
  assert.equal(db.prepare('SELECT state FROM forecast_notification_outbox').get()?.state, 'succeeded');
  assert.equal(count(db, 'forecast_notification_delivery_attempts'), 1);
  db.close();
});

test('delivery service never claims without an adapter and uses only explicitly injected fakes', async () => {
  const db = database();
  const runtime = new Runtime();
  const { projector, repository } = services(db, runtime);
  const preferenceService = new NotificationPreferenceService(repository);
  await establishBaseline(projector);
  await preferenceService.update({
    trustedProfileId: 1, expectedRevision: 0, snapshot: preference(),
    changeSource: 'operator', changeReason: 'test consent',
  });
  insertSource(db, { createdAt: '2026-08-25T06:31:00.000Z' });
  await projector.project(projection('commit'), 1);

  const delivery = new NotificationDeliveryService(repository, runtime);
  assert.deepEqual(await delivery.dispatchOne(1, null), { disposition: 'adapter_not_configured' });
  assert.equal(db.prepare('SELECT state FROM forecast_notification_outbox').get()?.state, 'pending');
  assert.equal(count(db, 'forecast_notification_delivery_attempts'), 0);

  let deliveredCategory: string | null = null;
  const success = await delivery.dispatchOne(1, {
    kind: 'deterministic_fake',
    version: 'test-1.0.0',
    async deliver(payload) {
      deliveredCategory = payload.category;
      return { disposition: 'succeeded' };
    },
  });
  assert.equal(success.disposition, 'succeeded');
  assert.equal(deliveredCategory, 'target_hit');
  assert.equal(db.prepare('SELECT state FROM forecast_notification_outbox').get()?.state, 'succeeded');

  runtime.instant = '2026-08-25T06:40:00.000Z';
  insertSource(db, { kind: 'needs_review', createdAt: '2026-08-25T06:39:00.000Z' });
  await projector.project(projection('commit'), 1);
  const failure = await delivery.dispatchOne(1, {
    kind: 'deterministic_fake',
    version: 'test-1.0.0',
    async deliver() { return { disposition: 'failed', failure: 'provider_timeout' }; },
  });
  assert.equal(failure.disposition, 'retry_scheduled');
  assert.equal(db.prepare("SELECT state FROM forecast_notification_outbox WHERE state <> 'succeeded'").get()?.state,
    'retry_scheduled');
  assert.equal(count(db, 'forecast_notification_delivery_attempts'), 2);
  db.close();
});

test('runtime DDL and generated migration agree for all notification tables', () => {
  const runtime = database();
  for (const statement of forecastInitializationStatements()) runtime.exec(statement);

  const migrated = new DatabaseSync(':memory:');
  migrated.exec('PRAGMA foreign_keys = OFF');
  for (const migrationName of [
    '0000_spotty_sugar_man.sql', '0001_kind_warbound.sql', '0002_quiet_gamora.sql',
    '0003_great_xavin.sql', '0004_clean_next_avengers.sql', '0005_thin_ikaris.sql',
    '0006_late_wasp.sql',
  ]) {
    const sql = readFileSync(new URL(`../../drizzle/${migrationName}`, import.meta.url), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) {
      migrated.exec(statement);
    }
  }

  const columns = (db: DatabaseSync, table: string) => db.prepare(`PRAGMA table_info(${table})`).all();
  const indexes = (db: DatabaseSync, table: string) => db.prepare(`PRAGMA index_list(${table})`).all()
    .filter((row) => String(row.origin) !== 'pk')
    .map((row) => ({
      name: row.name,
      unique: row.unique,
      partial: row.partial,
      columns: db.prepare(`PRAGMA index_info(${String(row.name)})`).all().map((column) => column.name),
    })).sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const foreignKeys = (db: DatabaseSync, table: string) => db.prepare(`PRAGMA foreign_key_list(${table})`).all()
    .map((row) => ({ id: row.id, seq: row.seq, table: row.table, from: row.from, to: row.to, onDelete: row.on_delete }))
    .sort((left, right) => Number(left.id) - Number(right.id) || Number(left.seq) - Number(right.seq));
  for (const table of NOTIFICATION_TABLES) {
    assert.deepEqual(columns(runtime, table), columns(migrated, table), `${table} columns differ`);
    assert.deepEqual(indexes(runtime, table), indexes(migrated, table), `${table} indexes differ`);
    assert.deepEqual(foreignKeys(runtime, table), foreignKeys(migrated, table), `${table} foreign keys differ`);
  }
  assert.deepEqual(runtime.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
  runtime.close();
  migrated.close();
});
