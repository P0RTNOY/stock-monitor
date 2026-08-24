import type { EvaluationKind } from '../evaluation/types.ts';
import {
  COORDINATOR_MAX_SAME_CUTOFF_RETRIES,
  COORDINATOR_VERSION,
  type CoordinatorDueReason,
  type CoordinatorOutcome,
  type CoordinatorRunStatus,
} from './contract.ts';
import type {
  CoordinatorItemCompletion,
  CoordinatorRunItemRecord,
  CoordinatorRunRecord,
  DueForecastPage,
  PlannedCoordinatorRun,
} from './types.ts';

type DueRow = {
  forecastId: number;
  symbol: string;
  status: 'active';
  evaluationDate: string;
  activatedAt: string;
  latestEvaluationRunId: number | null;
  latestEvaluationKind: EvaluationKind | null;
  latestEvaluationCutoff: string | null;
  retryCount: number;
  latestRetryClassification: CoordinatorOutcome | null;
};

type RunRow = Omit<CoordinatorRunRecord, 'outcomeCounts' | 'warnings'> & {
  outcomeCountsJson: string;
  warningsJson: string;
};

type ItemRow = Omit<CoordinatorRunItemRecord, 'mutated' | 'retryUseful' | 'providerCalled'> & {
  mutated: number;
  retryUseful: number;
  providerCalled: number;
};

export type CoordinatorProcessedState = {
  evaluationRunId: number;
  resultKind: EvaluationKind;
  reasonCode: string;
  explanation: string;
  evaluationCutoff: string;
  evaluatorVersion: string;
  rulesetVersion: string;
  reviewItemId: number | null;
} | null;

export type ClaimResult = 'acquired' | 'conflict';

const RUN_SELECT = `SELECT id, profile_id AS profileId, coordinator_version AS coordinatorVersion,
  mode, evaluation_cutoff AS evaluationCutoff, batch_limit AS batchLimit,
  scan_started_at AS scanStartedAt, snapshot_max_forecast_id AS snapshotMaxForecastId,
  initial_cursor AS initialCursor, resume_cursor AS resumeCursor, next_cursor AS nextCursor,
  operator_run_key AS operatorRunKey, request_fingerprint AS requestFingerprint,
  status, lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt,
  recovery_count AS recoveryCount, started_at AS startedAt, completed_at AS completedAt,
  duration_ms AS durationMs, selected_count AS selectedCount, attempted_count AS attemptedCount,
  mutation_count AS mutationCount, unexpected_error_count AS unexpectedErrorCount,
  outcome_counts_json AS outcomeCountsJson, warnings_json AS warningsJson, created_at AS createdAt
  FROM forecast_coordinator_runs`;

const ITEM_SELECT = `SELECT id, run_id AS runId, profile_id AS profileId, forecast_id AS forecastId,
  ordinal, symbol, evaluation_cutoff AS evaluationCutoff,
  sort_evaluation_date AS sortEvaluationDate, sort_forecast_id AS sortForecastId,
  due_reason AS dueReason, previous_status AS previousStatus, current_status AS currentStatus,
  latest_evaluation_run_id AS latestEvaluationRunId,
  latest_evaluation_kind AS latestEvaluationKind,
  latest_evaluation_cutoff AS latestEvaluationCutoff,
  state, classification, evaluator_result_kind AS evaluatorResultKind,
  evaluation_run_id AS evaluationRunId, review_item_id AS reviewItemId,
  reason_code AS reasonCode, safe_explanation AS safeExplanation,
  attempt_started_at AS attemptStartedAt, attempt_finished_at AS attemptFinishedAt,
  EXISTS (SELECT 1 FROM forecast_coordinator_item_attempts ia
    WHERE ia.profile_id = forecast_coordinator_run_items.profile_id
      AND ia.item_id = forecast_coordinator_run_items.id) AS providerCalled,
  mutated, retry_useful AS retryUseful, redacted_error_category AS redactedErrorCategory,
  provider_version AS providerVersion, evaluator_version AS evaluatorVersion,
  ruleset_version AS rulesetVersion, completed_at AS completedAt, created_at AS createdAt
  FROM forecast_coordinator_run_items`;

function changed(result: D1Result<unknown> | undefined) {
  return Number(result?.meta?.changes ?? 0);
}

function parseObject(value: string) {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function parseStrings(value: string) {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
}

function mapRun(row: RunRow): CoordinatorRunRecord {
  return {
    ...row,
    outcomeCounts: parseObject(row.outcomeCountsJson) as Partial<Record<CoordinatorOutcome, number>>,
    warnings: parseStrings(row.warningsJson),
  };
}

function mapItem(row: ItemRow): CoordinatorRunItemRecord {
  return {
    ...row,
    providerCalled: Boolean(row.providerCalled),
    mutated: Boolean(row.mutated),
    retryUseful: Boolean(row.retryUseful),
  };
}

function dueReason(row: DueRow, cutoff: string): CoordinatorDueReason {
  const retry = row.latestRetryClassification;
  if (retry === 'provider_unavailable') return 'retry_after_provider_unavailable';
  if (retry === 'provider_timeout') return 'retry_after_provider_timeout';
  if (retry === 'stale_state') return 'retry_after_stale_state';
  if (retry === 'unexpected_error') return 'retry_after_unexpected_error';
  if (!row.latestEvaluationRunId) return 'never_evaluated';
  if (row.evaluationDate <= cutoff.slice(0, 10)) return 'horizon_may_be_complete';
  if (row.latestEvaluationKind === 'no_change') return 'new_information_possible_after_no_change';
  if (row.latestEvaluationKind === 'needs_review') return 'new_information_possible_after_needs_review';
  return 'new_information_possible';
}

export class D1CoordinatorRepository {
  private readonly d1: D1Database;

  constructor(d1: D1Database) {
    this.d1 = d1;
  }

  async snapshotMaxForecastId(profileId: number, scanStartedAt: string) {
    const row = await this.d1.prepare(`SELECT COALESCE(MAX(id), 0) AS maximum
      FROM forecasts WHERE profile_id = ? AND activated_at <= ?`)
      .bind(profileId, scanStartedAt).first<{ maximum: number }>();
    return Number(row?.maximum ?? 0);
  }

  async selectDuePage(input: {
    profileId: number;
    cutoff: string;
    scanStartedAt: string;
    snapshotMaxForecastId: number;
    afterEvaluationDate: string | null;
    afterForecastId: number | null;
    limit: number;
  }): Promise<DueForecastPage> {
    const keyset = input.afterEvaluationDate === null
      ? ''
      : ' AND (f.evaluation_date > ? OR (f.evaluation_date = ? AND f.id > ?))';
    const rows = await this.d1.prepare(`SELECT f.id AS forecastId, f.symbol, f.status,
      f.evaluation_date AS evaluationDate, f.activated_at AS activatedAt,
      latest.id AS latestEvaluationRunId, latest.result_kind AS latestEvaluationKind,
      latest.evaluation_cutoff AS latestEvaluationCutoff,
      (SELECT COUNT(*) FROM forecast_coordinator_item_attempts ca
        JOIN forecast_coordinator_run_items ci
          ON ci.id = ca.item_id AND ci.run_id = ca.run_id AND ci.profile_id = ca.profile_id
        JOIN forecast_coordinator_runs cr ON cr.id = ci.run_id AND cr.profile_id = ci.profile_id
        WHERE ci.profile_id = f.profile_id AND ci.forecast_id = f.id
          AND cr.mode = 'execute' AND cr.evaluation_cutoff = ?
      ) AS retryCount,
      (SELECT ri.classification FROM forecast_coordinator_run_items ri
        JOIN forecast_coordinator_runs rr ON rr.id = ri.run_id AND rr.profile_id = ri.profile_id
        WHERE ri.profile_id = f.profile_id AND ri.forecast_id = f.id
          AND rr.mode = 'execute' AND rr.evaluation_cutoff = ? AND ri.state = 'completed'
          AND ri.classification IN ('provider_unavailable', 'provider_timeout', 'stale_state', 'unexpected_error')
        ORDER BY ri.completed_at DESC, ri.id DESC LIMIT 1
      ) AS latestRetryClassification
      FROM forecasts f
      LEFT JOIN evaluation_runs latest ON latest.id = (
        SELECT e.id FROM evaluation_runs e
        WHERE e.profile_id = f.profile_id AND e.forecast_id = f.id
        ORDER BY e.evaluation_cutoff DESC, e.id DESC LIMIT 1
      )
      WHERE f.profile_id = ? AND f.status = 'active' AND f.activated_at <= ?
        AND f.activated_at <= ? AND f.id <= ?
        AND NOT EXISTS (
          SELECT 1 FROM evaluation_runs e WHERE e.profile_id = f.profile_id
            AND e.forecast_id = f.id AND e.evaluation_cutoff >= ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM forecast_coordinator_run_items ci
          JOIN forecast_coordinator_runs cr ON cr.id = ci.run_id AND cr.profile_id = ci.profile_id
          WHERE ci.profile_id = f.profile_id AND ci.forecast_id = f.id
            AND cr.mode = 'execute' AND cr.evaluation_cutoff >= ? AND ci.state = 'completed'
            AND ci.classification IN ('no_change', 'target_hit', 'invalidated', 'expired', 'needs_review', 'duplicate_or_replayed', 'not_due')
        )
        AND NOT EXISTS (
          SELECT 1 FROM forecast_coordinator_run_items vi
          JOIN forecast_coordinator_runs vr ON vr.id = vi.run_id AND vr.profile_id = vi.profile_id
          WHERE vi.profile_id = f.profile_id AND vi.forecast_id = f.id
            AND vr.mode = 'execute' AND vr.evaluation_cutoff = ? AND vi.state = 'completed'
            AND vi.classification = 'validation_failure'
        )
        AND (SELECT COUNT(*) FROM forecast_coordinator_item_attempts fa
          JOIN forecast_coordinator_run_items fi
            ON fi.id = fa.item_id AND fi.run_id = fa.run_id AND fi.profile_id = fa.profile_id
          JOIN forecast_coordinator_runs fr ON fr.id = fi.run_id AND fr.profile_id = fi.profile_id
          WHERE fi.profile_id = f.profile_id AND fi.forecast_id = f.id
            AND fr.mode = 'execute' AND fr.evaluation_cutoff = ?
        ) < ${COORDINATOR_MAX_SAME_CUTOFF_RETRIES}
        ${keyset}
      ORDER BY f.evaluation_date ASC, f.id ASC LIMIT ?`)
      .bind(
        input.cutoff,
        input.cutoff,
        input.profileId,
        input.scanStartedAt,
        input.cutoff,
        input.snapshotMaxForecastId,
        input.cutoff,
        input.cutoff,
        input.cutoff,
        input.cutoff,
        ...(input.afterEvaluationDate === null
          ? []
          : [input.afterEvaluationDate, input.afterEvaluationDate, input.afterForecastId as number]),
        input.limit + 1,
      ).all<DueRow>();
    const candidates = rows.results.slice(0, input.limit).map((row) => ({
      ...row,
      retryCount: Number(row.retryCount),
      dueReason: dueReason(row, input.cutoff),
    }));
    return { candidates, hasMore: rows.results.length > input.limit };
  }

  async latestProcessedEvaluation(profileId: number, forecastId: number, cutoff: string) {
    return this.d1.prepare(`SELECT e.id AS evaluationRunId, e.result_kind AS resultKind,
      e.reason_code AS reasonCode, e.explanation, e.evaluation_cutoff AS evaluationCutoff,
      e.evaluator_version AS evaluatorVersion, e.ruleset_version AS rulesetVersion,
      (SELECT id FROM forecast_review_items ri WHERE ri.profile_id = e.profile_id
        AND ri.evaluation_run_id = e.id LIMIT 1) AS reviewItemId
      FROM evaluation_runs e WHERE e.profile_id = ? AND e.forecast_id = ?
        AND e.evaluation_cutoff >= ? ORDER BY e.evaluation_cutoff DESC, e.id DESC LIMIT 1`)
      .bind(profileId, forecastId, cutoff).first<NonNullable<CoordinatorProcessedState>>();
  }

  async reviewItemId(profileId: number, evaluationRunId: number) {
    const row = await this.d1.prepare(`SELECT id FROM forecast_review_items
      WHERE profile_id = ? AND evaluation_run_id = ? LIMIT 1`)
      .bind(profileId, evaluationRunId).first<{ id: number }>();
    return row?.id ?? null;
  }

  async findRunByOperatorKey(profileId: number, operatorRunKey: string) {
    const row = await this.d1.prepare(`${RUN_SELECT} WHERE profile_id = ? AND operator_run_key = ?`)
      .bind(profileId, operatorRunKey).first<RunRow>();
    return row ? mapRun(row) : null;
  }

  async getRun(profileId: number, runId: string) {
    const row = await this.d1.prepare(`${RUN_SELECT} WHERE profile_id = ? AND id = ?`)
      .bind(profileId, runId).first<RunRow>();
    return row ? mapRun(row) : null;
  }

  async getRunItems(profileId: number, runId: string) {
    const rows = await this.d1.prepare(`${ITEM_SELECT} WHERE profile_id = ? AND run_id = ? ORDER BY ordinal`)
      .bind(profileId, runId).all<ItemRow>();
    return rows.results.map(mapItem);
  }

  async createPlannedRun(plan: PlannedCoordinatorRun) {
    const statements: D1PreparedStatement[] = [
      this.d1.prepare(`INSERT INTO forecast_coordinator_runs
        (id, profile_id, coordinator_version, mode, evaluation_cutoff, batch_limit,
         scan_started_at, snapshot_max_forecast_id, initial_cursor, resume_cursor, next_cursor,
         operator_run_key, request_fingerprint, status, lease_token, lease_expires_at,
         started_at, selected_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`)
        .bind(
          plan.id, plan.input.profileId, COORDINATOR_VERSION, plan.input.mode,
          plan.input.cutoff, plan.input.limit, plan.scanStartedAt, plan.snapshotMaxForecastId,
          plan.initialCursor, plan.resumeCursor, plan.nextCursor, plan.input.operatorRunKey ?? null,
          plan.requestFingerprint, plan.leaseToken, plan.leaseExpiresAt, plan.startedAt,
          plan.candidates.length, plan.startedAt,
        ),
      ...plan.candidates.map((candidate, index) => this.d1.prepare(`INSERT INTO forecast_coordinator_run_items
        (id, run_id, profile_id, forecast_id, ordinal, symbol, evaluation_cutoff,
         sort_evaluation_date, sort_forecast_id, due_reason, previous_status,
         latest_evaluation_run_id, latest_evaluation_kind, latest_evaluation_cutoff, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
        .bind(
          plan.itemIds[index], plan.id, plan.input.profileId, candidate.forecastId, index + 1,
          candidate.symbol, plan.input.cutoff, candidate.evaluationDate, candidate.forecastId,
          candidate.dueReason, candidate.latestEvaluationRunId, candidate.latestEvaluationKind,
          candidate.latestEvaluationCutoff, plan.startedAt,
        )),
    ];
    await this.d1.batch(statements);
    const run = await this.getRun(plan.input.profileId, plan.id);
    if (!run) throw new Error('CoordinatorRunUnavailableAfterPlanning');
    return run;
  }

  async acquireRunLease(profileId: number, runId: string, token: string, now: string, expiresAt: string) {
    const result = await this.d1.prepare(`UPDATE forecast_coordinator_runs
      SET lease_token = ?, lease_expires_at = ?, recovery_count = recovery_count + 1,
        status = CASE WHEN status = 'interrupted' THEN 'running' ELSE status END
      WHERE id = ? AND profile_id = ? AND status IN ('running', 'interrupted')
        AND (lease_token IS NULL OR lease_expires_at <= ?)`)
      .bind(token, expiresAt, runId, profileId, now).run();
    return changed(result) === 1;
  }

  async renewRunLease(profileId: number, runId: string, token: string, expiresAt: string) {
    const result = await this.d1.prepare(`UPDATE forecast_coordinator_runs
      SET lease_expires_at = ? WHERE id = ? AND profile_id = ? AND lease_token = ? AND status = 'running'`)
      .bind(expiresAt, runId, profileId, token).run();
    return changed(result) === 1;
  }

  async acquireClaim(input: {
    profileId: number;
    forecastId: number;
    runId: string;
    itemId: string;
    runLeaseToken: string;
    token: string;
    cutoff: string;
    acquiredAt: string;
    expiresAt: string;
  }): Promise<ClaimResult> {
    const result = await this.d1.prepare(`INSERT INTO forecast_coordinator_claims
      (profile_id, forecast_id, owner_run_id, owner_item_id, owner_token,
       claim_cutoff, state, acquired_at, expires_at)
      SELECT ?, ?, ?, ?, ?, ?, 'active', ?, ?
      WHERE EXISTS (SELECT 1 FROM forecast_coordinator_runs r
        WHERE r.id = ? AND r.profile_id = ? AND r.lease_token = ? AND r.status = 'running'
          AND r.lease_expires_at > ?)
      ON CONFLICT(profile_id, forecast_id) DO UPDATE SET
        owner_run_id = excluded.owner_run_id, owner_item_id = excluded.owner_item_id,
        owner_token = excluded.owner_token, claim_cutoff = excluded.claim_cutoff,
        state = 'active', acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at, completed_at = NULL
      WHERE forecast_coordinator_claims.state <> 'active'
        OR forecast_coordinator_claims.expires_at <= ?`)
      .bind(
        input.profileId, input.forecastId, input.runId, input.itemId, input.token,
        input.cutoff, input.acquiredAt, input.expiresAt,
        input.runId, input.profileId, input.runLeaseToken, input.acquiredAt, input.acquiredAt,
      ).run();
    return changed(result) === 1 ? 'acquired' : 'conflict';
  }

  async startAttempt(input: {
    id: string;
    itemId: string;
    runId: string;
    profileId: number;
    runLeaseToken: string;
    ownerToken: string;
    startedAt: string;
  }) {
    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE forecast_coordinator_item_attempts
        SET state = 'interrupted', finished_at = ?, classification = 'unexpected_error',
          reason_code = 'interrupted_attempt_recovered',
          safe_explanation = 'A previous attempt ended before its coordinator result was recorded.'
        WHERE item_id = ? AND run_id = ? AND profile_id = ? AND state = 'started'
          AND EXISTS (SELECT 1 FROM forecast_coordinator_claims c
            WHERE c.profile_id = ? AND c.owner_run_id = ? AND c.owner_item_id = ?
              AND c.owner_token = ? AND c.state = 'active' AND c.expires_at > ?)
          AND EXISTS (SELECT 1 FROM forecast_coordinator_runs r
            WHERE r.id = ? AND r.profile_id = ? AND r.lease_token = ? AND r.status = 'running'
              AND r.lease_expires_at > ?)`)
        .bind(
          input.startedAt, input.itemId, input.runId, input.profileId,
          input.profileId, input.runId, input.itemId, input.ownerToken, input.startedAt,
          input.runId, input.profileId, input.runLeaseToken, input.startedAt,
        ),
      this.d1.prepare(`INSERT INTO forecast_coordinator_item_attempts
        (id, item_id, run_id, profile_id, attempt_number, owner_token, state, started_at, created_at)
        SELECT ?, ?, ?, ?,
          COALESCE((SELECT MAX(attempt_number) FROM forecast_coordinator_item_attempts
            WHERE item_id = ?), 0) + 1,
          ?, 'started', ?, ?
        WHERE EXISTS (SELECT 1 FROM forecast_coordinator_claims c
          WHERE c.profile_id = ? AND c.owner_run_id = ? AND c.owner_item_id = ?
            AND c.owner_token = ? AND c.state = 'active' AND c.expires_at > ?)
          AND EXISTS (SELECT 1 FROM forecast_coordinator_runs r
            WHERE r.id = ? AND r.profile_id = ? AND r.lease_token = ? AND r.status = 'running'
              AND r.lease_expires_at > ?)`)
        .bind(
          input.id, input.itemId, input.runId, input.profileId, input.itemId,
          input.ownerToken, input.startedAt, input.startedAt,
          input.profileId, input.runId, input.itemId, input.ownerToken, input.startedAt,
          input.runId, input.profileId, input.runLeaseToken, input.startedAt,
        ),
    ]);
    if (changed(results[1]) !== 1) throw new Error('CoordinatorAttemptStartFailed');
  }

  async latestStartedAttempt(profileId: number, itemId: string) {
    return this.d1.prepare(`SELECT owner_token AS ownerToken, started_at AS startedAt
      FROM forecast_coordinator_item_attempts
      WHERE profile_id = ? AND item_id = ? AND state = 'started'
      ORDER BY attempt_number DESC LIMIT 1`).bind(profileId, itemId).first<{
        ownerToken: string;
        startedAt: string;
      }>();
  }

  async attemptCountAtCutoff(profileId: number, forecastId: number, cutoff: string) {
    const row = await this.d1.prepare(`SELECT COUNT(*) AS count
      FROM forecast_coordinator_item_attempts a
      JOIN forecast_coordinator_run_items i
        ON i.id = a.item_id AND i.run_id = a.run_id AND i.profile_id = a.profile_id
      JOIN forecast_coordinator_runs r ON r.id = i.run_id AND r.profile_id = i.profile_id
      WHERE i.profile_id = ? AND i.forecast_id = ?
        AND r.mode = 'execute' AND r.evaluation_cutoff = ?`)
      .bind(profileId, forecastId, cutoff).first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  async reconcileProcessedItem(input: {
    profileId: number;
    runId: string;
    itemId: string;
    runLeaseToken: string;
    recoveredOwnerToken: string;
    attemptStartedAt: string;
    attemptReasonCode: string;
    attemptExplanation: string;
    completion: CoordinatorItemCompletion;
    completedAt: string;
    resumeCursor: string;
  }) {
    const completion = input.completion;
    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE forecast_coordinator_item_attempts
        SET state = 'interrupted', finished_at = ?, classification = ?,
          reason_code = ?, safe_explanation = ?, evaluation_run_id = ?, review_item_id = ?,
          mutated = ?, retry_useful = ?, redacted_error_category = ?
        WHERE item_id = ? AND run_id = ? AND profile_id = ? AND owner_token = ? AND state = 'started'`)
        .bind(
          input.completedAt, completion.classification, input.attemptReasonCode,
          input.attemptExplanation, completion.evaluationRunId ?? null,
          completion.reviewItemId ?? null, completion.mutated ? 1 : 0,
          completion.retryUseful ? 1 : 0, completion.redactedErrorCategory ?? null,
          input.itemId, input.runId, input.profileId,
          input.recoveredOwnerToken,
        ),
      this.d1.prepare(`UPDATE forecast_coordinator_run_items SET
        state = 'completed', current_status = ?, classification = ?, evaluator_result_kind = ?,
        evaluation_run_id = ?, review_item_id = ?, reason_code = ?, safe_explanation = ?,
        attempt_started_at = ?, attempt_finished_at = ?, mutated = ?, retry_useful = ?,
        redacted_error_category = ?, provider_version = ?, evaluator_version = ?,
        ruleset_version = ?, completed_at = ?
        WHERE id = ? AND run_id = ? AND profile_id = ? AND state = 'pending'
          AND EXISTS (SELECT 1 FROM forecast_coordinator_runs r
            WHERE r.id = ? AND r.profile_id = ? AND r.lease_token = ? AND r.status = 'running'
              AND r.lease_expires_at > ?)`)
        .bind(
          completion.currentStatus, completion.classification, completion.evaluatorResultKind ?? null,
          completion.evaluationRunId ?? null, completion.reviewItemId ?? null,
          completion.reasonCode, completion.safeExplanation, input.attemptStartedAt, input.completedAt,
          completion.mutated ? 1 : 0, completion.retryUseful ? 1 : 0,
          completion.redactedErrorCategory ?? null, completion.providerVersion ?? null,
          completion.evaluatorVersion ?? null, completion.rulesetVersion ?? null, input.completedAt,
          input.itemId, input.runId, input.profileId,
          input.runId, input.profileId, input.runLeaseToken, input.completedAt,
        ),
      this.d1.prepare(`UPDATE forecast_coordinator_runs SET resume_cursor = ?
        WHERE id = ? AND profile_id = ? AND lease_token = ?
          AND status = 'running' AND lease_expires_at > ? AND changes() = 1`)
        .bind(input.resumeCursor, input.runId, input.profileId, input.runLeaseToken, input.completedAt),
      this.d1.prepare(`UPDATE forecast_coordinator_claims
        SET state = 'completed', completed_at = ?, expires_at = ?
        WHERE profile_id = ? AND owner_run_id = ? AND owner_item_id = ?
          AND owner_token = ? AND state = 'active'`)
        .bind(
          input.completedAt, input.completedAt, input.profileId, input.runId, input.itemId,
          input.recoveredOwnerToken,
        ),
    ]);
    if (changed(results[1]) !== 1 || changed(results[2]) !== 1) {
      throw new Error('CoordinatorProcessedItemReconciliationFailed');
    }
  }

  async completeItem(input: {
    profileId: number;
    runId: string;
    itemId: string;
    runLeaseToken: string;
    attemptId?: string;
    ownerToken?: string;
    completion: CoordinatorItemCompletion;
    completedAt: string;
    resumeCursor: string;
  }) {
    const completion = input.completion;
    const statements: D1PreparedStatement[] = [];
    if (input.attemptId && input.ownerToken) {
      statements.push(this.d1.prepare(`UPDATE forecast_coordinator_item_attempts
        SET state = 'completed', finished_at = ?, classification = ?, reason_code = ?,
          safe_explanation = ?, evaluation_run_id = ?, review_item_id = ?, mutated = ?,
          retry_useful = ?, redacted_error_category = ?
        WHERE id = ? AND item_id = ? AND run_id = ? AND profile_id = ?
          AND owner_token = ? AND state = 'started'
          AND EXISTS (SELECT 1 FROM forecast_coordinator_claims c
            WHERE c.profile_id = ? AND c.owner_item_id = ? AND c.owner_token = ? AND c.state = 'active')`)
        .bind(
          input.completedAt, completion.classification, completion.reasonCode,
          completion.safeExplanation, completion.evaluationRunId ?? null, completion.reviewItemId ?? null,
          completion.mutated ? 1 : 0, completion.retryUseful ? 1 : 0,
          completion.redactedErrorCategory ?? null,
          input.attemptId, input.itemId, input.runId, input.profileId, input.ownerToken,
          input.profileId, input.itemId, input.ownerToken,
        ));
    }
    const runFence = ` AND EXISTS (SELECT 1 FROM forecast_coordinator_runs r
      WHERE r.id = ? AND r.profile_id = ? AND r.lease_token = ? AND r.status = 'running'
        AND r.lease_expires_at > ?)`;
    const claimFence = input.ownerToken
      ? ` AND EXISTS (SELECT 1 FROM forecast_coordinator_claims c
          WHERE c.profile_id = ? AND c.owner_run_id = ? AND c.owner_item_id = ?
            AND c.owner_token = ? AND c.state = 'active' AND c.expires_at > ?)`
      : '';
    const itemStatement = this.d1.prepare(`UPDATE forecast_coordinator_run_items SET
      state = 'completed', current_status = ?, classification = ?, evaluator_result_kind = ?,
      evaluation_run_id = ?, review_item_id = ?, reason_code = ?, safe_explanation = ?,
      attempt_started_at = ?, attempt_finished_at = ?, mutated = ?, retry_useful = ?,
      redacted_error_category = ?, provider_version = ?, evaluator_version = ?, ruleset_version = ?,
      completed_at = ? WHERE id = ? AND run_id = ? AND profile_id = ? AND state = 'pending'${runFence}${claimFence}`);
    const itemBindings: Array<string | number | null> = [
        completion.currentStatus, completion.classification, completion.evaluatorResultKind ?? null,
        completion.evaluationRunId ?? null, completion.reviewItemId ?? null,
        completion.reasonCode, completion.safeExplanation,
        completion.attemptStartedAt ?? null, completion.attemptFinishedAt ?? null,
        completion.mutated ? 1 : 0, completion.retryUseful ? 1 : 0,
        completion.redactedErrorCategory ?? null, completion.providerVersion ?? null,
        completion.evaluatorVersion ?? null, completion.rulesetVersion ?? null,
        input.completedAt, input.itemId, input.runId, input.profileId,
        input.runId, input.profileId, input.runLeaseToken, input.completedAt,
    ];
    if (input.ownerToken) {
      itemBindings.push(input.profileId, input.runId, input.itemId, input.ownerToken, input.completedAt);
    }
    statements.push(itemStatement.bind(...itemBindings));
    if (input.ownerToken) {
      statements.push(this.d1.prepare(`UPDATE forecast_coordinator_claims
        SET state = 'completed', completed_at = ?, expires_at = ?
        WHERE profile_id = ? AND owner_run_id = ? AND owner_item_id = ?
          AND owner_token = ? AND state = 'active' AND expires_at > ?`)
        .bind(
          input.completedAt, input.completedAt, input.profileId, input.runId, input.itemId,
          input.ownerToken, input.completedAt,
        ));
    }
    statements.push(this.d1.prepare(`UPDATE forecast_coordinator_runs SET resume_cursor = ?
      WHERE id = ? AND profile_id = ? AND lease_token = ?
        AND status = 'running' AND lease_expires_at > ? AND changes() = 1`)
      .bind(input.resumeCursor, input.runId, input.profileId, input.runLeaseToken, input.completedAt));
    const results = await this.d1.batch(statements);
    const attemptOffset = input.attemptId && input.ownerToken ? 1 : 0;
    if (attemptOffset && changed(results[0]) !== 1) throw new Error('CoordinatorAttemptCompletionFenced');
    if (changed(results[attemptOffset]) !== 1) throw new Error('CoordinatorItemCompletionFailed');
    if (input.ownerToken && changed(results[attemptOffset + 1]) !== 1) {
      throw new Error('CoordinatorClaimCompletionFenced');
    }
    if (changed(results.at(-1)) !== 1) throw new Error('CoordinatorProgressAdvanceFailed');
  }

  async finalizeRun(input: {
    profileId: number;
    runId: string;
    leaseToken: string;
    completedAt: string;
    durationMs: number;
    nextCursor: string | null;
  }) {
    const rows = await this.getRunItems(input.profileId, input.runId);
    if (rows.some((item) => item.state !== 'completed')) throw new Error('CoordinatorRunHasPendingItems');
    const outcomeCounts: Partial<Record<CoordinatorOutcome, number>> = {};
    for (const item of rows) {
      if (item.classification) outcomeCounts[item.classification] = (outcomeCounts[item.classification] ?? 0) + 1;
    }
    const unexpected = outcomeCounts.unexpected_error ?? 0;
    const status: CoordinatorRunStatus = unexpected > 0 ? 'completed_with_errors' : 'completed';
    const attempted = rows.filter((item) => item.classification !== 'dry_run_candidate').length;
    const mutated = rows.filter((item) => item.mutated).length;
    const result = await this.d1.prepare(`UPDATE forecast_coordinator_runs SET
      status = ?, completed_at = ?, duration_ms = ?, resume_cursor = ?, next_cursor = ?,
      selected_count = ?, attempted_count = ?, mutation_count = ?, unexpected_error_count = ?,
      outcome_counts_json = ?, lease_expires_at = ?
      WHERE id = ? AND profile_id = ? AND lease_token = ? AND status = 'running'
        AND lease_expires_at > ?
        AND NOT EXISTS (SELECT 1 FROM forecast_coordinator_run_items
          WHERE run_id = forecast_coordinator_runs.id AND state <> 'completed')`)
      .bind(
        status, input.completedAt, input.durationMs, input.nextCursor, input.nextCursor,
        rows.length, attempted, mutated, unexpected, JSON.stringify(outcomeCounts), input.completedAt,
        input.runId, input.profileId, input.leaseToken, input.completedAt,
      ).run();
    if (changed(result) !== 1) throw new Error('CoordinatorRunFinalizationFenced');
    const run = await this.getRun(input.profileId, input.runId);
    if (!run) throw new Error('CoordinatorRunUnavailableAfterFinalization');
    return run;
  }

  async claimOwner(profileId: number, forecastId: number) {
    return this.d1.prepare(`SELECT owner_run_id AS ownerRunId, owner_token AS ownerToken,
      state, expires_at AS expiresAt FROM forecast_coordinator_claims
      WHERE profile_id = ? AND forecast_id = ?`)
      .bind(profileId, forecastId).first<{
        ownerRunId: string;
        ownerToken: string;
        state: 'active' | 'completed';
        expiresAt: string;
      }>();
  }
}
