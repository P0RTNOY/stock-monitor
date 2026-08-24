import assert from 'node:assert/strict';
import test from 'node:test';
import { isTickerSuggestion, normalizeTickerQuery, normalizeTickerSearchResults } from './tickers.ts';

test('ticker queries are normalized and bounded before provider lookup', () => {
  assert.equal(normalizeTickerQuery(' nv.. '), 'NV..');
  assert.equal(normalizeTickerQuery('nvidia corp'), 'NVIDIACORP');
  assert.equal(normalizeTickerQuery('^nv'), 'NV');
  assert.equal(normalizeTickerQuery(null), '');
});

test('provider results retain real equities and ETFs while rejecting unsupported assets', () => {
  const results = normalizeTickerSearchResults({
    quotes: [
      { symbol: 'NVDA', longname: 'NVIDIA Corporation', quoteType: 'EQUITY', exchDisp: 'NASDAQ' },
      { symbol: 'NVDA', shortname: 'Duplicate', quoteType: 'EQUITY', exchDisp: 'NASDAQ' },
      { symbol: 'NVDS', shortname: 'AXS 1.25X NVDA Bear Daily ETF', quoteType: 'ETF', exchange: 'NGM' },
      { symbol: '^NVDA', shortname: 'Index', quoteType: 'INDEX', exchDisp: 'Index' },
      { symbol: 'BTC-USD', shortname: 'Bitcoin', quoteType: 'CRYPTOCURRENCY', exchDisp: 'CCC' },
      { symbol: '', shortname: 'Broken', quoteType: 'EQUITY', exchDisp: 'NASDAQ' },
    ],
  });

  assert.deepEqual(results, [
    { symbol: 'NVDA', companyName: 'NVIDIA Corporation', exchange: 'NASDAQ', quoteType: 'Equity' },
    { symbol: 'NVDS', companyName: 'AXS 1.25X NVDA Bear Daily ETF', exchange: 'NGM', quoteType: 'ETF' },
  ]);
});

test('ticker suggestions have a strict client runtime boundary', () => {
  assert.equal(isTickerSuggestion({ symbol: 'NVDA', companyName: 'NVIDIA Corporation', exchange: 'NASDAQ', quoteType: 'Equity' }), true);
  assert.equal(isTickerSuggestion({ symbol: 'NVDA', companyName: '', exchange: 'NASDAQ', quoteType: 'Equity' }), false);
  assert.equal(isTickerSuggestion({ symbol: 'BTC-USD', companyName: 'Bitcoin', exchange: 'CCC', quoteType: 'Crypto' }), false);
});
