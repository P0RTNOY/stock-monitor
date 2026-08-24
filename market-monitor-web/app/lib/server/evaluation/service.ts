import { logForecastDiagnostic } from '../forecasts/diagnostics.ts';
import type { ForecastRepository } from '../forecasts/repository.ts';
import { ForecastServiceError } from '../forecasts/service.ts';
import type { Forecast } from '../forecasts/types.ts';
import { buildEvaluationRequest, EvaluationProviderError } from './client.ts';
import type { EvaluationRepository } from './repository.ts';
import type { EvaluationRequest, EvaluationResult } from './types.ts';

export type EvaluationProvider = (request: EvaluationRequest) => Promise<EvaluationResult>;
export type ForecastEvaluationFailureCategory =
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'validation_failure';

/**
 * Safe, stable failure metadata for trusted internal orchestration.
 *
 * The public forecast error contract deliberately continues to expose only
 * the existing temporary-unavailable response.
 */
export class ForecastEvaluationUnavailableError extends ForecastServiceError {
  readonly failureCategory: ForecastEvaluationFailureCategory;

  constructor(failureCategory: ForecastEvaluationFailureCategory) {
    super('Forecast evaluation is temporarily unavailable.', 'market_unavailable', 503);
    this.name = 'ForecastEvaluationUnavailableError';
    this.failureCategory = failureCategory;
  }
}

function emptyEvaluationBody(value: unknown) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 0) {
    throw new ForecastServiceError('Evaluation requests must use an empty JSON object.', 'validation_error', 400);
  }
}

function acknowledgementBody(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ForecastServiceError('Review acknowledgement requires confirmation.', 'validation_error', 400);
  }
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).length !== 1 || payload.confirmed !== true) {
    throw new ForecastServiceError('Set confirmed to true to acknowledge this review.', 'validation_error', 400);
  }
}

function explicitEvaluationCutoff(value: string) {
  if (typeof value !== 'string') {
    throw new ForecastServiceError('Evaluation cutoff must be a canonical UTC timestamp.', 'validation_error', 400);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ForecastServiceError('Evaluation cutoff must be a canonical UTC timestamp.', 'validation_error', 400);
  }
  return value;
}

export class ForecastEvaluationService {
  private readonly forecasts: ForecastRepository;
  private readonly evaluations: EvaluationRepository;
  private readonly provider: EvaluationProvider;
  private readonly clock: () => Date;

  constructor(
    forecasts: ForecastRepository,
    evaluations: EvaluationRepository,
    provider: EvaluationProvider,
    clock: () => Date = () => new Date(),
  ) {
    this.forecasts = forecasts;
    this.evaluations = evaluations;
    this.provider = provider;
    this.clock = clock;
  }

  private now() {
    const value = this.clock();
    if (!Number.isFinite(value.getTime())) throw new Error('Evaluation clock returned an invalid date.');
    return value.toISOString();
  }

  private async requireForecast(profileId: number, id: number) {
    const forecast = await this.forecasts.get(profileId, id);
    if (!forecast) throw new ForecastServiceError('Forecast not found.', 'not_found', 404);
    return forecast;
  }

  private activeSnapshot(forecast: Forecast) {
    if (forecast.status !== 'active') {
      throw new ForecastServiceError('Only active forecasts can be evaluated.', 'invalid_state', 409);
    }
    if (!forecast.activatedAt || !forecast.marketDataAsOf || !forecast.activationPrice
      || !forecast.activationCurrency || !forecast.marketProvider) {
      throw new ForecastServiceError('The active forecast snapshot is incomplete.', 'invalid_state', 409);
    }
    const revision = forecast.events.at(-1)?.revision;
    if (!revision) throw new ForecastServiceError('Forecast audit history is unavailable.', 'invalid_state', 409);
    return { updatedAt: forecast.updatedAt, revision };
  }

  private async evaluateWithCutoff(
    profileId: number,
    forecastId: number,
    body: unknown,
    timing: () => { cutoff: string; persistedAt: string; explicit: boolean },
  ) {
    emptyEvaluationBody(body);
    const forecast = await this.requireForecast(profileId, forecastId);
    const expected = this.activeSnapshot(forecast);
    const { cutoff, persistedAt, explicit } = timing();
    const activationCutoff = Math.max(
      Date.parse(forecast.activatedAt as string),
      Date.parse(forecast.marketDataAsOf as string),
    );
    if (explicit && Date.parse(cutoff) < activationCutoff) {
      throw new ForecastServiceError(
        'Evaluation cutoff cannot precede the active forecast snapshot.',
        'validation_error',
        400,
      );
    }
    const request = buildEvaluationRequest(forecast, cutoff);
    let result: EvaluationResult;
    try {
      result = await this.provider(request);
    } catch (error) {
      logForecastDiagnostic('forecast evaluation provider', error);
      if (error instanceof EvaluationProviderError) {
        const failureCategory = error.failureKind === 'timeout'
          ? 'provider_timeout'
          : error.failureKind === 'unavailable'
            ? 'provider_unavailable'
            : 'validation_failure';
        throw new ForecastEvaluationUnavailableError(failureCategory);
      }
      throw error;
    }
    let persisted;
    try {
      persisted = await this.evaluations.persist(
        profileId,
        forecastId,
        expected.updatedAt,
        expected.revision,
        result,
        persistedAt,
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'EvaluationFingerprintConflict') {
        throw new ForecastServiceError(
          'A conflicting result exists for this evaluation input.',
          'invalid_state',
          409,
        );
      }
      throw error;
    }
    if (!persisted) {
      throw new ForecastServiceError(
        'Forecast changed while it was being evaluated. Review its current state and try again.',
        'invalid_state',
        409,
      );
    }
    return {
      forecast: await this.requireForecast(profileId, forecastId),
      evaluationRun: persisted.run,
      duplicate: persisted.duplicate,
    };
  }

  async evaluate(profileId: number, forecastId: number, body: unknown) {
    return this.evaluateWithCutoff(profileId, forecastId, body, () => {
      const now = this.now();
      return { cutoff: now, persistedAt: now, explicit: false };
    });
  }

  async evaluateAt(profileId: number, forecastId: number, body: unknown, evaluationCutoff: string) {
    const cutoff = explicitEvaluationCutoff(evaluationCutoff);
    return this.evaluateWithCutoff(profileId, forecastId, body, () => ({
      cutoff,
      persistedAt: this.now(),
      explicit: true,
    }));
  }

  async listReviews(profileId: number, includeAcknowledged = false) {
    return this.evaluations.listReviews(profileId, includeAcknowledged);
  }

  async latestEvaluation(profileId: number, forecastId: number) {
    await this.requireForecast(profileId, forecastId);
    return this.evaluations.latestRun(profileId, forecastId);
  }

  async acknowledgeReview(profileId: number, reviewId: number, body: unknown) {
    acknowledgementBody(body);
    const current = await this.evaluations.getReview(profileId, reviewId);
    if (!current) throw new ForecastServiceError('Review item not found.', 'not_found', 404);
    if (current.acknowledgedAt) {
      throw new ForecastServiceError('This review item is already acknowledged.', 'invalid_state', 409);
    }
    if (!await this.evaluations.acknowledgeReview(profileId, reviewId, this.now())) {
      throw new ForecastServiceError('This review item changed before acknowledgement.', 'invalid_state', 409);
    }
    return this.evaluations.getReview(profileId, reviewId);
  }
}
