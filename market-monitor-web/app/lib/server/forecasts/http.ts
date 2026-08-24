import { fetchYahooQuote } from '../yahoo';
import { resolveCurrentProfile } from '../profile';
import { ensureDatabase, getD1 } from '@/db';
import { D1ForecastRepository } from './repository';
import { ForecastService, ForecastServiceError } from './service';
import { normalizeForecastId } from './validation';
import { forecastErrorContract } from './error-contract';
import { logForecastDiagnostic } from './diagnostics.ts';

const MAX_REQUEST_BYTES = 600 * 1024;

export async function forecastRequestContext(request: Request) {
  await ensureDatabase();
  const { profileId } = await resolveCurrentProfile(request);
  const repository = new D1ForecastRepository(getD1());
  const service = new ForecastService(repository, async (symbol, fresh) => {
    const quote = await fetchYahooQuote(symbol, { fresh });
    if (!quote.currency || !quote.updatedAt) throw new Error('IncompleteMarketQuote');
    return {
      price: quote.price,
      currency: quote.currency,
      providerAsOf: quote.updatedAt,
      provider: quote.provider,
    };
  });
  return { profileId, service };
}

export async function requestJson(request: Request, { optional = false }: { optional?: boolean } = {}) {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    if (optional && !request.headers.get('content-length')) return undefined;
    throw new ForecastServiceError('Forecast requests must use JSON.', 'validation_error', 415);
  }
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_REQUEST_BYTES) throw new ForecastServiceError('Forecast request is too large.', 'validation_error', 413);
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw new ForecastServiceError('Forecast request is too large.', 'validation_error', 413);
  }
  if (!body.trim()) {
    if (optional) return undefined;
    throw new ForecastServiceError('Request body must be valid JSON.', 'validation_error', 400);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ForecastServiceError('Request body must be valid JSON.', 'validation_error', 400);
  }
}

export async function routeForecastId(context: { params: Promise<{ id: string }> | { id: string } }) {
  const params = await context.params;
  return normalizeForecastId(params.id);
}

export function forecastJson(payload: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Cache-Control', 'no-store');
  return Response.json(payload, { ...init, headers });
}

export function forecastErrorResponse(error: unknown, operation: string) {
  const contract = forecastErrorContract(error);
  if (contract.report) logForecastDiagnostic(operation, error);
  return forecastJson(contract.body, { status: contract.status });
}
