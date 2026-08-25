import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SIMULATE_USAGE,
  STATUS_USAGE,
  SchedulerOperatorUsageError,
  parseSimulationArgs,
  parseStatusArgs,
  renderSimulationHuman,
  renderStatusHuman,
  runSimulationOperator,
  runStatusOperator,
  type SchedulerStatusReport,
} from '../../operator/forecast-scheduler.ts';
import type { ScheduledInvocationReport } from './server/scheduler/types.ts';

const scheduledAt = '2026-08-25T06:30:00.000Z';

function simulation(): ScheduledInvocationReport {
  return {
    invocationId: 'schedule_invocation_1', schedulerVersion: 'forecast-scheduler-1.0.0',
    environment: 'local', occurrenceKey: 'fsched1:key', scheduledTime: scheduledAt,
    cutoff: scheduledAt, state: 'partial_budget_exhausted',
    persistedStatus: 'partial_budget_exhausted', replayed: false, recovered: true,
    replayCount: 2, lastReplayedAt: scheduledAt,
    pagesRequested: 2, pagesCompleted: 2, selectedCount: 20, attemptedCount: 20,
    mutatedCount: 1, unexpectedErrorCount: 1,
    outcomeCounts: { target_hit: 1, provider_timeout: 1 }, initialCursor: null,
    finalCursor: 'opaque', moreWork: true, stopReason: 'max_items_reached',
    durationMs: 42, errorCategory: null, coordinatorRunIds: ['run_1', 'run_2'], pages: [],
  };
}

function status(): SchedulerStatusReport {
  return {
    state: 'inspection_ready', profileId: 1, localSchema: 'present', remoteMigrationState: 'unknown',
    remoteCronState: 'unknown', invocations: [{
      id: 'schedule_invocation_1', schedulerVersion: 'forecast-scheduler-1.0.0',
      coordinatorVersion: 'forecast-coordinator-1.0.0', environment: 'local',
      occurrenceKey: 'fsched1:key', scheduleExpression: '30 6 * * *', scheduledTime: scheduledAt,
      cutoff: scheduledAt, status: 'partial_budget_exhausted', leaseExpiresAt: null,
      recoveryCount: 1, replayCount: 2, lastReplayedAt: scheduledAt,
      startedAt: scheduledAt, completedAt: scheduledAt, durationMs: 42,
      pagesRequested: 2, pagesCompleted: 2, selectedCount: 20, attemptedCount: 20,
      mutationCount: 1, unexpectedErrorCount: 1,
      outcomeCounts: { target_hit: 1, provider_timeout: 1 }, initialCursor: null,
      finalCursor: 'opaque', moreWork: true, stopReason: 'max_items_reached', errorCategory: null,
      coordinatorRunIds: ['run_1', 'run_2'], createdAt: scheduledAt, pages: [],
    }],
  };
}

test('simulation parser requires explicit scheduled time and kill switch with strict bounds', () => {
  const parsed = parseSimulationArgs([
    '--scheduled-at', scheduledAt, '--enabled', 'true', '--environment', 'local',
    '--page-size', '10', '--max-pages', '3', '--max-items', '25',
    '--max-runtime-ms', '480000', '--min-remaining-ms', '45000', '--json',
  ]);
  assert.equal(parsed.scheduledAt, scheduledAt);
  assert.equal(parsed.rawConfig.enabled, 'true');
  assert.equal(parsed.json, true);
  assert.deepEqual(parseSimulationArgs(['--help']), {
    help: true, json: false, cron: '30 6 * * *', rawConfig: {},
  });
  assert.match(SIMULATE_USAGE, /fixed profile is resolved internally/i);
  for (const argv of [
    [], ['--scheduled-at', scheduledAt], ['--enabled', 'true'],
    ['--scheduled-at', '2026-08-25T06:30:00Z', '--enabled', 'true'],
    ['--scheduled-at', scheduledAt, '--enabled', 'yes'],
    ['--scheduled-at', scheduledAt, '--enabled', 'true', '--profile', '1'],
    ['--scheduled-at', scheduledAt, '--enabled', 'true', '--enabled', 'false'],
    ['--help', '--json'],
  ]) assert.throws(() => parseSimulationArgs(argv), SchedulerOperatorUsageError);
});

test('status parser is strict and never accepts a profile', () => {
  assert.deepEqual(parseStatusArgs([]), { help: false, json: false, limit: 20 });
  assert.deepEqual(parseStatusArgs(['--limit', '100', '--run-id', 'schedule_1', '--json']), {
    help: false, json: true, limit: 100, runId: 'schedule_1',
  });
  assert.match(STATUS_USAGE, /read-only/i);
  for (const argv of [['--limit', '0'], ['--limit', '1.5'], ['--profile', '1'],
    ['--run-id', ''], ['--json', '--json'], ['--help', '--json']]) {
    assert.throws(() => parseStatusArgs(argv), SchedulerOperatorUsageError);
  }
});

test('human and JSON scheduler views preserve partial progress and coordinator links', () => {
  const human = renderSimulationHuman(simulation());
  for (const expected of ['partial_budget_exhausted', 'pages=2/2', 'selected=20',
    'target_hit=1', 'provider_timeout=1', 'max_items_reached', 'moreWork=true',
    'recovered=true', 'run_1, run_2']) {
    assert.match(human, new RegExp(expected));
  }
  const statusHuman = renderStatusHuman(status());
  for (const expected of ['local, read-only', 'Remote migration: unknown', 'remote cron: unknown',
    'inspection_ready', 'partial_budget_exhausted', 'stop=max_items_reached', 'replays=2',
    'provider_timeout=1', 'coordinatorRuns=none']) {
    assert.match(statusHuman, new RegExp(expected, 'i'));
  }
});

test('operator runners emit stable JSON and sanitize system failures', async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const io = { out: (value: string) => output.push(value), error: (value: string) => errors.push(value) };
  assert.equal(await runSimulationOperator(['--help'], io), 0);
  assert.equal(output.at(-1), SIMULATE_USAGE);
  assert.equal(await runSimulationOperator([
    '--scheduled-at', scheduledAt, '--enabled', 'true', '--json',
  ], io, async () => simulation()), 0);
  assert.deepEqual(JSON.parse(output.at(-1) ?? '{}'), simulation());
  assert.equal(await runSimulationOperator([
    '--scheduled-at', scheduledAt, '--enabled', 'true',
  ], io, async () => { throw new Error('secret provider body'); }), 1);
  assert.doesNotMatch(errors.at(-1) ?? '', /secret provider body/u);

  assert.equal(await runStatusOperator(['--json'], io, async () => status()), 0);
  assert.deepEqual(JSON.parse(output.at(-1) ?? '{}'), status());
  assert.doesNotMatch(output.at(-1) ?? '', /leaseToken/u);
  assert.equal(await runStatusOperator(['--profile', '1'], io, async () => status()), 2);
});
