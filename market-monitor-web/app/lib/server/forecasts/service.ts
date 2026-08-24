import type {
  Forecast,
  ForecastDraftInput,
  ForecastFilters,
  NormalizedAnalysisSnapshot,
  QuoteSnapshot,
} from './types.ts';
import type { ForecastRepository } from './repository.ts';
import { logForecastDiagnostic } from './diagnostics.ts';
import {
  ForecastValidationError,
  calendarDateInTimeZone,
  normalizeAnalysisSnapshot,
  normalizeCancelReason,
  normalizeDraftRequest,
  normalizeNote,
  isCanonicalInstant,
  normalizeTimeZone,
  validateActivationGeometry,
  validateEvaluationDateAtActivation,
} from './validation.ts';

export type ForecastErrorCode =
  | 'validation_error'
  | 'not_found'
  | 'invalid_state'
  | 'symbol_not_tracked'
  | 'profile_unavailable'
  | 'market_unavailable';

export class ForecastServiceError extends Error {
  readonly code: ForecastErrorCode;
  readonly status: number;
  readonly fieldErrors: Record<string, string>;

  constructor(
    message: string,
    code: ForecastErrorCode,
    status: number,
    fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ForecastServiceError';
    this.code = code;
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

export type ForecastQuoteProvider = (symbol: string, fresh: boolean) => Promise<QuoteSnapshot>;

function draftFromForecast(forecast: Forecast): ForecastDraftInput {
  return {
    symbol: forecast.symbol,
    direction: forecast.direction,
    confidence: forecast.confidence,
    thesis: forecast.thesis,
    supportingEvidence: forecast.supportingEvidence,
    counterEvidence: forecast.counterEvidence,
    setupTag: forecast.setupTag,
    evaluationDate: forecast.evaluationDate,
    target: forecast.target,
    invalidationPrice: forecast.invalidationPrice,
  };
}

function asServiceError(error: unknown): never {
  if (error instanceof ForecastServiceError) throw error;
  if (error instanceof ForecastValidationError) {
    throw new ForecastServiceError(error.message, 'validation_error', 400, error.fieldErrors);
  }
  throw error;
}

function activationSeedPayload(value: unknown) {
  if (value === undefined || value === null) return { analysisReport: undefined, scenarioId: undefined, timeZone: 'UTC' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ForecastValidationError('Activation body must be an object.');
  }
  const payload = value as Record<string, unknown>;
  const unknown = Object.keys(payload).filter((key) => key !== 'analysisReport' && key !== 'scenarioId' && key !== 'timeZone');
  if (unknown.length) throw new ForecastValidationError(`Unsupported field: ${unknown[0]}.`);
  const hasReport = Object.hasOwn(payload, 'analysisReport') && payload.analysisReport !== null;
  const hasScenario = typeof payload.scenarioId === 'string' && Boolean(payload.scenarioId.trim());
  if (hasReport !== hasScenario) throw new ForecastValidationError('Analysis report and scenario ID must be supplied together.');
  return {
    analysisReport: hasReport ? payload.analysisReport : undefined,
    scenarioId: hasScenario ? payload.scenarioId : undefined,
    timeZone: normalizeTimeZone(payload.timeZone),
  };
}

export class ForecastService {
  private readonly repository: ForecastRepository;
  private readonly quoteProvider: ForecastQuoteProvider;
  private readonly clock: () => Date;

  constructor(
    repository: ForecastRepository,
    quoteProvider: ForecastQuoteProvider,
    clock: () => Date = () => new Date(),
  ) {
    this.repository = repository;
    this.quoteProvider = quoteProvider;
    this.clock = clock;
  }

  private clockInstant() {
    const value = this.clock();
    if (!Number.isFinite(value.getTime())) throw new Error('Forecast clock returned an invalid date.');
    return value;
  }

  private now() {
    return this.clockInstant().toISOString();
  }

  private async requireForecast(profileId: number, id: number) {
    const forecast = await this.repository.get(profileId, id);
    if (!forecast) throw new ForecastServiceError('Forecast not found.', 'not_found', 404);
    return forecast;
  }

  private async requireTracked(profileId: number, symbol: string) {
    if (!await this.repository.isTrackedSymbol(profileId, symbol)) {
      throw new ForecastServiceError(
        'Save this symbol as a position or watchlist item first.',
        'symbol_not_tracked',
        400,
        { symbol: 'Track this symbol before creating a forecast.' },
      );
    }
  }

  async list(profileId: number, filters: ForecastFilters) {
    return this.repository.list(profileId, filters);
  }

  async get(profileId: number, id: number) {
    return this.requireForecast(profileId, id);
  }

  async createDraft(profileId: number, raw: unknown) {
    try {
      const { draft, analysisSeed } = normalizeDraftRequest(raw);
      await this.requireTracked(profileId, draft.symbol);
      const id = await this.repository.create(profileId, draft, analysisSeed ?? null, this.now());
      return this.requireForecast(profileId, id);
    } catch (error) {
      asServiceError(error);
    }
  }

  async updateDraft(profileId: number, id: number, raw: unknown) {
    try {
      const current = await this.requireForecast(profileId, id);
      if (current.status !== 'draft') throw new ForecastServiceError('Activated forecasts cannot be edited.', 'invalid_state', 409);
      const { draft, analysisSeed: requestedSeed } = normalizeDraftRequest(raw);
      await this.requireTracked(profileId, draft.symbol);
      const analysisSeed = requestedSeed === undefined
        && current.pendingAnalysis
        && (current.symbol !== draft.symbol || current.direction !== draft.direction)
        ? null
        : requestedSeed;
      if (!await this.repository.updateDraft(profileId, id, draft, analysisSeed, this.now())) {
        throw new ForecastServiceError('Forecast is no longer editable.', 'invalid_state', 409);
      }
      return this.requireForecast(profileId, id);
    } catch (error) {
      asServiceError(error);
    }
  }

  async deleteDraft(profileId: number, id: number) {
    const current = await this.requireForecast(profileId, id);
    if (current.status !== 'draft') throw new ForecastServiceError('Only draft forecasts can be deleted.', 'invalid_state', 409);
    if (!await this.repository.deleteDraft(profileId, id)) throw new ForecastServiceError('Forecast is no longer editable.', 'invalid_state', 409);
  }

  async activate(profileId: number, id: number, rawBody?: unknown) {
    try {
      const current = await this.requireForecast(profileId, id);
      if (current.status !== 'draft') throw new ForecastServiceError('Only draft forecasts can be activated.', 'invalid_state', 409);
      const activationRequest = activationSeedPayload(rawBody);
      await this.requireTracked(profileId, current.symbol);
      const currency = await this.repository.profileCurrency(profileId);
      if (!currency) throw new ForecastServiceError('Investment profile unavailable.', 'profile_unavailable', 500);
      let quote: QuoteSnapshot;
      try {
        quote = await this.quoteProvider(current.symbol, true);
      } catch (error) {
        logForecastDiagnostic('activation quote', error);
        throw new ForecastServiceError('A fresh market quote is unavailable. Try activation again later.', 'market_unavailable', 503);
      }
      if (!Number.isFinite(quote.price) || quote.price <= 0
        || !quote.provider || !isCanonicalInstant(quote.providerAsOf)) {
        throw new ForecastServiceError('A complete server-verified quote is unavailable.', 'market_unavailable', 503);
      }
      const activationInstant = this.clockInstant();
      const now = activationInstant.toISOString();
      const providerTime = Date.parse(quote.providerAsOf);
      const activationTime = Date.parse(now);
      if (providerTime > activationTime + (5 * 60 * 1_000)
        || providerTime < activationTime - (7 * 24 * 60 * 60 * 1_000)) {
        throw new ForecastServiceError('The market provider timestamp is too stale or inconsistent to activate this forecast.', 'market_unavailable', 503);
      }
      quote.currency = quote.currency.toUpperCase();
      if (quote.currency !== currency) {
        throw new ForecastServiceError(`A ${currency} quote is required for this profile.`, 'market_unavailable', 503);
      }
      const draft = draftFromForecast(current);
      validateEvaluationDateAtActivation(
        draft.evaluationDate,
        calendarDateInTimeZone(activationInstant, activationRequest.timeZone),
      );
      validateActivationGeometry(draft, quote.price);
      const persistedSeed = activationRequest.analysisReport === undefined
        ? await this.repository.getAnalysisSeed(profileId, id)
        : null;
      let snapshot: NormalizedAnalysisSnapshot | null = null;
      const report = activationRequest.analysisReport ?? persistedSeed?.report;
      const scenarioId = activationRequest.scenarioId ?? persistedSeed?.scenarioId;
      if (report !== undefined && scenarioId !== undefined) {
        snapshot = normalizeAnalysisSnapshot(report, scenarioId, current.symbol, current.direction);
        if (Date.parse(snapshot.generatedAt) > activationTime + (5 * 60 * 1_000)
          || Date.parse(snapshot.analysisAsOf) > activationTime + (5 * 60 * 1_000)
          || (snapshot.completedBarAsOf !== null
            && Date.parse(snapshot.completedBarAsOf) > activationTime + (5 * 60 * 1_000))) {
          throw new ForecastValidationError('Analysis report timestamps are in the future.');
        }
      }
      const expectedRevision = current.events.at(-1)?.revision;
      if (!expectedRevision) throw new ForecastServiceError('Forecast audit history is unavailable.', 'invalid_state', 409);
      if (!await this.repository.activate(profileId, id, current.updatedAt, expectedRevision, quote, snapshot, now)) {
        throw new ForecastServiceError('Forecast changed before activation. Review the latest draft and try again.', 'invalid_state', 409);
      }
      return this.requireForecast(profileId, id);
    } catch (error) {
      asServiceError(error);
    }
  }

  async cancel(profileId: number, id: number, raw: unknown) {
    try {
      const current = await this.requireForecast(profileId, id);
      if (current.status !== 'active') throw new ForecastServiceError('Only active forecasts can be cancelled.', 'invalid_state', 409);
      const reason = normalizeCancelReason(raw);
      if (!await this.repository.cancel(profileId, id, reason, this.now())) {
        throw new ForecastServiceError('Forecast is no longer active.', 'invalid_state', 409);
      }
      return this.requireForecast(profileId, id);
    } catch (error) {
      asServiceError(error);
    }
  }

  async addNote(profileId: number, id: number, raw: unknown) {
    try {
      const current = await this.requireForecast(profileId, id);
      if (current.status === 'draft') throw new ForecastServiceError('Activate the forecast before adding an amendment or review note.', 'invalid_state', 409);
      const { kind, note } = normalizeNote(raw);
      if (!await this.repository.addNote(profileId, id, kind, note, this.now())) {
        throw new ForecastServiceError('Forecast could not accept this note.', 'invalid_state', 409);
      }
      return this.requireForecast(profileId, id);
    } catch (error) {
      asServiceError(error);
    }
  }
}
