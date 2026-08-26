import { fetchYahooQuote } from '../yahoo';
import { ensureDatabase, getD1 } from '@/db';
import { D1ForecastRepository } from './repository';
import { ForecastService, ForecastServiceError } from './service';
import { normalizeForecastId } from './validation';
import { forecastErrorContract } from './error-contract';
import { logForecastDiagnostic } from './diagnostics.ts';
import { evaluateWithPython } from '../evaluation/client.ts';
import { D1EvaluationRepository } from '../evaluation/repository.ts';
import { ForecastEvaluationService } from '../evaluation/service.ts';
import { authorizeHumanRequest } from '../auth/runtime-resolver.ts';
import { authorizationErrorResponse } from '../auth/http.ts';
import type { AuthorizationAction } from '../auth/types.ts';
import { profileIdFromScope, type AuthorizedProfileScope } from '../auth/enforcement.ts';
import type { ForecastFilters } from './types.ts';

const MAX_REQUEST_BYTES = 600 * 1024;

class AuthorizedForecastService {
  constructor(
    private readonly scope: AuthorizedProfileScope,
    private readonly service: ForecastService,
  ) {}

  list(filters: ForecastFilters) { return this.service.list(profileIdFromScope(this.scope, 'forecast_list'), filters); }
  get(id: number) { return this.service.get(profileIdFromScope(this.scope, 'forecast_read'), id); }
  createDraft(body: unknown) { return this.service.createDraft(profileIdFromScope(this.scope, 'forecast_create'), body); }
  updateDraft(id: number, body: unknown) { return this.service.updateDraft(profileIdFromScope(this.scope, 'forecast_edit'), id, body); }
  deleteDraft(id: number) { return this.service.deleteDraft(profileIdFromScope(this.scope, 'forecast_delete'), id); }
  activate(id: number, body: unknown) { return this.service.activate(profileIdFromScope(this.scope, 'forecast_activate'), id, body); }
  cancel(id: number, body: unknown) { return this.service.cancel(profileIdFromScope(this.scope, 'forecast_cancel'), id, body); }
  addNote(id: number, body: unknown) { return this.service.addNote(profileIdFromScope(this.scope, 'forecast_note'), id, body); }
}

class AuthorizedEvaluationService {
  constructor(
    private readonly scope: AuthorizedProfileScope,
    private readonly service: ForecastEvaluationService,
  ) {}

  evaluate(id: number, body: unknown) { return this.service.evaluate(profileIdFromScope(this.scope, 'forecast_evaluate'), id, body); }
  listReviews(includeAcknowledged: boolean) { return this.service.listReviews(profileIdFromScope(this.scope, 'review_list'), includeAcknowledged); }
  latestEvaluation(id: number) { return this.service.latestEvaluation(profileIdFromScope(this.scope, 'evaluation_read'), id); }
  acknowledgeReview(id: number, body: unknown) { return this.service.acknowledgeReview(profileIdFromScope(this.scope, 'review_acknowledge'), id, body); }
}

export async function forecastRequestContext(request: Request, action: AuthorizationAction) {
  const scope = await authorizeHumanRequest(request, action);
  await ensureDatabase();
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
  return { scope, service: new AuthorizedForecastService(scope, service) };
}

export async function evaluationRequestContext(request: Request, action: AuthorizationAction) {
  const scope = await authorizeHumanRequest(request, action);
  await ensureDatabase();
  const d1 = getD1();
  const service = new ForecastEvaluationService(
    new D1ForecastRepository(d1),
    new D1EvaluationRepository(d1),
    evaluateWithPython,
  );
  return { scope, service: new AuthorizedEvaluationService(scope, service) };
}

export async function requestJson(
  request: Request,
  { optional = false, maxBytes = MAX_REQUEST_BYTES }: { optional?: boolean; maxBytes?: number } = {},
) {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    if (optional && !request.headers.get('content-length')) return undefined;
    throw new ForecastServiceError('Forecast requests must use JSON.', 'validation_error', 415);
  }
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > maxBytes) throw new ForecastServiceError('Forecast request is too large.', 'validation_error', 413);
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
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
  const authorizationResponse = authorizationErrorResponse(error);
  if (authorizationResponse) return authorizationResponse;
  const contract = forecastErrorContract(error);
  if (contract.report) logForecastDiagnostic(operation, error);
  return forecastJson(contract.body, { status: contract.status });
}
