import assert from 'node:assert/strict';
import test from 'node:test';
import { portfolioHistory, portfolioMetrics, positionValue } from './portfolio.ts';
import type { Position, QuoteMap } from './types.ts';

const positions: Position[] = [
  { id: 1, symbol: 'REAL', companyName: 'Real Co', shares: 2, averageCost: 10, createdAt: '2026-01-01T00:00:00Z' },
  { id: 2, symbol: 'MISS', companyName: 'Missing Quote Co', shares: 3, averageCost: 20, createdAt: '2026-01-01T00:00:00Z' },
];

const realQuote = {
  symbol: 'REAL',
  currency: 'USD',
  price: 15,
  previousClose: 14,
  change: 1,
  changePct: 7.14,
  history: [12, 13, 15],
  updatedAt: '2026-01-02T00:00:00Z',
};

test('a missing quote never falls back to the saved average cost', () => {
  assert.equal(positionValue(positions[1], { REAL: realQuote }), null);
  assert.equal(positionValue(positions[0], { REAL: realQuote }), 30);
});

test('portfolio totals stay unavailable while any position lacks a real quote', () => {
  const metrics = portfolioMetrics(positions, { REAL: realQuote }, 100);

  assert.equal(metrics.investedValue, null);
  assert.equal(metrics.totalValue, null);
  assert.equal(metrics.totalReturn, null);
  assert.equal(metrics.dailyChange, null);
  assert.equal(metrics.costBasis, 80);
  assert.deepEqual(metrics.unpricedSymbols, ['MISS']);
});

test('portfolio totals use provider values when quote coverage is complete', () => {
  const quotes: QuoteMap = {
    REAL: realQuote,
    MISS: { ...realQuote, symbol: 'MISS', price: 25, previousClose: 24, history: [22, 24, 25] },
  };
  const metrics = portfolioMetrics(positions, quotes, 100);

  assert.equal(metrics.investedValue, 105);
  assert.equal(metrics.totalValue, 205);
  assert.equal(metrics.totalReturn, 25);
  assert.equal(metrics.dailyChange, 5);
  assert.deepEqual(metrics.unpricedSymbols, []);
});

test('portfolio history is empty instead of synthetic when coverage is incomplete', () => {
  assert.deepEqual(portfolioHistory(positions, { REAL: realQuote }, 100), []);

  const quotes: QuoteMap = {
    REAL: realQuote,
    MISS: { ...realQuote, symbol: 'MISS', history: [20, 25] },
  };
  assert.deepEqual(portfolioHistory(positions, quotes, 100), [186, 205]);
});
