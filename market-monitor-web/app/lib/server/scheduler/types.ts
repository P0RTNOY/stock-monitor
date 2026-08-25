import type { CoordinatorOutcome, CoordinatorRunStatus } from '../coordinator/contract.ts';
import type {
  SchedulerConfig,
  SchedulerOperationalState,
  SchedulerPersistedStatus,
  SchedulerStopReason,
} from './contract.ts';

export type ScheduleInvocationRecord = {
  id: string;
  profileId: number;
  schedulerVersion: string;
  coordinatorVersion: string;
  environment: SchedulerConfig['environment'];
  occurrenceKey: string;
  scheduleExpression: string;
  scheduledTime: string;
  cutoff: string;
  configFingerprint: string;
  configurationJson: string;
  status: SchedulerPersistedStatus;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  recoveryCount: number;
  replayCount: number;
  lastReplayedAt: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  pagesRequested: number;
  pagesCompleted: number;
  selectedCount: number;
  attemptedCount: number;
  mutationCount: number;
  unexpectedErrorCount: number;
  outcomeCountsJson: string;
  initialCursor: string | null;
  finalCursor: string | null;
  moreWork: boolean;
  stopReason: SchedulerStopReason | null;
  errorCategory: string | null;
  coordinatorRunIdsJson: string;
  createdAt: string;
};

export type SchedulePageRecord = {
  id: string;
  invocationId: string;
  profileId: number;
  pageNumber: number;
  state: 'started' | 'completed' | 'failed';
  coordinatorRunId: string | null;
  coordinatorRunStatus: CoordinatorRunStatus | null;
  operatorRunKey: string;
  batchLimit: number;
  inputCursor: string | null;
  outputCursor: string | null;
  selectedCount: number;
  attemptedCount: number;
  mutationCount: number;
  unexpectedErrorCount: number;
  outcomeCountsJson: string;
  replayUsedExistingRun: boolean;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  errorCategory: string | null;
  errorType: string | null;
  createdAt: string;
};

export type SchedulePageReport = Omit<SchedulePageRecord, 'profileId' | 'outcomeCountsJson' | 'createdAt'> & {
  outcomeCounts: Partial<Record<CoordinatorOutcome, number>>;
};

export type ScheduledInvocationReport = {
  invocationId: string | null;
  schedulerVersion: string;
  environment: SchedulerConfig['environment'];
  occurrenceKey: string;
  scheduledTime: string;
  cutoff: string;
  state: SchedulerOperationalState;
  persistedStatus: SchedulerPersistedStatus | null;
  replayed: boolean;
  recovered: boolean;
  replayCount: number;
  lastReplayedAt: string | null;
  pagesRequested: number;
  pagesCompleted: number;
  selectedCount: number;
  attemptedCount: number;
  mutatedCount: number;
  unexpectedErrorCount: number;
  outcomeCounts: Partial<Record<CoordinatorOutcome, number>>;
  initialCursor: string | null;
  finalCursor: string | null;
  moreWork: boolean;
  stopReason: SchedulerStopReason | null;
  durationMs: number | null;
  errorCategory: string | null;
  coordinatorRunIds: string[];
  pages: SchedulePageReport[];
};

export type SchedulerRuntime = {
  now(): string;
  elapsedMs(startedAt: string): number;
  durationMs(startedAt: string, finishedAt: string): number;
  leaseExpiresAt(acquiredAt: string): string;
  id(kind: 'schedule_invocation' | 'schedule_page' | 'schedule_lease'): string;
};

export type SchedulerEventName =
  | 'forecast_schedule_received'
  | 'forecast_schedule_disabled'
  | 'forecast_schedule_configuration_invalid'
  | 'forecast_schedule_started'
  | 'forecast_schedule_page_started'
  | 'forecast_schedule_page_completed'
  | 'forecast_schedule_budget_reached'
  | 'forecast_schedule_replay_detected'
  | 'forecast_schedule_recovery_detected'
  | 'forecast_schedule_completed'
  | 'forecast_schedule_failed';

export type SchedulerLogEntry = {
  event: SchedulerEventName;
  schedulerVersion: string;
  environment?: SchedulerConfig['environment'];
  occurrenceKey?: string;
  invocationId?: string;
  cutoff?: string;
  pageNumber?: number;
  coordinatorRunId?: string;
  state?: SchedulerOperationalState;
  stopReason?: SchedulerStopReason;
  selectedCount?: number;
  attemptedCount?: number;
  mutatedCount?: number;
  unexpectedErrorCount?: number;
  durationMs?: number | null;
  errorCategory?: string;
  errorType?: string;
};

export type SchedulerLogger = {
  log(entry: SchedulerLogEntry): void;
};
