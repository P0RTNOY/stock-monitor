import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { forecastInitializationStatements } from '../../db/forecast-initialization.ts';
import type { CoordinatorOutcome, CoordinatorRunStatus } from './server/coordinator/contract.ts';
import type { CoordinatorRunReport } from './server/coordinator/types.ts';
import { parseSchedulerConfig } from './server/scheduler/contract.ts';
import type {
  BeginSchedulePage,
  CompleteSchedulePage,
  FinalizeScheduleInvocation,
  NewScheduleInvocation,
  SchedulerRepository,
} from './server/scheduler/repository.ts';
import { ForecastSchedulerService, disabledScheduledInvocation } from './server/scheduler/service.ts';
import type {
  ScheduleInvocationRecord,
  SchedulePageRecord,
  SchedulerLogEntry,
  SchedulerRuntime,
} from './server/scheduler/types.ts';

const scheduledTime = '2026-08-25T06:30:00.000Z';
const cron = '30 6 * * *';

class MemoryRepository implements SchedulerRepository {
  invocation: ScheduleInvocationRecord | null = null;
  pages = new Map<number, SchedulePageRecord>();
  failAfterFirstPage = false;
  crashBeforeFirstFinalize = false;

  async findByOccurrence(profileId: number, occurrenceKey: string) {
    return this.invocation?.profileId === profileId && this.invocation.occurrenceKey === occurrenceKey
      ? this.invocation : null;
  }
  async getInvocation(profileId: number, invocationId: string) {
    return this.invocation?.profileId === profileId && this.invocation.id === invocationId
      ? this.invocation : null;
  }
  async getPage(profileId: number, invocationId: string, pageNumber: number) {
    const page = this.pages.get(pageNumber);
    return page?.profileId === profileId && page.invocationId === invocationId ? page : null;
  }
  async getPages(profileId: number, invocationId: string) {
    return [...this.pages.values()].filter((page) => (
      page.profileId === profileId && page.invocationId === invocationId
    )).sort((left, right) => left.pageNumber - right.pageNumber);
  }
  async listRecent(profileId: number) { return this.invocation?.profileId === profileId ? [this.invocation] : []; }
  async createInvocation(value: NewScheduleInvocation) {
    if (this.invocation) return false;
    this.invocation = {
      ...value, status: 'running', recoveryCount: 0, replayCount: 0, lastReplayedAt: null,
      completedAt: null, durationMs: null,
      pagesRequested: 0, pagesCompleted: 0, selectedCount: 0, attemptedCount: 0,
      mutationCount: 0, unexpectedErrorCount: 0, outcomeCountsJson: '{}', initialCursor: null,
      finalCursor: null, moreWork: true, stopReason: null, errorCategory: null,
      coordinatorRunIdsJson: '[]', createdAt: value.startedAt,
    };
    return true;
  }
  async acquireLease(profileId: number, invocationId: string, token: string, now: string, expiresAt: string) {
    const row = await this.getInvocation(profileId, invocationId);
    if (!row || row.status !== 'running' || (row.leaseExpiresAt && row.leaseExpiresAt > now)) return false;
    Object.assign(row, { leaseToken: token, leaseExpiresAt: expiresAt, recoveryCount: row.recoveryCount + 1 });
    return true;
  }
  async recordReplay(profileId: number, invocationId: string, replayedAt: string) {
    const row = await this.getInvocation(profileId, invocationId);
    if (!row) return false;
    row.replayCount += 1;
    row.lastReplayedAt = replayedAt;
    return true;
  }
  async renewLease(profileId: number, invocationId: string, token: string, now: string, expiresAt: string) {
    const row = await this.getInvocation(profileId, invocationId);
    if (!row || row.status !== 'running' || row.leaseToken !== token
      || !row.leaseExpiresAt || row.leaseExpiresAt <= now) return false;
    row.leaseExpiresAt = expiresAt;
    return true;
  }
  async beginPage(value: BeginSchedulePage) {
    const row = await this.getInvocation(value.profileId, value.invocationId);
    if (!row || row.status !== 'running' || row.leaseToken !== value.leaseToken
      || !row.leaseExpiresAt || row.leaseExpiresAt <= value.startedAt || this.pages.has(value.pageNumber)) return false;
    this.pages.set(value.pageNumber, {
      id: value.id, invocationId: value.invocationId, profileId: value.profileId,
      pageNumber: value.pageNumber, state: 'started', coordinatorRunId: null,
      coordinatorRunStatus: null, operatorRunKey: value.operatorRunKey, batchLimit: value.batchLimit,
      inputCursor: value.inputCursor, outputCursor: null, selectedCount: 0, attemptedCount: 0,
      mutationCount: 0, unexpectedErrorCount: 0, outcomeCountsJson: '{}',
      replayUsedExistingRun: false, startedAt: value.startedAt, completedAt: null,
      durationMs: null, errorCategory: null, errorType: null, createdAt: value.startedAt,
    });
    row.pagesRequested = Math.max(row.pagesRequested, value.pageNumber);
    if (value.pageNumber === 1) row.initialCursor = value.inputCursor;
    return true;
  }
  async completePage(value: CompleteSchedulePage) {
    const row = await this.getInvocation(value.profileId, value.invocationId);
    const page = this.pages.get(value.pageNumber);
    if (!row || !page || page.state !== 'started' || row.status !== 'running'
      || row.leaseToken !== value.leaseToken || !row.leaseExpiresAt
      || row.leaseExpiresAt <= value.completedAt) return false;
    Object.assign(page, {
      state: 'completed', coordinatorRunId: value.coordinatorRunId,
      coordinatorRunStatus: value.coordinatorRunStatus, outputCursor: value.outputCursor,
      selectedCount: value.selectedCount, attemptedCount: value.attemptedCount,
      mutationCount: value.mutationCount, unexpectedErrorCount: value.unexpectedErrorCount,
      outcomeCountsJson: JSON.stringify(value.outcomeCounts),
      replayUsedExistingRun: value.replayUsedExistingRun, completedAt: value.completedAt,
      durationMs: value.durationMs,
    });
    row.pagesCompleted += 1;
    row.selectedCount += value.selectedCount;
    row.attemptedCount += value.attemptedCount;
    row.mutationCount += value.mutationCount;
    row.unexpectedErrorCount += value.unexpectedErrorCount;
    row.outcomeCountsJson = JSON.stringify(value.aggregateOutcomeCounts);
    row.finalCursor = value.outputCursor;
    row.coordinatorRunIdsJson = JSON.stringify([
      ...JSON.parse(row.coordinatorRunIdsJson) as string[], value.coordinatorRunId,
    ]);
    if (this.failAfterFirstPage && value.pageNumber === 1) {
      this.failAfterFirstPage = false;
      throw new Error('SimulatedSchedulerCrash');
    }
    return true;
  }
  async failPage(value: {
    invocationId: string; profileId: number; pageNumber: number; leaseToken: string;
    completedAt: string; durationMs: number; errorCategory: string; errorType: string;
  }) {
    const row = await this.getInvocation(value.profileId, value.invocationId);
    const page = this.pages.get(value.pageNumber);
    if (!row || !page || row.leaseToken !== value.leaseToken || page.state !== 'started') return false;
    Object.assign(page, { state: 'failed', completedAt: value.completedAt,
      durationMs: value.durationMs, errorCategory: value.errorCategory, errorType: value.errorType });
    return true;
  }
  async finalize(value: FinalizeScheduleInvocation) {
    const row = await this.getInvocation(value.profileId, value.invocationId);
    if (!row || row.status !== 'running' || row.leaseToken !== value.leaseToken
      || !row.leaseExpiresAt || row.leaseExpiresAt <= value.completedAt) return false;
    if (this.crashBeforeFirstFinalize) {
      this.crashBeforeFirstFinalize = false;
      throw new Error('SimulatedCrashBeforeSchedulerFinalize');
    }
    Object.assign(row, {
      status: value.status, completedAt: value.completedAt, durationMs: value.durationMs,
      moreWork: value.moreWork, stopReason: value.stopReason, finalCursor: value.finalCursor,
      errorCategory: value.errorCategory, leaseToken: null, leaseExpiresAt: null,
    });
    return true;
  }
}

class TakeoverFinalizesRepository extends MemoryRepository {
  override async completePage(value: CompleteSchedulePage) {
    const completed = await super.completePage(value);
    assert.equal(completed, true);
    Object.assign(this.invocation!, {
      status: 'completed', moreWork: false, stopReason: 'no_more_work',
      completedAt: value.completedAt, leaseToken: null, leaseExpiresAt: null,
    });
    return false;
  }
}

class Runtime implements SchedulerRuntime {
  sequence = 0;
  instant = scheduledTime;
  elapsed = 0;
  now() { return this.instant; }
  elapsedMs(startedAt: string) {
    return this.elapsed || Math.max(0, Date.parse(this.instant) - Date.parse(startedAt));
  }
  durationMs(startedAt: string, finishedAt: string) { return Date.parse(finishedAt) - Date.parse(startedAt); }
  leaseExpiresAt(acquiredAt: string) { return new Date(Date.parse(acquiredAt) + 13 * 60_000).toISOString(); }
  id(kind: 'schedule_invocation' | 'schedule_page' | 'schedule_lease') { return `${kind}_${++this.sequence}`; }
}

function coordinatorReport(
  index: number,
  nextCursor: string | null,
  outcomes: Partial<Record<CoordinatorOutcome, number>> = {},
  status: CoordinatorRunStatus = 'completed',
  replayUsedExistingRun = false,
): CoordinatorRunReport {
  const selectedCount = Object.values(outcomes).reduce((sum, count) => sum + (count ?? 0), 0);
  return {
    runId: `coordinator_${index}`, coordinatorVersion: 'forecast-coordinator-1.0.0',
    mode: 'execute', profileId: 1, cutoff: scheduledTime, initialCursor: null,
    resumeCursor: `resume_${index}`, nextCursor, hasMore: nextCursor !== null,
    selectedCount, attemptedCount: selectedCount, mutatedCount: outcomes.target_hit ?? 0,
    outcomeCounts: outcomes, unexpectedErrorCount: outcomes.unexpected_error ?? 0,
    totalDurationMs: 1, status, items: [], warnings: [], replayUsedExistingRun,
  };
}

function harness(reports: CoordinatorRunReport[], repository = new MemoryRepository()) {
  const runtime = new Runtime();
  const logs: SchedulerLogEntry[] = [];
  const calls: unknown[] = [];
  const service = new ForecastSchedulerService(repository, {
    async coordinate(value) {
      calls.push(value);
      const report = reports.shift();
      if (!report) throw new Error('NoScriptedCoordinatorReport');
      return report;
    },
  }, runtime, { log: (entry) => logs.push(entry) });
  return { repository, runtime, logs, calls, service };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    config: parseSchedulerConfig({ enabled: true, ...overrides }),
    profileId: 1, scheduledTime, scheduleExpression: cron,
  };
}

test('disabled scheduler performs no persistence or coordinator work', async () => {
  let touched = false;
  const logger = { log() {} };
  const report = await disabledScheduledInvocation({
    ...input(), config: parseSchedulerConfig({ enabled: false }),
  }, logger);
  assert.equal(report.state, 'disabled');
  const poisoned = new Proxy({}, { get() { touched = true; throw new Error('mutation'); } });
  void poisoned;
  assert.equal(touched, false);
});

test('empty due set and one-page work complete durably', async () => {
  const empty = harness([coordinatorReport(1, null)]);
  const emptyResult = await empty.service.run(input());
  assert.equal(emptyResult.state, 'completed');
  assert.equal(emptyResult.pagesCompleted, 1);
  assert.equal(emptyResult.moreWork, false);
  const one = harness([coordinatorReport(1, null, { target_hit: 1 })]);
  const result = await one.service.run(input());
  assert.equal(result.mutatedCount, 1);
  assert.deepEqual(result.outcomeCounts, { target_hit: 1 });
});

test('multiple pages preserve opaque cursors byte-for-byte and aggregate outcomes', async () => {
  const token1 = 'opaque/+==:first';
  const token2 = 'opaque/+==:second';
  const value = harness([
    coordinatorReport(1, token1, { provider_unavailable: 1, needs_review: 1 }),
    coordinatorReport(2, token2, { provider_timeout: 1, stale_state: 1 }),
    coordinatorReport(3, null, { claim_conflict: 1, target_hit: 1 }),
  ]);
  const result = await value.service.run(input({ maxPages: 3, maxItems: 20 }));
  assert.equal(result.state, 'completed');
  assert.equal(result.initialCursor, null);
  assert.equal(result.finalCursor, null);
  assert.deepEqual(value.calls.map((call) => (call as { cursor?: string }).cursor), [undefined, token1, token2]);
  assert.deepEqual(result.outcomeCounts, {
    provider_unavailable: 1, needs_review: 1, provider_timeout: 1,
    stale_state: 1, claim_conflict: 1, target_hit: 1,
  });
});

test('page and item bounds stop partially with more work', async () => {
  const pageBound = harness([coordinatorReport(1, 'next', { no_change: 1 })]);
  const page = await pageBound.service.run(input({ maxPages: 1 }));
  assert.equal(page.state, 'partial_budget_exhausted');
  assert.equal(page.stopReason, 'max_pages_reached');
  assert.equal(page.moreWork, true);

  const itemBound = harness([coordinatorReport(1, 'next', { no_change: 2 })]);
  const item = await itemBound.service.run(input({ pageSize: 2, maxItems: 2 }));
  assert.equal(item.stopReason, 'max_items_reached');
  assert.equal((itemBound.calls[0] as { limit: number }).limit, 2);
});

test('runtime reserve is enforced only at safe page boundaries', async () => {
  const value = harness([coordinatorReport(1, null)]);
  value.runtime.elapsed = 479_000;
  const result = await value.service.run(input());
  assert.equal(result.stopReason, 'runtime_budget_reached');
  assert.equal(result.pagesRequested, 0);
  assert.equal(value.calls.length, 0);
});

test('repeated cursor fails safely and never loops indefinitely', async () => {
  const value = harness([coordinatorReport(1, 'same'), coordinatorReport(2, 'same')]);
  const result = await value.service.run(input());
  assert.equal(result.state, 'coordinator_failure');
  assert.equal(result.stopReason, 'repeated_cursor');
  assert.equal(result.moreWork, true);
  assert.equal(value.calls.length, 2);
});

test('same-event replay is terminal and a new event gets a new identity and cutoff', async () => {
  const value = harness([coordinatorReport(1, null)]);
  const first = await value.service.run(input());
  const replay = await value.service.run(input());
  assert.equal(replay.state, 'replayed');
  assert.equal(replay.invocationId, first.invocationId);
  assert.equal(replay.replayCount, 1);
  assert.equal(replay.lastReplayedAt, scheduledTime);
  assert.equal(value.calls.length, 1);
  const next = harness([coordinatorReport(2, null)]);
  const nextResult = await next.service.run({
    ...input(), scheduledTime: '2026-08-26T06:30:00.000Z',
  });
  assert.notEqual(nextResult.occurrenceKey, first.occurrenceKey);
  assert.equal(nextResult.cutoff, '2026-08-26T06:30:00.000Z');
});

test('live scheduler and live Phase 2B overlap are explicit and do not advance pages', async () => {
  const repository = new MemoryRepository();
  const runtime = new Runtime();
  let coordinatorCalls = 0;
  let release!: (report: CoordinatorRunReport) => void;
  let enteredCoordinator!: () => void;
  const gate = new Promise<CoordinatorRunReport>((resolve) => { release = resolve; });
  const coordinatorEntered = new Promise<void>((resolve) => { enteredCoordinator = resolve; });
  const service = new ForecastSchedulerService(repository, {
    async coordinate() {
      coordinatorCalls += 1;
      enteredCoordinator();
      return gate;
    },
  }, runtime, { log() {} });
  const firstPromise = service.run(input());
  await coordinatorEntered;
  assert.equal(coordinatorCalls, 1);
  const overlap = await service.run(input());
  assert.equal(overlap.state, 'running');
  assert.equal(overlap.stopReason, 'overlap_in_progress');
  assert.equal(overlap.replayCount, 1);
  release(coordinatorReport(1, null));
  const first = await firstPromise;
  assert.equal(first.state, 'completed');
  assert.equal(coordinatorCalls, 1);

  const phase2b = harness([coordinatorReport(1, null, {}, 'running', true)]);
  const running = await phase2b.service.run(input());
  assert.equal(running.state, 'running');
  assert.equal(running.stopReason, 'overlap_in_progress');
  assert.equal(running.pagesCompleted, 0);
});

test('expired scheduler recovery resumes a started page with the exact same Phase 2B key', async () => {
  const repository = new MemoryRepository();
  const first = harness([coordinatorReport(1, null, {}, 'running', true)], repository);
  const running = await first.service.run(input());
  const pageKey = (first.calls[0] as { operatorRunKey: string }).operatorRunKey;
  assert.equal(running.pagesCompleted, 0);
  assert.ok(repository.invocation);
  repository.invocation.leaseExpiresAt = scheduledTime;
  const recovered = harness([coordinatorReport(1, null, { no_change: 1 }, 'completed', true)], repository);
  recovered.runtime.instant = '2026-08-25T06:31:00.000Z';
  const result = await recovered.service.run(input());
  assert.equal(result.state, 'recovered');
  assert.equal(result.recovered, true);
  assert.equal((recovered.calls[0] as { operatorRunKey: string }).operatorRunKey, pageKey);
});

test('recovery gets a fresh page-runtime budget after the real scheduler lease interval', async () => {
  const repository = new MemoryRepository();
  const first = harness([coordinatorReport(1, null, {}, 'running', true)], repository);
  await first.service.run(input());
  const recovered = harness([coordinatorReport(1, null, { no_change: 1 }, 'completed', true)], repository);
  recovered.runtime.instant = '2026-08-25T06:44:00.000Z';
  const result = await recovered.service.run(input());
  assert.equal(result.state, 'recovered');
  assert.equal(result.stopReason, 'no_more_work');
  assert.equal(recovered.calls.length, 1);
  assert.ok((result.durationMs ?? 0) >= 14 * 60_000);
});

test('crash after a durable page resumes at the next cursor without duplicate provider work', async () => {
  const repository = new MemoryRepository();
  repository.failAfterFirstPage = true;
  const crashing = harness([coordinatorReport(1, 'cursor-after-one', { target_hit: 1 })], repository);
  await assert.rejects(() => crashing.service.run(input()), /SimulatedSchedulerCrash/);
  assert.equal(repository.invocation?.pagesCompleted, 1);
  repository.invocation!.leaseExpiresAt = scheduledTime;
  const recovered = harness([coordinatorReport(2, null, { no_change: 1 }, 'completed', true)], repository);
  recovered.runtime.instant = '2026-08-25T06:31:00.000Z';
  const result = await recovered.service.run(input());
  assert.equal(result.state, 'recovered');
  assert.equal((recovered.calls[0] as { cursor: string }).cursor, 'cursor-after-one');
  assert.equal(result.pagesCompleted, 2);
  assert.deepEqual(result.outcomeCounts, { target_hit: 1, no_change: 1 });
});

test('crash after a durable final page finalizes recovery without restarting the scan', async () => {
  const repository = new MemoryRepository();
  repository.failAfterFirstPage = true;
  const crashing = harness([coordinatorReport(1, null, { needs_review: 1 })], repository);
  await assert.rejects(() => crashing.service.run(input()), /SimulatedSchedulerCrash/);
  repository.invocation!.leaseExpiresAt = scheduledTime;
  const recovered = harness([], repository);
  recovered.runtime.instant = '2026-08-25T06:31:00.000Z';
  const result = await recovered.service.run(input());
  assert.equal(result.state, 'recovered');
  assert.equal(result.stopReason, 'no_more_work');
  assert.equal(result.pagesCompleted, 1);
  assert.equal(recovered.calls.length, 0);
});

test('crash after a failed page resumes by finalizing sanitized failure instead of rerunning it', async () => {
  const repository = new MemoryRepository();
  repository.crashBeforeFirstFinalize = true;
  const crashing = new ForecastSchedulerService(repository, {
    async coordinate() { throw new Error('provider internals'); },
  }, new Runtime(), { log() {} });
  await assert.rejects(() => crashing.run(input()), /SimulatedCrashBeforeSchedulerFinalize/);
  repository.invocation!.leaseExpiresAt = scheduledTime;
  const recovered = harness([], repository);
  recovered.runtime.instant = '2026-08-25T06:31:00.000Z';
  const result = await recovered.service.run(input());
  assert.equal(result.state, 'recovered');
  assert.equal(result.persistedStatus, 'unexpected_error');
  assert.equal(result.pagesCompleted, 0);
  assert.equal(recovered.calls.length, 0);
});

test('changed config for an existing occurrence fails closed without coordinator work', async () => {
  const repository = new MemoryRepository();
  const first = harness([coordinatorReport(1, null)], repository);
  await first.service.run(input());
  const changed = harness([], repository);
  const result = await changed.service.run(input({ maxItems: 26 }));
  assert.equal(result.state, 'configuration_error');
  assert.equal(result.errorCategory, 'config_fingerprint_mismatch');
  assert.equal(changed.calls.length, 0);
});

test('coordinator failures persist sanitized categories and structured logs omit messages', async () => {
  const repository = new MemoryRepository();
  const runtime = new Runtime();
  const logs: SchedulerLogEntry[] = [];
  const service = new ForecastSchedulerService(repository, {
    async coordinate() { throw new Error('secret upstream body and token'); },
  }, runtime, { log: (entry) => logs.push(entry) });
  const result = await service.run(input());
  assert.equal(result.state, 'unexpected_error');
  assert.equal(result.errorCategory, 'unexpected_scheduler_error');
  assert.equal(repository.pages.get(1)?.errorType, 'Error');
  assert.doesNotMatch(JSON.stringify(logs), /secret|token|upstream body/u);
  assert.ok(logs.some((entry) => entry.event === 'forecast_schedule_failed'));
});

test('stale scheduler owner cannot finalize after a lease takeover', async () => {
  const repository = new MemoryRepository();
  await repository.createInvocation({
    id: 'inv', profileId: 1, schedulerVersion: 'forecast-scheduler-1.0.0',
    coordinatorVersion: 'forecast-coordinator-1.0.0', environment: 'local', occurrenceKey: 'key',
    scheduleExpression: cron, scheduledTime, cutoff: scheduledTime, configFingerprint: 'a'.repeat(64),
    configurationJson: '{}', leaseToken: 'old', leaseExpiresAt: scheduledTime, startedAt: scheduledTime,
  });
  assert.equal(await repository.acquireLease(1, 'inv', 'new', scheduledTime,
    '2026-08-25T06:40:00.000Z'), true);
  assert.equal(await repository.finalize({
    invocationId: 'inv', profileId: 1, leaseToken: 'old', completedAt: scheduledTime,
    durationMs: 0, status: 'completed', moreWork: false, stopReason: 'no_more_work',
    finalCursor: null, errorCategory: null,
  }), false);
  assert.equal(repository.invocation?.status, 'running');
});

test('fence loss reports a takeover terminal state instead of falsely reporting running', async () => {
  const value = harness([coordinatorReport(1, null)], new TakeoverFinalizesRepository());
  const result = await value.service.run(input());
  assert.equal(result.state, 'completed');
  assert.equal(result.persistedStatus, 'completed');
  assert.equal(result.moreWork, false);
  assert.equal(result.stopReason, 'no_more_work');
});

test('runtime DDL and migration both define scheduler invocation/page audit tables', () => {
  const runtime = forecastInitializationStatements().join('\n');
  const migration = readFileSync(new URL('../../drizzle/0005_thin_ikaris.sql', import.meta.url), 'utf8');
  for (const table of ['forecast_scheduler_invocations', 'forecast_scheduler_pages']) {
    assert.match(runtime, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(migration, new RegExp(`CREATE TABLE .${table}.`));
  }
  for (const column of ['occurrence_key', 'config_fingerprint', 'replay_count',
    'last_replayed_at', 'pages_completed',
    'more_work', 'stop_reason', 'coordinator_run_id', 'input_cursor', 'output_cursor']) {
    assert.match(runtime, new RegExp(column));
    assert.match(migration, new RegExp(column));
  }

  const runtimeDb = new DatabaseSync(':memory:');
  runtimeDb.exec('PRAGMA foreign_keys = ON');
  runtimeDb.exec(`CREATE TABLE investment_profiles (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, base_currency TEXT NOT NULL,
    cash_balance REAL NOT NULL, created_at TEXT NOT NULL)`);
  for (const statement of forecastInitializationStatements()) runtimeDb.exec(statement);

  const migratedDb = new DatabaseSync(':memory:');
  migratedDb.exec('PRAGMA foreign_keys = ON');
  migratedDb.exec('CREATE TABLE investment_profiles (id INTEGER PRIMARY KEY)');
  migratedDb.exec(`CREATE TABLE forecast_coordinator_runs (
    id TEXT NOT NULL, profile_id INTEGER NOT NULL, PRIMARY KEY (id), UNIQUE (id, profile_id))`);
  migratedDb.exec(migration.replaceAll('--> statement-breakpoint', ''));

  for (const table of ['forecast_scheduler_invocations', 'forecast_scheduler_pages']) {
    const columns = (db: DatabaseSync) => db.prepare(`PRAGMA table_info(${table})`).all()
      .map((row) => ({ name: row.name, type: row.type, notnull: row.notnull, dflt_value: row.dflt_value }));
    const indexes = (db: DatabaseSync) => db.prepare(`PRAGMA index_list(${table})`).all()
      .map((row) => String(row.name)).sort();
    assert.deepEqual(columns(runtimeDb), columns(migratedDb));
    assert.deepEqual(indexes(runtimeDb), indexes(migratedDb));
  }
  runtimeDb.close();
  migratedDb.close();
});
