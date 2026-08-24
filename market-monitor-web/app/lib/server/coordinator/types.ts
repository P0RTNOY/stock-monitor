import type { EvaluationKind } from '../evaluation/types.ts';
import type { ForecastStatus } from '../forecasts/types.ts';
import type {
  CoordinatorDueReason,
  CoordinatorInput,
  CoordinatorMode,
  CoordinatorOutcome,
  CoordinatorRunStatus,
} from './contract.ts';
import type { CoordinatorCursorPosition } from './cursor.ts';

export type DueForecastCandidate = {
  forecastId: number;
  symbol: string;
  status: 'active';
  evaluationDate: string;
  activatedAt: string;
  dueReason: CoordinatorDueReason;
  latestEvaluationRunId: number | null;
  latestEvaluationKind: EvaluationKind | null;
  latestEvaluationCutoff: string | null;
  retryCount: number;
  latestRetryClassification: CoordinatorOutcome | null;
};

export type DueForecastPage = {
  candidates: DueForecastCandidate[];
  hasMore: boolean;
};

export type CoordinatorRunRecord = {
  id: string;
  profileId: number;
  coordinatorVersion: string;
  mode: CoordinatorMode;
  evaluationCutoff: string;
  batchLimit: number;
  scanStartedAt: string;
  snapshotMaxForecastId: number;
  initialCursor: string | null;
  resumeCursor: string | null;
  nextCursor: string | null;
  operatorRunKey: string | null;
  requestFingerprint: string;
  status: CoordinatorRunStatus;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  recoveryCount: number;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  selectedCount: number;
  attemptedCount: number;
  mutationCount: number;
  unexpectedErrorCount: number;
  outcomeCounts: Partial<Record<CoordinatorOutcome, number>>;
  warnings: string[];
  createdAt: string;
};

export type CoordinatorRunItemRecord = {
  id: string;
  runId: string;
  profileId: number;
  forecastId: number;
  ordinal: number;
  symbol: string;
  evaluationCutoff: string;
  sortEvaluationDate: string;
  sortForecastId: number;
  dueReason: CoordinatorDueReason;
  previousStatus: ForecastStatus;
  currentStatus: ForecastStatus | null;
  latestEvaluationRunId: number | null;
  latestEvaluationKind: EvaluationKind | null;
  latestEvaluationCutoff: string | null;
  state: 'pending' | 'completed';
  classification: CoordinatorOutcome | null;
  evaluatorResultKind: EvaluationKind | null;
  evaluationRunId: number | null;
  reviewItemId: number | null;
  reasonCode: string | null;
  safeExplanation: string | null;
  attemptStartedAt: string | null;
  attemptFinishedAt: string | null;
  providerCalled: boolean;
  mutated: boolean;
  retryUseful: boolean;
  redactedErrorCategory: string | null;
  providerVersion: string | null;
  evaluatorVersion: string | null;
  rulesetVersion: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type CoordinatorItemCompletion = {
  classification: CoordinatorOutcome;
  currentStatus: ForecastStatus | null;
  evaluatorResultKind?: EvaluationKind | null;
  evaluationRunId?: number | null;
  reviewItemId?: number | null;
  reasonCode: string;
  safeExplanation: string;
  attemptStartedAt?: string | null;
  attemptFinishedAt?: string | null;
  mutated: boolean;
  retryUseful: boolean;
  redactedErrorCategory?: string | null;
  providerVersion?: string | null;
  evaluatorVersion?: string | null;
  rulesetVersion?: string | null;
};

export type CoordinatorItemReport = Omit<CoordinatorRunItemRecord, 'state' | 'createdAt' | 'completedAt' | 'providerCalled'> & {
  cutoff: string;
  cursorPosition: CoordinatorCursorPosition;
  wouldCallProvider: boolean;
};

export type CoordinatorRunReport = {
  runId: string;
  coordinatorVersion: string;
  mode: CoordinatorMode;
  profileId: number;
  cutoff: string;
  initialCursor: string | null;
  resumeCursor: string | null;
  nextCursor: string | null;
  hasMore: boolean;
  selectedCount: number;
  attemptedCount: number;
  mutatedCount: number;
  outcomeCounts: Partial<Record<CoordinatorOutcome, number>>;
  unexpectedErrorCount: number;
  totalDurationMs: number | null;
  status: CoordinatorRunStatus;
  items: CoordinatorItemReport[];
  warnings: string[];
  replayUsedExistingRun: boolean;
};

export type PlannedCoordinatorRun = {
  id: string;
  itemIds: string[];
  input: CoordinatorInput;
  requestFingerprint: string;
  scanStartedAt: string;
  snapshotMaxForecastId: number;
  initialCursor: string | null;
  resumeCursor: string;
  nextCursor: string | null;
  startedAt: string;
  leaseToken: string;
  leaseExpiresAt: string;
  candidates: DueForecastCandidate[];
};
