import { isTechnicalAnalysisReport } from '../analysis.ts';
import { TICKER_PATTERN, type TickerSuggestion } from '../tickers.ts';
import { authorizeProfileScope, type AuthorizedProfileScope } from './auth/enforcement.ts';
import { authorizationErrorResponse } from './auth/http.ts';
import type { AuthorizationAction, ResourceScope } from './auth/types.ts';

const DIRECTIONS = new Set(['Bullish', 'Bearish', 'Neutral', 'Watching']);
const CONDITIONS = new Set(['Price above', 'Price below', 'Daily move above %', 'Daily move below %']);
const ANALYSIS_REQUEST_FIELDS = new Set([
  'symbol',
  'accountRisk',
  'commissionPerUnit',
  'expectedSlippagePerUnit',
  'executionStopPrice',
]);
const MAX_ANALYSIS_REQUEST_BYTES = 4 * 1024;

type Payload = Record<string, unknown>;

type MarketQuote = {
  symbol: string;
  provider: string;
  currency: string | null;
  price: number;
  previousClose: number | null;
  change: number | null;
  changePct: number | null;
  history: number[];
  updatedAt: string | null;
};

export type DirectSqlHumanRouteDependencies = {
  authorizeHumanRequest<A extends AuthorizationAction>(
    request: Request,
    action: A,
    resource?: Omit<ResourceScope, 'profileId'>,
  ): Promise<AuthorizedProfileScope<A>>;
  ensureDatabase(): Promise<void>;
  getD1(): D1Database;
  fetchYahooQuote(symbol: string): Promise<MarketQuote>;
  resolveYahooTicker(symbol: string): Promise<TickerSuggestion | null>;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  now(): Date;
  analysisApiUrl(): string;
};

function cleanText(value: unknown, field: string, maxLength = 240) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${field} is required.`);
  return text.slice(0, maxLength);
}

function cleanSymbol(value: unknown) {
  const symbol = cleanText(value, 'Symbol', 10).toUpperCase();
  if (!TICKER_PATTERN.test(symbol)) throw new Error('Enter a valid ticker symbol.');
  return symbol;
}

function cleanNumber(value: unknown, field: string, min: number, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${field} must be between ${min} and ${max}.`);
  }
  return number;
}

function cleanId(value: unknown) {
  return Math.trunc(cleanNumber(value, 'ID', 1));
}

async function cleanTrackedSymbol(d1: D1Database, profileId: number, value: unknown) {
  const symbol = cleanSymbol(value);
  const tracked = await d1.prepare(`SELECT symbol FROM positions WHERE profile_id = ? AND symbol = ?
    UNION SELECT symbol FROM watchlist_items WHERE profile_id = ? AND symbol = ? LIMIT 1`)
    .bind(profileId, symbol, profileId, symbol).first();
  if (!tracked) throw new Error('Save this symbol as a position or watchlist item first.');
  return symbol;
}

function optionalNumber(payload: Payload, field: string, positive: boolean) {
  const value = payload[field];
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number.`);
  }
  if (positive ? value <= 0 : value < 0) {
    throw new Error(`${field} must be ${positive ? 'positive' : 'non-negative'}.`);
  }
  return value;
}

function normalizeAnalysisPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Request body must be an object.');
  }
  const values = payload as Payload;
  const unknown = Object.keys(values).filter((key) => !ANALYSIS_REQUEST_FIELDS.has(key));
  if (unknown.length) throw new Error('Request contains unsupported fields.');
  const symbol = typeof values.symbol === 'string' ? values.symbol.trim().toUpperCase() : '';
  if (!TICKER_PATTERN.test(symbol)) throw new Error('Enter a valid ticker symbol.');
  return {
    symbol,
    accountRisk: optionalNumber(values, 'accountRisk', true),
    commissionPerUnit: optionalNumber(values, 'commissionPerUnit', false),
    expectedSlippagePerUnit: optionalNumber(values, 'expectedSlippagePerUnit', false),
    executionStopPrice: optionalNumber(values, 'executionStopPrice', true),
  };
}

export function createDirectSqlHumanRouteHandlers(dependencies: DirectSqlHumanRouteDependencies) {
  async function readWorkspace(profileId: number) {
    const d1 = dependencies.getD1();
    const [profile, positions, watchlist, journalEntries, alerts] = await Promise.all([
      d1.prepare('SELECT id, name, base_currency AS baseCurrency, cash_balance AS cashBalance FROM investment_profiles WHERE id = ?')
        .bind(profileId).first(),
      d1.prepare('SELECT id, symbol, company_name AS companyName, shares, average_cost AS averageCost, created_at AS createdAt FROM positions WHERE profile_id = ? ORDER BY shares * average_cost DESC')
        .bind(profileId).all(),
      d1.prepare('SELECT id, symbol, company_name AS companyName, created_at AS createdAt FROM watchlist_items WHERE profile_id = ? ORDER BY symbol')
        .bind(profileId).all(),
      d1.prepare('SELECT id, entry_date AS entryDate, symbol, direction, confidence, thesis, target, created_at AS createdAt FROM journal_entries WHERE profile_id = ? ORDER BY entry_date DESC, id DESC LIMIT 100')
        .bind(profileId).all(),
      d1.prepare('SELECT id, symbol, condition_type AS conditionType, threshold, note, active, created_at AS createdAt FROM review_alerts WHERE profile_id = ? ORDER BY active DESC, symbol LIMIT 100')
        .bind(profileId).all(),
    ]);

    return {
      profile,
      positions: positions.results,
      watchlist: watchlist.results,
      journalEntries: journalEntries.results,
      alerts: alerts.results.map((alert) => ({ ...alert, active: Boolean(alert.active) })),
    };
  }

  async function resolveCanonicalTicker(d1: D1Database, profileId: number, value: unknown) {
    const symbol = cleanSymbol(value);
    const [ticker, profile] = await Promise.all([
      dependencies.resolveYahooTicker(symbol),
      d1.prepare('SELECT base_currency AS baseCurrency FROM investment_profiles WHERE id = ?')
        .bind(profileId).first<{ baseCurrency: string }>(),
    ]);
    if (!ticker) throw new Error('Choose a valid stock or ETF from ticker search.');
    if (!profile) throw new Error('Investment profile unavailable.');

    const quote = await dependencies.fetchYahooQuote(ticker.symbol);
    if (!quote.currency || quote.currency !== profile.baseCurrency.toUpperCase()) {
      throw new Error(`Choose a ticker quoted in ${profile.baseCurrency.toUpperCase()}.`);
    }
    return ticker;
  }

  async function workspaceGet(request: Request) {
    try {
      const scope = await dependencies.authorizeHumanRequest(request, 'workspace_read');
      await dependencies.ensureDatabase();
      return Response.json(await readWorkspace(scope.profileId), { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      const authorizationResponse = authorizationErrorResponse(error);
      if (authorizationResponse) return authorizationResponse;
      console.error('workspace GET failed', error instanceof Error ? error.name : 'UnknownError');
      return Response.json({ error: 'Your saved workspace could not be loaded.' },
        { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  async function workspacePost(request: Request) {
    try {
      const readScope = await dependencies.authorizeHumanRequest(request, 'workspace_read');
      await dependencies.ensureDatabase();
      const payload = await request.json() as Payload;
      const action = cleanText(payload.action, 'Action', 40);
      const writeAction = action === 'updateProfile' ? 'profile_update' : 'portfolio_write';
      const scope = authorizeProfileScope(readScope.principal, writeAction, { profileId: readScope.profileId });
      const profileId = scope.profileId;
      const d1 = dependencies.getD1();
      const createdAt = dependencies.now().toISOString();

      if (action === 'addPosition') {
        const { symbol, companyName } = await resolveCanonicalTicker(d1, profileId, payload.symbol);
        const shares = cleanNumber(payload.shares, 'Shares', 0.000001, 1_000_000_000);
        const averageCost = cleanNumber(payload.averageCost, 'Average cost', 0, 10_000_000);
        await d1.prepare(`INSERT INTO positions (profile_id, symbol, company_name, shares, average_cost, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(profile_id, symbol) DO UPDATE SET
            company_name = excluded.company_name,
            average_cost = ((positions.shares * positions.average_cost) + (excluded.shares * excluded.average_cost)) / (positions.shares + excluded.shares),
            shares = positions.shares + excluded.shares`)
          .bind(profileId, symbol, companyName, shares, averageCost, createdAt).run();
      } else if (action === 'deletePosition') {
        await d1.prepare('DELETE FROM positions WHERE id = ? AND profile_id = ?')
          .bind(cleanId(payload.id), profileId).run();
      } else if (action === 'addWatchlist') {
        const { symbol, companyName } = await resolveCanonicalTicker(d1, profileId, payload.symbol);
        await d1.prepare(`INSERT INTO watchlist_items (profile_id, symbol, company_name, created_at)
          VALUES (?, ?, ?, ?) ON CONFLICT(profile_id, symbol) DO UPDATE SET company_name = excluded.company_name`)
          .bind(profileId, symbol, companyName, createdAt).run();
      } else if (action === 'deleteWatchlist') {
        await d1.prepare('DELETE FROM watchlist_items WHERE id = ? AND profile_id = ?')
          .bind(cleanId(payload.id), profileId).run();
      } else if (action === 'addJournal') {
        const entryDate = cleanText(payload.entryDate, 'Entry date', 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) throw new Error('Enter a valid journal date.');
        const direction = cleanText(payload.direction, 'Direction', 24);
        if (!DIRECTIONS.has(direction)) throw new Error('Choose a supported direction.');
        await d1.prepare(`INSERT INTO journal_entries
          (profile_id, entry_date, symbol, direction, confidence, thesis, target, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(profileId, entryDate, await cleanTrackedSymbol(d1, profileId, payload.symbol), direction,
            Math.trunc(cleanNumber(payload.confidence, 'Confidence', 0, 100)),
            cleanText(payload.thesis, 'Thesis', 2000),
            typeof payload.target === 'string' ? payload.target.trim().slice(0, 120) : '', createdAt).run();
      } else if (action === 'deleteJournal') {
        await d1.prepare('DELETE FROM journal_entries WHERE id = ? AND profile_id = ?')
          .bind(cleanId(payload.id), profileId).run();
      } else if (action === 'addAlert') {
        const conditionType = cleanText(payload.conditionType, 'Condition', 40);
        if (!CONDITIONS.has(conditionType)) throw new Error('Choose a supported alert condition.');
        await d1.prepare(`INSERT INTO review_alerts
          (profile_id, symbol, condition_type, threshold, note, active, created_at)
          VALUES (?, ?, ?, ?, ?, 1, ?)`)
          .bind(profileId, await cleanTrackedSymbol(d1, profileId, payload.symbol), conditionType,
            cleanNumber(payload.threshold, 'Threshold', -10_000_000, 10_000_000),
            typeof payload.note === 'string' ? payload.note.trim().slice(0, 240) : '', createdAt).run();
      } else if (action === 'toggleAlert') {
        await d1.prepare('UPDATE review_alerts SET active = ? WHERE id = ? AND profile_id = ?')
          .bind(payload.active ? 1 : 0, cleanId(payload.id), profileId).run();
      } else if (action === 'deleteAlert') {
        await d1.prepare('DELETE FROM review_alerts WHERE id = ? AND profile_id = ?')
          .bind(cleanId(payload.id), profileId).run();
      } else if (action === 'updateProfile') {
        const name = cleanText(payload.name, 'Portfolio name', 80);
        const cashBalance = cleanNumber(payload.cashBalance, 'Cash balance', 0, 1_000_000_000_000);
        await d1.prepare('UPDATE investment_profiles SET name = ?, cash_balance = ? WHERE id = ?')
          .bind(name, cashBalance, profileId).run();
      } else {
        return Response.json({ error: 'Unsupported workspace action.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } });
      }

      return Response.json(await readWorkspace(profileId), { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      const authorizationResponse = authorizationErrorResponse(error);
      if (authorizationResponse) return authorizationResponse;
      const message = error instanceof Error ? error.message : 'The workspace could not be updated.';
      console.error('workspace POST failed', error instanceof Error ? error.name : 'UnknownError');
      return Response.json({ error: message },
        { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  async function marketGet(request: Request) {
    let scope;
    try {
      scope = await dependencies.authorizeHumanRequest(request, 'market_read');
    } catch (error) {
      return authorizationErrorResponse(error) ?? Response.json(
        { error: 'Real market data could not be loaded.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const allRequestedSymbols = [...new Set(new URL(request.url).searchParams.get('symbols')
      ?.split(',').map((symbol) => symbol.trim().toUpperCase())
      .filter((symbol) => TICKER_PATTERN.test(symbol)) ?? [])];
    const requestedSymbols = allRequestedSymbols.slice(0, 24);

    if (!requestedSymbols.length) return Response.json(
      { quotes: {}, fetchedAt: dependencies.now().toISOString(), unavailable: [] },
      { headers: { 'Cache-Control': 'no-store' } },
    );

    try {
      await dependencies.ensureDatabase();
      const d1 = dependencies.getD1();
      const profile = await d1.prepare('SELECT base_currency AS baseCurrency FROM investment_profiles WHERE id = ?')
        .bind(scope.profileId).first<{ baseCurrency: string }>();
      if (!profile) throw new Error('Investment profile unavailable');
      const trackedRows = await d1.prepare(`SELECT symbol FROM positions WHERE profile_id = ?
        UNION SELECT symbol FROM watchlist_items WHERE profile_id = ?
        UNION SELECT symbol FROM review_alerts WHERE profile_id = ?`)
        .bind(scope.profileId, scope.profileId, scope.profileId).all<{ symbol: string }>();
      const tracked = new Set(trackedRows.results.map((row) => row.symbol));
      const symbols = requestedSymbols.filter((symbol) => tracked.has(symbol));
      const results = await Promise.allSettled(symbols.map((symbol) => dependencies.fetchYahooQuote(symbol)));
      const quotes: Record<string, MarketQuote> = {};
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.currency === profile.baseCurrency.toUpperCase()) {
          quotes[result.value.symbol] = result.value;
        }
      }
      return Response.json(
        { quotes, fetchedAt: dependencies.now().toISOString(), unavailable: allRequestedSymbols.filter((symbol) => !quotes[symbol]) },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    } catch (error) {
      console.error('market GET failed', error instanceof Error ? error.name : 'UnknownError');
      return Response.json({ error: 'Real market data could not be loaded.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  async function analysisPost(request: Request) {
    try {
      const scope = await dependencies.authorizeHumanRequest(request, 'analysis_run');
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
        return Response.json({ error: 'Analysis requests must use JSON.' },
          { status: 415, headers: { 'Cache-Control': 'no-store' } });
      }
      const contentLength = Number(request.headers.get('content-length') || 0);
      if (contentLength > MAX_ANALYSIS_REQUEST_BYTES) {
        return Response.json({ error: 'Analysis request is too large.' },
          { status: 413, headers: { 'Cache-Control': 'no-store' } });
      }
      const payload = normalizeAnalysisPayload(await request.json());
      await dependencies.ensureDatabase();
      const tracked = await dependencies.getD1().prepare(`SELECT symbol FROM positions WHERE profile_id = ? AND symbol = ?
        UNION SELECT symbol FROM watchlist_items WHERE profile_id = ? AND symbol = ? LIMIT 1`)
        .bind(scope.profileId, payload.symbol, scope.profileId, payload.symbol).first();
      if (!tracked) {
        return Response.json({ error: 'Save this symbol as a position or watchlist item first.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } });
      }
      const upstream = await dependencies.fetch(dependencies.analysisApiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      const response = await upstream.json() as { report?: unknown; error?: string };
      if (!upstream.ok || !isTechnicalAnalysisReport(response.report, payload.symbol)) {
        const status = upstream.status === 422 ? 400 : upstream.status === 503 ? 503 : 502;
        const message = status === 400
          ? 'Check the symbol and risk assumptions.'
          : status === 503
            ? 'Completed market data is unavailable for this symbol.'
            : 'Technical analysis is temporarily unavailable.';
        return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
      }
      return Response.json(response, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      const authorizationResponse = authorizationErrorResponse(error);
      if (authorizationResponse) return authorizationResponse;
      const isInputError = error instanceof SyntaxError
        || (error instanceof Error && /Request|ticker|accountRisk|commission|slippage|executionStop/.test(error.message));
      if (!isInputError) console.error('analysis proxy failed', error instanceof Error ? error.name : 'UnknownError');
      return Response.json(
        { error: isInputError ? 'Check the symbol and risk assumptions.' : 'Technical analysis service is unavailable.' },
        { status: isInputError ? 400 : 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }

  return { workspaceGet, workspacePost, marketGet, analysisPost };
}
