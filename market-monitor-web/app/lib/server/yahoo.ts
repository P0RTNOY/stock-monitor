import { normalizeTickerSearchResults, type TickerSuggestion } from '../tickers';

type YahooChart = {
  chart?: {
    error?: { code?: string; description?: string } | null;
    result?: Array<{
      meta?: {
        currency?: string;
        regularMarketPrice?: number;
        previousClose?: number;
        chartPreviousClose?: number;
        regularMarketTime?: number;
      };
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
  };
};

const MAX_PROVIDER_BYTES = 256 * 1024;
const PROVIDER_HEADERS = { 'User-Agent': 'Mozilla/5.0 Northstar market monitor' };

async function providerJson(url: URL) {
  const response = await fetch(url, {
    headers: PROVIDER_HEADERS,
    redirect: 'manual',
    signal: AbortSignal.timeout(8_000),
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!response.ok) throw new Error('Yahoo market provider unavailable');
  const body = await response.text();
  if (body.length > MAX_PROVIDER_BYTES) throw new Error('Yahoo market provider response too large');
  return JSON.parse(body) as unknown;
}

export async function searchYahooTickers(query: string): Promise<TickerSuggestion[]> {
  const url = new URL('https://query2.finance.yahoo.com/v1/finance/search');
  url.searchParams.set('q', query);
  url.searchParams.set('quotesCount', '10');
  url.searchParams.set('newsCount', '0');
  url.searchParams.set('enableFuzzyQuery', 'false');
  return normalizeTickerSearchResults(await providerJson(url));
}

export async function resolveYahooTicker(symbol: string) {
  const results = await searchYahooTickers(symbol);
  return results.find((candidate) => candidate.symbol === symbol) ?? null;
}

export async function fetchYahooQuote(symbol: string) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set('range', '1mo');
  url.searchParams.set('interval', '1d');
  url.searchParams.set('includePrePost', 'false');
  url.searchParams.set('events', 'div,splits');
  const payload = await providerJson(url) as YahooChart;
  const chart = payload.chart?.result?.[0];
  if (!chart || payload.chart?.error) throw new Error(`Market data unavailable for ${symbol}`);
  const closes = (chart.indicators?.quote?.[0]?.close ?? [])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const price = chart.meta?.regularMarketPrice ?? closes.at(-1) ?? null;
  if (price === null || !Number.isFinite(price)) throw new Error(`Market data unavailable for ${symbol}`);
  const previousCloseValue = chart.meta?.previousClose ?? chart.meta?.chartPreviousClose ?? closes.at(-2) ?? null;
  const previousClose = previousCloseValue !== null && Number.isFinite(previousCloseValue) ? previousCloseValue : null;
  const change = previousClose === null ? null : price - previousClose;
  const changePct = change !== null && previousClose ? (change / previousClose) * 100 : null;
  return {
    symbol,
    currency: chart.meta?.currency?.toUpperCase() ?? null,
    price,
    previousClose,
    change,
    changePct,
    history: closes.slice(-22),
    updatedAt: chart.meta?.regularMarketTime
      ? new Date(chart.meta.regularMarketTime * 1000).toISOString()
      : chart.timestamp?.at(-1)
        ? new Date((chart.timestamp.at(-1) as number) * 1000).toISOString()
        : null,
  };
}
