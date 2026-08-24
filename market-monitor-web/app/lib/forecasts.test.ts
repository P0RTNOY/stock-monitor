import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterForecasts,
  forecastSeedFromScenario,
  forecastTargetLabel,
  formatLocalDate,
  groupForecasts,
  isQualifyingForecastScenario,
  todayLocalDate,
  defaultEvaluationDate,
} from './forecasts.ts';
import type { Forecast, TechnicalAnalysisReport } from './types.ts';

function forecast(id: number, symbol: string, status: Forecast['status']): Forecast {
  return {
    id,
    symbol,
    status,
    direction: 'bullish',
    confidence: 70,
    thesis: 'A measurable thesis.',
    supportingEvidence: 'Supporting evidence.',
    counterEvidence: 'Counter evidence.',
    setupTag: 'Breakout',
    evaluationDate: '2026-11-24',
    target: { kind: 'price', price: 200 },
    invalidationPrice: 140,
    activatedAt: status === 'draft' ? null : '2026-08-24T10:00:00Z',
    activationPrice: status === 'draft' ? null : 160,
    activationCurrency: status === 'draft' ? null : 'USD',
    marketDataAsOf: status === 'draft' ? null : '2026-08-24T09:59:00Z',
    marketProvider: status === 'draft' ? null : 'Yahoo',
    resolvedAt: null,
    resolutionReason: null,
    createdAt: '2026-08-24T09:00:00Z',
    updatedAt: '2026-08-24T10:00:00Z',
    events: [],
    analysisSnapshot: null,
    pendingAnalysis: null,
  };
}

const report = {
  symbol: 'NVDA',
  status: 'scenario_detected',
  generated_at: '2026-08-24T10:00:00Z',
  as_of: '2026-08-23T20:00:00Z',
  engine_version: '1.0',
  ruleset_version: 'v1',
  provider: 'Yahoo',
  adjustment_mode: 'raw',
  data_hash: 'a'.repeat(64),
  summary: 'A rectangle is being tracked.',
  timeframes: {},
  evidence: [],
  warnings: [],
  scenarios: [{
    scenario_id: 'rectangle-1',
    setup: 'rectangle',
    timeframe: '1d',
    direction: 'bullish',
    lifecycle_state: 'confirmed',
    range_lower: 150,
    range_upper: 170,
    range_height: 20,
    range_started_at: '2026-07-20T20:00:00Z',
    established_at: '2026-08-01T20:00:00Z',
    retested_at: null,
    terminal_at: null,
    last_event_at: '2026-08-23T20:00:00Z',
    event_reason: null,
    confirmation_condition: 'Completed close above the range.',
    confirmed_at: '2026-08-23T20:00:00Z',
    entry_trigger: 'Research assumption only.',
    entry_assumption: 171,
    analytical_invalidation: 'Close back inside the range.',
    measured_target: 190,
    intermediate_levels: [],
    risk: null,
    evidence_ids: ['setup.rectangle.geometry.1d'],
    warnings: [],
  }],
} satisfies TechnicalAnalysisReport;

test('forecast filters combine exact status and symbol selections', () => {
  const values = [forecast(1, 'NVDA', 'draft'), forecast(2, 'AAPL', 'active'), forecast(3, 'NVDA', 'expired')];
  assert.deepEqual(filterForecasts(values, 'all', 'NVDA').map(({ id }) => id), [1, 3]);
  assert.deepEqual(filterForecasts(values, 'active', '').map(({ id }) => id), [2]);
  assert.deepEqual(filterForecasts(values, 'draft', 'AAPL'), []);
});

test('forecast grouping keeps editable, active, and closed records distinct', () => {
  const values = [forecast(1, 'NVDA', 'draft'), forecast(2, 'AAPL', 'active'), forecast(3, 'MSFT', 'invalidated')];
  const groups = groupForecasts(values);
  assert.deepEqual(groups.drafts.map(({ id }) => id), [1]);
  assert.deepEqual(groups.active.map(({ id }) => id), [2]);
  assert.deepEqual(groups.closed.map(({ id }) => id), [3]);
});

test('calendar dates are formatted without a UTC conversion', () => {
  assert.equal(todayLocalDate(new Date(2026, 0, 2, 0, 5)), '2026-01-02');
  assert.equal(formatLocalDate('2026-01-02'), new Date(2026, 0, 2).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  }));
  assert.equal(formatLocalDate('2026-02-31'), 'Unavailable');
  assert.equal(defaultEvaluationDate(new Date(2026, 0, 31)), '2026-04-30');
});

test('target presentation supports a price and a range', () => {
  assert.equal(forecastTargetLabel({ kind: 'price', price: 180 }, 'USD'), '$180.00');
  assert.equal(forecastTargetLabel({ kind: 'range', lower: 180, upper: 190 }, 'USD'), '$180.00–$190.00');
});

test('only active, directional scenarios with finite targets seed forecasts', () => {
  const scenario = report.scenarios[0];
  assert.equal(isQualifyingForecastScenario(report, scenario), true);
  assert.deepEqual(forecastSeedFromScenario(report, scenario), {
    symbol: 'NVDA',
    direction: 'bullish',
    setupTag: 'Rectangle',
    target: { kind: 'price', price: 190 },
    analysisReport: report,
    analysisScenarioId: 'rectangle-1',
  });
  assert.equal(forecastSeedFromScenario(report, { ...scenario, lifecycle_state: 'expired' }), null);
  assert.equal(forecastSeedFromScenario(report, { ...scenario, direction: 'undetermined' }), null);
});
