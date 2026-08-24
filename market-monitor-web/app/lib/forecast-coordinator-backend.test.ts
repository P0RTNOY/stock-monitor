import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { forecastInitializationStatements } from '../../db/forecast-initialization.ts';
import { COORDINATOR_MAX_SAME_CUTOFF_RETRIES, CoordinatorContractError } from './server/coordinator/contract.ts';
import { D1CoordinatorRepository } from './server/coordinator/repository.ts';
import {
  ForecastCoordinatorService,
  type CoordinatorRuntime,
} from './server/coordinator/service.ts';
import type { CoordinatorItemCompletion, PlannedCoordinatorRun } from './server/coordinator/types.ts';
import { EvaluationProviderError } from './server/evaluation/client.ts';
import { D1EvaluationRepository } from './server/evaluation/repository.ts';
import { ForecastEvaluationService } from './server/evaluation/service.ts';
import type { EvaluationKind, EvaluationRequest, EvaluationResult } from './server/evaluation/types.ts';
import { D1ForecastRepository } from './server/forecasts/repository.ts';

const CUTOFF = '2026-08-24T10:00:00.000Z';
const BEFORE_CUTOFF = '2026-08-23T10:00:00.000Z';
const ACTIVATED_AT = '2026-08-24T09:50:00.000Z';
const MARKET_DATA_AS_OF = '2026-08-24T09:55:00.000Z';

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

  async run() {
    return this.execute();
  }

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

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  prepare(sql: string) {
    return new SQLitePrepared(this.database, sql);
  }

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

class TestRuntime implements CoordinatorRuntime {
  private sequence = 0;
  instant: string;

  constructor(instant = CUTOFF) {
    this.instant = instant;
  }

  now() {
    return this.instant;
  }

  leaseExpiresAt(acquiredAt: string) {
    return new Date(Date.parse(acquiredAt) + 60_000).toISOString();
  }

  durationMs(startedAt: string, finishedAt: string) {
    return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
  }

  id(kind: 'run' | 'item' | 'attempt' | 'claim' | 'run_lease') {
    this.sequence += 1;
    return `${kind}-${this.sequence}`;
  }
}

class CrashBeforeCoordinatorCompletionRepository extends D1CoordinatorRepository {
  private shouldCrash = true;

  override async completeItem(input: Parameters<D1CoordinatorRepository['completeItem']>[0]) {
    if (this.shouldCrash && input.ownerToken) {
      this.shouldCrash = false;
      throw new Error('SimulatedProcessCrashAfterEvaluationPersistence');
    }
    return super.completeItem(input);
  }
}

class CrashAfterPlanningRepository extends D1CoordinatorRepository {
  private shouldCrash = true;
  private hideRecoveryLookup = false;

  override async createPlannedRun(input: Parameters<D1CoordinatorRepository['createPlannedRun']>[0]) {
    const run = await super.createPlannedRun(input);
    if (this.shouldCrash) {
      this.shouldCrash = false;
      this.hideRecoveryLookup = true;
      throw new Error('SimulatedProcessCrashBeforeFirstItem');
    }
    return run;
  }

  override async findRunByOperatorKey(profileId: number, operatorRunKey: string) {
    if (this.hideRecoveryLookup) {
      this.hideRecoveryLookup = false;
      return null;
    }
    return super.findRunByOperatorKey(profileId, operatorRunKey);
  }
}

class CrashAfterAttemptStartRepository extends D1CoordinatorRepository {
  private shouldCrash = true;

  override async startAttempt(input: Parameters<D1CoordinatorRepository['startAttempt']>[0]) {
    const result = await super.startAttempt(input);
    if (this.shouldCrash) {
      this.shouldCrash = false;
      throw new Error('SimulatedProcessCrashAfterAttemptStart');
    }
    return result;
  }
}

class CrashAfterFirstRecordedItemRepository extends D1CoordinatorRepository {
  private shouldCrash = true;

  override async completeItem(input: Parameters<D1CoordinatorRepository['completeItem']>[0]) {
    const result = await super.completeItem(input);
    if (this.shouldCrash && input.ownerToken) {
      this.shouldCrash = false;
      throw new Error('SimulatedProcessCrashAfterCoordinatorItemRecording');
    }
    return result;
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

function insertForecast(db: DatabaseSync, options: {
  profileId?: number;
  symbol?: string;
  status?: 'draft' | 'active' | 'target_hit' | 'invalidated' | 'expired' | 'cancelled';
  evaluationDate?: string;
  activatedAt?: string;
} = {}) {
  const profileId = options.profileId ?? 1;
  const status = options.status ?? 'active';
  const symbol = options.symbol ?? 'NVDA';
  const evaluationDate = options.evaluationDate ?? '2026-09-24';
  const activatedAt = options.activatedAt ?? ACTIVATED_AT;
  const result = db.prepare(`INSERT INTO forecasts
    (profile_id, symbol, direction, confidence, thesis, supporting_evidence, counter_evidence,
     setup_tag, evaluation_date, target_kind, target_price, target_lower, target_upper,
     invalidation_price, status, activated_at, market_data_as_of, activation_price,
     activation_currency, market_provider, resolved_at, resolution_reason, created_at, updated_at)
    VALUES (?, ?, 'bullish', 75, 'Thesis', 'Evidence', 'Counter', 'Rectangle', ?,
      'price', 190, NULL, NULL, 150, ?, ?, ?, 175, 'USD', 'yahoo-finance',
      NULL, NULL, ?, ?)`)
    .run(profileId, symbol, evaluationDate, status, activatedAt, MARKET_DATA_AS_OF, activatedAt, activatedAt);
  const id = Number(result.lastInsertRowid);
  db.prepare(`INSERT INTO forecast_events
    (forecast_id, profile_id, revision, event_type, note, payload_json, created_at)
    VALUES (?, ?, 1, 'activated', '', '{}', ?)`)
    .run(id, profileId, activatedAt);
  return id;
}

function observation(kind: EvaluationKind) {
  if (!['target_hit', 'invalidated', 'needs_review'].includes(kind)) return null;
  return {
    symbol: 'NVDA',
    market_date: '2026-08-24',
    timestamp: '2026-08-24T13:30:00+00:00',
    completed_at: '2026-08-24T20:00:00+00:00',
    open: 175,
    high: kind === 'invalidated' ? 180 : 191,
    low: kind === 'target_hit' ? 160 : 149,
    close: 175,
    volume: 1_000,
    provider: 'coordinator-test-provider',
    adjustment_mode: 'raw',
    corporate_action_flags: [],
  };
}

function evaluationResult(
  request: Pick<EvaluationRequest, 'forecast' | 'evaluation_cutoff'>,
  kind: EvaluationKind = 'no_change',
  fingerprint = 'a'.repeat(64),
): EvaluationResult {
  const trigger = observation(kind);
  return {
    kind,
    reason_code: {
      no_change: 'horizon_not_complete',
      target_hit: 'target_boundary_touched',
      invalidated: 'invalidation_boundary_touched',
      expired: 'horizon_complete_without_terminal_touch',
      needs_review: 'same_bar_target_invalidation_collision',
    }[kind],
    explanation: `Deterministic ${kind} result.`,
    evaluator_version: 'forecast-evaluator-1.0.0',
    ruleset_version: 'forecast-evaluation-ruleset-v1',
    forecast_id: request.forecast.forecast_id,
    evaluation_cutoff: request.evaluation_cutoff,
    evaluated_through: trigger?.market_date ?? null,
    input_fingerprint: fingerprint,
    evidence: {
      activation_cutoff: MARKET_DATA_AS_OF,
      activation_currency: 'USD',
      observed_currency: 'USD',
      observation_count: trigger ? 1 : 0,
      first_eligible_observation: trigger,
      last_eligible_observation: trigger,
      triggering_observation: trigger,
      target_boundary: 190,
      target_range: null,
      invalidation_boundary: 150,
      detected_at: kind === 'target_hit' || kind === 'invalidated' ? 'within_bar' : null,
      observed_open: null,
      crossed_boundary: kind === 'target_hit' ? 190 : kind === 'invalidated' ? 150 : null,
      corporate_action_findings: [],
      coverage_findings: {
        calendar_id: 'XNYS',
        calendar_version: '4.11.2',
        calendar_supported: true,
        market_timezone: 'America/New_York',
        expected_sessions: ['2026-08-24'],
        available_expected_sessions: ['2026-08-24'],
        future_expected_sessions: [],
        final_expected_session: '2026-08-24',
        horizon_available_at: '2026-09-25T04:00:00+00:00',
        missing_available_sessions: [],
        provider_complete: true,
        observed_currency: 'USD',
        horizon_reviewable: kind === 'expired',
        coverage_complete: kind === 'expired',
        ...(trigger ? {
          observation_path_checked_through: '2026-08-24',
          observation_path_expected_sessions: ['2026-08-24'],
          observation_path_missing_sessions: [],
          observation_path_complete: true,
        } : {}),
      },
      warnings: [],
    },
  };
}

function services(db: DatabaseSync, runtime: TestRuntime, provider: (request: EvaluationRequest) => Promise<EvaluationResult>) {
  const binding = d1(db);
  const forecasts = new D1ForecastRepository(binding);
  const evaluations = new D1EvaluationRepository(binding);
  const evaluator = new ForecastEvaluationService(
    forecasts,
    evaluations,
    provider,
    () => new Date(runtime.instant),
  );
  const repository = new D1CoordinatorRepository(binding);
  return {
    binding,
    forecasts,
    evaluations,
    evaluator,
    repository,
    coordinator: new ForecastCoordinatorService(repository, forecasts, evaluator, runtime),
  };
}

async function persistEvaluation(
  db: DatabaseSync,
  forecastId: number,
  kind: EvaluationKind,
  cutoff = BEFORE_CUTOFF,
  fingerprint = 'b'.repeat(64),
) {
  const repository = new D1EvaluationRepository(d1(db));
  const request: Pick<EvaluationRequest, 'forecast' | 'evaluation_cutoff'> = {
    forecast: { forecast_id: forecastId } as EvaluationRequest['forecast'],
    evaluation_cutoff: cutoff,
  };
  return repository.persist(
    1,
    forecastId,
    ACTIVATED_AT,
    1,
    evaluationResult(request, kind, fingerprint),
    cutoff,
  );
}

function insertHistoricalOutcome(
  db: DatabaseSync,
  forecastId: number,
  index: number,
  classification: 'provider_unavailable' | 'provider_timeout' | 'stale_state' | 'unexpected_error',
) {
  const runId = `historical-run-${forecastId}-${index}`;
  const itemId = `historical-item-${forecastId}-${index}`;
  db.prepare(`INSERT INTO forecast_coordinator_runs
    (id, profile_id, coordinator_version, mode, evaluation_cutoff, batch_limit,
     scan_started_at, snapshot_max_forecast_id, request_fingerprint, status,
     started_at, completed_at, created_at)
    VALUES (?, 1, 'forecast-coordinator-1.0.0', 'execute', ?, 25, ?, ?, ?, 'completed', ?, ?, ?)`)
    .run(runId, CUTOFF, CUTOFF, forecastId, String(index).padStart(64, '0'), CUTOFF, CUTOFF, CUTOFF);
  db.prepare(`INSERT INTO forecast_coordinator_run_items
    (id, run_id, profile_id, forecast_id, ordinal, symbol, evaluation_cutoff,
     sort_evaluation_date, sort_forecast_id, due_reason, previous_status, current_status,
     state, classification, reason_code, safe_explanation, retry_useful, completed_at, created_at)
    VALUES (?, ?, 1, ?, 1, 'NVDA', ?, '2026-09-24', ?, 'never_evaluated',
      'active', 'active', 'completed', ?, 'temporary_failure', 'Temporary failure.', 1, ?, ?)`)
    .run(itemId, runId, forecastId, CUTOFF, forecastId, classification, CUTOFF, CUTOFF);
  db.prepare(`INSERT INTO forecast_coordinator_item_attempts
    (id, item_id, run_id, profile_id, attempt_number, owner_token, state,
     started_at, finished_at, classification, created_at)
    VALUES (?, ?, ?, 1, 1, ?, 'completed', ?, ?, ?, ?)`)
    .run(
      `historical-attempt-${forecastId}-${index}`, itemId, runId,
      `historical-owner-${forecastId}-${index}`, CUTOFF, CUTOFF, classification, CUTOFF,
    );
}

function plannedRun(
  forecastId: number,
  runId: string,
  itemId: string,
  leaseToken: string,
  startedAt = CUTOFF,
): PlannedCoordinatorRun {
  return {
    id: runId,
    itemIds: [itemId],
    input: { profileId: 1, cutoff: CUTOFF, limit: 1, mode: 'execute' },
    requestFingerprint: 'f'.repeat(64),
    scanStartedAt: startedAt,
    snapshotMaxForecastId: forecastId,
    initialCursor: null,
    resumeCursor: 'start-cursor',
    nextCursor: null,
    startedAt,
    leaseToken,
    leaseExpiresAt: new Date(Date.parse(startedAt) + 60_000).toISOString(),
    candidates: [{
      forecastId,
      symbol: 'NVDA',
      status: 'active',
      evaluationDate: '2026-09-24',
      activatedAt: ACTIVATED_AT,
      dueReason: 'never_evaluated',
      latestEvaluationRunId: null,
      latestEvaluationKind: null,
      latestEvaluationCutoff: null,
      retryCount: 0,
      latestRetryClassification: null,
    }],
  };
}

const noChangeCompletion: CoordinatorItemCompletion = {
  classification: 'no_change',
  currentStatus: 'active',
  evaluatorResultKind: 'no_change',
  reasonCode: 'horizon_not_complete',
  safeExplanation: 'No lifecycle transition.',
  attemptStartedAt: CUTOFF,
  attemptFinishedAt: '2026-08-24T10:00:01.000Z',
  mutated: true,
  retryUseful: false,
};

test('due selection is profile-scoped, status-aware, conservative before horizon, and bounded by retry policy', async () => {
  const db = database();
  const preHorizon = insertForecast(db, { symbol: 'PRE', evaluationDate: '2026-09-24' });
  const horizon = insertForecast(db, { symbol: 'HZN', evaluationDate: '2026-08-24' });
  const afterNoChange = insertForecast(db, { symbol: 'NOC', evaluationDate: '2026-09-25' });
  const afterNeedsReview = insertForecast(db, { symbol: 'REV', evaluationDate: '2026-09-26' });
  insertForecast(db, { symbol: 'DONE', status: 'target_hit', evaluationDate: '2026-08-20' });
  insertForecast(db, { symbol: 'CXL', status: 'cancelled', evaluationDate: '2026-08-21' });
  insertForecast(db, { profileId: 2, symbol: 'OTHER', evaluationDate: '2026-08-20' });
  insertForecast(db, { symbol: 'LATE', activatedAt: '2026-08-24T10:00:01.000Z' });
  const alreadyProcessed = insertForecast(db, { symbol: 'SAME', evaluationDate: '2026-09-27' });
  const retryCapped = insertForecast(db, { symbol: 'CAP', evaluationDate: '2026-09-28' });
  const retryable = insertForecast(db, { symbol: 'TRY', evaluationDate: '2026-09-29' });

  await persistEvaluation(db, afterNoChange, 'no_change', BEFORE_CUTOFF, '1'.repeat(64));
  await persistEvaluation(db, afterNeedsReview, 'needs_review', BEFORE_CUTOFF, '2'.repeat(64));
  db.prepare('UPDATE forecast_review_items SET acknowledged_at = ? WHERE forecast_id = ?')
    .run('2026-08-23T11:00:00.000Z', afterNeedsReview);
  await persistEvaluation(db, alreadyProcessed, 'no_change', CUTOFF, '3'.repeat(64));
  for (let attempt = 1; attempt <= COORDINATOR_MAX_SAME_CUTOFF_RETRIES; attempt += 1) {
    insertHistoricalOutcome(db, retryCapped, attempt, 'provider_unavailable');
  }
  insertHistoricalOutcome(db, retryable, 1, 'provider_timeout');

  const repository = new D1CoordinatorRepository(d1(db));
  const maximum = await repository.snapshotMaxForecastId(1, CUTOFF);
  const page = await repository.selectDuePage({
    profileId: 1,
    cutoff: CUTOFF,
    scanStartedAt: CUTOFF,
    snapshotMaxForecastId: maximum,
    afterEvaluationDate: null,
    afterForecastId: null,
    limit: 100,
  });

  assert.deepEqual(page.candidates.map((candidate) => candidate.forecastId), [
    horizon,
    preHorizon,
    afterNoChange,
    afterNeedsReview,
    retryable,
  ]);
  assert.deepEqual(page.candidates.map((candidate) => candidate.dueReason), [
    'never_evaluated',
    'never_evaluated',
    'new_information_possible_after_no_change',
    'new_information_possible_after_needs_review',
    'retry_after_provider_timeout',
  ]);
  assert.equal(page.hasMore, false);
  assert.equal(page.candidates.some((candidate) => candidate.forecastId === retryCapped), false);
  assert.equal(page.candidates.some((candidate) => candidate.forecastId === alreadyProcessed), false);
  db.close();
});

test('planned coordinator items reject cross-profile forecast ownership', async () => {
  const db = database();
  const foreignForecastId = insertForecast(db, { profileId: 2 });
  const repository = new D1CoordinatorRepository(d1(db));
  await assert.rejects(
    () => repository.createPlannedRun(plannedRun(
      foreignForecastId, 'cross-profile-run', 'cross-profile-item', 'cross-profile-lease',
    )),
    /FOREIGN KEY constraint failed/,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forecast_coordinator_runs WHERE id = 'cross-profile-run'").get()?.count, 0);
  db.close();
});

test('keyset pages preserve total order and frozen scan membership without offset skips', async () => {
  const db = database();
  const original = Array.from({ length: 6 }, (_, index) => insertForecast(db, {
    symbol: `P${index + 1}`,
    evaluationDate: '2026-09-24',
  }));
  const runtime = new TestRuntime();
  let providerCalls = 0;
  const { coordinator } = services(db, runtime, async (request) => {
    providerCalls += 1;
    return evaluationResult(request);
  });
  const first = await coordinator.coordinate({ profileId: 1, cutoff: CUTOFF, limit: 2, mode: 'dry_run' }, 1);
  assert.deepEqual(first.items.map((item) => item.forecastId), original.slice(0, 2));
  assert.ok(first.nextCursor);

  const insertedDuringScan = insertForecast(db, { symbol: 'NEW', evaluationDate: '2026-09-24' });
  db.prepare(`UPDATE forecasts SET status = 'target_hit', resolved_at = ?, resolution_reason = 'resolved elsewhere'
    WHERE id = ?`).run(CUTOFF, original[2]);
  db.prepare('DELETE FROM forecasts WHERE id = ?').run(original[3]);
  const second = await coordinator.coordinate({
    profileId: 1, cutoff: CUTOFF, limit: 2, mode: 'dry_run', cursor: first.nextCursor,
  }, 1);

  assert.deepEqual(second.items.map((item) => item.forecastId), original.slice(4));
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    [...first.items, ...second.items].map((item) => item.forecastId),
    [original[0], original[1], original[4], original[5]],
  );
  assert.equal([...first.items, ...second.items].some((item) => item.forecastId === insertedDuringScan), false);
  assert.equal(providerCalls, 0);
  db.close();
});

test('keyset execution honors limit one and the maximum page bound', async () => {
  const db = database();
  for (let index = 0; index < 101; index += 1) {
    insertForecast(db, {
      symbol: `S${String(index).padStart(3, '0')}`,
      evaluationDate: '2026-09-24',
    });
  }
  const runtime = new TestRuntime();
  const { coordinator } = services(db, runtime, async (request) => evaluationResult(request));
  const first = await coordinator.coordinate({
    profileId: 1, cutoff: CUTOFF, limit: 1, mode: 'dry_run',
  }, 1);
  assert.equal(first.selectedCount, 1);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);

  const remainder = await coordinator.coordinate({
    profileId: 1, cutoff: CUTOFF, limit: 100, mode: 'dry_run', cursor: first.nextCursor,
  }, 1);
  assert.equal(remainder.selectedCount, 100);
  assert.equal(remainder.hasMore, false);
  assert.equal(remainder.nextCursor, null);
  assert.equal(new Set([...first.items, ...remainder.items].map((item) => item.forecastId)).size, 101);
  db.close();
});

test('dry-run records an auditable plan without provider, attempt, claim, evaluation, review, event, or lifecycle mutation', async () => {
  const db = database();
  const forecastId = insertForecast(db);
  const originalEventCount = Number(db.prepare('SELECT COUNT(*) AS count FROM forecast_events').get()?.count);
  let providerCalls = 0;
  const runtime = new TestRuntime();
  const { coordinator } = services(db, runtime, async (request) => {
    providerCalls += 1;
    return evaluationResult(request);
  });

  const report = await coordinator.coordinate({
    profileId: 1, cutoff: CUTOFF, limit: 25, mode: 'dry_run', operatorRunKey: 'dry-audit',
  }, 1);

  assert.equal(report.status, 'completed');
  assert.equal(report.selectedCount, 1);
  assert.equal(report.attemptedCount, 0);
  assert.equal(report.mutatedCount, 0);
  assert.deepEqual(report.outcomeCounts, { dry_run_candidate: 1 });
  assert.equal(report.items[0].forecastId, forecastId);
  assert.equal(report.items[0].classification, 'dry_run_candidate');
  assert.equal(report.items[0].wouldCallProvider, true);
  assert.equal(providerCalls, 0);
  assert.equal(db.prepare('SELECT status FROM forecasts WHERE id = ?').get(forecastId)?.status, 'active');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evaluation_runs').get()?.count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM forecast_review_items').get()?.count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM forecast_coordinator_claims').get()?.count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM forecast_coordinator_item_attempts').get()?.count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM forecast_events').get()?.count, originalEventCount);
  db.close();
});

test('dry-run and execute select the same bounded candidates in the same order', async () => {
  const dryDb = database();
  const executeDb = database();
  for (const db of [dryDb, executeDb]) {
    insertForecast(db, { symbol: 'LATE', evaluationDate: '2026-09-25' });
    insertForecast(db, { symbol: 'EARLY-A', evaluationDate: '2026-09-24' });
    insertForecast(db, { symbol: 'EARLY-B', evaluationDate: '2026-09-24' });
  }
  const dryRuntime = new TestRuntime();
  const executeRuntime = new TestRuntime();
  let dryProviderCalls = 0;
  const dry = await services(dryDb, dryRuntime, async (request) => {
    dryProviderCalls += 1;
    return evaluationResult(request);
  }).coordinator.coordinate({ profileId: 1, cutoff: CUTOFF, limit: 2, mode: 'dry_run' }, 1);
  const execute = await services(executeDb, executeRuntime, async (request) => (
    evaluationResult(request, 'no_change', request.forecast.forecast_id.toString(16).padStart(64, '0'))
  )).coordinator.coordinate({ profileId: 1, cutoff: CUTOFF, limit: 2, mode: 'execute' }, 1);
  assert.deepEqual(
    dry.items.map((item) => [item.forecastId, item.symbol, item.dueReason]),
    execute.items.map((item) => [item.forecastId, item.symbol, item.dueReason]),
  );
  assert.equal(dry.nextCursor, execute.nextCursor);
  assert.equal(dryProviderCalls, 0);
  dryDb.close();
  executeDb.close();
});

test('execute delegates to the real Phase 2A service for no-change and terminal outcomes with truthful counts', async () => {
  const db = database();
  const noChangeId = insertForecast(db, { symbol: 'NOC', evaluationDate: '2026-09-24' });
  const targetId = insertForecast(db, { symbol: 'HIT', evaluationDate: '2026-09-25' });
  let providerCalls = 0;
  const runtime = new TestRuntime();
  const { coordinator } = services(db, runtime, async (request) => {
    providerCalls += 1;
    return evaluationResult(request, request.forecast.forecast_id === targetId ? 'target_hit' : 'no_change');
  });

  const report = await coordinator.coordinate({
    profileId: 1, cutoff: CUTOFF, limit: 25, mode: 'execute', operatorRunKey: 'real-phase-2a',
  }, 1);

  assert.equal(report.status, 'completed');
  assert.equal(report.selectedCount, 2);
  assert.equal(report.attemptedCount, 2);
  assert.equal(report.mutatedCount, 2);
  assert.equal(report.unexpectedErrorCount, 0);
  assert.deepEqual(report.outcomeCounts, { no_change: 1, target_hit: 1 });
  assert.deepEqual(report.items.map((item) => item.classification), ['no_change', 'target_hit']);
  assert.equal(providerCalls, 2);
  assert.equal(db.prepare('SELECT status FROM forecasts WHERE id = ?').get(noChangeId)?.status, 'active');
  assert.equal(db.prepare('SELECT status FROM forecasts WHERE id = ?').get(targetId)?.status, 'target_hit');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evaluation_runs').get()?.count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forecast_events WHERE event_type = 'evaluated'").get()?.count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM forecast_review_items').get()?.count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forecast_coordinator_claims WHERE state = 'completed'").get()?.count, 2);
  const stored = db.prepare(`SELECT selected_count AS selectedCount, attempted_count AS attemptedCount,
    mutation_count AS mutationCount, unexpected_error_count AS unexpectedErrorCount,
    outcome_counts_json AS outcomeCounts FROM forecast_coordinator_runs WHERE id = ?`).get(report.runId);
  assert.deepEqual({ ...stored }, {
    selectedCount: report.selectedCount,
    attemptedCount: report.attemptedCount,
    mutationCount: report.mutatedCount,
    unexpectedErrorCount: report.unexpectedErrorCount,
    outcomeCounts: JSON.stringify(report.outcomeCounts),
  });
  db.close();
});

test('execute preserves invalidated, expired, and needs-review evaluator decisions', async () => {
  const db = database();
  const invalidatedId = insertForecast(db, { symbol: 'INV', evaluationDate: '2026-08-24' });
  const expiredId = insertForecast(db, { symbol: 'EXP', evaluationDate: '2026-08-24' });
  const reviewId = insertForecast(db, { symbol: 'REV', evaluationDate: '2026-08-24' });
  const kinds = new Map<number, EvaluationKind>([
    [invalidatedId, 'invalidated'], [expiredId, 'expired'], [reviewId, 'needs_review'],
  ]);
  const runtime = new TestRuntime();
  const { coordinator } = services(db, runtime, async (request) => (
    evaluationResult(request, kinds.get(request.forecast.forecast_id) as EvaluationKind)
  ));
  const report = await coordinator.coordinate({
    profileId: 1, cutoff: CUTOFF, limit: 25, mode: 'execute',
  }, 1);
  assert.deepEqual(report.items.map((item) => item.classification), ['invalidated', 'expired', 'needs_review']);
  assert.deepEqual(report.outcomeCounts, { invalidated: 1, expired: 1, needs_review: 1 });
  assert.equal(db.prepare('SELECT status FROM forecasts WHERE id = ?').get(invalidatedId)?.status, 'invalidated');
  assert.equal(db.prepare('SELECT status FROM forecasts WHERE id = ?').get(expiredId)?.status, 'expired');
  assert.equal(db.prepare('SELECT status FROM forecasts WHERE id = ?').get(reviewId)?.status, 'active');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM forecast_review_items').get()?.count, 3);
  db.close();
});

test('a repeated evaluator fingerprint is classified once and suppresses same-cutoff provider replay', async () => {
  const db = database();
  const forecastId = insertForecast(db);
  await persistEvaluation(db, forecastId, 'no_change', BEFORE_CUTOFF, 'a'.repeat(64));
  let providerCalls = 0;
  const runtime = new TestRuntime();
  const { coordinator } = services(db, runtime, async (request) => {
    providerCalls += 1;
    return evaluationResult(request, 'no_change', 'a'.repeat(64));
  });
  const first = await coordinator.coordinate({
    profileId: 1, cutoff: CUTOFF, limit: 25, mode: 'execute',
  }, 1);
  assert.equal(first.items[0].classification, 'duplicate_or_replayed');
  assert.equal(first.items[0].evaluationRunId, 1);
  assert.equal(first.mutatedCount, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evaluation_runs').get()?.count, 1);

  const replayPage = await coordinator.coordinate({
    profileId: 1, cutoff: CUTOFF, limit: 25, mode: 'execute',
  }, 1);
  assert.equal(replayPage.selectedCount, 0);
  assert.equal(providerCalls, 1);
  db.close();
});

test('one unexpected item failure is isolated and later items still complete', async () => {
  const db = database();
  const ids = [
    insertForecast(db, { symbol: 'ONE', evaluationDate: '2026-09-24' }),
    insertForecast(db, { symbol: 'TWO', evaluationDate: '2026-09-25' }),
    insertForecast(db, { symbol: 'THR', evaluationDate: '2026-09-26' }),
  ];
  let providerCalls = 0;
  const runtime = new TestRuntime();
  const { coordinator } = services(db, runtime, async (request) => {
    providerCalls += 1;
    if (request.forecast.forecast_id === ids[1]) throw new Error('private-provider-detail');
    return evaluationResult(request, 'no_change', request.forecast.forecast_id.toString(16).padStart(64, '0'));
  });

  const report = await coordinator.coordinate({ profileId: 1, cutoff: CUTOFF, limit: 25, mode: 'execute' }, 1);

  assert.equal(providerCalls, 3);
  assert.equal(report.status, 'completed_with_errors');
  assert.equal(report.selectedCount, 3);
  assert.equal(report.attemptedCount, 3);
  assert.equal(report.mutatedCount, 2);
  assert.equal(report.unexpectedErrorCount, 1);
  assert.deepEqual(report.outcomeCounts, { no_change: 2, unexpected_error: 1 });
  assert.deepEqual(report.items.map((item) => item.classification), ['no_change', 'unexpected_error', 'no_change']);
  assert.equal(report.items[1].redactedErrorCategory, 'unexpected_error');
  assert.doesNotMatch(report.items[1].safeExplanation ?? '', /private-provider-detail/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evaluation_runs').get()?.count, 2);
  db.close();
});

test('expected provider and validation failures are classified safely and do not stop the batch', async () => {
  const db = database();
  const unavailableId = insertForecast(db, { symbol: 'OFF', evaluationDate: '2026-09-24' });
  const timeoutId = insertForecast(db, { symbol: 'SLOW', evaluationDate: '2026-09-25' });
  const invalidId = insertForecast(db, { symbol: 'BAD', evaluationDate: '2026-09-26' });
  let providerCalls = 0;
  const runtime = new TestRuntime();
  const { coordinator } = services(db, runtime, async (request) => {
    providerCalls += 1;
    if (request.forecast.forecast_id === unavailableId) {
      throw new EvaluationProviderError('secret unavailable detail', 'unavailable');
    }
    if (request.forecast.forecast_id === timeoutId) {
      throw new EvaluationProviderError('secret timeout detail', 'timeout');
    }
    assert.equal(request.forecast.forecast_id, invalidId);
    throw new EvaluationProviderError('secret invalid response detail', 'invalid_response');
  });

  const report = await coordinator.coordinate({ profileId: 1, cutoff: CUTOFF, limit: 25, mode: 'execute' }, 1);

  assert.equal(providerCalls, 3);
  assert.equal(report.status, 'completed');
  assert.equal(report.selectedCount, 3);
  assert.equal(report.attemptedCount, 3);
  assert.equal(report.mutatedCount, 0);
  assert.equal(report.unexpectedErrorCount, 0);
  assert.deepEqual(report.items.map((item) => item.classification), [
    'provider_unavailable', 'provider_timeout', 'validation_failure',
  ]);
  assert.deepEqual(report.items.map((item) => item.retryUseful), [true, true, false]);
  assert.deepEqual(report.outcomeCounts, {
    provider_unavailable: 1,
    provider_timeout: 1,
    validation_failure: 1,
  });
  for (const item of report.items) {
    assert.doesNotMatch(item.safeExplanation ?? '', /secret/);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evaluation_runs').get()?.count, 0);
  db.close();
});

test('a selected forecast that becomes terminal before item invocation is reported not-active without a claim', async () => {
  const db = database();
  const forecastId = insertForecast(db);
  const runtime = new TestRuntime();
  const binding = d1(db);
  const baseForecasts = new D1ForecastRepository(binding);
  let firstRead = true;
  const forecasts = new Proxy(baseForecasts, {
    get(target, property, receiver) {
      if (property !== 'get') return Reflect.get(target, property, receiver);
      return async (profileId: number, id: number) => {
        if (firstRead) {
          firstRead = false;
          db.prepare(`UPDATE forecasts SET status = 'target_hit', resolved_at = ?,
            resolution_reason = 'resolved concurrently', updated_at = ? WHERE id = ?`)
            .run(CUTOFF, CUTOFF, forecastId);
        }
        return target.get(profileId, id);
      };
    },
  });
  let providerCalls = 0;
  const evaluator = new ForecastEvaluationService(
    forecasts,
    new D1EvaluationRepository(binding),
    async (request) => {
      providerCalls += 1;
      return evaluationResult(request);
    },
    () => new Date(runtime.instant),
  );
  const coordinator = new ForecastCoordinatorService(
    new D1CoordinatorRepository(binding), forecasts, evaluator, runtime,
  );

  const report = await coordinator.coordinate({ profileId: 1, cutoff: CUTOFF, limit: 25, mode: 'execute' }, 1);

  assert.equal(report.selectedCount, 1);
  assert.equal(report.attemptedCount, 1);
  assert.deepEqual(report.outcomeCounts, { not_active: 1 });
  assert.equal(report.items[0].classification, 'not_active');
  assert.equal(report.items[0].currentStatus, 'target_hit');
  assert.equal(report.items[0].wouldCallProvider, false);
  assert.equal(providerCalls, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM forecast_coordinator_claims').get()?.count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evaluation_runs').get()?.count, 0);
  db.close();
});

test('a selected forecast processed manually before invocation is reported not-due without provider work', async () => {
  const db = database();
  const forecastId = insertForecast(db);
  const runtime = new TestRuntime();
  const binding = d1(db);
  const baseForecasts = new D1ForecastRepository(binding);
  let firstRead = true;
  const forecasts = new Proxy(baseForecasts, {
    get(target, property, receiver) {
      if (property !== 'get') return Reflect.get(target, property, receiver);
      return async (profileId: number, id: number) => {
        if (firstRead) {
          firstRead = false;
          await persistEvaluation(db, forecastId, 'no_change', CUTOFF, 'd'.repeat(64));
        }
        return target.get(profileId, id);
      };
    },
  });
  let providerCalls = 0;
  const evaluator = new ForecastEvaluationService(
    forecasts,
    new D1EvaluationRepository(binding),
    async (request) => {
      providerCalls += 1;
      return evaluationResult(request);
    },
    () => new Date(runtime.instant),
  );
  const report = await new ForecastCoordinatorService(
    new D1CoordinatorRepository(binding), forecasts, evaluator, runtime,
  ).coordinate({ profileId: 1, cutoff: CUTOFF, limit: 25, mode: 'execute' }, 1);
  assert.deepEqual(report.outcomeCounts, { not_due: 1 });
  assert.equal(report.items[0].evaluationRunId, 1);
  assert.equal(report.items[0].wouldCallProvider, false);
  assert.equal(providerCalls, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM forecast_coordinator_claims').get()?.count, 0);
  db.close();
});

test('a Phase 2A optimistic-concurrency rejection is classified stale-state', async () => {
  const db = database();
  const forecastId = insertForecast(db);
  const runtime = new TestRuntime();
  const forecastHolder: { value?: D1ForecastRepository } = {};
  const bundle = services(db, runtime, async (request) => {
    await forecastHolder.value?.addNote(1, forecastId, 'review_note', 'Concurrent review note.', CUTOFF);
    return evaluationResult(request);
  });
  forecastHolder.value = bundle.forecasts;
  const report = await bundle.coordinator.coordinate({
    profileId: 1, cutoff: CUTOFF, limit: 25, mode: 'execute',
  }, 1);
  assert.deepEqual(report.outcomeCounts, { stale_state: 1 });
  assert.equal(report.items[0].retryUseful, true);
  assert.equal(report.items[0].mutated, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evaluation_runs').get()?.count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forecast_events WHERE event_type = 'review_note'").get()?.count, 1);
  db.close();
});

test('claims conflict while live, recover after expiry, and fence an old owner from completion', async () => {
  const db = database();
  const forecastId = insertForecast(db);
  const repository = new D1CoordinatorRepository(d1(db));
  await repository.createPlannedRun(plannedRun(forecastId, 'old-run', 'old-item', 'old-run-lease'));
  await repository.createPlannedRun(plannedRun(forecastId, 'new-run', 'new-item', 'new-run-lease'));

  assert.equal(await repository.acquireClaim({
    profileId: 1, forecastId, runId: 'old-run', itemId: 'old-item',
    runLeaseToken: 'old-run-lease', token: 'old-token',
    cutoff: CUTOFF, acquiredAt: CUTOFF, expiresAt: '2026-08-24T10:01:00.000Z',
  }), 'acquired');

  await repository.startAttempt({
    id: 'old-attempt', itemId: 'old-item', runId: 'old-run', profileId: 1,
    runLeaseToken: 'old-run-lease', ownerToken: 'old-token', startedAt: CUTOFF,
  });
  assert.equal(await repository.acquireClaim({
    profileId: 1, forecastId, runId: 'new-run', itemId: 'new-item',
    runLeaseToken: 'new-run-lease', token: 'too-early',
    cutoff: CUTOFF, acquiredAt: '2026-08-24T10:00:30.000Z', expiresAt: '2026-08-24T10:01:30.000Z',
  }), 'conflict');
  assert.equal(await repository.renewRunLease(
    1, 'new-run', 'new-run-lease', '2026-08-24T10:03:00.000Z',
  ), true);
  assert.equal(await repository.acquireClaim({
    profileId: 1, forecastId, runId: 'new-run', itemId: 'new-item',
    runLeaseToken: 'new-run-lease', token: 'new-token',
    cutoff: CUTOFF, acquiredAt: '2026-08-24T10:01:00.000Z', expiresAt: '2026-08-24T10:02:00.000Z',
  }), 'acquired');

  await assert.rejects(() => repository.startAttempt({
    id: 'stale-attempt', itemId: 'old-item', runId: 'old-run', profileId: 1,
    runLeaseToken: 'old-run-lease', ownerToken: 'old-token',
    startedAt: '2026-08-24T10:01:01.000Z',
  }), /CoordinatorAttemptStartFailed/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forecast_coordinator_item_attempts WHERE item_id = 'old-item'").get()?.count, 1);

  await assert.rejects(() => repository.completeItem({
    profileId: 1,
    runId: 'old-run',
    itemId: 'old-item',
    runLeaseToken: 'old-run-lease',
    attemptId: 'old-attempt',
    ownerToken: 'old-token',
    completion: noChangeCompletion,
    completedAt: '2026-08-24T10:01:01.000Z',
    resumeCursor: 'old-resume',
  }), /CoordinatorAttemptCompletionFenced/);
  assert.deepEqual({ ...await repository.claimOwner(1, forecastId) }, {
    ownerRunId: 'new-run',
    ownerToken: 'new-token',
    state: 'active',
    expiresAt: '2026-08-24T10:02:00.000Z',
  });
  assert.equal(db.prepare("SELECT state FROM forecast_coordinator_run_items WHERE id = 'old-item'").get()?.state, 'pending');
  db.close();
});

test('two coordinators racing the same forecast perform only one provider evaluation', async () => {
  const db = database();
  insertForecast(db);
  const runtime = new TestRuntime();
  let providerCalls = 0;
  let announceStarted!: () => void;
  let releaseProvider!: () => void;
  const started = new Promise<void>((resolve) => { announceStarted = resolve; });
  const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
  const { coordinator } = services(db, runtime, async (request) => {
    providerCalls += 1;
    announceStarted();
    await providerGate;
    return evaluationResult(request);
  });

  const firstPromise = coordinator.coordinate({
    profileId: 1, cutoff: CUTOFF, limit: 25, mode: 'execute',
  }, 1);
  await started;
  const second = await coordinator.coordinate({
    profileId: 1, cutoff: CUTOFF, limit: 25, mode: 'execute',
  }, 1);
  assert.deepEqual(second.outcomeCounts, { claim_conflict: 1 });
  assert.equal(second.items[0].retryUseful, true);
  assert.equal(second.items[0].wouldCallProvider, false);
  releaseProvider();
  const first = await firstPromise;
  assert.deepEqual(first.outcomeCounts, { no_change: 1 });
  assert.equal(providerCalls, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evaluation_runs').get()?.count, 1);
  db.close();
});

test('same operator run key replays without provider work and rejects a mismatched request', async () => {
  const db = database();
  insertForecast(db);
  let providerCalls = 0;
  const runtime = new TestRuntime();
  const { coordinator } = services(db, runtime, async (request) => {
    providerCalls += 1;
    return evaluationResult(request);
  });
  const input = {
    profileId: 1,
    cutoff: CUTOFF,
    limit: 25,
    mode: 'execute' as const,
    operatorRunKey: 'operator-replay',
  };

  const first = await coordinator.coordinate(input, 1);
  const replay = await coordinator.coordinate(input, 1);
  assert.equal(replay.runId, first.runId);
  assert.equal(replay.replayUsedExistingRun, true);
  assert.equal(providerCalls, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM forecast_coordinator_runs').get()?.count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evaluation_runs').get()?.count, 1);

  await assert.rejects(
    () => coordinator.coordinate({ ...input, limit: 24 }, 1),
    (error: unknown) => error instanceof CoordinatorContractError && error.code === 'invalid_operator_run_key',
  );
  assert.equal(providerCalls, 1);
  db.close();
});

test('expired same-run recovery reconciles a persisted evaluation without a second provider call', async () => {
  const db = database();
  insertForecast(db);
  let providerCalls = 0;
  const runtime = new TestRuntime();
  const binding = d1(db);
  const forecasts = new D1ForecastRepository(binding);
  const evaluations = new D1EvaluationRepository(binding);
  const evaluator = new ForecastEvaluationService(forecasts, evaluations, async (request) => {
    providerCalls += 1;
    return evaluationResult(request);
  }, () => new Date(runtime.instant));
  const crashingRepository = new CrashBeforeCoordinatorCompletionRepository(binding);
  const crashingCoordinator = new ForecastCoordinatorService(crashingRepository, forecasts, evaluator, runtime);
  const input = {
    profileId: 1,
    cutoff: CUTOFF,
    limit: 25,
    mode: 'execute' as const,
    operatorRunKey: 'crash-recovery',
  };

  await assert.rejects(
    () => crashingCoordinator.coordinate(input, 1),
    /SimulatedProcessCrashAfterEvaluationPersistence/,
  );
  assert.equal(providerCalls, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evaluation_runs').get()?.count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forecast_coordinator_run_items WHERE state = 'pending'").get()?.count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forecast_coordinator_item_attempts WHERE state = 'started'").get()?.count, 1);

  runtime.instant = '2026-08-24T10:02:00.000Z';
  const recoveredCoordinator = new ForecastCoordinatorService(
    new D1CoordinatorRepository(binding), forecasts, evaluator, runtime,
  );
  const recovered = await recoveredCoordinator.coordinate(input, 1);

  assert.equal(recovered.replayUsedExistingRun, true);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.selectedCount, 1);
  assert.equal(recovered.attemptedCount, 1);
  assert.equal(recovered.mutatedCount, 0);
  assert.deepEqual(recovered.outcomeCounts, { duplicate_or_replayed: 1 });
  assert.equal(recovered.items[0].classification, 'duplicate_or_replayed');
  assert.equal(recovered.items[0].attemptStartedAt, CUTOFF);
  assert.equal(recovered.items[0].attemptFinishedAt, '2026-08-24T10:02:00.000Z');
  assert.equal(recovered.items[0].wouldCallProvider, true);
  assert.equal(providerCalls, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evaluation_runs').get()?.count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forecast_coordinator_run_items WHERE state = 'completed'").get()?.count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forecast_coordinator_item_attempts WHERE state = 'interrupted'").get()?.count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forecast_coordinator_claims WHERE state = 'completed'").get()?.count, 1);
  db.close();
});

test('a run lease renewed between items prevents same-key takeover past its original expiry', async () => {
  const db = database();
  insertForecast(db, { symbol: 'ONE', evaluationDate: '2026-09-24' });
  insertForecast(db, { symbol: 'TWO', evaluationDate: '2026-09-25' });
  const runtime = new TestRuntime();
  let providerCalls = 0;
  let announceSecond!: () => void;
  let releaseSecond!: () => void;
  const secondStarted = new Promise<void>((resolve) => { announceSecond = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const { coordinator } = services(db, runtime, async (request) => {
    providerCalls += 1;
    if (providerCalls === 1) {
      runtime.instant = '2026-08-24T10:00:50.000Z';
    } else {
      announceSecond();
      await secondGate;
    }
    return evaluationResult(
      request,
      'no_change',
      request.forecast.forecast_id.toString(16).padStart(64, '0'),
    );
  });
  const input = {
    profileId: 1, cutoff: CUTOFF, limit: 25, mode: 'execute' as const,
    operatorRunKey: 'renewed-page-run',
  };

  const original = coordinator.coordinate(input, 1);
  await secondStarted;
  runtime.instant = '2026-08-24T10:01:01.000Z';
  const replay = await coordinator.coordinate(input, 1);
  assert.equal(replay.status, 'running');
  assert.equal(replay.replayUsedExistingRun, true);
  assert.equal(replay.items.filter((item) => item.classification === 'no_change').length, 1);
  assert.equal(providerCalls, 2);

  releaseSecond();
  const completed = await original;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.attemptedCount, 2);
  assert.equal(providerCalls, 2);
  db.close();
});

test('a superseded run lease cannot record item progress', async () => {
  const db = database();
  const forecastId = insertForecast(db);
  const repository = new D1CoordinatorRepository(d1(db));
  await repository.createPlannedRun(plannedRun(forecastId, 'lease-run', 'lease-item', 'old-lease'));
  assert.equal(await repository.renewRunLease(
    1, 'lease-run', 'old-lease', '2026-08-24T10:01:30.000Z',
  ), true);
  assert.equal(await repository.acquireRunLease(
    1, 'lease-run', 'too-early', '2026-08-24T10:01:00.000Z', '2026-08-24T10:02:00.000Z',
  ), false);
  assert.equal(await repository.acquireRunLease(
    1, 'lease-run', 'new-lease', '2026-08-24T10:01:30.000Z', '2026-08-24T10:02:30.000Z',
  ), true);
  await assert.rejects(() => repository.completeItem({
    profileId: 1, runId: 'lease-run', itemId: 'lease-item', runLeaseToken: 'old-lease',
    completion: noChangeCompletion, completedAt: '2026-08-24T10:01:31.000Z', resumeCursor: 'stale',
  }), /CoordinatorItemCompletionFailed/);
  assert.equal(db.prepare("SELECT state FROM forecast_coordinator_run_items WHERE id = 'lease-item'").get()?.state, 'pending');
  await repository.completeItem({
    profileId: 1, runId: 'lease-run', itemId: 'lease-item', runLeaseToken: 'new-lease',
    completion: noChangeCompletion, completedAt: '2026-08-24T10:01:32.000Z', resumeCursor: 'current',
  });
  assert.equal(db.prepare("SELECT state FROM forecast_coordinator_run_items WHERE id = 'lease-item'").get()?.state, 'completed');
  db.close();
});

test('recovery appends a second attempt after a crash before Phase 2A persistence', async () => {
  const db = database();
  insertForecast(db);
  const runtime = new TestRuntime();
  const binding = d1(db);
  const forecasts = new D1ForecastRepository(binding);
  let providerCalls = 0;
  const evaluator = new ForecastEvaluationService(
    forecasts,
    new D1EvaluationRepository(binding),
    async (request) => {
      providerCalls += 1;
      return evaluationResult(request);
    },
    () => new Date(runtime.instant),
  );
  const input = {
    profileId: 1, cutoff: CUTOFF, limit: 25, mode: 'execute' as const,
    operatorRunKey: 'crash-after-attempt-start',
  };
  await assert.rejects(() => new ForecastCoordinatorService(
    new CrashAfterAttemptStartRepository(binding), forecasts, evaluator, runtime,
  ).coordinate(input, 1), /SimulatedProcessCrashAfterAttemptStart/);
  assert.equal(providerCalls, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forecast_coordinator_item_attempts WHERE state = 'started'").get()?.count, 1);

  runtime.instant = '2026-08-24T10:02:00.000Z';
  const recovered = await new ForecastCoordinatorService(
    new D1CoordinatorRepository(binding), forecasts, evaluator, runtime,
  ).coordinate(input, 1);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.attemptedCount, 1);
  assert.equal(providerCalls, 1);
  assert.deepEqual(
    db.prepare('SELECT attempt_number, state FROM forecast_coordinator_item_attempts ORDER BY attempt_number')
      .all().map((row) => ({ ...row })),
    [{ attempt_number: 1, state: 'interrupted' }, { attempt_number: 2, state: 'completed' }],
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evaluation_runs').get()?.count, 1);
  db.close();
});

test('same-run recovery stops after three interrupted provider attempts', async () => {
  const db = database();
  insertForecast(db);
  const runtime = new TestRuntime();
  const binding = d1(db);
  const forecasts = new D1ForecastRepository(binding);
  let providerCalls = 0;
  const evaluator = new ForecastEvaluationService(
    forecasts,
    new D1EvaluationRepository(binding),
    async (request) => {
      providerCalls += 1;
      return evaluationResult(request);
    },
    () => new Date(runtime.instant),
  );
  const input = {
    profileId: 1, cutoff: CUTOFF, limit: 25, mode: 'execute' as const,
    operatorRunKey: 'three-interrupted-attempts',
  };

  for (const instant of [
    CUTOFF,
    '2026-08-24T10:02:00.000Z',
    '2026-08-24T10:04:00.000Z',
  ]) {
    runtime.instant = instant;
    await assert.rejects(() => new ForecastCoordinatorService(
      new CrashAfterAttemptStartRepository(binding), forecasts, evaluator, runtime,
    ).coordinate(input, 1), /SimulatedProcessCrashAfterAttemptStart/);
  }
  assert.equal(providerCalls, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM forecast_coordinator_item_attempts').get()?.count, 3);

  runtime.instant = '2026-08-24T10:06:00.000Z';
  const exhausted = await new ForecastCoordinatorService(
    new D1CoordinatorRepository(binding), forecasts, evaluator, runtime,
  ).coordinate(input, 1);
  assert.equal(exhausted.status, 'completed_with_errors');
  assert.equal(exhausted.attemptedCount, 1);
  assert.equal(exhausted.unexpectedErrorCount, 1);
  assert.equal(exhausted.items[0].reasonCode, 'same_cutoff_attempt_budget_exhausted');
  assert.equal(exhausted.items[0].retryUseful, false);
  assert.equal(exhausted.items[0].wouldCallProvider, true);
  assert.equal(providerCalls, 0);
  assert.deepEqual(
    db.prepare('SELECT attempt_number, state FROM forecast_coordinator_item_attempts ORDER BY attempt_number')
      .all().map((row) => ({ ...row })),
    [
      { attempt_number: 1, state: 'interrupted' },
      { attempt_number: 2, state: 'interrupted' },
      { attempt_number: 3, state: 'interrupted' },
    ],
  );
  db.close();
});

test('expired same-run recovery resumes a page that crashed before its first item', async () => {
  const db = database();
  insertForecast(db);
  const runtime = new TestRuntime();
  const binding = d1(db);
  const forecasts = new D1ForecastRepository(binding);
  let providerCalls = 0;
  const evaluator = new ForecastEvaluationService(
    forecasts,
    new D1EvaluationRepository(binding),
    async (request) => {
      providerCalls += 1;
      return evaluationResult(request);
    },
    () => new Date(runtime.instant),
  );
  const crashing = new ForecastCoordinatorService(
    new CrashAfterPlanningRepository(binding), forecasts, evaluator, runtime,
  );
  const input = { profileId: 1, cutoff: CUTOFF, limit: 25, mode: 'execute' as const, operatorRunKey: 'crash-before-first' };
  await assert.rejects(() => crashing.coordinate(input, 1), /SimulatedProcessCrashBeforeFirstItem/);
  assert.equal(providerCalls, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forecast_coordinator_run_items WHERE state = 'pending'").get()?.count, 1);

  runtime.instant = '2026-08-24T10:02:00.000Z';
  const recovered = await new ForecastCoordinatorService(
    new D1CoordinatorRepository(binding), forecasts, evaluator, runtime,
  ).coordinate(input, 1);
  assert.equal(recovered.replayUsedExistingRun, true);
  assert.equal(recovered.status, 'completed');
  assert.equal(providerCalls, 1);
  assert.equal(recovered.items[0].classification, 'no_change');
  db.close();
});

test('recovery after a recorded first item advances without replaying it or skipping the second', async () => {
  const db = database();
  insertForecast(db, { symbol: 'ONE', evaluationDate: '2026-09-24' });
  insertForecast(db, { symbol: 'TWO', evaluationDate: '2026-09-25' });
  const runtime = new TestRuntime();
  const binding = d1(db);
  const forecasts = new D1ForecastRepository(binding);
  let providerCalls = 0;
  const evaluator = new ForecastEvaluationService(
    forecasts,
    new D1EvaluationRepository(binding),
    async (request) => {
      providerCalls += 1;
      return evaluationResult(request, 'no_change', request.forecast.forecast_id.toString(16).padStart(64, '0'));
    },
    () => new Date(runtime.instant),
  );
  const input = { profileId: 1, cutoff: CUTOFF, limit: 25, mode: 'execute' as const, operatorRunKey: 'crash-after-first' };
  await assert.rejects(() => new ForecastCoordinatorService(
    new CrashAfterFirstRecordedItemRepository(binding), forecasts, evaluator, runtime,
  ).coordinate(input, 1), /SimulatedProcessCrashAfterCoordinatorItemRecording/);
  assert.equal(providerCalls, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forecast_coordinator_run_items WHERE state = 'completed'").get()?.count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forecast_coordinator_run_items WHERE state = 'pending'").get()?.count, 1);

  runtime.instant = '2026-08-24T10:02:00.000Z';
  const recovered = await new ForecastCoordinatorService(
    new D1CoordinatorRepository(binding), forecasts, evaluator, runtime,
  ).coordinate(input, 1);
  assert.equal(recovered.status, 'completed');
  assert.equal(providerCalls, 2);
  assert.deepEqual(recovered.items.map((item) => item.classification), ['no_change', 'no_change']);
  assert.equal(recovered.attemptedCount, 2);
  db.close();
});

test('coordinator runtime DDL is idempotent and matches the complete generated migration schema', () => {
  const runtime = database();
  for (const statement of forecastInitializationStatements()) runtime.exec(statement);

  const migrated = new DatabaseSync(':memory:');
  migrated.exec('PRAGMA foreign_keys = OFF');
  for (const migrationName of [
    '0000_spotty_sugar_man.sql',
    '0001_kind_warbound.sql',
    '0002_quiet_gamora.sql',
    '0003_great_xavin.sql',
    '0004_clean_next_avengers.sql',
  ]) {
    const migration = readFileSync(new URL(`../../drizzle/${migrationName}`, import.meta.url), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) {
      migrated.exec(statement);
    }
  }

  const tables = [
    'forecast_coordinator_runs',
    'forecast_coordinator_run_items',
    'forecast_coordinator_item_attempts',
    'forecast_coordinator_claims',
  ];
  const columns = (db: DatabaseSync, table: string) => db.prepare(`PRAGMA table_info(${table})`).all();
  const indexes = (db: DatabaseSync, table: string) => db.prepare(`PRAGMA index_list(${table})`).all()
    .filter((row) => String(row.origin) !== 'pk')
    .map((row) => ({
      name: row.name,
      unique: row.unique,
      columns: db.prepare(`PRAGMA index_info(${String(row.name)})`).all().map((column) => column.name),
    })).sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const foreignKeys = (db: DatabaseSync, table: string) => db.prepare(`PRAGMA foreign_key_list(${table})`).all()
    .map((row) => ({ id: row.id, seq: row.seq, table: row.table, from: row.from, to: row.to, onDelete: row.on_delete }))
    .sort((left, right) => Number(left.id) - Number(right.id) || Number(left.seq) - Number(right.seq));

  for (const table of tables) {
    assert.deepEqual(columns(runtime, table), columns(migrated, table), `${table} columns differ`);
    assert.deepEqual(indexes(runtime, table), indexes(migrated, table), `${table} indexes differ`);
    assert.deepEqual(foreignKeys(runtime, table), foreignKeys(migrated, table), `${table} foreign keys differ`);
  }

  const assertFrozenChecks = (db: DatabaseSync, prefix: string) => {
    db.exec('PRAGMA foreign_keys = OFF');
    const insertRun = (id: string, mode: string, limit: number, status: string) => db.prepare(`INSERT INTO forecast_coordinator_runs
      (id, profile_id, coordinator_version, mode, evaluation_cutoff, batch_limit,
       scan_started_at, snapshot_max_forecast_id, request_fingerprint, status, started_at, created_at)
      VALUES (?, 1, 'forecast-coordinator-1.0.0', ?, ?, ?, ?, 0, ?, ?, ?, ?)`).run(
      id, mode, CUTOFF, limit, CUTOFF, 'a'.repeat(64), status, CUTOFF, CUTOFF,
    );
    assert.throws(() => insertRun(`${prefix}-mode`, 'future_mode', 25, 'running'), /CHECK constraint failed/);
    assert.throws(() => insertRun(`${prefix}-limit`, 'execute', 101, 'running'), /CHECK constraint failed/);
    assert.throws(() => insertRun(`${prefix}-status`, 'execute', 25, 'future_status'), /CHECK constraint failed/);
    assert.throws(() => db.prepare(`INSERT INTO forecast_coordinator_run_items
      (id, run_id, profile_id, forecast_id, ordinal, symbol, evaluation_cutoff,
       sort_evaluation_date, sort_forecast_id, due_reason, previous_status, created_at)
      VALUES (?, 'missing', 1, 1, 1, 'NVDA', ?, '2026-09-24', 1, 'future_due_reason', 'active', ?)`).run(
      `${prefix}-due`, CUTOFF, CUTOFF,
    ), /CHECK constraint failed/);
    assert.throws(() => db.prepare(`INSERT INTO forecast_coordinator_run_items
      (id, run_id, profile_id, forecast_id, ordinal, symbol, evaluation_cutoff,
       sort_evaluation_date, sort_forecast_id, due_reason, previous_status, classification, created_at)
      VALUES (?, 'missing', 1, 1, 1, 'NVDA', ?, '2026-09-24', 1, 'never_evaluated',
        'active', 'future_outcome', ?)`).run(`${prefix}-outcome`, CUTOFF, CUTOFF), /CHECK constraint failed/);
    assert.throws(() => db.prepare(`INSERT INTO forecast_coordinator_item_attempts
      (id, item_id, run_id, profile_id, attempt_number, owner_token, state, started_at, created_at)
      VALUES (?, 'missing', 'missing', 1, 1, ?, 'future_state', ?, ?)`).run(
      `${prefix}-attempt`, `${prefix}-owner`, CUTOFF, CUTOFF,
    ), /CHECK constraint failed/);
    assert.throws(() => db.prepare(`INSERT INTO forecast_coordinator_claims
      (profile_id, forecast_id, owner_run_id, owner_item_id, owner_token,
       claim_cutoff, state, acquired_at, expires_at)
      VALUES (1, 1, 'missing', 'missing', ?, ?, 'future_state', ?, ?)`).run(
      `${prefix}-claim`, CUTOFF, CUTOFF, '2026-08-24T10:01:00.000Z',
    ), /CHECK constraint failed/);
    db.exec('PRAGMA foreign_keys = ON');
  };
  assertFrozenChecks(runtime, 'runtime');
  assertFrozenChecks(migrated, 'migration');
  assert.deepEqual(runtime.prepare('PRAGMA foreign_key_check').all(), []);
  assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
  runtime.close();
  migrated.close();
});
