import {
  CoordinatorContractError,
  isCanonicalUtcInstant,
  type CoordinatorOutcome,
} from '../coordinator/contract.ts';
import { CoordinatorSystemError, type ForecastCoordinatorService } from '../coordinator/service.ts';
import type { CoordinatorRunReport } from '../coordinator/types.ts';
import {
  SCHEDULER_VERSION,
  scheduleOccurrenceKey,
  schedulePageRunKey,
  safePersistedConfig,
  schedulerConfigFingerprint,
  type SchedulerConfig,
  type SchedulerOperationalState,
  type SchedulerPersistedStatus,
  type SchedulerStopReason,
} from './contract.ts';
import type {
  ScheduleInvocationRecord,
  SchedulePageRecord,
  SchedulePageReport,
  ScheduledInvocationReport,
  SchedulerLogger,
  SchedulerRuntime,
} from './types.ts';
import type { SchedulerRepository } from './repository.ts';

const SUCCESSFUL_COORDINATOR_STATUSES = new Set(['completed', 'completed_with_errors']);

export type RunScheduledInvocationInput = {
  config: SchedulerConfig;
  profileId: number;
  scheduledTime: string;
  scheduleExpression: string;
};

function parseObject(value: string): Partial<Record<CoordinatorOutcome, number>> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Partial<Record<CoordinatorOutcome, number>>
      : {};
  } catch {
    return {};
  }
}

function parseStrings(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function aggregate(
  existing: Partial<Record<CoordinatorOutcome, number>>,
  next: Partial<Record<CoordinatorOutcome, number>>,
) {
  const result = { ...existing };
  for (const [key, value] of Object.entries(next) as [CoordinatorOutcome, number][]) {
    result[key] = (result[key] ?? 0) + value;
  }
  return result;
}

function pageReport(row: SchedulePageRecord): SchedulePageReport {
  const visible = Object.fromEntries(Object.entries(row).filter(([key]) => (
    key !== 'profileId' && key !== 'outcomeCountsJson' && key !== 'createdAt'
  ))) as Omit<SchedulePageRecord, 'profileId' | 'outcomeCountsJson' | 'createdAt'>;
  return { ...visible, outcomeCounts: parseObject(row.outcomeCountsJson) };
}

function errorType(error: unknown) {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(error.name)
    ? error.name
    : 'UnknownError';
}

function errorCategory(error: unknown) {
  if (error instanceof CoordinatorContractError) return 'coordinator_contract_error';
  if (error instanceof CoordinatorSystemError) return 'coordinator_system_error';
  return 'unexpected_scheduler_error';
}

function persistedState(status: SchedulerPersistedStatus): SchedulerOperationalState {
  return status;
}

export async function disabledScheduledInvocation(
  input: RunScheduledInvocationInput,
  logger: SchedulerLogger,
): Promise<ScheduledInvocationReport> {
  const occurrenceKey = await scheduleOccurrenceKey(
    input.profileId, input.config.environment, input.scheduleExpression, input.scheduledTime,
  );
  logger.log({
    event: 'forecast_schedule_received', schedulerVersion: SCHEDULER_VERSION,
    environment: input.config.environment, occurrenceKey, cutoff: input.scheduledTime,
  });
  logger.log({
    event: 'forecast_schedule_disabled', schedulerVersion: SCHEDULER_VERSION,
    environment: input.config.environment, occurrenceKey, cutoff: input.scheduledTime,
    state: 'disabled',
  });
  return {
    invocationId: null, schedulerVersion: SCHEDULER_VERSION,
    environment: input.config.environment, occurrenceKey, scheduledTime: input.scheduledTime,
    cutoff: input.scheduledTime, state: 'disabled', persistedStatus: null,
    replayed: false, recovered: false, replayCount: 0, lastReplayedAt: null,
    pagesRequested: 0, pagesCompleted: 0,
    selectedCount: 0, attemptedCount: 0, mutatedCount: 0, unexpectedErrorCount: 0,
    outcomeCounts: {}, initialCursor: null, finalCursor: null, moreWork: false,
    stopReason: null, durationMs: null, errorCategory: null, coordinatorRunIds: [], pages: [],
  };
}

export class ForecastSchedulerService {
  private readonly repository: SchedulerRepository;
  private readonly coordinator: Pick<ForecastCoordinatorService, 'coordinate'>;
  private readonly runtime: SchedulerRuntime;
  private readonly logger: SchedulerLogger;
  private readonly hasAuthority: () => boolean;

  constructor(
    repository: SchedulerRepository,
    coordinator: Pick<ForecastCoordinatorService, 'coordinate'>,
    runtime: SchedulerRuntime,
    logger: SchedulerLogger,
    hasAuthority: () => boolean = () => true,
  ) {
    this.repository = repository;
    this.coordinator = coordinator;
    this.runtime = runtime;
    this.logger = logger;
    this.hasAuthority = hasAuthority;
  }

  private now() {
    const value = this.runtime.now();
    if (!isCanonicalUtcInstant(value)) throw new Error('InvalidSchedulerRuntimeInstant');
    return value;
  }

  private async report(
    record: ScheduleInvocationRecord,
    state: SchedulerOperationalState = persistedState(record.status),
    replayed = false,
    recovered = record.recoveryCount > 0,
    overrides: Partial<ScheduledInvocationReport> = {},
  ): Promise<ScheduledInvocationReport> {
    const pages = (await this.repository.getPages(record.profileId, record.id)).map(pageReport);
    return {
      invocationId: record.id,
      schedulerVersion: record.schedulerVersion,
      environment: record.environment,
      occurrenceKey: record.occurrenceKey,
      scheduledTime: record.scheduledTime,
      cutoff: record.cutoff,
      state,
      persistedStatus: record.status,
      replayed,
      recovered,
      replayCount: record.replayCount,
      lastReplayedAt: record.lastReplayedAt,
      pagesRequested: record.pagesRequested,
      pagesCompleted: record.pagesCompleted,
      selectedCount: record.selectedCount,
      attemptedCount: record.attemptedCount,
      mutatedCount: record.mutationCount,
      unexpectedErrorCount: record.unexpectedErrorCount,
      outcomeCounts: parseObject(record.outcomeCountsJson),
      initialCursor: record.initialCursor,
      finalCursor: record.finalCursor,
      moreWork: record.moreWork,
      stopReason: record.stopReason,
      durationMs: record.durationMs,
      errorCategory: record.errorCategory,
      coordinatorRunIds: parseStrings(record.coordinatorRunIdsJson),
      pages,
      ...overrides,
    };
  }

  private async current(profileId: number, invocationId: string) {
    const value = await this.repository.getInvocation(profileId, invocationId);
    if (!value) throw new Error('MissingSchedulerInvocation');
    return value;
  }

  private lostAuthority(record: ScheduleInvocationRecord) {
    if (record.status !== 'running') {
      return this.report(record, persistedState(record.status), true, record.recoveryCount > 0);
    }
    return this.report(record, 'running', true, record.recoveryCount > 0, {
      stopReason: 'authority_lost', moreWork: true,
    });
  }

  private async finalize(
    record: ScheduleInvocationRecord,
    token: string,
    status: Exclude<SchedulerPersistedStatus, 'running'>,
    stopReason: SchedulerStopReason,
    moreWork: boolean,
    error: string | null = null,
    recovered = false,
  ) {
    const completedAt = this.now();
    const owned = await this.repository.finalize({
      invocationId: record.id,
      profileId: record.profileId,
      leaseToken: token,
      completedAt,
      durationMs: this.runtime.durationMs(record.startedAt, completedAt),
      status,
      moreWork,
      stopReason,
      finalCursor: record.finalCursor,
      errorCategory: error,
    });
    const latest = await this.current(record.profileId, record.id);
    if (!owned) {
      return this.lostAuthority(latest);
    }
    const state = recovered ? 'recovered' : persistedState(status);
    const result = await this.report(latest, state, false, recovered);
    this.logger.log({
      event: status === 'coordinator_failure' || status === 'unexpected_error'
        ? 'forecast_schedule_failed' : 'forecast_schedule_completed',
      schedulerVersion: SCHEDULER_VERSION,
      environment: latest.environment,
      occurrenceKey: latest.occurrenceKey,
      invocationId: latest.id,
      cutoff: latest.cutoff,
      state,
      stopReason,
      selectedCount: latest.selectedCount,
      attemptedCount: latest.attemptedCount,
      mutatedCount: latest.mutationCount,
      unexpectedErrorCount: latest.unexpectedErrorCount,
      durationMs: latest.durationMs,
      ...(error ? { errorCategory: error } : {}),
    });
    return result;
  }

  async run(input: RunScheduledInvocationInput): Promise<ScheduledInvocationReport> {
    const { config, profileId, scheduledTime, scheduleExpression } = input;
    const occurrenceKey = await scheduleOccurrenceKey(
      profileId, config.environment, scheduleExpression, scheduledTime,
    );
    if (!config.enabled) return disabledScheduledInvocation(input, this.logger);
    this.logger.log({
      event: 'forecast_schedule_received', schedulerVersion: SCHEDULER_VERSION,
      environment: config.environment, occurrenceKey, cutoff: scheduledTime,
    });
    const fingerprint = await schedulerConfigFingerprint(config);
    const invokedAt = this.now();
    let record = await this.repository.findByOccurrence(profileId, occurrenceKey);
    let token: string;
    let recovered = false;

    if (record) {
      if (record.configFingerprint !== fingerprint) {
        this.logger.log({
          event: 'forecast_schedule_configuration_invalid', schedulerVersion: SCHEDULER_VERSION,
          environment: config.environment, occurrenceKey, invocationId: record.id,
          cutoff: scheduledTime, state: 'configuration_error', errorCategory: 'config_fingerprint_mismatch',
        });
        return this.report(record, 'configuration_error', true, record.recoveryCount > 0, {
          errorCategory: 'config_fingerprint_mismatch', moreWork: record.status === 'running' || record.moreWork,
        });
      }
      if (record.status !== 'running') {
        await this.repository.recordReplay(profileId, record.id, invokedAt);
        record = await this.current(profileId, record.id);
        this.logger.log({
          event: 'forecast_schedule_replay_detected', schedulerVersion: SCHEDULER_VERSION,
          environment: config.environment, occurrenceKey, invocationId: record.id,
          cutoff: record.cutoff, state: 'replayed', stopReason: 'replayed_terminal_invocation',
        });
        return this.report(record, 'replayed', true, record.recoveryCount > 0);
      }
      if (record.leaseExpiresAt && record.leaseExpiresAt > invokedAt) {
        await this.repository.recordReplay(profileId, record.id, invokedAt);
        record = await this.current(profileId, record.id);
        this.logger.log({
          event: 'forecast_schedule_replay_detected', schedulerVersion: SCHEDULER_VERSION,
          environment: config.environment, occurrenceKey, invocationId: record.id,
          cutoff: record.cutoff, state: 'running', stopReason: 'overlap_in_progress',
        });
        return this.report(record, 'running', true, record.recoveryCount > 0, {
          moreWork: true, stopReason: 'overlap_in_progress',
        });
      }
      token = this.runtime.id('schedule_lease');
      if (!await this.repository.acquireLease(
        profileId, record.id, token, invokedAt, this.runtime.leaseExpiresAt(invokedAt),
      )) {
        const raced = await this.current(profileId, record.id);
        if (raced.status !== 'running') return this.lostAuthority(raced);
        return this.report(raced, 'running', true, raced.recoveryCount > 0, {
          moreWork: true, stopReason: 'overlap_in_progress',
        });
      }
      recovered = true;
      record = await this.current(profileId, record.id);
      this.logger.log({
        event: 'forecast_schedule_recovery_detected', schedulerVersion: SCHEDULER_VERSION,
        environment: config.environment, occurrenceKey, invocationId: record.id,
        cutoff: record.cutoff, state: 'recovered',
      });
    } else {
      const id = this.runtime.id('schedule_invocation');
      token = this.runtime.id('schedule_lease');
      const created = await this.repository.createInvocation({
        id, profileId, schedulerVersion: config.schedulerVersion,
        coordinatorVersion: config.coordinatorVersion, environment: config.environment,
        occurrenceKey, scheduleExpression, scheduledTime, cutoff: scheduledTime,
        configFingerprint: fingerprint, configurationJson: JSON.stringify(safePersistedConfig(config)),
        leaseToken: token, leaseExpiresAt: this.runtime.leaseExpiresAt(invokedAt), startedAt: invokedAt,
      });
      record = created
        ? await this.current(profileId, id)
        : await this.repository.findByOccurrence(profileId, occurrenceKey);
      if (!record) throw new Error('MissingSchedulerInvocation');
      if (!created) return this.run(input);
      this.logger.log({
        event: 'forecast_schedule_started', schedulerVersion: SCHEDULER_VERSION,
        environment: config.environment, occurrenceKey, invocationId: record.id,
        cutoff: record.cutoff, state: 'running',
      });
    }

    const persistedPages = await this.repository.getPages(profileId, record.id);
    const seen = new Set<string>();
    for (const page of persistedPages) {
      if (page.inputCursor) seen.add(page.inputCursor);
      if (page.outputCursor) seen.add(page.outputCursor);
    }
    const lastPersistedPage = persistedPages.at(-1);
    if (lastPersistedPage?.state === 'completed'
      && lastPersistedPage.pageNumber === record.pagesCompleted
      && lastPersistedPage.outputCursor === null) {
      return this.finalize(record, token, 'completed', 'no_more_work', false, null, recovered);
    }
    if (lastPersistedPage?.state === 'failed'
      && lastPersistedPage.pageNumber === record.pagesCompleted + 1) {
      const unexpected = lastPersistedPage.errorCategory === 'unexpected_scheduler_error';
      return this.finalize(record, token,
        unexpected ? 'unexpected_error' : 'coordinator_failure',
        unexpected ? 'unexpected_error' : 'coordinator_failure', true,
        lastPersistedPage.errorCategory ?? 'coordinator_failure', recovered);
    }

    while (true) {
      record = await this.current(profileId, record.id);
      let stop: SchedulerStopReason | null = null;
      if (!this.hasAuthority()) stop = 'authority_lost';
      else if (record.pagesCompleted >= config.maxPages) stop = 'max_pages_reached';
      else if (record.selectedCount >= config.maxItems) stop = 'max_items_reached';
      else if (this.runtime.elapsedMs(invokedAt) + config.minRemainingMs >= config.maxRuntimeMs) {
        stop = 'runtime_budget_reached';
      }
      if (stop) {
        this.logger.log({
          event: 'forecast_schedule_budget_reached', schedulerVersion: SCHEDULER_VERSION,
          environment: config.environment, occurrenceKey, invocationId: record.id,
          cutoff: record.cutoff, state: 'partial_budget_exhausted', stopReason: stop,
        });
        return this.finalize(record, token, 'partial_budget_exhausted', stop, true, null, recovered);
      }

      const pageNumber = record.pagesCompleted + 1;
      const inputCursor = record.finalCursor;
      const batchLimit = Math.min(config.pageSize, config.maxItems - record.selectedCount);
      const operatorRunKey = schedulePageRunKey(occurrenceKey, pageNumber);
      let page = await this.repository.getPage(profileId, record.id, pageNumber);
      if (page && (page.operatorRunKey !== operatorRunKey
        || page.inputCursor !== inputCursor || page.batchLimit !== batchLimit)) {
        return this.finalize(record, token, 'unexpected_error', 'unexpected_error', true,
          'persisted_page_mismatch', recovered);
      }
      if (page?.state === 'completed') {
        return this.finalize(record, token, 'unexpected_error', 'unexpected_error', true,
          'inconsistent_page_progress', recovered);
      }
      const pageStartedAt = page?.startedAt ?? this.now();
      if (!page) {
        const begun = await this.repository.beginPage({
          id: this.runtime.id('schedule_page'), invocationId: record.id, profileId,
          pageNumber, operatorRunKey, batchLimit, inputCursor, startedAt: pageStartedAt,
          leaseToken: token,
        });
        if (!begun) {
          const latest = await this.current(profileId, record.id);
          return this.lostAuthority(latest);
        }
        page = await this.repository.getPage(profileId, record.id, pageNumber);
      }
      if (!page) throw new Error('MissingSchedulerPage');
      this.logger.log({
        event: 'forecast_schedule_page_started', schedulerVersion: SCHEDULER_VERSION,
        environment: config.environment, occurrenceKey, invocationId: record.id,
        cutoff: record.cutoff, pageNumber,
      });

      const renewedAt = this.now();
      if (!await this.repository.renewLease(
        profileId, record.id, token, renewedAt, this.runtime.leaseExpiresAt(renewedAt),
      )) {
        return this.lostAuthority(await this.current(profileId, record.id));
      }

      let coordinatorReport: CoordinatorRunReport;
      try {
        coordinatorReport = await this.coordinator.coordinate({
          profileId, cutoff: scheduledTime, limit: batchLimit, mode: 'execute',
          ...(inputCursor ? { cursor: inputCursor } : {}), operatorRunKey,
        }, profileId);
      } catch (error) {
        const failedAt = this.now();
        const category = errorCategory(error);
        await this.repository.failPage({
          invocationId: record.id, profileId, pageNumber, leaseToken: token,
          completedAt: failedAt, durationMs: this.runtime.durationMs(pageStartedAt, failedAt),
          errorCategory: category, errorType: errorType(error),
        });
        record = await this.current(profileId, record.id);
        return this.finalize(record, token,
          category === 'unexpected_scheduler_error' ? 'unexpected_error' : 'coordinator_failure',
          category === 'unexpected_scheduler_error' ? 'unexpected_error' : 'coordinator_failure',
          true, category, recovered);
      }

      if (coordinatorReport.status === 'running') {
        this.logger.log({
          event: 'forecast_schedule_replay_detected', schedulerVersion: SCHEDULER_VERSION,
          environment: config.environment, occurrenceKey, invocationId: record.id,
          cutoff: record.cutoff, pageNumber, coordinatorRunId: coordinatorReport.runId,
          state: 'running', stopReason: 'overlap_in_progress',
        });
        return this.report(await this.current(profileId, record.id), 'running', true, recovered, {
          moreWork: true, stopReason: 'overlap_in_progress',
        });
      }
      if (!SUCCESSFUL_COORDINATOR_STATUSES.has(coordinatorReport.status)) {
        const failedAt = this.now();
        await this.repository.failPage({
          invocationId: record.id, profileId, pageNumber, leaseToken: token,
          completedAt: failedAt, durationMs: this.runtime.durationMs(pageStartedAt, failedAt),
          errorCategory: 'coordinator_terminal_failure', errorType: 'CoordinatorRunFailure',
        });
        record = await this.current(profileId, record.id);
        return this.finalize(record, token, 'coordinator_failure', 'coordinator_failure', true,
          'coordinator_terminal_failure', recovered);
      }

      const outputCursor = coordinatorReport.nextCursor;
      const repeatedCursor = outputCursor !== null
        && (outputCursor === inputCursor || seen.has(outputCursor));
      const completedAt = this.now();
      const completed = await this.repository.completePage({
        invocationId: record.id, profileId, pageNumber, leaseToken: token,
        completedAt, durationMs: this.runtime.durationMs(pageStartedAt, completedAt),
        coordinatorRunId: coordinatorReport.runId, coordinatorRunStatus: coordinatorReport.status,
        outputCursor, selectedCount: coordinatorReport.selectedCount,
        attemptedCount: coordinatorReport.attemptedCount, mutationCount: coordinatorReport.mutatedCount,
        unexpectedErrorCount: coordinatorReport.unexpectedErrorCount,
        outcomeCounts: coordinatorReport.outcomeCounts,
        aggregateOutcomeCounts: aggregate(
          parseObject(record.outcomeCountsJson), coordinatorReport.outcomeCounts,
        ),
        replayUsedExistingRun: coordinatorReport.replayUsedExistingRun,
      });
      record = await this.current(profileId, record.id);
      if (!completed) {
        return this.lostAuthority(record);
      }
      this.logger.log({
        event: 'forecast_schedule_page_completed', schedulerVersion: SCHEDULER_VERSION,
        environment: config.environment, occurrenceKey, invocationId: record.id,
        cutoff: record.cutoff, pageNumber, coordinatorRunId: coordinatorReport.runId,
        selectedCount: coordinatorReport.selectedCount,
        attemptedCount: coordinatorReport.attemptedCount,
        mutatedCount: coordinatorReport.mutatedCount,
        unexpectedErrorCount: coordinatorReport.unexpectedErrorCount,
        durationMs: this.runtime.durationMs(pageStartedAt, completedAt),
      });
      if (repeatedCursor) {
        return this.finalize(record, token, 'coordinator_failure', 'repeated_cursor', true,
          'repeated_cursor', recovered);
      }
      if (!outputCursor) {
        return this.finalize(record, token, 'completed', 'no_more_work', false, null, recovered);
      }
      seen.add(outputCursor);
    }
  }
}
