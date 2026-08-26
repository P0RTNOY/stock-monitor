import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { forecastInitializationStatements } from '../../db/forecast-initialization.ts';
import { forecastErrorContract } from './server/forecasts/error-contract.ts';
import { sanitizedForecastDiagnostic } from './server/forecasts/diagnostics.ts';
import { D1ForecastRepository, type ForecastRepository } from './server/forecasts/repository.ts';
import { ForecastService, ForecastServiceError } from './server/forecasts/service.ts';
import type {
  Forecast,
  ForecastDraftInput,
  ForecastFilters,
  ForecastNoteKind,
  NormalizedAnalysisSnapshot,
  QuoteSnapshot,
} from './server/forecasts/types.ts';
import { ForecastValidationError, normalizeAnalysisSnapshot, normalizeDraftInput } from './server/forecasts/validation.ts';
import { fetchYahooQuote } from './server/yahoo.ts';

const NOW = new Date('2026-08-24T10:00:00.000Z');

function draft(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'NVDA',
    direction: 'bullish',
    confidence: 70,
    thesis: 'A measurable thesis.',
    supportingEvidence: 'Completed-bar structure and improving demand.',
    counterEvidence: 'A failed breakout would contradict the thesis.',
    setupTag: 'Rectangle',
    evaluationDate: '2026-09-24',
    target: { kind: 'price', price: 190 },
    invalidationPrice: 150,
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'NVDA',
    status: 'scenario_detected',
    generated_at: '2026-08-24T09:00:00Z',
    as_of: '2026-08-24T08:59:00Z',
    engine_version: '0.2.0',
    ruleset_version: 'ruleset-v1',
    provider: 'yahoo-finance-prototype',
    adjustment_mode: 'raw',
    data_hash: 'a'.repeat(64),
    summary: 'A descriptive rectangle scenario.',
    timeframes: { '1d': { last_bar: '2026-08-23T20:00:00Z' } },
    evidence: [{
      rule_id: 'setup.rectangle.geometry.1d',
      category: 'setup',
      status: 'passed',
      explanation: 'Frozen range geometry passed.',
    }],
    warnings: [],
    scenarios: [{
      scenario_id: 'rectangle-1',
      setup: 'rectangle',
      timeframe: '1d',
      direction: 'bullish',
      lifecycle_state: 'candidate',
      range_lower: 150,
      range_upper: 170,
      range_height: 20,
      measured_target: 190,
      evidence_ids: ['setup.rectangle.geometry.1d'],
      warnings: [],
    }],
    ...overrides,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class FakeRepository implements ForecastRepository {
  private nextId = 1;
  private records = new Map<string, Forecast>();
  private seeds = new Map<string, { report: unknown; scenarioId: string }>();
  readonly tracked = new Map<number, Set<string>>([[1, new Set(['NVDA', 'AAPL'])], [2, new Set(['MSFT'])]]);
  readonly currencies = new Map([[1, 'USD'], [2, 'USD']]);

  private key(profileId: number, id: number) { return `${profileId}:${id}`; }

  async isTrackedSymbol(profileId: number, symbol: string) { return this.tracked.get(profileId)?.has(symbol) ?? false; }
  async profileCurrency(profileId: number) { return this.currencies.get(profileId) ?? null; }
  async list(profileId: number, filters: ForecastFilters) {
    return [...this.records.values()].filter((value) => value.profileId === profileId
      && (!filters.status || value.status === filters.status)
      && (!filters.symbol || value.symbol === filters.symbol)).map(clone);
  }
  async get(profileId: number, id: number) { return clone(this.records.get(this.key(profileId, id)) ?? null); }
  async getAnalysisSeed(profileId: number, id: number) { return clone(this.seeds.get(this.key(profileId, id)) ?? null); }
  async create(profileId: number, input: ForecastDraftInput, seed: NormalizedAnalysisSnapshot | null, now: string) {
    const id = this.nextId++;
    const value: Forecast = {
      ...clone(input), id, profileId, status: 'draft', activatedAt: null, marketDataAsOf: null,
      activationPrice: null, activationCurrency: null, marketProvider: null, resolvedAt: null,
      resolutionReason: null, pendingAnalysis: seed ? {
        scenarioId: seed.scenarioId, generatedAt: seed.generatedAt, provider: seed.provider,
        lifecycleState: seed.lifecycleState, direction: seed.direction,
      } : null,
      createdAt: now, updatedAt: now,
      events: [{ id: 1, revision: 1, eventType: 'draft_created', note: '', payload: {}, createdAt: now }],
      analysisSnapshot: null,
    };
    this.records.set(this.key(profileId, id), value);
    if (seed) this.seeds.set(this.key(profileId, id), { report: clone(seed.report), scenarioId: seed.scenarioId });
    return id;
  }
  async updateDraft(profileId: number, id: number, input: ForecastDraftInput, seed: NormalizedAnalysisSnapshot | null | undefined, now: string) {
    const key = this.key(profileId, id);
    const value = this.records.get(key);
    if (!value || value.status !== 'draft') return false;
    Object.assign(value, clone(input), { updatedAt: now });
    value.events.push({ id: value.events.length + 1, revision: value.events.length + 1, eventType: 'draft_updated', note: '', payload: {}, createdAt: now });
    if (seed === null) {
      this.seeds.delete(key);
      value.pendingAnalysis = null;
    } else if (seed) {
      this.seeds.set(key, { report: clone(seed.report), scenarioId: seed.scenarioId });
    }
    return true;
  }
  async deleteDraft(profileId: number, id: number) {
    const key = this.key(profileId, id);
    if (this.records.get(key)?.status !== 'draft') return false;
    this.seeds.delete(key);
    return this.records.delete(key);
  }
  async activate(profileId: number, id: number, expectedUpdatedAt: string, expectedRevision: number, quote: QuoteSnapshot, snapshot: NormalizedAnalysisSnapshot | null, now: string) {
    const key = this.key(profileId, id);
    const value = this.records.get(key);
    if (!value || value.status !== 'draft' || value.updatedAt !== expectedUpdatedAt
      || value.events.at(-1)?.revision !== expectedRevision
      || !await this.isTrackedSymbol(profileId, value.symbol)) return false;
    Object.assign(value, {
      status: 'active', activatedAt: now, marketDataAsOf: quote.providerAsOf,
      activationPrice: quote.price, activationCurrency: quote.currency, marketProvider: quote.provider,
      updatedAt: now, pendingAnalysis: null,
      analysisSnapshot: snapshot ? { ...clone(snapshot), id: 1, createdAt: now } : null,
    });
    value.events.push({ id: value.events.length + 1, revision: value.events.length + 1, eventType: 'activated', note: '', payload: { quote }, createdAt: now });
    this.seeds.delete(key);
    return true;
  }
  async cancel(profileId: number, id: number, reason: string, now: string) {
    const value = this.records.get(this.key(profileId, id));
    if (!value || value.status !== 'active') return false;
    Object.assign(value, { status: 'cancelled', resolvedAt: now, resolutionReason: reason, updatedAt: now });
    value.events.push({ id: value.events.length + 1, revision: value.events.length + 1, eventType: 'cancelled', note: reason, payload: { reason }, createdAt: now });
    return true;
  }
  async addNote(profileId: number, id: number, kind: ForecastNoteKind, note: string, now: string) {
    const value = this.records.get(this.key(profileId, id));
    if (!value || value.status === 'draft') return false;
    value.events.push({ id: value.events.length + 1, revision: value.events.length + 1, eventType: kind, note, payload: { note }, createdAt: now });
    return true;
  }
}

function service(repository = new FakeRepository(), quoteTime = '2026-08-24T09:59:00Z') {
  return {
    repository,
    service: new ForecastService(repository, async () => ({
      price: 175, currency: 'USD', providerAsOf: quoteTime, provider: 'yahoo-finance',
    }), () => NOW),
  };
}

test('forecast validation rejects malformed, contradictory, and neutral single-price drafts', () => {
  assert.throws(() => normalizeDraftInput(draft({ confidence: 70.5 })), ForecastValidationError);
  assert.throws(() => normalizeDraftInput(draft({ invalidationPrice: 195 })), /Invalidation/);
  assert.throws(() => normalizeDraftInput(draft({ direction: 'neutral' })), /target range/);
  assert.doesNotThrow(() => normalizeDraftInput(draft({
    direction: 'neutral', target: { kind: 'range', lower: 160, upper: 180 }, invalidationPrice: 150,
  })));
  assert.throws(() => normalizeDraftInput(draft({ evaluationDate: '2026-02-31' })), /calendar/);
});

test('analysis snapshots validate evidence, timestamps, range geometry, and measured target direction', () => {
  const timeframeSpecific = normalizeAnalysisSnapshot(report({
    timeframes: {
      '1d': { last_bar: '2026-08-22T20:00:00Z' },
      '1wk': { last_bar: '2026-08-23T20:00:00Z' },
    },
  }), 'rectangle-1', 'NVDA', 'bullish');
  assert.equal(timeframeSpecific.completedBarAsOf, '2026-08-22T20:00:00Z');
  assert.throws(() => normalizeAnalysisSnapshot(report({ timeframes: {} }), 'rectangle-1', 'NVDA', 'bullish'), /timeframe is missing/);
  const badEvidence = report({ evidence: [{ rule_id: 'x', category: 'setup', status: 'maybe', explanation: 'bad' }] });
  assert.throws(() => normalizeAnalysisSnapshot(badEvidence, 'rectangle-1', 'NVDA', 'bullish'), /status/);
  const badDate = report({ generated_at: '2026-02-31T09:00:00Z' });
  assert.throws(() => normalizeAnalysisSnapshot(badDate, 'rectangle-1', 'NVDA', 'bullish'), /generated_at/);
  const badGeometry = report({ scenarios: [{ ...report().scenarios[0], range_height: 19 }] });
  assert.throws(() => normalizeAnalysisSnapshot(badGeometry, 'rectangle-1', 'NVDA', 'bullish'), /geometry/);
  const badTarget = report({ scenarios: [{ ...report().scenarios[0], measured_target: 165 }] });
  assert.throws(() => normalizeAnalysisSnapshot(badTarget, 'rectangle-1', 'NVDA', 'bullish'), /measured target/);
});

test('draft lifecycle persists a seed, captures a verified quote and immutable snapshot, then appends notes', async () => {
  const { repository, service: forecasts } = service();
  const sourceReport = report();
  const created = await forecasts.createDraft(1, {
    ...draft(), analysisSeed: { report: sourceReport, scenarioId: 'rectangle-1' },
  });
  assert.equal(created.status, 'draft');
  assert.equal(created.pendingAnalysis?.scenarioId, 'rectangle-1');
  const updated = await forecasts.updateDraft(1, created.id, { ...draft(), confidence: 75 });
  assert.equal(updated.confidence, 75);
  assert.equal(updated.events.at(-1)?.eventType, 'draft_updated');
  sourceReport.summary = 'client mutation after persistence';

  const active = await forecasts.activate(1, created.id, {});
  assert.equal(active.status, 'active');
  assert.equal(active.activationPrice, 175);
  assert.equal(active.marketDataAsOf, '2026-08-24T09:59:00Z');
  assert.equal(active.pendingAnalysis, null);
  assert.equal((active.analysisSnapshot?.report as ReturnType<typeof report>).summary, 'A descriptive rectangle scenario.');
  await assert.rejects(() => forecasts.updateDraft(1, created.id, { ...draft(), confidence: 50 }), /cannot be edited/);
  const noted = await forecasts.addNote(1, created.id, { kind: 'amendment', note: 'Review after earnings.' });
  assert.equal(noted.analysisSnapshot?.dataHash, 'a'.repeat(64));
  assert.equal(noted.events.at(-1)?.eventType, 'amendment');
  const cancelled = await forecasts.cancel(1, created.id, { reason: 'The original review is no longer relevant.' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.resolutionReason, 'The original review is no longer relevant.');
  assert.equal((await repository.get(1, created.id))?.analysisSnapshot?.dataHash, 'a'.repeat(64));
});

test('ownership, tracked-symbol, deletion, illegal transitions, horizon, and quote freshness are enforced', async () => {
  const first = service();
  await assert.rejects(() => first.service.createDraft(1, draft({ symbol: 'MSFT' })), /position or watchlist/);
  const created = await first.service.createDraft(1, draft());
  await assert.rejects(() => first.service.get(2, created.id), (error: unknown) => error instanceof ForecastServiceError && error.status === 404);
  await assert.rejects(() => first.service.cancel(1, created.id, { reason: 'No.' }), /Only active/);
  await first.service.deleteDraft(1, created.id);
  await assert.rejects(() => first.service.get(1, created.id), /not found/);

  const stale = service(new FakeRepository(), '2026-08-01T10:00:00Z');
  const staleDraft = await stale.service.createDraft(1, draft());
  await assert.rejects(() => stale.service.activate(1, staleDraft.id, {}), /too stale/);

  const past = service();
  const pastDraft = await past.service.createDraft(1, draft({ evaluationDate: '2026-08-23' }));
  await assert.rejects(() => past.service.activate(1, pastDraft.id, {}), /earlier than/);
});

test('activation calendar date honors a validated client time zone at the UTC boundary', async () => {
  const boundary = new Date('2026-08-25T00:30:00Z');
  const localRepository = new FakeRepository();
  const localService = new ForecastService(localRepository, async () => ({
    price: 175, currency: 'USD', provider: 'yahoo-finance', providerAsOf: '2026-08-25T00:29:00Z',
  }), () => boundary);
  const localDraft = await localService.createDraft(1, draft({ evaluationDate: '2026-08-24' }));
  assert.equal((await localService.activate(1, localDraft.id, { timeZone: 'America/Los_Angeles' })).status, 'active');

  const utcRepository = new FakeRepository();
  const utcService = new ForecastService(utcRepository, async () => ({
    price: 175, currency: 'USD', provider: 'yahoo-finance', providerAsOf: '2026-08-25T00:29:00Z',
  }), () => boundary);
  const utcDraft = await utcService.createDraft(1, draft({ evaluationDate: '2026-08-24' }));
  await assert.rejects(() => utcService.activate(1, utcDraft.id, {}), /earlier than/);
  await assert.rejects(() => utcService.activate(1, utcDraft.id, { timeZone: 'Mars/Olympus' }), /time zone/);
});

test('safe API error contract preserves actionable fields and hides unknown failures', () => {
  const validation = forecastErrorContract(new ForecastServiceError('Bad target.', 'validation_error', 400, { target: 'Fix target.' }));
  assert.deepEqual(validation, {
    status: 400,
    body: { error: 'Bad target.', code: 'validation_error', fieldErrors: { target: 'Fix target.' } },
    report: false,
  });
  const internal = forecastErrorContract(new Error('provider secret details'));
  assert.deepEqual(internal.body, { error: 'The forecast request could not be completed.', code: 'internal_error' });
  assert.equal(JSON.stringify(internal).includes('secret'), false);
  const diagnostic = sanitizedForecastDiagnostic(new Error('Bearer abc123 at https://provider.test/path?api_key=secret sk-proj-example'));
  assert.equal(JSON.stringify(diagnostic).includes('abc123'), false);
  assert.equal(JSON.stringify(diagnostic).includes('provider.test'), false);
  assert.equal(JSON.stringify(diagnostic).includes('sk-proj-example'), false);
  assert.equal(JSON.stringify(sanitizedForecastDiagnostic(new Error('plain private-provider-detail'))).includes('private'), false);
});

function createProfileTable(database: DatabaseSync) {
  database.exec(`CREATE TABLE investment_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, base_currency TEXT NOT NULL,
    cash_balance REAL NOT NULL, created_at TEXT NOT NULL
  )`);
}

function columns(database: DatabaseSync, table: string) {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)).sort();
}

test('runtime forecast initialization is idempotent and matches the generated migration columns', () => {
  const runtime = new DatabaseSync(':memory:');
  runtime.exec('PRAGMA foreign_keys = ON');
  createProfileTable(runtime);
  for (let pass = 0; pass < 2; pass += 1) {
    for (const statement of forecastInitializationStatements()) runtime.exec(statement);
  }

  const migrated = new DatabaseSync(':memory:');
  migrated.exec('PRAGMA foreign_keys = ON');
  createProfileTable(migrated);
  const migration = readFileSync(new URL('../../drizzle/0002_quiet_gamora.sql', import.meta.url), 'utf8');
  for (const statement of migration.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) {
    migrated.exec(statement);
  }

  for (const table of ['forecasts', 'forecast_events', 'analysis_snapshots']) {
    assert.deepEqual(columns(runtime, table), columns(migrated, table), `${table} runtime and migration columns differ`);
  }
  assert.ok(columns(runtime, 'forecasts').includes('analysis_seed_json'));
  assert.ok(columns(runtime, 'analysis_snapshots').includes('report_json'));
  runtime.close();
  migrated.close();
});

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

  async first<T>() {
    return (this.database.prepare(this.sql).get(...this.bindings) ?? null) as T | null;
  }

  async all<T>() {
    return { success: true, results: this.database.prepare(this.sql).all(...this.bindings) as T[], meta: {} };
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
  private database: DatabaseSync;

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

test('D1 repository SQL atomically records one activation event and one immutable snapshot', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  createProfileTable(database);
  database.exec(`CREATE TABLE positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, symbol TEXT NOT NULL,
    company_name TEXT NOT NULL, shares REAL NOT NULL, average_cost REAL NOT NULL, created_at TEXT NOT NULL
  )`);
  database.exec(`CREATE TABLE watchlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, symbol TEXT NOT NULL,
    company_name TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  for (const statement of forecastInitializationStatements()) database.exec(statement);
  database.exec(`INSERT INTO investment_profiles VALUES (1, 'Mine', 'USD', 0, '2026-01-01T00:00:00Z')`);
  database.exec(`INSERT INTO positions (profile_id, symbol, company_name, shares, average_cost, created_at)
    VALUES (1, 'NVDA', 'NVIDIA', 1, 100, '2026-01-01T00:00:00Z')`);
  const repository = new D1ForecastRepository(new SQLiteD1(database) as unknown as D1Database);
  const forecasts = new ForecastService(repository, async () => ({
    price: 175, currency: 'USD', provider: 'yahoo-finance', providerAsOf: '2026-08-24T09:59:00Z',
  }), () => NOW);
  const created = await forecasts.createDraft(1, {
    ...draft(), analysisSeed: { report: report(), scenarioId: 'rectangle-1' },
  });
  const active = await forecasts.activate(1, created.id, {});
  assert.equal(active.events.filter((event) => event.eventType === 'activated').length, 1);
  assert.equal(active.analysisSnapshot?.scenarioId, 'rectangle-1');
  const duplicate = await repository.activate(1, created.id, active.updatedAt, active.events.at(-1)?.revision ?? 0, {
    price: 176, currency: 'USD', provider: 'yahoo-finance', providerAsOf: '2026-08-24T09:59:00Z',
  }, null, NOW.toISOString());
  assert.equal(duplicate, false);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM forecast_events WHERE event_type = 'activated'`).get()?.count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM analysis_snapshots').get()?.count, 1);
  assert.equal(database.prepare('SELECT analysis_seed_json FROM forecasts WHERE id = ?').get(created.id)?.analysis_seed_json, null);

  const racingDraft = await forecasts.createDraft(1, draft());
  const racingService = new ForecastService(repository, async () => {
    await repository.updateDraft(1, racingDraft.id, normalizeDraftInput(draft({ confidence: 88 })), undefined, racingDraft.updatedAt);
    return { price: 175, currency: 'USD', provider: 'yahoo-finance', providerAsOf: '2026-08-24T09:59:00Z' };
  }, () => new Date('2026-08-24T10:00:02.000Z'));
  await assert.rejects(() => racingService.activate(1, racingDraft.id, {}), /changed before activation/);
  const afterRace = await repository.get(1, racingDraft.id);
  assert.equal(afterRace?.status, 'draft');
  assert.equal(afterRace?.confidence, 88);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM forecast_events WHERE forecast_id = ? AND event_type = 'activated'`).get(racingDraft.id)?.count, 0);

  const untrackedDraft = await forecasts.createDraft(1, draft());
  const untrackingService = new ForecastService(repository, async () => {
    database.prepare(`DELETE FROM positions WHERE profile_id = 1 AND symbol = 'NVDA'`).run();
    return { price: 175, currency: 'USD', provider: 'yahoo-finance', providerAsOf: '2026-08-24T09:59:00Z' };
  }, () => NOW);
  await assert.rejects(() => untrackingService.activate(1, untrackedDraft.id, {}), /changed before activation/);
  assert.equal((await repository.get(1, untrackedDraft.id))?.status, 'draft');
  database.close();
});

test('D1 forecast operations isolate a foreign profile without mutating rows, events, or snapshots', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  createProfileTable(database);
  database.exec(`CREATE TABLE positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, symbol TEXT NOT NULL,
    company_name TEXT NOT NULL, shares REAL NOT NULL, average_cost REAL NOT NULL, created_at TEXT NOT NULL
  )`);
  database.exec(`CREATE TABLE watchlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, symbol TEXT NOT NULL,
    company_name TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  for (const statement of forecastInitializationStatements()) database.exec(statement);
  database.exec(`INSERT INTO investment_profiles VALUES
    (1, 'Owner', 'USD', 0, '2026-01-01T00:00:00Z'),
    (2, 'Foreign', 'USD', 0, '2026-01-01T00:00:00Z')`);
  database.exec(`INSERT INTO positions (profile_id, symbol, company_name, shares, average_cost, created_at)
    VALUES (1, 'NVDA', 'NVIDIA', 1, 100, '2026-01-01T00:00:00Z')`);

  const repository = new D1ForecastRepository(new SQLiteD1(database) as unknown as D1Database);
  let quoteCalls = 0;
  const forecasts = new ForecastService(repository, async () => {
    quoteCalls += 1;
    return {
      price: 175,
      currency: 'USD',
      provider: 'yahoo-finance',
      providerAsOf: '2026-08-24T09:59:00Z',
    };
  }, () => NOW);
  const foreignDraft = await forecasts.createDraft(1, draft({ confidence: 71 }));
  const foreignActiveDraft = await forecasts.createDraft(1, {
    ...draft({ confidence: 72 }),
    analysisSeed: { report: report(), scenarioId: 'rectangle-1' },
  });
  const foreignActive = await forecasts.activate(1, foreignActiveDraft.id, {});
  assert.equal(quoteCalls, 1);

  const persistedState = () => ({
    forecasts: database.prepare('SELECT * FROM forecasts ORDER BY id').all(),
    events: database.prepare('SELECT * FROM forecast_events ORDER BY id').all(),
    snapshots: database.prepare('SELECT * FROM analysis_snapshots ORDER BY id').all(),
  });
  const expectForeignNotFound = async (operation: () => Promise<unknown>) => {
    await assert.rejects(operation, (error: unknown) => error instanceof ForecastServiceError
      && error.code === 'not_found'
      && error.status === 404);
  };
  const attempts: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: 'list',
      run: async () => assert.deepEqual(await forecasts.list(2, {}), []),
    },
    {
      name: 'get',
      run: () => expectForeignNotFound(() => forecasts.get(2, foreignDraft.id)),
    },
    {
      name: 'update',
      run: () => expectForeignNotFound(() => forecasts.updateDraft(2, foreignDraft.id, draft({ confidence: 90 }))),
    },
    {
      name: 'delete',
      run: () => expectForeignNotFound(() => forecasts.deleteDraft(2, foreignDraft.id)),
    },
    {
      name: 'activate',
      run: () => expectForeignNotFound(() => forecasts.activate(2, foreignDraft.id, {})),
    },
    {
      name: 'cancel',
      run: () => expectForeignNotFound(() => forecasts.cancel(2, foreignActive.id, { reason: 'Foreign cancellation attempt.' })),
    },
    {
      name: 'note',
      run: () => expectForeignNotFound(() => forecasts.addNote(2, foreignActive.id, {
        kind: 'review_note',
        note: 'Foreign note attempt.',
      })),
    },
  ];

  for (const attempt of attempts) {
    const before = persistedState();
    await attempt.run();
    assert.deepEqual(persistedState(), before, `${attempt.name} changed foreign forecast persistence`);
  }
  assert.equal(quoteCalls, 1, 'foreign activation must be rejected before requesting market data');
  assert.equal((await repository.get(1, foreignDraft.id))?.status, 'draft');
  assert.equal((await repository.get(1, foreignActive.id))?.status, 'active');
  assert.equal((await repository.get(1, foreignActive.id))?.analysisSnapshot?.scenarioId, 'rectangle-1');
  database.close();
});

test('activation quote adapter bypasses cache and keeps provider price and timestamp coherent', async () => {
  const originalFetch = globalThis.fetch;
  let captured: (RequestInit & { cf?: { cacheTtl?: number } }) | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    captured = init as RequestInit & { cf?: { cacheTtl?: number } };
    return new Response(JSON.stringify({ chart: { result: [{
      meta: { currency: 'usd', regularMarketPrice: 175, regularMarketTime: 1787561940, previousClose: 170 },
      timestamp: [1787392800, 1787479200],
      indicators: { quote: [{ close: [169, 170] }] },
    }] } }), { status: 200 });
  }) as typeof fetch;
  try {
    const quote = await fetchYahooQuote('NVDA', { fresh: true });
    assert.equal(quote.price, 175);
    assert.equal(quote.updatedAt, new Date(1787561940 * 1000).toISOString());
    assert.equal(quote.provider, 'yahoo-finance');
    assert.equal(captured?.cache, 'no-store');
    assert.equal(captured?.cf?.cacheTtl, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
