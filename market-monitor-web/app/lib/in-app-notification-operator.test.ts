import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IN_APP_BACKFILL_USAGE,
  IN_APP_PROJECT_USAGE,
  InAppOperatorUsageError,
  parseInAppBackfillArgs,
  parseInAppProjectArgs,
  parseInAppStatusArgs,
  renderInAppProjection,
  visibleInAppProjection,
} from '../../operator/forecast-in-app-notifications.ts';

const CUTOFF = '2026-08-26T12:00:00.000Z';

test('in-app project operator is dry-run by default and commit is explicit', () => {
  assert.equal(parseInAppProjectArgs(['--cutoff', CUTOFF]).mode, 'dry_run');
  assert.equal(parseInAppProjectArgs(['--cutoff', CUTOFF, '--commit', '--limit', '100']).mode, 'commit');
  assert.throws(() => parseInAppProjectArgs(['--cutoff', CUTOFF, '--commit', '--dry-run']), InAppOperatorUsageError);
  assert.throws(() => parseInAppProjectArgs(['--cutoff', CUTOFF, '--limit', '101']), InAppOperatorUsageError);
  assert.match(IN_APP_PROJECT_USAGE, /never evaluates forecasts, sends email, or calls an external provider/u);
});

test('historical backfill requires bounded preview confirmation and a second commit confirmation', () => {
  const base = ['--from-id', '1', '--through-id', '10', '--cutoff', CUTOFF, '--confirm-historical-preview'];
  assert.equal(parseInAppBackfillArgs(base).mode, 'dry_run');
  assert.throws(() => parseInAppBackfillArgs(base.filter((value) => value !== '--confirm-historical-preview')), InAppOperatorUsageError);
  assert.throws(() => parseInAppBackfillArgs([...base, '--commit']), /confirm-historical-commit/u);
  assert.equal(parseInAppBackfillArgs([...base, '--commit', '--confirm-historical-commit']).mode, 'commit');
  assert.throws(() => parseInAppBackfillArgs(['--from-id', '10', '--through-id', '1', '--cutoff', CUTOFF, '--confirm-historical-preview']), InAppOperatorUsageError);
  assert.match(IN_APP_BACKFILL_USAGE, /never reset read state/u);
});

test('status arguments are allowlisted and renderer is redacted', () => {
  assert.deepEqual(parseInAppStatusArgs(['--json']), { help: false, json: true });
  assert.throws(() => parseInAppStatusArgs(['--profile', '1']), InAppOperatorUsageError);
  const output = renderInAppProjection({
    projectorVersion: 'forecast-in-app-projector-1.0.0',
    presentationVersion: 'forecast-in-app-presentation-1.0.0',
    mode: 'dry_run', operation: 'forward', disposition: 'page_completed',
    baselineEvaluationRunId: 4, startingEvaluationRunId: 4, endingEvaluationRunId: 5,
    selectedCount: 1, materializedCount: 1, duplicateCount: 0, invalidSourceCount: 0,
    unsupportedSourceCount: 0, hasMore: false, stoppedByCutoff: false,
    items: [{ sourceIntentId: 'secret-internal-id', evaluationRunId: 5, classification: 'materialized', reasonCode: 'trusted_intent_materialized', entryWouldBeCreated: true }],
    warnings: [],
  });
  assert.match(output, /external delivery: not attempted/u);
  assert.doesNotMatch(output, /secret-internal-id/u);
  assert.doesNotMatch(JSON.stringify(visibleInAppProjection({
    projectorVersion: 'forecast-in-app-projector-1.0.0',
    presentationVersion: 'forecast-in-app-presentation-1.0.0',
    mode: 'dry_run', operation: 'forward', disposition: 'page_completed',
    baselineEvaluationRunId: 4, startingEvaluationRunId: 4, endingEvaluationRunId: 5,
    selectedCount: 1, materializedCount: 1, duplicateCount: 0, invalidSourceCount: 0,
    unsupportedSourceCount: 0, hasMore: false, stoppedByCutoff: false,
    items: [{ sourceIntentId: 'secret-internal-id', evaluationRunId: 5, classification: 'materialized', reasonCode: 'trusted_intent_materialized', entryWouldBeCreated: true }], warnings: [],
  })), /secret-internal-id/u);
});
