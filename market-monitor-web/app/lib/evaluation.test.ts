import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLatestRequestGate,
  evaluationCurrency,
  evaluationPresentation,
  filterReviewItems,
  isEvaluationRun,
  isForecastReviewItem,
  readableEvaluationReason,
} from './evaluation.ts';
import type { EvaluationRun, ForecastReviewItem } from './types.ts';

function run(kind: EvaluationRun['resultKind'] = 'needs_review'): EvaluationRun {
  return {
    id: 9,
    profileId: 1,
    forecastId: 4,
    resultKind: kind,
    reasonCode: kind === 'needs_review' ? 'same_bar_target_invalidation_collision' : 'target_touched',
    explanation: 'The stored completed bar evidence explains the result.',
    evaluatorVersion: '1.0.0',
    rulesetVersion: 'forecast-evaluation-ruleset-v1',
    evaluatedThrough: '2026-08-21',
    evaluationCutoff: '2026-08-24T10:00:00Z',
    evidence: {
      activation_cutoff: '2026-08-20T20:00:00Z',
      activation_currency: 'USD',
      observed_currency: 'USD',
      observation_count: 1,
      first_eligible_observation: {
        symbol: 'NVDA', market_date: '2026-08-21', timestamp: '2026-08-21T20:00:00Z',
        completed_at: '2026-08-21T20:15:00Z', open: 160, high: 181, low: 139, close: 170,
        volume: 1000, provider: 'Yahoo', adjustment_mode: 'raw', corporate_action_flags: [],
      },
      last_eligible_observation: {
        symbol: 'NVDA', market_date: '2026-08-21', timestamp: '2026-08-21T20:00:00Z',
        completed_at: '2026-08-21T20:15:00Z', open: 160, high: 181, low: 139, close: 170,
        volume: 1000, provider: 'Yahoo', adjustment_mode: 'raw', corporate_action_flags: [],
      },
      triggering_observation: {
        symbol: 'NVDA', market_date: '2026-08-21', timestamp: '2026-08-21T20:00:00Z',
        completed_at: '2026-08-21T20:15:00Z', open: 160, high: 181, low: 139, close: 170,
        volume: 1000, provider: 'Yahoo', adjustment_mode: 'raw', corporate_action_flags: [],
      },
      target_boundary: 180,
      target_range: null,
      invalidation_boundary: 140,
      detected_at: 'within_bar',
      observed_open: null,
      crossed_boundary: null,
      corporate_action_findings: [],
      coverage_findings: {},
      warnings: ['Both boundaries were touched in one bar.'],
    },
    warnings: ['Both boundaries were touched in one bar.'],
    inputFingerprint: 'a'.repeat(64),
    createdAt: '2026-08-24T10:00:01Z',
  };
}

function review(acknowledgedAt: string | null): ForecastReviewItem {
  return {
    id: acknowledgedAt ? 2 : 1,
    profileId: 1,
    forecastId: 4,
    evaluationRunId: 9,
    reviewKind: 'needs_review',
    acknowledgedAt,
    createdAt: '2026-08-24T10:00:01Z',
    symbol: 'NVDA',
    forecastStatus: 'active',
    target: { kind: 'price', price: 180 },
    invalidationPrice: 140,
    analysisSnapshotId: 3,
    run: run(),
  };
}

test('evaluation presentation never describes needs_review as a failure', () => {
  const ambiguous = evaluationPresentation('needs_review', 'same_bar_target_invalidation_collision');
  assert.equal(ambiguous.eyebrow, 'Ambiguous evidence');
  assert.equal(ambiguous.tone, 'attention');
  assert.doesNotMatch(`${ambiguous.heading} ${ambiguous.description}`, /fail/i);

  const insufficient = evaluationPresentation('needs_review', 'insufficient_horizon_coverage');
  assert.equal(insufficient.eyebrow, 'Insufficient evidence');
  assert.match(insufficient.description, /remains unchanged/i);
  assert.equal(evaluationPresentation('needs_review', 'currency_mismatch').eyebrow, 'Insufficient evidence');
  assert.equal(evaluationPresentation('needs_review', 'currency_unverified').eyebrow, 'Insufficient evidence');
});

test('presentation distinguishes proven terminal results from pending evaluation', () => {
  assert.equal(evaluationPresentation('target_hit').eyebrow, 'Proven terminal result');
  assert.equal(evaluationPresentation('invalidated').tone, 'proven');
  assert.equal(evaluationPresentation('no_change').eyebrow, 'Latest evaluation complete');
});

test('latest-request gate prevents an obsolete response from replacing a newer filter result', async () => {
  const gate = createLatestRequestGate();
  const writes: string[] = [];
  const firstRequest = gate.begin();
  const secondRequest = gate.begin();
  await Promise.resolve();
  if (gate.isCurrent(secondRequest)) writes.push('acknowledged');
  await Promise.resolve();
  if (gate.isCurrent(firstRequest)) writes.push('unacknowledged');
  assert.deepEqual(writes, ['acknowledged']);
});

test('strict guards validate nested evidence and matching review ownership', () => {
  const validRun = run();
  assert.equal(isEvaluationRun(validRun), true);
  assert.equal(evaluationCurrency(validRun), 'USD');
  assert.equal(isEvaluationRun({ ...validRun, evidence: { ...validRun.evidence, activation_currency: '' } }), false);
  assert.equal(isEvaluationRun({ ...validRun, evidence: { ...validRun.evidence, triggering_observation: { symbol: 'NVDA' } } }), false);
  assert.equal(isEvaluationRun({ ...validRun, evaluatedThrough: '2026-08-21T20:00:00Z' }), false);
  assert.equal(isEvaluationRun({ ...validRun, evidence: { ...validRun.evidence, observation_count: 1, first_eligible_observation: null } }), false);
  assert.equal(isEvaluationRun({ ...validRun, evidence: { ...validRun.evidence, observation_count: 0 } }), false);
  assert.equal(isEvaluationRun({
    ...validRun,
    evidence: {
      ...validRun.evidence,
      observation_count: 0,
      first_eligible_observation: null,
      last_eligible_observation: null,
      triggering_observation: null,
    },
  }), true);
  assert.equal(isForecastReviewItem(review(null)), true);
  assert.equal(isForecastReviewItem({ ...review(null), forecastId: 99 }), false);
});

test('review visibility filters acknowledgement without changing stored ordering', () => {
  const items = [review(null), review('2026-08-24T11:00:00Z')];
  assert.deepEqual(filterReviewItems(items, 'unacknowledged').map(({ id }) => id), [1]);
  assert.deepEqual(filterReviewItems(items, 'acknowledged').map(({ id }) => id), [2]);
  assert.deepEqual(filterReviewItems(items, 'all').map(({ id }) => id), [1, 2]);
  assert.equal(readableEvaluationReason('same_bar_target_invalidation_collision'), 'Same Bar Target Invalidation Collision');
});
