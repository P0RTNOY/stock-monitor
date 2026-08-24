import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { forecastEventUpgradeStatements, forecastInitializationStatements } from '../../db/forecast-initialization.ts';
import { buildEvaluationRequest, EvaluationProviderError, evaluateWithPython, normalizeEvaluationResult } from './server/evaluation/client.ts';
import { D1EvaluationRepository } from './server/evaluation/repository.ts';
import { ForecastEvaluationService } from './server/evaluation/service.ts';
import type { EvaluationKind, EvaluationRequest, EvaluationResult } from './server/evaluation/types.ts';
import { D1ForecastRepository } from './server/forecasts/repository.ts';

const NOW = '2026-08-24T10:00:00.000Z';

class SQLitePrepared {
  private bindings: Array<string | number | null> = [];
  private database: DatabaseSync;
  private sql: string;
  constructor(database: DatabaseSync, sql: string) {
    this.database = database;
    this.sql = sql;
  }
  bind(...values: Array<string | number | null>) {
    const prepared = new SQLitePrepared(this.database, this.sql);
    prepared.bindings = values;
    return prepared;
  }
  async first<T>() { return (this.database.prepare(this.sql).get(...this.bindings) ?? null) as T | null; }
  async all<T>() { return { success: true, results: this.database.prepare(this.sql).all(...this.bindings) as T[], meta: {} }; }
  async run() { return this.execute(); }
  execute() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
  }
}

class SQLiteD1 {
  private database: DatabaseSync;
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
    (1, 'Mine', 'USD', 0, '2026-01-01T00:00:00Z'),
    (2, 'Other', 'USD', 0, '2026-01-01T00:00:00Z')`);
  return db;
}

function insertActive(db: DatabaseSync, profileId = 1) {
  const result = db.prepare(`INSERT INTO forecasts
    (profile_id, symbol, direction, confidence, thesis, supporting_evidence, counter_evidence,
     setup_tag, evaluation_date, target_kind, target_price, target_lower, target_upper,
     invalidation_price, status, activated_at, market_data_as_of, activation_price,
     activation_currency, market_provider, created_at, updated_at)
    VALUES (?, 'NVDA', 'bullish', 75, 'Thesis', 'Evidence', 'Counter', 'Rectangle',
      '2026-09-24', 'price', 190, NULL, NULL, 150, 'active',
      '2026-08-24T09:58:00.000Z', '2026-08-24T09:59:00.000Z', 175, 'USD',
      'yahoo-finance', '2026-08-24T09:58:00.000Z', '2026-08-24T09:58:00.000Z')`)
    .run(profileId);
  const id = Number(result.lastInsertRowid);
  db.prepare(`INSERT INTO forecast_events
    (forecast_id, profile_id, revision, event_type, note, payload_json, created_at)
    VALUES (?, ?, 1, 'activated', '', '{}', '2026-08-24T09:58:00.000Z')`).run(id, profileId);
  return id;
}

function request(forecastId: number): EvaluationRequest {
  return {
    forecast: {
      forecast_id: forecastId,
      symbol: 'NVDA',
      direction: 'bullish',
      activated_at: '2026-08-24T09:58:00.000Z',
      activation_market_data_as_of: '2026-08-24T09:59:00.000Z',
      activation_price: 175,
      currency: 'USD',
      evaluation_date: '2026-09-24',
      target_price: 190,
      target_range: null,
      invalidation_price: 150,
      adjustment_mode: 'raw',
    },
    evaluation_cutoff: NOW,
    ruleset_version: 'forecast-evaluation-ruleset-v1',
  };
}

function result(forecastId: number, kind: EvaluationKind = 'no_change', fingerprint = 'a'.repeat(64)): EvaluationResult {
  const trigger = kind === 'target_hit' || kind === 'invalidated' || kind === 'needs_review' ? {
    symbol: 'NVDA', market_date: '2026-08-24', timestamp: '2026-08-24T13:30:00+00:00',
    completed_at: '2026-08-24T20:00:00+00:00', open: 175,
    high: kind === 'invalidated' ? 180 : 191,
    low: kind === 'target_hit' ? 160 : 149,
    close: 175,
    volume: 1000, provider: 'yahoo-finance-prototype', adjustment_mode: 'raw', corporate_action_flags: [],
  } : null;
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
    forecast_id: forecastId,
    evaluation_cutoff: '2026-08-24T10:00:00.000Z',
    evaluated_through: trigger?.market_date ?? null,
    input_fingerprint: fingerprint,
    evidence: {
      activation_cutoff: '2026-08-24T09:59:00.000Z', activation_currency: 'USD', observed_currency: 'USD',
      observation_count: trigger ? 1 : 0,
      first_eligible_observation: trigger, last_eligible_observation: trigger,
      triggering_observation: trigger, target_boundary: 190, target_range: null,
      invalidation_boundary: 150,
      detected_at: kind === 'target_hit' || kind === 'invalidated' ? 'within_bar' : null,
      observed_open: null,
      crossed_boundary: kind === 'target_hit' ? 190 : kind === 'invalidated' ? 150 : null,
      corporate_action_findings: [],
      coverage_findings: {
        calendar_id: 'XNYS', calendar_version: '4.11.2', calendar_supported: true,
        market_timezone: 'America/New_York', expected_sessions: ['2026-08-24'],
        available_expected_sessions: ['2026-08-24'], future_expected_sessions: [],
        final_expected_session: '2026-08-24', horizon_available_at: '2026-09-25T04:00:00+00:00',
        missing_available_sessions: [],
        provider_complete: true, observed_currency: 'USD',
        horizon_reviewable: kind === 'expired', coverage_complete: kind === 'expired',
        ...(trigger ? {
          observation_path_checked_through: '2026-08-24',
          observation_path_expected_sessions: ['2026-08-24'],
          observation_path_missing_sessions: [],
          observation_path_complete: true,
        } : {}),
      }, warnings: [],
    },
  };
}

test('Python evaluation adapter sends the frozen request no-store and rejects malformed responses', async () => {
  const input = request(7);
  let capturedUrl = '';
  let captured: RequestInit | undefined;
  const valid = result(7);
  const output = await evaluateWithPython(input, (async (url, init) => {
    capturedUrl = String(url);
    captured = init;
    return Response.json({ result: valid });
  }) as typeof fetch);
  assert.equal(output.input_fingerprint, 'a'.repeat(64));
  assert.match(capturedUrl, /\/v1\/evaluate$/);
  assert.equal(captured?.cache, 'no-store');
  assert.deepEqual(JSON.parse(String(captured?.body)), input);

  await assert.rejects(() => evaluateWithPython(input, (async () => Response.json({ result: { ...valid, forecast_id: 8 } })) as typeof fetch), EvaluationProviderError);
  await assert.rejects(() => evaluateWithPython(input, (async () => Response.json({ result: { ...valid, extra: true } })) as typeof fetch), /fields/);
  await assert.rejects(() => evaluateWithPython(input, (async () => new Response('nope', { status: 503 })) as typeof fetch), /could not evaluate/);
  await assert.rejects(() => evaluateWithPython(input, (async () => new Response('{}', {
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(600 * 1024) },
  })) as typeof fetch), /too large/);
  assert.throws(() => normalizeEvaluationResult({ ...valid, input_fingerprint: 'unsafe' }, input), /does not match/);
  assert.throws(() => normalizeEvaluationResult({ ...valid, evaluator_version: 'future-untrusted' }, input), /does not match/);
  assert.throws(() => normalizeEvaluationResult({ ...valid, reason_code: 'target_boundary_touched' }, input), /reason/);
  assert.throws(() => normalizeEvaluationResult({
    ...valid, evidence: { ...valid.evidence, target_boundary: 999 },
  }, input), /saved forecast terms/);
  assert.throws(() => normalizeEvaluationResult({
    ...valid, evidence: { ...valid.evidence, observed_currency: 'EUR' },
  }, input), /currency evidence/);
  const terminal = result(7, 'target_hit');
  assert.throws(() => normalizeEvaluationResult({
    ...terminal, evidence: { ...terminal.evidence, triggering_observation: null },
  }, input), /incomplete/);
  const expired = result(7, 'expired');
  assert.throws(() => normalizeEvaluationResult({
    ...expired,
    evidence: { ...expired.evidence, coverage_findings: { ...expired.evidence.coverage_findings, coverage_complete: false } },
  }, input), /complete coverage/);
  const mismatch = result(7, 'needs_review');
  mismatch.reason_code = 'currency_mismatch';
  mismatch.evidence.triggering_observation = null;
  mismatch.evidence.observed_currency = 'EUR';
  mismatch.evidence.coverage_findings.observed_currency = 'EUR';
  assert.equal(normalizeEvaluationResult(mismatch, input).reason_code, 'currency_mismatch');
  const unverified = structuredClone(mismatch);
  unverified.reason_code = 'currency_unverified';
  unverified.evidence.observed_currency = null;
  unverified.evidence.coverage_findings.observed_currency = null;
  assert.equal(normalizeEvaluationResult(unverified, input).reason_code, 'currency_unverified');
});

test('request builder contains only immutable activated terms owned by the server', () => {
  const built = buildEvaluationRequest({
    id: 7, symbol: 'NVDA', direction: 'bullish', activatedAt: '2026-08-24T09:58:00.000Z',
    marketDataAsOf: '2026-08-24T09:59:00.000Z', activationPrice: 175, activationCurrency: 'USD',
    evaluationDate: '2026-09-24', target: { kind: 'price', price: 190 }, invalidationPrice: 150,
  }, NOW);
  assert.deepEqual(built, request(7));
});

test('strict normalization accepts an early target with more than 500 future horizon sessions', () => {
  const sessions = Array.from({ length: 620 }, (_, offset) => (
    new Date(Date.UTC(2026, 7, 24 + offset)).toISOString().slice(0, 10)
  ));
  const input = request(7);
  input.forecast.evaluation_date = sessions.at(-1) as string;
  const terminal = result(7, 'target_hit');
  terminal.evidence.coverage_findings = {
    ...terminal.evidence.coverage_findings,
    expected_sessions: sessions,
    available_expected_sessions: [sessions[0]],
    future_expected_sessions: sessions.slice(1),
    final_expected_session: sessions.at(-1),
    horizon_available_at: `${sessions.at(-1)}T04:00:00+00:00`,
    missing_available_sessions: [],
    horizon_reviewable: false,
    coverage_complete: false,
    observation_path_checked_through: sessions[0],
    observation_path_expected_sessions: [sessions[0]],
    observation_path_missing_sessions: [],
    observation_path_complete: true,
  };

  const normalized = normalizeEvaluationResult(terminal, input);
  assert.equal(normalized.kind, 'target_hit');
  assert.equal((normalized.evidence.coverage_findings.expected_sessions as string[]).length, 620);
  assert.equal((normalized.evidence.coverage_findings.future_expected_sessions as string[]).length, 619);
});

test('no-change is append-only and idempotent without lifecycle or review mutations', async () => {
  const db = database();
  const id = insertActive(db);
  const repository = new D1EvaluationRepository(new SQLiteD1(db) as unknown as D1Database);
  const first = await repository.persist(1, id, '2026-08-24T09:58:00.000Z', 1, result(id), NOW);
  const repeated = await repository.persist(1, id, '2026-08-24T09:58:00.000Z', 1, result(id), NOW);
  const laterCutoff = { ...result(id), evaluation_cutoff: '2026-08-24T11:00:00.000Z' };
  const repeatedLater = await repository.persist(1, id, '2026-08-24T09:58:00.000Z', 1, laterCutoff, NOW);
  assert.equal(first?.duplicate, false);
  assert.equal(repeated?.duplicate, true);
  assert.equal(repeatedLater?.duplicate, true);
  assert.equal(repeatedLater?.run.evaluationCutoff, NOW);
  await assert.rejects(() => repository.persist(1, id, '2026-08-24T09:58:00.000Z', 1, {
    ...result(id), kind: 'needs_review', reason_code: 'conflicting_result',
  }, NOW), /FingerprintConflict/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evaluation_runs').get()?.count, 1);
  assert.equal(db.prepare('SELECT status FROM forecasts WHERE id = ?').get(id)?.status, 'active');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM forecast_review_items').get()?.count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forecast_events WHERE event_type = 'evaluated'").get()?.count, 0);
  assert.equal((await repository.latestRun(1, id))?.resultKind, 'no_change');
  assert.equal(await repository.latestRun(2, id), null);
  db.close();
});

test('latest evaluation lookup is profile-scoped and returns the newest durable run', async () => {
  const db = database();
  const id = insertActive(db);
  const d1 = new SQLiteD1(db) as unknown as D1Database;
  const forecasts = new D1ForecastRepository(d1);
  const evaluations = new D1EvaluationRepository(d1);
  const service = new ForecastEvaluationService(forecasts, evaluations, async () => result(id), () => new Date(NOW));
  assert.equal(await service.latestEvaluation(1, id), null);
  await assert.rejects(() => service.latestEvaluation(2, id), /not found/);
  await service.evaluate(1, id, {});
  assert.equal((await service.latestEvaluation(1, id))?.resultKind, 'no_change');
  db.prepare(`INSERT INTO evaluation_runs
    (profile_id, forecast_id, result_kind, reason_code, explanation, evaluator_version,
     ruleset_version, evaluated_through, evaluation_cutoff, evidence_json, warnings_json,
     input_fingerprint, created_at)
    SELECT profile_id, forecast_id, result_kind, 'newer_reason', 'Newer durable evaluation.', evaluator_version,
     ruleset_version, evaluated_through, '2026-08-25T10:00:00.000Z', evidence_json, warnings_json,
     ?, '2026-08-25T10:00:00.000Z' FROM evaluation_runs WHERE forecast_id = ?`)
    .run('b'.repeat(64), id);
  assert.equal((await service.latestEvaluation(1, id))?.reasonCode, 'newer_reason');
  db.close();
});

test('needs-review preserves active state and acknowledgement appends an audit event', async () => {
  const db = database();
  const id = insertActive(db);
  const repository = new D1EvaluationRepository(new SQLiteD1(db) as unknown as D1Database);
  await repository.persist(1, id, '2026-08-24T09:58:00.000Z', 1, result(id, 'needs_review'), NOW);
  assert.equal(db.prepare('SELECT status FROM forecasts WHERE id = ?').get(id)?.status, 'active');
  const reviews = await repository.listReviews(1, false);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].reviewKind, 'needs_review');
  assert.equal((await repository.listReviews(2, true)).length, 0);
  assert.equal(await repository.acknowledgeReview(2, reviews[0].id, NOW), false);
  assert.equal(await repository.acknowledgeReview(1, reviews[0].id, NOW), true);
  assert.equal(await repository.acknowledgeReview(1, reviews[0].id, NOW), false);
  assert.equal((await repository.getReview(1, reviews[0].id))?.acknowledgedAt, NOW);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forecast_events WHERE event_type = 'evaluation_review_acknowledged'").get()?.count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evaluation_runs').get()?.count, 1);
  db.close();
});

test('proven terminal result atomically writes run, transition, one event, and review item', async () => {
  for (const kind of ['target_hit', 'invalidated', 'expired'] as const) {
    const db = database();
    const id = insertActive(db);
    const repository = new D1EvaluationRepository(new SQLiteD1(db) as unknown as D1Database);
    const saved = await repository.persist(1, id, '2026-08-24T09:58:00.000Z', 1, result(id, kind), NOW);
    assert.equal(saved?.run.resultKind, kind);
    assert.equal(db.prepare('SELECT status FROM forecasts WHERE id = ?').get(id)?.status, kind);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evaluation_runs').get()?.count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forecast_events WHERE event_type = 'evaluated'").get()?.count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM forecast_review_items').get()?.count, 1);
    const duplicate = await repository.persist(1, id, NOW, 2, result(id, kind), NOW);
    assert.equal(duplicate?.duplicate, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forecast_events WHERE event_type = 'evaluated'").get()?.count, 1);
    db.close();
  }
});

test('service rejects unknown bodies, cross-profile access, stale revisions, and provider failure safely', async () => {
  const db = database();
  const id = insertActive(db);
  const d1 = new SQLiteD1(db) as unknown as D1Database;
  const forecasts = new D1ForecastRepository(d1);
  const evaluations = new D1EvaluationRepository(d1);
  let providerCalls = 0;
  const service = new ForecastEvaluationService(forecasts, evaluations, async () => {
    providerCalls += 1;
    return result(id);
  }, () => new Date(NOW));
  await assert.rejects(() => service.evaluate(1, id, { symbol: 'AAPL' }), /empty JSON object/);
  await assert.rejects(() => service.evaluate(2, id, {}), /not found/);
  assert.equal(providerCalls, 0);

  const staleService = new ForecastEvaluationService(forecasts, evaluations, async () => {
    await forecasts.addNote(1, id, 'review_note', 'Concurrent note.', NOW);
    return result(id);
  }, () => new Date(NOW));
  await assert.rejects(() => staleService.evaluate(1, id, {}), /changed while/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evaluation_runs').get()?.count, 0);

  const unavailable = new ForecastEvaluationService(forecasts, evaluations, async () => {
    throw new EvaluationProviderError('private upstream detail');
  }, () => new Date(NOW));
  await assert.rejects(() => unavailable.evaluate(1, id, {}), (error: unknown) => (
    error instanceof Error && error.message === 'Forecast evaluation is temporarily unavailable.'
  ));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM evaluation_runs').get()?.count, 0);
  db.close();
});

test('concurrent duplicate and conflicting terminal evaluations cannot create extra or orphan writes', async () => {
  const duplicateDb = database();
  const duplicateId = insertActive(duplicateDb);
  const duplicateD1 = new SQLiteD1(duplicateDb) as unknown as D1Database;
  const duplicateForecasts = new D1ForecastRepository(duplicateD1);
  const duplicateEvaluations = new D1EvaluationRepository(duplicateD1);
  let duplicateCalls = 0;
  let releaseDuplicate!: () => void;
  const duplicateGate = new Promise<void>((resolve) => { releaseDuplicate = resolve; });
  const duplicateService = new ForecastEvaluationService(duplicateForecasts, duplicateEvaluations, async () => {
    duplicateCalls += 1;
    if (duplicateCalls === 2) releaseDuplicate();
    await duplicateGate;
    return result(duplicateId, 'target_hit');
  }, () => new Date(NOW));
  const duplicates = await Promise.all([
    duplicateService.evaluate(1, duplicateId, {}),
    duplicateService.evaluate(1, duplicateId, {}),
  ]);
  assert.deepEqual(duplicates.map((value) => value.duplicate).sort(), [false, true]);
  assert.equal(duplicateDb.prepare('SELECT COUNT(*) AS count FROM evaluation_runs').get()?.count, 1);
  assert.equal(duplicateDb.prepare("SELECT COUNT(*) AS count FROM forecast_events WHERE event_type = 'evaluated'").get()?.count, 1);
  assert.equal(duplicateDb.prepare('SELECT COUNT(*) AS count FROM forecast_review_items').get()?.count, 1);
  duplicateDb.close();

  const conflictDb = database();
  const conflictId = insertActive(conflictDb);
  const conflictD1 = new SQLiteD1(conflictDb) as unknown as D1Database;
  const conflictForecasts = new D1ForecastRepository(conflictD1);
  const conflictEvaluations = new D1EvaluationRepository(conflictD1);
  let conflictCalls = 0;
  let releaseConflict!: () => void;
  const conflictGate = new Promise<void>((resolve) => { releaseConflict = resolve; });
  const conflictService = new ForecastEvaluationService(conflictForecasts, conflictEvaluations, async () => {
    conflictCalls += 1;
    const call = conflictCalls;
    if (call === 2) releaseConflict();
    await conflictGate;
    return result(conflictId, call === 1 ? 'target_hit' : 'invalidated', call === 1 ? 'a'.repeat(64) : 'b'.repeat(64));
  }, () => new Date(NOW));
  const conflicts = await Promise.allSettled([
    conflictService.evaluate(1, conflictId, {}),
    conflictService.evaluate(1, conflictId, {}),
  ]);
  assert.equal(conflicts.filter((value) => value.status === 'fulfilled').length, 1);
  assert.equal(conflicts.filter((value) => value.status === 'rejected').length, 1);
  assert.equal(conflictDb.prepare('SELECT COUNT(*) AS count FROM evaluation_runs').get()?.count, 1);
  assert.equal(conflictDb.prepare("SELECT COUNT(*) AS count FROM forecast_events WHERE event_type = 'evaluated'").get()?.count, 1);
  assert.equal(conflictDb.prepare('SELECT COUNT(*) AS count FROM forecast_review_items').get()?.count, 1);
  conflictDb.close();
});

test('runtime DDL and generated migration agree for Phase 2A tables and are idempotent', () => {
  const runtime = database();
  for (const statement of forecastInitializationStatements()) runtime.exec(statement);
  const migrated = new DatabaseSync(':memory:');
  migrated.exec('PRAGMA foreign_keys = OFF');
  migrated.exec(`CREATE TABLE investment_profiles (id INTEGER PRIMARY KEY); CREATE TABLE forecasts (id INTEGER PRIMARY KEY);`);
  const migration = readFileSync(new URL('../../drizzle/0003_great_xavin.sql', import.meta.url), 'utf8');
  const relevant = migration.split('--> statement-breakpoint').map((value) => value.trim()).filter((value) => (
    value.includes('evaluation_runs') || value.includes('forecast_review_items')
  ));
  for (const statement of relevant) {
    if (statement.startsWith('CREATE TABLE') || statement.startsWith('CREATE INDEX') || statement.startsWith('CREATE UNIQUE INDEX')) migrated.exec(statement);
  }
  const columns = (db: DatabaseSync, table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  for (const table of ['evaluation_runs', 'forecast_review_items']) {
    assert.deepEqual(columns(runtime, table), columns(migrated, table));
  }
  runtime.close();
  migrated.close();
});

test('runtime event-table upgrade preserves legacy audit rows and admits Phase 2A event types', async () => {
  const db = database();
  db.exec('DROP TABLE forecast_events');
  db.exec(`CREATE TABLE forecast_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, forecast_id INTEGER NOT NULL, profile_id INTEGER NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    event_type TEXT NOT NULL CHECK (event_type IN ('draft_created', 'draft_updated', 'activated', 'cancelled', 'amendment', 'review_note')),
    note TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  db.exec('CREATE UNIQUE INDEX idx_forecast_events_revision ON forecast_events(forecast_id, revision)');
  db.exec('CREATE INDEX idx_forecast_events_profile_forecast ON forecast_events(profile_id, forecast_id, created_at)');
  const id = insertActive(db);
  const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'forecast_events'").get()?.sql);
  assert.doesNotMatch(sql, /evaluation_review_acknowledged/);
  const d1 = new SQLiteD1(db);
  await d1.batch(forecastEventUpgradeStatements().map((statement) => d1.prepare(statement)));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM forecast_events WHERE forecast_id = ?').get(id)?.count, 1);
  db.prepare(`INSERT INTO forecast_events
    (forecast_id, profile_id, revision, event_type, note, payload_json, created_at)
    VALUES (?, 1, 2, 'evaluated', '', '{}', ?)`).run(id, NOW);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM forecast_events WHERE event_type = 'evaluated'").get()?.count, 1);
  const upgradedSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'forecast_events'").get()?.sql);
  assert.match(upgradedSql, /evaluation_review_acknowledged/);
  db.close();
});
