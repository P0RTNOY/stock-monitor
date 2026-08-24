import type { ForecastEvaluationService } from '../evaluation/service.ts';
import { ForecastEvaluationUnavailableError } from '../evaluation/service.ts';
import type { ForecastRepository } from '../forecasts/repository.ts';
import { ForecastServiceError } from '../forecasts/service.ts';
import type { Forecast } from '../forecasts/types.ts';
import {
  COORDINATOR_MAX_SAME_CUTOFF_RETRIES,
  COORDINATOR_VERSION,
  CoordinatorContractError,
  isCanonicalUtcInstant,
  parseCoordinatorInput,
  type CoordinatorInput,
  type CoordinatorOutcome,
} from './contract.ts';
import {
  advanceCoordinatorCursor,
  createCoordinatorCursorPayload,
  decodeCoordinatorCursor,
  encodeCoordinatorCursor,
  type CoordinatorCursorPayload,
} from './cursor.ts';
import { D1CoordinatorRepository } from './repository.ts';
import type {
  CoordinatorItemCompletion,
  CoordinatorItemReport,
  CoordinatorRunItemRecord,
  CoordinatorRunReport,
  PlannedCoordinatorRun,
} from './types.ts';

export type CoordinatorRuntime = {
  now(): string;
  leaseExpiresAt(acquiredAt: string): string;
  durationMs(startedAt: string, finishedAt: string): number;
  id(kind: 'run' | 'item' | 'attempt' | 'claim' | 'run_lease'): string;
};

export class CoordinatorSystemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoordinatorSystemError';
  }
}

type ActiveCoordinatorRun = {
  profileId: number;
  id: string;
  evaluationCutoff: string;
  scanStartedAt: string;
  snapshotMaxForecastId: number;
  leaseToken: string;
};

function validateRuntimeInstant(value: string, label: string) {
  if (!isCanonicalUtcInstant(value)) throw new CoordinatorSystemError(`Coordinator runtime returned an invalid ${label}.`);
  return value;
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function requestFingerprint(input: CoordinatorInput) {
  const canonical = JSON.stringify({
    coordinatorVersion: COORDINATOR_VERSION,
    profileId: input.profileId,
    cutoff: input.cutoff,
    limit: input.limit,
    cursor: input.cursor ?? null,
    mode: input.mode,
  });
  const bytes = new TextEncoder().encode(canonical);
  return bytesToHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
}

function safeStatus(forecast: Forecast | null) {
  return forecast?.status ?? null;
}

function providerVersion(forecastResult: Awaited<ReturnType<ForecastEvaluationService['evaluateAt']>>) {
  const evidence = forecastResult.evaluationRun.evidence;
  return evidence.last_eligible_observation?.provider
    ?? evidence.first_eligible_observation?.provider
    ?? null;
}

function outcomeExplanation(classification: CoordinatorOutcome) {
  const values: Record<CoordinatorOutcome, { reason: string; explanation: string; retry: boolean }> = {
    no_change: { reason: 'evaluation_no_change', explanation: 'The trusted evaluator recorded no lifecycle change.', retry: false },
    target_hit: { reason: 'evaluation_target_hit', explanation: 'The trusted evaluator proved the saved target was reached.', retry: false },
    invalidated: { reason: 'evaluation_invalidated', explanation: 'The trusted evaluator proved the saved invalidation boundary was reached.', retry: false },
    expired: { reason: 'evaluation_expired', explanation: 'The trusted evaluator proved the forecast horizon completed without a terminal touch.', retry: false },
    needs_review: { reason: 'evaluation_needs_review', explanation: 'The trusted evaluator recorded a durable Review Queue item.', retry: false },
    duplicate_or_replayed: { reason: 'evaluation_already_persisted', explanation: 'The same trusted evaluation was already persisted; no duplicate lifecycle mutation was created.', retry: false },
    provider_unavailable: { reason: 'provider_unavailable', explanation: 'The trusted evaluation provider was temporarily unavailable.', retry: true },
    provider_timeout: { reason: 'provider_timeout', explanation: 'The trusted evaluation provider did not respond before its timeout.', retry: true },
    stale_state: { reason: 'forecast_state_changed', explanation: 'The forecast changed while the trusted evaluator was working.', retry: true },
    not_active: { reason: 'forecast_not_active', explanation: 'The selected forecast was no longer active before evaluation began.', retry: false },
    not_due: { reason: 'already_processed_at_or_after_cutoff', explanation: 'The forecast was already processed at or after this cutoff.', retry: false },
    claim_conflict: { reason: 'live_claim_exists', explanation: 'Another coordinator holds a live claim for this forecast.', retry: true },
    validation_failure: { reason: 'evaluation_validation_failure', explanation: 'The trusted evaluation boundary rejected the saved state or provider response.', retry: false },
    unexpected_error: { reason: 'unexpected_coordinator_error', explanation: 'An unexpected internal error prevented this item from completing normally.', retry: true },
    dry_run_candidate: { reason: 'due_candidate', explanation: 'This forecast is due under the conservative selection policy; execute mode may call the provider.', retry: false },
  };
  return values[classification];
}

function itemReport(item: CoordinatorRunItemRecord, mode: 'dry_run' | 'execute'): CoordinatorItemReport {
  const visible = Object.fromEntries(Object.entries(item).filter(([key]) => (
    key !== 'state' && key !== 'createdAt' && key !== 'completedAt' && key !== 'providerCalled'
  ))) as Omit<CoordinatorRunItemRecord, 'state' | 'createdAt' | 'completedAt'>;
  return {
    ...visible,
    cutoff: item.evaluationCutoff,
    cursorPosition: { evaluationDate: item.sortEvaluationDate, forecastId: item.sortForecastId },
    wouldCallProvider: mode === 'dry_run' || item.providerCalled,
  };
}

export class ForecastCoordinatorService {
  private readonly repository: D1CoordinatorRepository;
  private readonly forecasts: ForecastRepository;
  private readonly evaluator: Pick<ForecastEvaluationService, 'evaluateAt'>;
  private readonly runtime: CoordinatorRuntime;

  constructor(
    repository: D1CoordinatorRepository,
    forecasts: ForecastRepository,
    evaluator: Pick<ForecastEvaluationService, 'evaluateAt'>,
    runtime: CoordinatorRuntime,
  ) {
    this.repository = repository;
    this.forecasts = forecasts;
    this.evaluator = evaluator;
    this.runtime = runtime;
  }

  private now(label: string) {
    return validateRuntimeInstant(this.runtime.now(), label);
  }

  private expiry(acquiredAt: string) {
    const value = validateRuntimeInstant(this.runtime.leaseExpiresAt(acquiredAt), 'lease expiry');
    if (value <= acquiredAt) throw new CoordinatorSystemError('Coordinator lease expiry must follow acquisition.');
    return value;
  }

  private async cursorFor(run: {
    profileId: number;
    evaluationCutoff: string;
    scanStartedAt: string;
    snapshotMaxForecastId: number;
  }, item: CoordinatorRunItemRecord) {
    return encodeCoordinatorCursor(createCoordinatorCursorPayload({
      profileId: run.profileId,
      cutoff: run.evaluationCutoff,
      scanStartedAt: run.scanStartedAt,
      snapshotMaxForecastId: run.snapshotMaxForecastId,
      after: { evaluationDate: item.sortEvaluationDate, forecastId: item.sortForecastId },
    }));
  }

  private async report(profileId: number, runId: string, replayUsedExistingRun: boolean): Promise<CoordinatorRunReport> {
    const run = await this.repository.getRun(profileId, runId);
    if (!run) throw new CoordinatorSystemError('Coordinator run could not be read.');
    const rows = await this.repository.getRunItems(profileId, runId);
    const completed = rows.filter((item) => item.state === 'completed');
    const outcomeCounts: Partial<Record<CoordinatorOutcome, number>> = {};
    for (const item of completed) {
      if (item.classification) outcomeCounts[item.classification] = (outcomeCounts[item.classification] ?? 0) + 1;
    }
    return {
      runId: run.id,
      coordinatorVersion: run.coordinatorVersion,
      mode: run.mode,
      profileId: run.profileId,
      cutoff: run.evaluationCutoff,
      initialCursor: run.initialCursor,
      resumeCursor: run.resumeCursor,
      nextCursor: run.nextCursor,
      hasMore: run.nextCursor !== null,
      selectedCount: rows.length,
      attemptedCount: completed.filter((item) => item.classification !== 'dry_run_candidate').length,
      mutatedCount: completed.filter((item) => item.mutated).length,
      outcomeCounts,
      unexpectedErrorCount: outcomeCounts.unexpected_error ?? 0,
      totalDurationMs: run.durationMs,
      status: run.status,
      items: rows.map((item) => itemReport(item, run.mode)),
      warnings: run.warnings,
      replayUsedExistingRun,
    };
  }

  private async completeWithoutClaim(
    run: ActiveCoordinatorRun,
    item: CoordinatorRunItemRecord,
    completion: CoordinatorItemCompletion,
  ) {
    const completedAt = this.now('item completion time');
    const timedCompletion = {
      ...completion,
      attemptStartedAt: completion.attemptStartedAt ?? completedAt,
      attemptFinishedAt: completion.attemptFinishedAt ?? completedAt,
    };
    await this.repository.completeItem({
      profileId: run.profileId,
      runId: run.id,
      itemId: item.id,
      runLeaseToken: run.leaseToken,
      completion: timedCompletion,
      completedAt,
      resumeCursor: await this.cursorFor(run, item),
    });
  }

  private async completeDryRunItem(
    run: ActiveCoordinatorRun,
    item: CoordinatorRunItemRecord,
  ) {
    const startedAt = this.now('dry-run item start time');
    const current = await this.forecasts.get(run.profileId, item.forecastId);
    const descriptor = outcomeExplanation('dry_run_candidate');
    await this.completeWithoutClaim(run, item, {
      classification: 'dry_run_candidate', currentStatus: safeStatus(current),
      reasonCode: item.dueReason, safeExplanation: descriptor.explanation,
      attemptStartedAt: startedAt,
      mutated: false, retryUseful: false,
    });
  }

  private async evaluateItem(
    run: ActiveCoordinatorRun,
    item: CoordinatorRunItemRecord,
  ) {
    const itemStartedAt = this.now('item start time');
    let forecast = await this.forecasts.get(run.profileId, item.forecastId);
    const processed = await this.repository.latestProcessedEvaluation(
      run.profileId, item.forecastId, run.evaluationCutoff,
    );
    if (processed) {
      const recovered = await this.repository.latestStartedAttempt(run.profileId, item.id);
      const descriptor = outcomeExplanation(recovered ? 'duplicate_or_replayed' : 'not_due');
      const completion: CoordinatorItemCompletion = {
        classification: recovered ? 'duplicate_or_replayed' : 'not_due',
        currentStatus: safeStatus(forecast),
        evaluatorResultKind: processed.resultKind,
        evaluationRunId: processed.evaluationRunId,
        reviewItemId: processed.reviewItemId,
        reasonCode: descriptor.reason,
        safeExplanation: descriptor.explanation,
        mutated: false,
        retryUseful: false,
        evaluatorVersion: processed.evaluatorVersion,
        rulesetVersion: processed.rulesetVersion,
      };
      if (recovered) {
        const completedAt = this.now('recovery reconciliation time');
        await this.repository.reconcileProcessedItem({
          profileId: run.profileId,
          runId: run.id,
          itemId: item.id,
          runLeaseToken: run.leaseToken,
          recoveredOwnerToken: recovered.ownerToken,
          attemptStartedAt: recovered.startedAt,
          attemptReasonCode: 'domain_result_reconciled_after_interruption',
          attemptExplanation: 'Phase 2A persisted the result before coordinator completion; recovery reconciled it without another provider call.',
          completion,
          completedAt,
          resumeCursor: await this.cursorFor(run, item),
        });
      } else await this.completeWithoutClaim(run, item, completion);
      return;
    }
    if (!forecast || forecast.status !== 'active') {
      const descriptor = outcomeExplanation('not_active');
      await this.completeWithoutClaim(run, item, {
        classification: 'not_active', currentStatus: safeStatus(forecast),
        reasonCode: descriptor.reason, safeExplanation: descriptor.explanation,
        mutated: false, retryUseful: false,
      });
      return;
    }

    const priorAttempts = await this.repository.attemptCountAtCutoff(
      run.profileId, item.forecastId, run.evaluationCutoff,
    );
    if (priorAttempts >= COORDINATOR_MAX_SAME_CUTOFF_RETRIES) {
      const completedAt = this.now('attempt-budget completion time');
      const completion: CoordinatorItemCompletion = {
        classification: 'unexpected_error',
        currentStatus: forecast.status,
        reasonCode: 'same_cutoff_attempt_budget_exhausted',
        safeExplanation: 'The bounded provider-attempt budget for this forecast and cutoff is exhausted.',
        attemptStartedAt: itemStartedAt,
        attemptFinishedAt: completedAt,
        mutated: false,
        retryUseful: false,
        redactedErrorCategory: 'attempt_budget_exhausted',
      };
      const interrupted = await this.repository.latestStartedAttempt(run.profileId, item.id);
      if (interrupted) {
        await this.repository.reconcileProcessedItem({
          profileId: run.profileId,
          runId: run.id,
          itemId: item.id,
          runLeaseToken: run.leaseToken,
          recoveredOwnerToken: interrupted.ownerToken,
          attemptStartedAt: interrupted.startedAt,
          attemptReasonCode: completion.reasonCode,
          attemptExplanation: completion.safeExplanation,
          completion: { ...completion, attemptStartedAt: interrupted.startedAt },
          completedAt,
          resumeCursor: await this.cursorFor(run, item),
        });
      } else await this.completeWithoutClaim(run, item, completion);
      return;
    }

    const startedAt = itemStartedAt;
    const ownerToken = this.runtime.id('claim');
    const claim = await this.repository.acquireClaim({
      profileId: run.profileId,
      forecastId: item.forecastId,
      runId: run.id,
      itemId: item.id,
      runLeaseToken: run.leaseToken,
      token: ownerToken,
      cutoff: run.evaluationCutoff,
      acquiredAt: startedAt,
      expiresAt: this.expiry(startedAt),
    });
    if (claim === 'conflict') {
      const descriptor = outcomeExplanation('claim_conflict');
      await this.completeWithoutClaim(run, item, {
        classification: 'claim_conflict', currentStatus: forecast.status,
        reasonCode: descriptor.reason, safeExplanation: descriptor.explanation,
        mutated: false, retryUseful: true, redactedErrorCategory: 'claim_conflict',
      });
      return;
    }

    const attemptId = this.runtime.id('attempt');
    await this.repository.startAttempt({
      id: attemptId, itemId: item.id, runId: run.id, profileId: run.profileId,
      runLeaseToken: run.leaseToken, ownerToken, startedAt,
    });
    let completion: CoordinatorItemCompletion;
    try {
      const result = await this.evaluator.evaluateAt(run.profileId, item.forecastId, {}, run.evaluationCutoff);
      const finishedAt = this.now('attempt finish time');
      const classification = result.duplicate ? 'duplicate_or_replayed' : result.evaluationRun.resultKind;
      const descriptor = outcomeExplanation(classification);
      completion = {
        classification,
        currentStatus: result.forecast.status,
        evaluatorResultKind: result.evaluationRun.resultKind,
        evaluationRunId: result.evaluationRun.id,
        reviewItemId: await this.repository.reviewItemId(run.profileId, result.evaluationRun.id),
        reasonCode: result.evaluationRun.reasonCode || descriptor.reason,
        safeExplanation: result.evaluationRun.explanation || descriptor.explanation,
        attemptStartedAt: startedAt,
        attemptFinishedAt: finishedAt,
        mutated: !result.duplicate,
        retryUseful: false,
        providerVersion: providerVersion(result),
        evaluatorVersion: result.evaluationRun.evaluatorVersion,
        rulesetVersion: result.evaluationRun.rulesetVersion,
      };
    } catch (error) {
      const finishedAt = this.now('attempt failure time');
      forecast = await this.forecasts.get(run.profileId, item.forecastId);
      let classification: CoordinatorOutcome = 'unexpected_error';
      let category = 'unexpected_error';
      if (error instanceof ForecastEvaluationUnavailableError) {
        classification = error.failureCategory;
        category = error.failureCategory;
      } else if (error instanceof ForecastServiceError) {
        if (error.code === 'validation_error') classification = 'validation_failure';
        else if (error.code === 'invalid_state' || error.code === 'not_found') classification = 'stale_state';
        category = `forecast_service_${error.code}`;
      }
      const descriptor = outcomeExplanation(classification);
      completion = {
        classification,
        currentStatus: safeStatus(forecast),
        reasonCode: descriptor.reason,
        safeExplanation: descriptor.explanation,
        attemptStartedAt: startedAt,
        attemptFinishedAt: finishedAt,
        mutated: false,
        retryUseful: descriptor.retry,
        redactedErrorCategory: category,
      };
    }

    await this.repository.completeItem({
      profileId: run.profileId,
      runId: run.id,
      itemId: item.id,
      runLeaseToken: run.leaseToken,
      attemptId,
      ownerToken,
      completion,
      completedAt: completion.attemptFinishedAt as string,
      resumeCursor: await this.cursorFor(run, item),
    });
  }

  private async renewRun(run: ActiveCoordinatorRun) {
    const renewedAt = this.now('run lease renewal time');
    if (!await this.repository.renewRunLease(
      run.profileId, run.id, run.leaseToken, this.expiry(renewedAt),
    )) throw new CoordinatorSystemError('Coordinator run lease is no longer owned by this invocation.');
  }

  async coordinate(value: unknown, trustedProfileId: number): Promise<CoordinatorRunReport> {
    const input = parseCoordinatorInput(value, trustedProfileId);
    const invokedAt = this.now('invocation time');
    const fingerprint = await requestFingerprint(input);
    const decoded = input.cursor
      ? await decodeCoordinatorCursor(input.cursor, { profileId: input.profileId, cutoff: input.cutoff })
      : null;

    if (input.operatorRunKey) {
      const existing = await this.repository.findRunByOperatorKey(input.profileId, input.operatorRunKey);
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new CoordinatorContractError(
            'Coordinator operatorRunKey was already used with a different request.',
            'invalid_operator_run_key',
          );
        }
        if (existing.status === 'completed' || existing.status === 'completed_with_errors') {
          return this.report(input.profileId, existing.id, true);
        }
        if (existing.leaseExpiresAt && existing.leaseExpiresAt > invokedAt) {
          return this.report(input.profileId, existing.id, true);
        }
        const token = this.runtime.id('run_lease');
        if (!await this.repository.acquireRunLease(
          input.profileId, existing.id, token, invokedAt, this.expiry(invokedAt),
        )) return this.report(input.profileId, existing.id, true);
        const resumed = await this.repository.getRun(input.profileId, existing.id);
        if (!resumed) throw new CoordinatorSystemError('Coordinator run disappeared during recovery.');
        const activeRun: ActiveCoordinatorRun = {
          profileId: resumed.profileId,
          id: resumed.id,
          evaluationCutoff: resumed.evaluationCutoff,
          scanStartedAt: resumed.scanStartedAt,
          snapshotMaxForecastId: resumed.snapshotMaxForecastId,
          leaseToken: token,
        };
        const pending = (await this.repository.getRunItems(input.profileId, resumed.id))
          .filter((item) => item.state === 'pending');
        for (const item of pending) {
          await this.renewRun(activeRun);
          if (resumed.mode === 'dry_run') await this.completeDryRunItem(activeRun, item);
          else await this.evaluateItem(activeRun, item);
        }
        const finishedAt = this.now('run completion time');
        await this.repository.finalizeRun({
          profileId: resumed.profileId, runId: resumed.id, leaseToken: token,
          completedAt: finishedAt, durationMs: this.runtime.durationMs(resumed.startedAt, finishedAt),
          nextCursor: resumed.nextCursor,
        });
        return this.report(input.profileId, resumed.id, true);
      }
    }

    const scanStartedAt = decoded?.scanStartedAt ?? invokedAt;
    const snapshotMaxForecastId = decoded?.snapshotMaxForecastId
      ?? await this.repository.snapshotMaxForecastId(input.profileId, scanStartedAt);
    const cursorPayload: CoordinatorCursorPayload = decoded ?? createCoordinatorCursorPayload({
      profileId: input.profileId,
      cutoff: input.cutoff,
      scanStartedAt,
      snapshotMaxForecastId,
      after: null,
    });
    const page = await this.repository.selectDuePage({
      profileId: input.profileId,
      cutoff: input.cutoff,
      scanStartedAt,
      snapshotMaxForecastId,
      afterEvaluationDate: cursorPayload.after?.evaluationDate ?? null,
      afterForecastId: cursorPayload.after?.forecastId ?? null,
      limit: input.limit,
    });
    const last = page.candidates.at(-1);
    const nextCursor = page.hasMore && last
      ? await encodeCoordinatorCursor(advanceCoordinatorCursor(cursorPayload, {
        evaluationDate: last.evaluationDate, forecastId: last.forecastId,
      }))
      : null;
    const startCursor = await encodeCoordinatorCursor(cursorPayload);
    const runId = this.runtime.id('run');
    const leaseToken = this.runtime.id('run_lease');
    const plan: PlannedCoordinatorRun = {
      id: runId,
      itemIds: page.candidates.map(() => this.runtime.id('item')),
      input,
      requestFingerprint: fingerprint,
      scanStartedAt,
      snapshotMaxForecastId,
      initialCursor: input.cursor ?? null,
      resumeCursor: startCursor,
      nextCursor,
      startedAt: invokedAt,
      leaseToken,
      leaseExpiresAt: this.expiry(invokedAt),
      candidates: page.candidates,
    };
    try {
      await this.repository.createPlannedRun(plan);
    } catch (error) {
      if (input.operatorRunKey) {
        const raced = await this.repository.findRunByOperatorKey(input.profileId, input.operatorRunKey);
        if (raced && raced.requestFingerprint === fingerprint) return this.report(input.profileId, raced.id, true);
      }
      throw error;
    }

    const items = await this.repository.getRunItems(input.profileId, runId);
    const activeRun: ActiveCoordinatorRun = {
      profileId: input.profileId,
      id: runId,
      evaluationCutoff: input.cutoff,
      scanStartedAt,
      snapshotMaxForecastId,
      leaseToken,
    };
    for (const item of items) {
      await this.renewRun(activeRun);
      if (input.mode === 'dry_run') {
        await this.completeDryRunItem(activeRun, item);
      } else await this.evaluateItem(activeRun, item);
    }
    const finishedAt = this.now('run completion time');
    await this.repository.finalizeRun({
      profileId: input.profileId,
      runId,
      leaseToken,
      completedAt: finishedAt,
      durationMs: this.runtime.durationMs(invokedAt, finishedAt),
      nextCursor,
    });
    return this.report(input.profileId, runId, false);
  }
}
