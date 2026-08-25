import type { CoordinatorOutcome, CoordinatorRunStatus } from '../coordinator/contract.ts';
import type {
  ScheduleInvocationRecord,
  SchedulePageRecord,
} from './types.ts';
import type { SchedulerEnvironment, SchedulerPersistedStatus, SchedulerStopReason } from './contract.ts';

type InvocationRow = Omit<ScheduleInvocationRecord, 'moreWork'> & { moreWork: number };
type PageRow = Omit<SchedulePageRecord, 'replayUsedExistingRun'> & { replayUsedExistingRun: number };

const INVOCATION_SELECT = `SELECT id, profile_id AS profileId,
  scheduler_version AS schedulerVersion, coordinator_version AS coordinatorVersion,
  environment, occurrence_key AS occurrenceKey, schedule_expression AS scheduleExpression,
  scheduled_time AS scheduledTime, evaluation_cutoff AS cutoff,
  config_fingerprint AS configFingerprint, configuration_json AS configurationJson,
  status, lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt,
  recovery_count AS recoveryCount, replay_count AS replayCount,
  last_replayed_at AS lastReplayedAt, started_at AS startedAt, completed_at AS completedAt,
  duration_ms AS durationMs, pages_requested AS pagesRequested, pages_completed AS pagesCompleted,
  selected_count AS selectedCount, attempted_count AS attemptedCount,
  mutation_count AS mutationCount, unexpected_error_count AS unexpectedErrorCount,
  outcome_counts_json AS outcomeCountsJson, initial_cursor AS initialCursor,
  final_cursor AS finalCursor, more_work AS moreWork, stop_reason AS stopReason,
  error_category AS errorCategory, coordinator_run_ids_json AS coordinatorRunIdsJson,
  created_at AS createdAt FROM forecast_scheduler_invocations`;

const PAGE_SELECT = `SELECT id, invocation_id AS invocationId, profile_id AS profileId,
  page_number AS pageNumber, state, coordinator_run_id AS coordinatorRunId,
  coordinator_run_status AS coordinatorRunStatus, operator_run_key AS operatorRunKey,
  batch_limit AS batchLimit, input_cursor AS inputCursor, output_cursor AS outputCursor,
  selected_count AS selectedCount, attempted_count AS attemptedCount,
  mutation_count AS mutationCount, unexpected_error_count AS unexpectedErrorCount,
  outcome_counts_json AS outcomeCountsJson, replay_used_existing_run AS replayUsedExistingRun,
  started_at AS startedAt, completed_at AS completedAt, duration_ms AS durationMs,
  error_category AS errorCategory, error_type AS errorType, created_at AS createdAt
  FROM forecast_scheduler_pages`;

function changed(result: D1Result<unknown> | undefined) {
  return Number(result?.meta?.changes ?? 0);
}

function invocation(row: InvocationRow): ScheduleInvocationRecord {
  return { ...row, moreWork: Boolean(row.moreWork) };
}

function page(row: PageRow): SchedulePageRecord {
  return { ...row, replayUsedExistingRun: Boolean(row.replayUsedExistingRun) };
}

export type NewScheduleInvocation = {
  id: string;
  profileId: number;
  schedulerVersion: string;
  coordinatorVersion: string;
  environment: SchedulerEnvironment;
  occurrenceKey: string;
  scheduleExpression: string;
  scheduledTime: string;
  cutoff: string;
  configFingerprint: string;
  configurationJson: string;
  leaseToken: string;
  leaseExpiresAt: string;
  startedAt: string;
};

export type BeginSchedulePage = {
  id: string;
  invocationId: string;
  profileId: number;
  pageNumber: number;
  operatorRunKey: string;
  batchLimit: number;
  inputCursor: string | null;
  startedAt: string;
  leaseToken: string;
};

export type CompleteSchedulePage = {
  invocationId: string;
  profileId: number;
  pageNumber: number;
  leaseToken: string;
  completedAt: string;
  durationMs: number;
  coordinatorRunId: string;
  coordinatorRunStatus: CoordinatorRunStatus;
  outputCursor: string | null;
  selectedCount: number;
  attemptedCount: number;
  mutationCount: number;
  unexpectedErrorCount: number;
  outcomeCounts: Partial<Record<CoordinatorOutcome, number>>;
  aggregateOutcomeCounts: Partial<Record<CoordinatorOutcome, number>>;
  replayUsedExistingRun: boolean;
};

export type FinalizeScheduleInvocation = {
  invocationId: string;
  profileId: number;
  leaseToken: string;
  completedAt: string;
  durationMs: number;
  status: Exclude<SchedulerPersistedStatus, 'running'>;
  moreWork: boolean;
  stopReason: SchedulerStopReason;
  finalCursor: string | null;
  errorCategory: string | null;
};

export interface SchedulerRepository {
  findByOccurrence(profileId: number, occurrenceKey: string): Promise<ScheduleInvocationRecord | null>;
  getInvocation(profileId: number, invocationId: string): Promise<ScheduleInvocationRecord | null>;
  getPage(profileId: number, invocationId: string, pageNumber: number): Promise<SchedulePageRecord | null>;
  getPages(profileId: number, invocationId: string): Promise<SchedulePageRecord[]>;
  listRecent(profileId: number, limit: number): Promise<ScheduleInvocationRecord[]>;
  createInvocation(value: NewScheduleInvocation): Promise<boolean>;
  acquireLease(profileId: number, invocationId: string, token: string, now: string, expiresAt: string): Promise<boolean>;
  recordReplay(profileId: number, invocationId: string, replayedAt: string): Promise<boolean>;
  renewLease(profileId: number, invocationId: string, token: string, now: string, expiresAt: string): Promise<boolean>;
  beginPage(value: BeginSchedulePage): Promise<boolean>;
  completePage(value: CompleteSchedulePage): Promise<boolean>;
  failPage(value: {
    invocationId: string; profileId: number; pageNumber: number; leaseToken: string;
    completedAt: string; durationMs: number; errorCategory: string; errorType: string;
  }): Promise<boolean>;
  finalize(value: FinalizeScheduleInvocation): Promise<boolean>;
}

export class D1SchedulerRepository implements SchedulerRepository {
  private readonly d1: D1Database;

  constructor(d1: D1Database) {
    this.d1 = d1;
  }

  async findByOccurrence(profileId: number, occurrenceKey: string) {
    const row = await this.d1.prepare(`${INVOCATION_SELECT} WHERE profile_id = ? AND occurrence_key = ?`)
      .bind(profileId, occurrenceKey).first<InvocationRow>();
    return row ? invocation(row) : null;
  }

  async getInvocation(profileId: number, invocationId: string) {
    const row = await this.d1.prepare(`${INVOCATION_SELECT} WHERE profile_id = ? AND id = ?`)
      .bind(profileId, invocationId).first<InvocationRow>();
    return row ? invocation(row) : null;
  }

  async getPage(profileId: number, invocationId: string, pageNumber: number) {
    const row = await this.d1.prepare(`${PAGE_SELECT} WHERE profile_id = ? AND invocation_id = ? AND page_number = ?`)
      .bind(profileId, invocationId, pageNumber).first<PageRow>();
    return row ? page(row) : null;
  }

  async getPages(profileId: number, invocationId: string) {
    const rows = await this.d1.prepare(`${PAGE_SELECT} WHERE profile_id = ? AND invocation_id = ? ORDER BY page_number`)
      .bind(profileId, invocationId).all<PageRow>();
    return rows.results.map(page);
  }

  async listRecent(profileId: number, limit: number) {
    const rows = await this.d1.prepare(`${INVOCATION_SELECT} WHERE profile_id = ? ORDER BY scheduled_time DESC, id DESC LIMIT ?`)
      .bind(profileId, limit).all<InvocationRow>();
    return rows.results.map(invocation);
  }

  async createInvocation(value: NewScheduleInvocation) {
    const result = await this.d1.prepare(`INSERT OR IGNORE INTO forecast_scheduler_invocations
      (id, profile_id, scheduler_version, coordinator_version, environment, occurrence_key,
       schedule_expression, scheduled_time, evaluation_cutoff, config_fingerprint,
       configuration_json, status, lease_token, lease_expires_at, started_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
      .bind(value.id, value.profileId, value.schedulerVersion, value.coordinatorVersion,
        value.environment, value.occurrenceKey, value.scheduleExpression, value.scheduledTime,
        value.cutoff, value.configFingerprint, value.configurationJson, value.leaseToken,
        value.leaseExpiresAt, value.startedAt, value.startedAt).run();
    return changed(result) === 1;
  }

  async acquireLease(profileId: number, invocationId: string, token: string, now: string, expiresAt: string) {
    const result = await this.d1.prepare(`UPDATE forecast_scheduler_invocations
      SET lease_token = ?, lease_expires_at = ?, recovery_count = recovery_count + 1
      WHERE profile_id = ? AND id = ? AND status = 'running'
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`)
      .bind(token, expiresAt, profileId, invocationId, now).run();
    return changed(result) === 1;
  }

  async recordReplay(profileId: number, invocationId: string, replayedAt: string) {
    const result = await this.d1.prepare(`UPDATE forecast_scheduler_invocations
      SET replay_count = replay_count + 1, last_replayed_at = ?
      WHERE profile_id = ? AND id = ?`)
      .bind(replayedAt, profileId, invocationId).run();
    return changed(result) === 1;
  }

  async renewLease(profileId: number, invocationId: string, token: string, now: string, expiresAt: string) {
    const result = await this.d1.prepare(`UPDATE forecast_scheduler_invocations SET lease_expires_at = ?
      WHERE profile_id = ? AND id = ? AND status = 'running' AND lease_token = ? AND lease_expires_at > ?`)
      .bind(expiresAt, profileId, invocationId, token, now).run();
    return changed(result) === 1;
  }

  async beginPage(value: BeginSchedulePage) {
    const results = await this.d1.batch([
      this.d1.prepare(`INSERT OR IGNORE INTO forecast_scheduler_pages
        (id, invocation_id, profile_id, page_number, state, operator_run_key, batch_limit,
         input_cursor, started_at, created_at)
        SELECT ?, ?, ?, ?, 'started', ?, ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM forecast_scheduler_invocations WHERE id = ? AND profile_id = ?
          AND status = 'running' AND lease_token = ? AND lease_expires_at > ?)`)
        .bind(value.id, value.invocationId, value.profileId, value.pageNumber,
          value.operatorRunKey, value.batchLimit, value.inputCursor, value.startedAt,
          value.startedAt, value.invocationId, value.profileId, value.leaseToken, value.startedAt),
      this.d1.prepare(`UPDATE forecast_scheduler_invocations
        SET pages_requested = MAX(pages_requested, ?),
          initial_cursor = CASE WHEN ? = 1 THEN ? ELSE initial_cursor END
        WHERE id = ? AND profile_id = ? AND status = 'running' AND lease_token = ? AND lease_expires_at > ?`)
        .bind(value.pageNumber, value.pageNumber, value.inputCursor, value.invocationId, value.profileId,
          value.leaseToken, value.startedAt),
    ]);
    return changed(results[0]) === 1 && changed(results[1]) === 1;
  }

  async completePage(value: CompleteSchedulePage) {
    const outcomes = JSON.stringify(value.outcomeCounts);
    const aggregateOutcomes = JSON.stringify(value.aggregateOutcomeCounts);
    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE forecast_scheduler_pages SET state = 'completed',
        coordinator_run_id = ?, coordinator_run_status = ?, output_cursor = ?,
        selected_count = ?, attempted_count = ?, mutation_count = ?, unexpected_error_count = ?,
        outcome_counts_json = ?, replay_used_existing_run = ?, completed_at = ?, duration_ms = ?
        WHERE invocation_id = ? AND profile_id = ? AND page_number = ? AND state = 'started'
          AND EXISTS (SELECT 1 FROM forecast_scheduler_invocations si WHERE si.id = invocation_id
            AND si.profile_id = profile_id AND si.status = 'running' AND si.lease_token = ?
            AND si.lease_expires_at > ?)`)
        .bind(value.coordinatorRunId, value.coordinatorRunStatus, value.outputCursor,
          value.selectedCount, value.attemptedCount, value.mutationCount,
          value.unexpectedErrorCount, outcomes, value.replayUsedExistingRun ? 1 : 0,
          value.completedAt, value.durationMs, value.invocationId, value.profileId,
          value.pageNumber, value.leaseToken, value.completedAt),
      this.d1.prepare(`UPDATE forecast_scheduler_invocations SET
        pages_completed = pages_completed + 1,
        selected_count = selected_count + ?, attempted_count = attempted_count + ?,
        mutation_count = mutation_count + ?, unexpected_error_count = unexpected_error_count + ?,
        outcome_counts_json = json_patch(outcome_counts_json, ?), final_cursor = ?,
        coordinator_run_ids_json = json_insert(coordinator_run_ids_json, '$[#]', ?)
        WHERE id = ? AND profile_id = ? AND status = 'running' AND lease_token = ?
          AND lease_expires_at > ? AND changes() = 1`)
        .bind(value.selectedCount, value.attemptedCount, value.mutationCount,
          value.unexpectedErrorCount, aggregateOutcomes, value.outputCursor, value.coordinatorRunId,
          value.invocationId, value.profileId, value.leaseToken, value.completedAt),
    ]);
    return changed(results[0]) === 1 && changed(results[1]) === 1;
  }

  async failPage(value: {
    invocationId: string; profileId: number; pageNumber: number; leaseToken: string;
    completedAt: string; durationMs: number; errorCategory: string; errorType: string;
  }) {
    const result = await this.d1.prepare(`UPDATE forecast_scheduler_pages SET state = 'failed',
      completed_at = ?, duration_ms = ?, error_category = ?, error_type = ?
      WHERE invocation_id = ? AND profile_id = ? AND page_number = ? AND state = 'started'
        AND EXISTS (SELECT 1 FROM forecast_scheduler_invocations si WHERE si.id = invocation_id
          AND si.profile_id = profile_id AND si.status = 'running' AND si.lease_token = ?
          AND si.lease_expires_at > ?)`)
      .bind(value.completedAt, value.durationMs, value.errorCategory, value.errorType,
        value.invocationId, value.profileId, value.pageNumber, value.leaseToken,
        value.completedAt).run();
    return changed(result) === 1;
  }

  async finalize(value: FinalizeScheduleInvocation) {
    const result = await this.d1.prepare(`UPDATE forecast_scheduler_invocations SET status = ?,
      completed_at = ?, duration_ms = ?, more_work = ?, stop_reason = ?, final_cursor = ?,
      error_category = ?, lease_token = NULL, lease_expires_at = NULL
      WHERE id = ? AND profile_id = ? AND status = 'running' AND lease_token = ?
        AND lease_expires_at > ?`)
      .bind(value.status, value.completedAt, value.durationMs, value.moreWork ? 1 : 0,
        value.stopReason, value.finalCursor, value.errorCategory, value.invocationId,
        value.profileId, value.leaseToken, value.completedAt).run();
    return changed(result) === 1;
  }
}
