import { isTechnicalAnalysisReport } from '@/app/lib/analysis';
import { TICKER_PATTERN } from '@/app/lib/tickers';
import { ensureDatabase, getD1 } from '@/db';
import { resolveCurrentProfile } from '@/app/lib/server/profile';

const REQUEST_FIELDS = new Set([
  'symbol',
  'accountRisk',
  'commissionPerUnit',
  'expectedSlippagePerUnit',
  'executionStopPrice',
]);
const MAX_REQUEST_BYTES = 4 * 1024;

type Payload = Record<string, unknown>;

function analysisServiceUrl() {
  const configured = process.env.ANALYSIS_API_URL || 'http://127.0.0.1:8502';
  const url = new URL(configured);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid analysis service URL.');
  }
  return `${url.toString().replace(/\/$/, '')}/v1/analyze`;
}

function optionalNumber(
  payload: Payload,
  field: string,
  positive: boolean,
) {
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

function normalizePayload(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Request body must be an object.');
  }
  const values = payload as Payload;
  const unknown = Object.keys(values).filter((key) => !REQUEST_FIELDS.has(key));
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

export async function POST(request: Request) {
  try {
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      return Response.json({ error: 'Analysis requests must use JSON.' }, { status: 415 });
    }
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > MAX_REQUEST_BYTES) {
      return Response.json({ error: 'Analysis request is too large.' }, { status: 413 });
    }
    const payload = normalizePayload(await request.json());
    await ensureDatabase();
    const { profileId } = await resolveCurrentProfile(request);
    const tracked = await getD1().prepare(`SELECT symbol FROM positions WHERE profile_id = ? AND symbol = ?
      UNION SELECT symbol FROM watchlist_items WHERE profile_id = ? AND symbol = ? LIMIT 1`)
      .bind(profileId, payload.symbol, profileId, payload.symbol).first();
    if (!tracked) {
      return Response.json({ error: 'Save this symbol as a position or watchlist item first.' }, { status: 400 });
    }
    const upstream = await fetch(analysisServiceUrl(), {
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
      return Response.json({ error: message }, { status });
    }
    return Response.json(response, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const isInputError = error instanceof SyntaxError
      || (error instanceof Error && /Request|ticker|accountRisk|commission|slippage|executionStop/.test(error.message));
    if (!isInputError) console.error('analysis proxy failed', error instanceof Error ? error.name : 'UnknownError');
    return Response.json(
      { error: isInputError ? 'Check the symbol and risk assumptions.' : 'Technical analysis service is unavailable.' },
      { status: isInputError ? 400 : 503 },
    );
  }
}
