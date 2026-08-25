import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BACKFILL_USAGE,
  PROJECT_USAGE,
  STATUS_USAGE,
  NotificationOperatorUsageError,
  parseBackfillArgs,
  parseProjectionArgs,
  parseStatusArgs,
  renderBackfillHuman,
  renderProjectionHuman,
  renderStatusHuman,
  runBackfillOperator,
  runProjectionOperator,
  runStatusOperator,
  type NotificationStatusReport,
} from '../../operator/forecast-notifications.ts';
import type { NotificationProjectionReport } from './server/notifications/service.ts';

const cutoff = '2026-08-25T12:00:00.000Z';

function projectionReport(
  overrides: Partial<NotificationProjectionReport> = {},
): NotificationProjectionReport {
  return {
    projectorVersion: 'forecast-notification-projector-1.0.0',
    profileId: 1,
    cutoff,
    mode: 'dry_run',
    disposition: 'page_completed',
    baselineEvaluationRunId: 4,
    startingEvaluationRunId: 4,
    endingEvaluationRunId: 6,
    selectedCount: 2,
    processedCount: 2,
    materializedCount: 1,
    excludedCount: 1,
    invalidSourceCount: 0,
    hasMore: true,
    stoppedByCutoff: false,
    nextCursor: 'opaque-continuation',
    items: [
      {
        evaluationRunId: 5,
        forecastId: 12,
        category: 'target_hit',
        classification: 'intent_materialized',
        reasonCode: 'master_consent_disabled',
        policyDecision: 'suppressed_no_consent',
        intentWouldBeCreated: true,
        intentCreated: false,
      },
      {
        evaluationRunId: 6,
        forecastId: 13,
        category: null,
        classification: 'excluded_no_change',
        reasonCode: 'evaluation_result_no_change',
        policyDecision: null,
        intentWouldBeCreated: false,
        intentCreated: false,
      },
    ],
    warnings: ['One more bounded page is available.'],
    ...overrides,
  };
}

function statusReport(): NotificationStatusReport {
  return {
    state: 'inspection_ready',
    localSchema: 'present',
    remoteMigrationState: 'unknown',
    deliveryWorkerState: 'not_configured',
    projectorVersion: 'forecast-notification-projector-1.0.0',
    filters: { limit: 20, state: 'suppressed', category: 'target_hit' },
    checkpoint: {
      baselineEvaluationRunId: 4,
      lastEvaluationRunId: 5,
      activatedAt: cutoff,
      leaseExpiresAt: null,
      recoveryCount: 0,
      createdAt: cutoff,
      updatedAt: cutoff,
    },
    counts: [{ category: 'target_hit', state: 'suppressed', count: 1 }],
    outbox: [{
      outboxId: 'outbox_1',
      intentId: 'intent_1',
      category: 'target_hit',
      state: 'suppressed',
      policyDecision: 'suppressed_no_consent',
      policyReason: 'master_consent_disabled',
      preferenceRevision: null,
      eventOccurredAt: cutoff,
      availableAt: null,
      attemptCount: 0,
      leaseExpiresAt: null,
      lastAttemptAt: null,
      succeededAt: null,
      deadLetteredAt: null,
      lastFailureCategory: null,
      createdAt: cutoff,
      updatedAt: cutoff,
      attempts: [],
    }],
  };
}

function io() {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    adapter: {
      out: (value: string) => output.push(value),
      error: (value: string) => errors.push(value),
    },
  };
}

test('projection parser defaults safely and accepts the bounded explicit commit contract', () => {
  assert.deepEqual(parseProjectionArgs(['--cutoff', cutoff]), {
    help: false,
    json: false,
    cutoff,
    limit: 25,
    mode: 'dry_run',
  });
  assert.deepEqual(parseProjectionArgs([
    '--cutoff', cutoff,
    '--limit', '100',
    '--cursor', 'opaque',
    '--commit',
    '--json',
  ]), {
    help: false,
    json: true,
    cutoff,
    limit: 100,
    mode: 'commit',
    cursor: 'opaque',
  });
  assert.deepEqual(parseProjectionArgs(['--help']), {
    help: true,
    json: false,
    limit: 25,
    mode: 'dry_run',
  });
  assert.match(PROJECT_USAGE, /fixed profile is resolved internally/i);
  assert.match(PROJECT_USAGE, /never sends a notification/i);
});

test('projection parser rejects unknown, duplicate, profile, mode, cutoff, limit, and cursor errors', () => {
  const overlongCursor = 'x'.repeat(4_097);
  for (const argv of [
    [],
    ['--cutoff', '2026-08-25T12:00:00Z'],
    ['--cutoff', cutoff, '--profile', '1'],
    ['--cutoff', cutoff, '--unknown'],
    ['--cutoff', cutoff, '--cutoff', cutoff],
    ['--cutoff', cutoff, '--dry-run', '--commit'],
    ['--cutoff', cutoff, '--limit', '0'],
    ['--cutoff', cutoff, '--limit', '101'],
    ['--cutoff', cutoff, '--limit', '1.5'],
    ['--cutoff', cutoff, '--cursor'],
    ['--cutoff', cutoff, '--cursor', ' padded '],
    ['--cutoff', cutoff, '--cursor', 'control\u0000token'],
    ['--cutoff', cutoff, '--cursor', overlongCursor],
    ['--help', '--json'],
  ]) {
    assert.throws(() => parseProjectionArgs(argv), NotificationOperatorUsageError);
  }
});

test('historical parser is bounded, confirmed, preview-only, and needs-review opt-in is explicit', () => {
  assert.deepEqual(parseBackfillArgs([
    '--from-id', '2',
    '--through-id', '20',
    '--cutoff', cutoff,
    '--confirm-historical-preview',
    '--include-needs-review',
    '--limit', '10',
    '--dry-run',
    '--json',
  ]), {
    help: false,
    json: true,
    cutoff,
    fromEvaluationRunId: 2,
    throughEvaluationRunId: 20,
    limit: 10,
    includeNeedsReview: true,
  });
  assert.deepEqual(parseBackfillArgs(['--help']), {
    help: true,
    json: false,
    limit: 25,
    includeNeedsReview: false,
  });
  assert.match(BACKFILL_USAGE, /preview-only/i);
  assert.doesNotMatch(BACKFILL_USAGE, /--commit/u);
});

test('historical parser rejects missing confirmation or bounds and malformed invocation fields', () => {
  const required = [
    '--from-id', '2', '--through-id', '20', '--cutoff', cutoff,
    '--confirm-historical-preview',
  ];
  for (const argv of [
    [],
    ['--from-id', '2', '--through-id', '20', '--cutoff', cutoff],
    ['--through-id', '20', '--cutoff', cutoff, '--confirm-historical-preview'],
    ['--from-id', '2', '--cutoff', cutoff, '--confirm-historical-preview'],
    ['--from-id', '2', '--through-id', '1', '--cutoff', cutoff, '--confirm-historical-preview'],
    ['--from-id', '0', '--through-id', '20', '--cutoff', cutoff, '--confirm-historical-preview'],
    ['--from-id', 'x', '--through-id', '20', '--cutoff', cutoff, '--confirm-historical-preview'],
    ['--from-id', '2', '--through-id', '20', '--cutoff', 'bad', '--confirm-historical-preview'],
    [...required, '--limit', '101'],
    [...required, '--commit'],
    [...required, '--profile', '1'],
    [...required, '--from-id', '3'],
    ['--help', '--json'],
  ]) {
    assert.throws(() => parseBackfillArgs(argv), NotificationOperatorUsageError);
  }
});

test('status parser accepts only allowlisted state and category filters', () => {
  assert.deepEqual(parseStatusArgs([]), { help: false, json: false, limit: 20 });
  assert.deepEqual(parseStatusArgs([
    '--state', 'retry_scheduled', '--category', 'needs_review', '--limit', '100', '--json',
  ]), {
    help: false,
    json: true,
    limit: 100,
    state: 'retry_scheduled',
    category: 'needs_review',
  });
  assert.deepEqual(parseStatusArgs(['--help']), { help: true, json: false, limit: 20 });
  assert.match(STATUS_USAGE, /read-only/i);

  for (const argv of [
    ['--state', 'pending OR 1=1'],
    ['--state', 'ready'],
    ['--category', 'no_change'],
    ['--category', "target_hit'--"],
    ['--limit', '0'],
    ['--limit', '1.5'],
    ['--profile', '1'],
    ['--state', 'pending', '--state', 'suppressed'],
    ['--help', '--json'],
  ]) {
    assert.throws(() => parseStatusArgs(argv), NotificationOperatorUsageError);
  }
});

test('human reports preserve the same projection and status facts as JSON reports', () => {
  const projection = projectionReport();
  const projectionHuman = renderProjectionHuman(projection);
  for (const expected of [
    'page_completed',
    'mode=dry_run',
    'selected=2',
    'materialized=1',
    'opaque-continuation',
    'suppressed_no_consent',
    'External delivery: not attempted',
  ]) assert.match(projectionHuman, new RegExp(expected, 'i'));

  const backfillHuman = renderBackfillHuman(projection);
  assert.match(backfillHuman, /read-only/i);
  assert.match(backfillHuman, /Historical writes: none/i);

  const status = statusReport();
  const statusHuman = renderStatusHuman(status);
  for (const expected of [
    'local, read-only',
    'inspection_ready',
    'Remote migration: unknown',
    'delivery worker: not_configured',
    'target_hit/suppressed=1',
    'outbox_1',
    'suppressed_no_consent',
  ]) assert.match(statusHuman, new RegExp(expected, 'i'));
});

test('projection runner defaults to dry-run and help or invalid input never reaches persistence', async () => {
  const streams = io();
  let invocationCount = 0;
  let receivedMode: string | undefined;
  const invoke = async (options: ReturnType<typeof parseProjectionArgs>) => {
    invocationCount += 1;
    receivedMode = options.mode;
    return projectionReport();
  };

  assert.equal(await runProjectionOperator(['--help'], streams.adapter, invoke), 0);
  assert.equal(streams.output.at(-1), PROJECT_USAGE);
  assert.equal(invocationCount, 0);

  assert.equal(await runProjectionOperator(['--cutoff', 'bad'], streams.adapter, invoke), 2);
  assert.equal(invocationCount, 0);

  assert.equal(await runProjectionOperator([
    '--cutoff', cutoff, '--json',
  ], streams.adapter, invoke), 0);
  assert.equal(receivedMode, 'dry_run');
  assert.equal(invocationCount, 1);
  const { profileId, ...visibleReport } = projectionReport();
  void profileId;
  assert.deepEqual(JSON.parse(streams.output.at(-1) ?? '{}'), visibleReport);
});

test('backfill and status runners use injected read-only boundaries and stable JSON', async () => {
  const streams = io();
  let backfillCalls = 0;
  let statusCalls = 0;

  assert.equal(await runBackfillOperator([
    '--from-id', '1',
    '--through-id', '5',
    '--cutoff', cutoff,
    '--confirm-historical-preview',
    '--json',
  ], streams.adapter, async (options) => {
    backfillCalls += 1;
    assert.equal(options.includeNeedsReview, false);
    return projectionReport({ warnings: ['Historical preview performed no writes.'] });
  }), 0);
  assert.equal(backfillCalls, 1);
  assert.equal(JSON.parse(streams.output.at(-1) ?? '{}').mode, 'dry_run');

  assert.equal(await runStatusOperator([
    '--state', 'suppressed', '--category', 'target_hit', '--json',
  ], streams.adapter, async (options) => {
    statusCalls += 1;
    assert.equal(options.state, 'suppressed');
    assert.equal(options.category, 'target_hit');
    return statusReport();
  }), 0);
  assert.equal(statusCalls, 1);
  assert.deepEqual(JSON.parse(streams.output.at(-1) ?? '{}'), statusReport());

  const serialized = streams.output.at(-1) ?? '';
  for (const forbidden of [
    'payloadJson', 'payload_json', 'payloadFingerprint', 'dedupKey',
    'leaseToken', 'ownerToken', 'configurationFingerprint',
  ]) assert.doesNotMatch(serialized, new RegExp(forbidden, 'iu'));
});

test('all runners return sanitized stable errors without exposing thrown system details', async () => {
  const secret = 'secret payload and owner token';
  const cases = [
    () => runProjectionOperator(
      ['--cutoff', cutoff],
      io().adapter,
      async () => { throw new Error(secret); },
    ),
    () => runBackfillOperator(
      ['--from-id', '1', '--through-id', '2', '--cutoff', cutoff,
        '--confirm-historical-preview'],
      io().adapter,
      async () => { throw new Error(secret); },
    ),
    () => runStatusOperator(
      [],
      io().adapter,
      async () => { throw new Error(secret); },
    ),
  ];
  for (const run of cases) assert.equal(await run(), 1);

  const streams = io();
  assert.equal(await runStatusOperator([], streams.adapter, async () => {
    throw new Error(secret);
  }), 1);
  assert.doesNotMatch(streams.errors.at(-1) ?? '', /secret payload|owner token/iu);

  assert.equal(await runProjectionOperator([
    '--cutoff', cutoff, '--json',
  ], streams.adapter, async () => { throw new Error(secret); }), 1);
  const failure = JSON.parse(streams.errors.at(-1) ?? '{}');
  assert.deepEqual(failure, {
    error: {
      category: 'system_failure',
      message: 'The notification operator could not produce a report.',
    },
  });
});
