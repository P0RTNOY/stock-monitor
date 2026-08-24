export type TickerSuggestion = {
  symbol: string;
  companyName: string;
  exchange: string;
  quoteType: 'Equity' | 'ETF';
};

export const TICKER_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;
const SUPPORTED_QUOTE_TYPES = new Map([
  ['EQUITY', 'Equity' as const],
  ['ETF', 'ETF' as const],
]);

function text(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function normalizeTickerQuery(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '').slice(0, 10);
}

export function normalizeTickerSearchResults(value: unknown, limit = 8): TickerSuggestion[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const quotes = (value as { quotes?: unknown }).quotes;
  if (!Array.isArray(quotes)) return [];

  const results: TickerSuggestion[] = [];
  const seen = new Set<string>();
  for (const candidate of quotes) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const quote = candidate as Record<string, unknown>;
    const symbol = text(quote.symbol, 10).toUpperCase();
    const quoteType = SUPPORTED_QUOTE_TYPES.get(text(quote.quoteType, 16).toUpperCase());
    if (!TICKER_PATTERN.test(symbol) || !quoteType || seen.has(symbol)) continue;
    const companyName = text(quote.longname, 80) || text(quote.shortname, 80) || symbol;
    const exchange = text(quote.exchDisp, 40) || text(quote.exchange, 40) || 'Exchange unavailable';
    results.push({ symbol, companyName, exchange, quoteType });
    seen.add(symbol);
    if (results.length >= limit) break;
  }
  return results;
}

export function isTickerSuggestion(value: unknown): value is TickerSuggestion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const suggestion = value as Record<string, unknown>;
  return typeof suggestion.symbol === 'string'
    && TICKER_PATTERN.test(suggestion.symbol)
    && typeof suggestion.companyName === 'string'
    && Boolean(suggestion.companyName)
    && typeof suggestion.exchange === 'string'
    && (suggestion.quoteType === 'Equity' || suggestion.quoteType === 'ETF');
}
