import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OPERATOR_USAGE,
  OperatorUsageError,
  parseOperatorArgs,
  renderHumanReport,
  renderJsonReport,
  runOperator,
} from '../../operator/forecast-coordinator.ts';
import type { CoordinatorRunReport } from './server/coordinator/types.ts';

const cutoff = '2026-08-24T12:00:00.000Z';

function report(): CoordinatorRunReport {
  return {
    runId: 'run_1',
    coordinatorVersion: 'forecast-coordinator-1.0.0',
    mode: 'execute',
    profileId: 1,
    cutoff,
    initialCursor: null,
    resumeCursor: 'resume-token',
    nextCursor: 'next-token',
    hasMore: true,
    selectedCount: 2,
    attemptedCount: 2,
    mutatedCount: 0,
    outcomeCounts: { provider_timeout: 1, unexpected_error: 1 },
    unexpectedErrorCount: 1,
    totalDurationMs: 42,
    status: 'completed_with_errors',
    items: [
      {
        id: 'item_1', runId: 'run_1', profileId: 1, forecastId: 7, ordinal: 1,
        symbol: 'NVDA', evaluationCutoff: cutoff, sortEvaluationDate: '2026-09-01',
        sortForecastId: 7, dueReason: 'never_evaluated', previousStatus: 'active',
        currentStatus: 'active', latestEvaluationRunId: null, latestEvaluationKind: null,
        latestEvaluationCutoff: null, classification: 'provider_timeout', evaluatorResultKind: null,
        evaluationRunId: null, reviewItemId: null, reasonCode: 'provider_timeout',
        safeExplanation: 'The trusted evaluation provider did not respond before its timeout.',
        attemptStartedAt: cutoff, attemptFinishedAt: cutoff, mutated: false, retryUseful: true,
        redactedErrorCategory: 'provider_timeout', providerVersion: null, evaluatorVersion: null,
        rulesetVersion: null, cutoff, cursorPosition: { evaluationDate: '2026-09-01', forecastId: 7 },
        wouldCallProvider: true,
      },
      {
        id: 'item_2', runId: 'run_1', profileId: 1, forecastId: 8, ordinal: 2,
        symbol: 'MSFT', evaluationCutoff: cutoff, sortEvaluationDate: '2026-09-02',
        sortForecastId: 8, dueReason: 'new_information_possible', previousStatus: 'active',
        currentStatus: 'active', latestEvaluationRunId: 4, latestEvaluationKind: 'no_change',
        latestEvaluationCutoff: '2026-08-23T12:00:00.000Z', classification: 'unexpected_error',
        evaluatorResultKind: null, evaluationRunId: null, reviewItemId: null,
        reasonCode: 'unexpected_coordinator_error', safeExplanation: 'An unexpected internal error prevented this item from completing normally.',
        attemptStartedAt: cutoff, attemptFinishedAt: cutoff, mutated: false, retryUseful: true,
        redactedErrorCategory: 'unexpected_error', providerVersion: null, evaluatorVersion: null,
        rulesetVersion: null, cutoff, cursorPosition: { evaluationDate: '2026-09-02', forecastId: 8 },
        wouldCallProvider: true,
      },
    ],
    warnings: ['One or more items require operator attention.'],
    replayUsedExistingRun: false,
  };
}

test('operator parser accepts only the bounded non-profile contract', () => {
  assert.deepEqual(parseOperatorArgs([
    '--cutoff', cutoff, '--mode', 'execute', '--limit', '100', '--cursor', 'opaque',
    '--run-key', 'operator:2026-08-24', '--json',
  ]), {
    help: false, json: true, cutoff, mode: 'execute', limit: 100,
    cursor: 'opaque', operatorRunKey: 'operator:2026-08-24',
  });
  assert.deepEqual(parseOperatorArgs(['--cutoff', cutoff, '--mode', 'dry_run']), {
    help: false, json: false, cutoff, mode: 'dry_run', limit: 25,
  });
  assert.deepEqual(parseOperatorArgs(['--help']), { help: true, json: false, limit: 25 });
  assert.match(OPERATOR_USAGE, /profile is resolved internally/i);
});

test('operator parser rejects missing, duplicate, unknown, profile, and malformed arguments', () => {
  for (const argv of [
    [],
    ['--cutoff', cutoff],
    ['--mode', 'execute'],
    ['--cutoff', cutoff, '--mode', 'execute', '--profile', '1'],
    ['--cutoff', cutoff, '--mode', 'execute', '--cutoff', cutoff],
    ['--cutoff', '2026-08-24T12:00:00Z', '--mode', 'execute'],
    ['--cutoff', cutoff, '--mode', 'preview'],
    ['--cutoff', cutoff, '--mode', 'execute', '--limit', '0'],
    ['--cutoff', cutoff, '--mode', 'execute', '--limit', '1.5'],
    ['--cutoff', cutoff, '--mode', 'execute', '--cursor'],
    ['--help', '--json'],
  ]) {
    assert.throws(() => parseOperatorArgs(argv), OperatorUsageError);
  }
});

test('human and JSON renderers preserve the same failures, counts, cursors, and warnings', () => {
  const value = report();
  assert.deepEqual(JSON.parse(renderJsonReport(value)), value);
  const human = renderHumanReport(value);
  for (const expected of [
    'completed_with_errors', 'selected=2', 'attempted=2', 'mutated=0', 'unexpected=1',
    'provider_timeout=1', 'unexpected_error=1', 'resume-token', 'next-token',
    'NVDA #7: provider_timeout', 'MSFT #8: unexpected_error',
    'One or more items require operator attention.',
  ]) assert.match(human, new RegExp(expected));
});

test('operator command returns zero for item-level failures and non-zero for invalid or system failures', async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const io = { out: (value: string) => output.push(value), error: (value: string) => errors.push(value) };
  assert.equal(await runOperator(['--help'], io), 0);
  assert.equal(output.at(-1), OPERATOR_USAGE);
  assert.equal(await runOperator(['--mode', 'execute'], io), 2);
  assert.match(errors.at(-1) ?? '', /--cutoff is required/);
  assert.equal(await runOperator(
    ['--cutoff', cutoff, '--mode', 'execute', '--json'],
    io,
    async () => report(),
  ), 0);
  assert.deepEqual(JSON.parse(output.at(-1) ?? '{}'), report());
  assert.equal(await runOperator(
    ['--cutoff', cutoff, '--mode', 'execute'],
    io,
    async () => { throw new Error('secret provider URL'); },
  ), 1);
  assert.doesNotMatch(errors.at(-1) ?? '', /secret provider URL/);
});
