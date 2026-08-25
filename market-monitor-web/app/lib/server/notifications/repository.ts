import { isCanonicalUtcInstant } from '../coordinator/contract.ts';
import {
  NOTIFICATION_DEDUP_VERSION,
  NOTIFICATION_PAYLOAD_SCHEMA_VERSION,
  NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
  NOTIFICATION_RETRY_POLICY_VERSION,
} from './contract.ts';
import type { NotificationPayload } from './types.ts';
import type { NotificationPolicyResult } from './policy.ts';
import {
  NOTIFICATION_MAX_ATTEMPTS,
  calculateNotificationRetry,
  type NotificationDeliveryFailure,
  type NotificationRetryDecision,
} from './retry.ts';
import type { NotificationPreferenceSnapshot } from './preference.ts';
import type {
  NotificationAttemptState,
  NotificationCategory,
  NotificationOutboxState,
  NotificationPolicyDecision,
  NotificationProjectionClassification,
  TrustedNotificationSourceRow,
} from './types.ts';

const NOTIFICATION_TABLES = [
  'forecast_notification_projection_checkpoints',
  'forecast_notification_preference_revisions',
  'forecast_notification_preferences',
  'forecast_notification_intents',
  'forecast_notification_policy_decisions',
  'forecast_notification_outbox',
  'forecast_notification_projection_items',
  'forecast_notification_delivery_attempts',
] as const;

type ProjectionCheckpointRow = {
  profileId: number;
  projectorVersion: string;
  baselineEvaluationRunId: number;
  lastEvaluationRunId: number;
  activatedAt: string;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  recoveryCount: number;
  createdAt: string;
  updatedAt: string;
};

export type NotificationProjectionCheckpoint = ProjectionCheckpointRow;

type NotificationSourceRow = Omit<TrustedNotificationSourceRow, 'reviewItemId' | 'reviewKind'> & {
  reviewItemId: number | null;
  reviewKind: string | null;
};

/**
 * The projector reads all durable evaluation runs, including no-change and
 * malformed rows. A source becomes TrustedNotificationSourceRow only after
 * the notification payload boundary validates the non-null review linkage.
 */
export type NotificationProjectionSource = NotificationSourceRow;

export type NotificationSourcePage = {
  sources: NotificationProjectionSource[];
  hasMore: boolean;
  blockedByCutoff: {
    evaluationRunId: number;
    createdAt: string;
  } | null;
};

export type NotificationPreferenceAuditRecord = NotificationPreferenceSnapshot & {
  changeSource: string;
  changeReason: string;
};

type PersistedPolicyDecision = Exclude<
  NotificationPolicyDecision,
  'invalid_source_needs_review'
>;

export type MaterializeNotificationInput = {
  profileId: number;
  projectorVersion: string;
  expectedLastEvaluationRunId: number;
  leaseToken: string;
  leaseCheckedAt: string;
  projectionItemId: string;
  intentId: string;
  policyDecisionId: string;
  outboxId: string;
  dedupKey: string;
  payloadJson: string;
  payloadFingerprint: string;
  payload: NotificationPayload;
  policy: Omit<NotificationPolicyResult, 'decision'> & { decision: PersistedPolicyDecision };
  processedAt: string;
};

export type RecordProjectionDecisionInput = {
  profileId: number;
  projectorVersion: string;
  expectedLastEvaluationRunId: number;
  leaseToken: string;
  leaseCheckedAt: string;
  projectionItemId: string;
  evaluationRunId: number;
  sourceCreatedAt: string;
  classification: Exclude<NotificationProjectionClassification, 'intent_materialized'>;
  reasonCode: string;
  warnings: string[];
  processedAt: string;
};

export type NotificationMaterializationResult = {
  committed: boolean;
  intentCreated: boolean;
};

export type NotificationStatusFilter = {
  limit: number;
  state?: NotificationOutboxState;
  category?: NotificationCategory;
};

export type NotificationStatusRow = {
  outboxId: string;
  intentId: string;
  category: NotificationCategory;
  state: NotificationOutboxState;
  policyDecision: PersistedPolicyDecision;
  policyReason: string;
  preferenceRevision: number | null;
  eventOccurredAt: string;
  availableAt: string | null;
  attemptCount: number;
  leaseExpiresAt: string | null;
  lastAttemptAt: string | null;
  succeededAt: string | null;
  deadLetteredAt: string | null;
  lastFailureCategory: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NotificationStatusCount = {
  category: NotificationCategory;
  state: NotificationOutboxState;
  count: number;
};

export type NotificationAttemptRecord = {
  id: string;
  outboxId: string;
  attemptNumber: number;
  state: NotificationAttemptState;
  retryPolicyVersion: string;
  adapterKind: string;
  adapterVersion: string;
  startedAt: string;
  finishedAt: string | null;
  failureClassification: 'retryable' | 'terminal' | 'interrupted' | null;
  redactedErrorCategory: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
};

export type NotificationOutboxClaim = {
  outboxId: string;
  intentId: string;
  attemptId: string;
  attemptNumber: number;
  category: NotificationCategory;
  payloadJson: string;
  retryPolicyVersion: string;
  leaseExpiresAt: string;
};

type StatusRow = NotificationStatusRow;
type StatusCountRow = NotificationStatusCount;
type AttemptRow = NotificationAttemptRecord;

const CHECKPOINT_SELECT = `SELECT profile_id AS profileId, projector_version AS projectorVersion,
  baseline_evaluation_run_id AS baselineEvaluationRunId,
  last_evaluation_run_id AS lastEvaluationRunId, activated_at AS activatedAt,
  lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt,
  recovery_count AS recoveryCount, created_at AS createdAt, updated_at AS updatedAt
  FROM forecast_notification_projection_checkpoints`;

const SOURCE_SELECT = `SELECT er.profile_id AS profileId, er.forecast_id AS forecastId,
  er.id AS evaluationRunId, ri.id AS reviewItemId, ri.review_kind AS reviewKind,
  er.result_kind AS resultKind, er.reason_code AS reasonCode,
  er.evaluator_version AS evaluatorVersion, er.ruleset_version AS rulesetVersion,
  er.evaluated_through AS evaluatedThrough, er.evaluation_cutoff AS evaluationCutoff,
  er.created_at AS createdAt, f.symbol, s.id AS analysisSnapshotId,
  er.evidence_json AS evidenceJson
  FROM evaluation_runs er
  JOIN forecasts f ON f.id = er.forecast_id AND f.profile_id = er.profile_id
  LEFT JOIN forecast_review_items ri
    ON ri.evaluation_run_id = er.id AND ri.profile_id = er.profile_id
  LEFT JOIN analysis_snapshots s
    ON s.forecast_id = er.forecast_id AND s.profile_id = er.profile_id`;

const ATTEMPT_SELECT = `SELECT id, outbox_id AS outboxId,
  attempt_number AS attemptNumber, state, retry_policy_version AS retryPolicyVersion,
  adapter_kind AS adapterKind, adapter_version AS adapterVersion,
  started_at AS startedAt, finished_at AS finishedAt,
  failure_classification AS failureClassification,
  redacted_error_category AS redactedErrorCategory,
  next_attempt_at AS nextAttemptAt, created_at AS createdAt
  FROM forecast_notification_delivery_attempts`;

const PROJECTION_AUTHORITY = `EXISTS (
    SELECT 1 FROM forecast_notification_projection_checkpoints c
    WHERE c.profile_id = ? AND c.projector_version = ?
      AND c.last_evaluation_run_id = ? AND c.lease_token = ?
      AND c.lease_expires_at > ? AND ? > c.last_evaluation_run_id
  ) AND NOT EXISTS (
    SELECT 1 FROM evaluation_runs intervening
    WHERE intervening.profile_id = ? AND intervening.id > ? AND intervening.id < ?
  )`;

function authorityBindings(input: {
  profileId: number;
  projectorVersion: string;
  expectedLastEvaluationRunId: number;
  leaseToken: string;
  leaseCheckedAt: string;
}, evaluationRunId: number) {
  return [
    input.profileId, input.projectorVersion, input.expectedLastEvaluationRunId,
    input.leaseToken, input.leaseCheckedAt, evaluationRunId,
    input.profileId, input.expectedLastEvaluationRunId, evaluationRunId,
  ] as const;
}

function changed(result: D1Result<unknown> | undefined) {
  return Number(result?.meta?.changes ?? 0);
}

function preference(row: {
  profileId: number;
  preferenceVersion: NotificationPreferenceSnapshot['schemaVersion'];
  revision: number;
  masterConsent: number;
  targetHitEnabled: number;
  invalidatedEnabled: number;
  expiredEnabled: number;
  needsReviewEnabled: number;
  timezone: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  createdAt: string;
  updatedAt: string;
}): NotificationPreferenceSnapshot {
  return {
    profileId: row.profileId,
    schemaVersion: row.preferenceVersion,
    revision: row.revision,
    masterConsent: Boolean(row.masterConsent),
    categories: {
      target_hit: Boolean(row.targetHitEnabled),
      invalidated: Boolean(row.invalidatedEnabled),
      expired: Boolean(row.expiredEnabled),
      needs_review: Boolean(row.needsReviewEnabled),
    },
    timeZone: row.timezone,
    quietHours: row.quietHoursStart === null || row.quietHoursEnd === null
      ? null
      : { start: row.quietHoursStart, end: row.quietHoursEnd },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function preferenceSelect(where: string) {
  return `SELECT p.profile_id AS profileId, r.preference_version AS preferenceVersion,
    r.revision, r.master_consent AS masterConsent,
    r.target_hit_enabled AS targetHitEnabled, r.invalidated_enabled AS invalidatedEnabled,
    r.expired_enabled AS expiredEnabled, r.needs_review_enabled AS needsReviewEnabled,
    r.timezone, r.quiet_hours_start AS quietHoursStart, r.quiet_hours_end AS quietHoursEnd,
    p.created_at AS createdAt, p.updated_at AS updatedAt,
    r.change_source AS changeSource, r.change_reason AS changeReason
    FROM forecast_notification_preferences p
    JOIN forecast_notification_preference_revisions r
      ON r.profile_id = p.profile_id AND r.revision = p.current_revision ${where}`;
}

export interface NotificationRepository {
  hasSchema(): Promise<boolean>;
  prospectiveBaseline(profileId: number): Promise<number>;
  createBaseline(profileId: number, projectorVersion: string, activatedAt: string): Promise<NotificationProjectionCheckpoint>;
  getBaseline(profileId: number, projectorVersion: string): Promise<NotificationProjectionCheckpoint | null>;
  acquireProjectionLease(profileId: number, projectorVersion: string, token: string, now: string, expiresAt: string): Promise<boolean>;
  renewProjectionLease(profileId: number, projectorVersion: string, token: string, now: string, expiresAt: string): Promise<boolean>;
  releaseProjectionLease(profileId: number, projectorVersion: string, token: string, now: string): Promise<boolean>;
  selectSources(profileId: number, afterEvaluationRunId: number, cutoff: string, limit: number): Promise<NotificationSourcePage>;
  getCurrentPreference(profileId: number): Promise<NotificationPreferenceSnapshot | null>;
  appendPreference(value: NotificationPreferenceSnapshot, expectedRevision: number, changeSource: string, changeReason: string): Promise<boolean>;
  listPreferenceHistory(profileId: number, limit: number): Promise<NotificationPreferenceAuditRecord[]>;
  materialize(input: MaterializeNotificationInput): Promise<NotificationMaterializationResult>;
  recordProjectionDecision(input: RecordProjectionDecisionInput): Promise<boolean>;
  listStatus(profileId: number, filter: NotificationStatusFilter): Promise<NotificationStatusRow[]>;
  statusCounts(profileId: number): Promise<NotificationStatusCount[]>;
  claimNext(input: {
    profileId: number; attemptId: string; ownerToken: string; now: string; expiresAt: string;
    adapterKind: string; adapterVersion: string;
  }): Promise<NotificationOutboxClaim | null>;
  renewClaim(profileId: number, outboxId: string, ownerToken: string, now: string, expiresAt: string): Promise<boolean>;
  completeSuccess(input: {
    profileId: number; outboxId: string; attemptId: string; ownerToken: string; completedAt: string;
  }): Promise<boolean>;
  completeFailure(input: {
    profileId: number; outboxId: string; attemptId: string; ownerToken: string;
    completedAt: string; failure: NotificationDeliveryFailure;
  }): Promise<NotificationRetryDecision | null>;
  listAttempts(profileId: number, outboxId: string): Promise<NotificationAttemptRecord[]>;
}

export class D1NotificationRepository implements NotificationRepository {
  private readonly d1: D1Database;

  constructor(d1: D1Database) {
    this.d1 = d1;
  }

  async hasSchema() {
    const placeholders = NOTIFICATION_TABLES.map(() => '?').join(', ');
    const row = await this.d1.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name IN (${placeholders})`)
      .bind(...NOTIFICATION_TABLES).first<{ count: number }>();
    return Number(row?.count ?? 0) === NOTIFICATION_TABLES.length;
  }

  async prospectiveBaseline(profileId: number) {
    const row = await this.d1.prepare(`SELECT COALESCE(MAX(id), 0) AS baseline
      FROM evaluation_runs WHERE profile_id = ?`).bind(profileId).first<{ baseline: number }>();
    return Number(row?.baseline ?? 0);
  }

  async createBaseline(profileId: number, projectorVersion: string, activatedAt: string) {
    await this.d1.prepare(`INSERT OR IGNORE INTO forecast_notification_projection_checkpoints
      (profile_id, projector_version, baseline_evaluation_run_id, last_evaluation_run_id,
       activated_at, created_at, updated_at)
      SELECT ?, ?, COALESCE(MAX(id), 0), COALESCE(MAX(id), 0), ?, ?, ?
      FROM evaluation_runs WHERE profile_id = ?`)
      .bind(profileId, projectorVersion, activatedAt, activatedAt, activatedAt, profileId).run();
    const stored = await this.getBaseline(profileId, projectorVersion);
    if (!stored) throw new Error('NotificationProjectionBaselineUnavailable');
    return stored;
  }

  async getBaseline(profileId: number, projectorVersion: string) {
    return this.d1.prepare(`${CHECKPOINT_SELECT} WHERE profile_id = ? AND projector_version = ?`)
      .bind(profileId, projectorVersion).first<ProjectionCheckpointRow>();
  }

  async acquireProjectionLease(
    profileId: number,
    projectorVersion: string,
    token: string,
    now: string,
    expiresAt: string,
  ) {
    const result = await this.d1.prepare(`UPDATE forecast_notification_projection_checkpoints
      SET lease_token = ?, lease_expires_at = ?,
        recovery_count = recovery_count + CASE WHEN lease_token IS NULL THEN 0 ELSE 1 END,
        updated_at = ?
      WHERE profile_id = ? AND projector_version = ?
        AND (lease_token IS NULL OR lease_expires_at <= ?)`)
      .bind(token, expiresAt, now, profileId, projectorVersion, now).run();
    return changed(result) === 1;
  }

  async renewProjectionLease(
    profileId: number,
    projectorVersion: string,
    token: string,
    now: string,
    expiresAt: string,
  ) {
    const result = await this.d1.prepare(`UPDATE forecast_notification_projection_checkpoints
      SET lease_expires_at = ?, updated_at = ?
      WHERE profile_id = ? AND projector_version = ? AND lease_token = ?
        AND lease_expires_at > ?`)
      .bind(expiresAt, now, profileId, projectorVersion, token, now).run();
    return changed(result) === 1;
  }

  async releaseProjectionLease(
    profileId: number,
    projectorVersion: string,
    token: string,
    now: string,
  ) {
    const result = await this.d1.prepare(`UPDATE forecast_notification_projection_checkpoints
      SET lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE profile_id = ? AND projector_version = ? AND lease_token = ?
        AND lease_expires_at > ?`)
      .bind(now, profileId, projectorVersion, token, now).run();
    return changed(result) === 1;
  }

  async selectSources(profileId: number, afterEvaluationRunId: number, cutoff: string, limit: number) {
    const rows = await this.d1.prepare(`${SOURCE_SELECT}
      WHERE er.profile_id = ? AND er.id > ? ORDER BY er.id ASC LIMIT ?`)
      .bind(profileId, afterEvaluationRunId, limit + 1).all<NotificationSourceRow>();
    const sources: NotificationProjectionSource[] = [];
    let blockedByCutoff: NotificationSourcePage['blockedByCutoff'] = null;
    for (const row of rows.results) {
      if (isCanonicalUtcInstant(row.createdAt) && row.createdAt > cutoff) {
        blockedByCutoff = { evaluationRunId: row.evaluationRunId, createdAt: row.createdAt };
        break;
      }
      if (sources.length === limit) break;
      sources.push(row);
    }
    return {
      sources,
      hasMore: blockedByCutoff !== null || rows.results.length > sources.length,
      blockedByCutoff,
    };
  }

  async getCurrentPreference(profileId: number) {
    const row = await this.d1.prepare(preferenceSelect('WHERE p.profile_id = ?'))
      .bind(profileId).first<Parameters<typeof preference>[0] & {
        changeSource: string;
        changeReason: string;
      }>();
    return row ? preference(row) : null;
  }

  async appendPreference(
    value: NotificationPreferenceSnapshot,
    expectedRevision: number,
    changeSource: string,
    changeReason: string,
  ) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || value.revision !== expectedRevision + 1) return false;
    const quietStart = value.quietHours?.start ?? null;
    const quietEnd = value.quietHours?.end ?? null;
    const results = await this.d1.batch([
      this.d1.prepare(`INSERT INTO forecast_notification_preference_revisions
        (profile_id, revision, preference_version, master_consent, target_hit_enabled,
         invalidated_enabled, expired_enabled, needs_review_enabled, timezone,
         quiet_hours_start, quiet_hours_end, change_source, change_reason, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM investment_profiles WHERE id = ?)
          AND ((? = 0 AND NOT EXISTS (
            SELECT 1 FROM forecast_notification_preferences WHERE profile_id = ?
          )) OR (? > 0 AND EXISTS (
            SELECT 1 FROM forecast_notification_preferences
            WHERE profile_id = ? AND current_revision = ? AND created_at = ?
          )))`)
        .bind(
          value.profileId, value.revision, value.schemaVersion, value.masterConsent ? 1 : 0,
          value.categories.target_hit ? 1 : 0, value.categories.invalidated ? 1 : 0,
          value.categories.expired ? 1 : 0, value.categories.needs_review ? 1 : 0,
          value.timeZone, quietStart, quietEnd, changeSource, changeReason, value.updatedAt,
          value.profileId, expectedRevision, value.profileId, expectedRevision,
          value.profileId, expectedRevision, value.createdAt,
        ),
      this.d1.prepare(`INSERT INTO forecast_notification_preferences
        (profile_id, current_revision, created_at, updated_at)
        SELECT ?, ?, ?, ? WHERE changes() = 1
        ON CONFLICT(profile_id) DO UPDATE SET
          current_revision = excluded.current_revision, updated_at = excluded.updated_at
        WHERE forecast_notification_preferences.current_revision = ?
          AND forecast_notification_preferences.created_at = excluded.created_at`)
        .bind(value.profileId, value.revision, value.createdAt, value.updatedAt, expectedRevision),
    ]);
    return changed(results[0]) === 1 && changed(results[1]) === 1;
  }

  async listPreferenceHistory(profileId: number, limit: number) {
    const rows = await this.d1.prepare(`SELECT p.profile_id AS profileId,
      r.preference_version AS preferenceVersion, r.revision,
      r.master_consent AS masterConsent, r.target_hit_enabled AS targetHitEnabled,
      r.invalidated_enabled AS invalidatedEnabled, r.expired_enabled AS expiredEnabled,
      r.needs_review_enabled AS needsReviewEnabled, r.timezone,
      r.quiet_hours_start AS quietHoursStart, r.quiet_hours_end AS quietHoursEnd,
      p.created_at AS createdAt, r.created_at AS updatedAt,
      r.change_source AS changeSource, r.change_reason AS changeReason
      FROM forecast_notification_preference_revisions r
      JOIN forecast_notification_preferences p ON p.profile_id = r.profile_id
      WHERE r.profile_id = ? ORDER BY r.revision DESC LIMIT ?`)
      .bind(profileId, limit).all<Parameters<typeof preference>[0] & {
        changeSource: string;
        changeReason: string;
      }>();
    return rows.results.map((row) => ({
      ...preference(row),
      changeSource: row.changeSource,
      changeReason: row.changeReason,
    }));
  }

  async materialize(input: MaterializeNotificationInput): Promise<NotificationMaterializationResult> {
    const policyWarnings = JSON.stringify(input.policy.warnings);
    const earliestEligibleAt = input.policy.decision === 'deferred_quiet_hours'
      ? input.policy.earliestEligibleAt
      : null;
    const results = await this.d1.batch([
      this.d1.prepare(`INSERT OR IGNORE INTO forecast_notification_intents
        (id, profile_id, forecast_id, evaluation_run_id, review_item_id,
         analysis_snapshot_id, category, dedup_contract_version, projector_version,
         payload_schema_version, dedup_key, payload_json, payload_fingerprint,
         event_occurred_at, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${PROJECTION_AUTHORITY}`)
        .bind(
          input.intentId, input.profileId, input.payload.forecastId,
          input.payload.evaluationRunId, input.payload.reviewItemId,
          input.payload.analysisSnapshotId, input.payload.category,
          NOTIFICATION_DEDUP_VERSION, input.projectorVersion,
          NOTIFICATION_PAYLOAD_SCHEMA_VERSION, input.dedupKey, input.payloadJson,
          input.payloadFingerprint, input.payload.occurredAt, input.processedAt,
          ...authorityBindings(input, input.payload.evaluationRunId),
        ),
      this.d1.prepare(`INSERT OR IGNORE INTO forecast_notification_policy_decisions
        (id, intent_id, profile_id, policy_version, preference_revision, decision,
         reason_code, decided_at, earliest_eligible_at, warnings_json, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM forecast_notification_intents
          WHERE id = ? AND profile_id = ? AND evaluation_run_id = ? AND category = ?
            AND dedup_key = ? AND payload_fingerprint = ?)
          AND ${PROJECTION_AUTHORITY}`)
        .bind(
          input.policyDecisionId, input.intentId, input.profileId, input.policy.policyVersion,
          input.policy.preferenceRevision, input.policy.decision, input.policy.reason,
          input.policy.decidedAt, earliestEligibleAt, policyWarnings, input.processedAt,
          input.intentId, input.profileId, input.payload.evaluationRunId,
          input.payload.category, input.dedupKey, input.payloadFingerprint,
          ...authorityBindings(input, input.payload.evaluationRunId),
        ),
      this.d1.prepare(`INSERT OR IGNORE INTO forecast_notification_outbox
        (id, intent_id, policy_decision_id, profile_id, retry_policy_version,
         quiet_hours_policy_version, state, available_at, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM forecast_notification_policy_decisions
          WHERE id = ? AND intent_id = ? AND profile_id = ? AND policy_version = ?
            AND decision = ? AND reason_code = ?)
          AND ${PROJECTION_AUTHORITY}`)
        .bind(
          input.outboxId, input.intentId, input.policyDecisionId, input.profileId,
          NOTIFICATION_RETRY_POLICY_VERSION, NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
          input.policy.initialOutboxState, input.policy.outboxAvailableAt,
          input.processedAt, input.processedAt, input.policyDecisionId,
          input.intentId, input.profileId, input.policy.policyVersion,
          input.policy.decision, input.policy.reason,
          ...authorityBindings(input, input.payload.evaluationRunId),
        ),
      this.d1.prepare(`INSERT OR IGNORE INTO forecast_notification_projection_items
        (id, profile_id, projector_version, evaluation_run_id, intent_id, category,
         dedup_key, classification, reason_code, source_created_at,
         warnings_json, processed_at, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, 'intent_materialized', ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM forecast_notification_outbox
          WHERE id = ? AND intent_id = ? AND profile_id = ? AND policy_decision_id = ?)
          AND ${PROJECTION_AUTHORITY}`)
        .bind(
          input.projectionItemId, input.profileId, input.projectorVersion,
          input.payload.evaluationRunId, input.intentId, input.payload.category,
          input.dedupKey, input.policy.reason, input.payload.occurredAt,
          policyWarnings, input.processedAt, input.processedAt,
          input.outboxId, input.intentId, input.profileId, input.policyDecisionId,
          ...authorityBindings(input, input.payload.evaluationRunId),
        ),
      this.d1.prepare(`UPDATE forecast_notification_projection_checkpoints
        SET last_evaluation_run_id = ?, updated_at = ?
        WHERE profile_id = ? AND projector_version = ?
          AND last_evaluation_run_id = ? AND lease_token = ? AND lease_expires_at > ?
          AND EXISTS (SELECT 1 FROM forecast_notification_projection_items
            WHERE id = ? AND profile_id = ? AND projector_version = ?
              AND evaluation_run_id = ? AND intent_id = ?)
          AND NOT EXISTS (SELECT 1 FROM evaluation_runs intervening
            WHERE intervening.profile_id = ? AND intervening.id > ?
              AND intervening.id < ?)`)
        .bind(
          input.payload.evaluationRunId, input.processedAt, input.profileId,
          input.projectorVersion, input.expectedLastEvaluationRunId, input.leaseToken,
          input.leaseCheckedAt, input.projectionItemId, input.profileId,
          input.projectorVersion, input.payload.evaluationRunId, input.intentId,
          input.profileId, input.expectedLastEvaluationRunId,
          input.payload.evaluationRunId,
        ),
    ]);
    return {
      committed: changed(results[4]) === 1,
      intentCreated: changed(results[0]) === 1,
    };
  }

  async recordProjectionDecision(input: RecordProjectionDecisionInput) {
    const results = await this.d1.batch([
      this.d1.prepare(`INSERT OR IGNORE INTO forecast_notification_projection_items
        (id, profile_id, projector_version, evaluation_run_id, classification,
         reason_code, source_created_at, warnings_json, processed_at, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${PROJECTION_AUTHORITY}`)
        .bind(
          input.projectionItemId, input.profileId, input.projectorVersion,
          input.evaluationRunId, input.classification, input.reasonCode,
          input.sourceCreatedAt, JSON.stringify(input.warnings),
          input.processedAt, input.processedAt,
          ...authorityBindings(input, input.evaluationRunId),
        ),
      this.d1.prepare(`UPDATE forecast_notification_projection_checkpoints
        SET last_evaluation_run_id = ?, updated_at = ?
        WHERE profile_id = ? AND projector_version = ?
          AND last_evaluation_run_id = ? AND lease_token = ? AND lease_expires_at > ?
          AND EXISTS (SELECT 1 FROM forecast_notification_projection_items
            WHERE id = ? AND profile_id = ? AND projector_version = ?
              AND evaluation_run_id = ? AND intent_id IS NULL)
          AND NOT EXISTS (SELECT 1 FROM evaluation_runs intervening
            WHERE intervening.profile_id = ? AND intervening.id > ?
              AND intervening.id < ?)`)
        .bind(
          input.evaluationRunId, input.processedAt, input.profileId,
          input.projectorVersion, input.expectedLastEvaluationRunId, input.leaseToken,
          input.leaseCheckedAt, input.projectionItemId, input.profileId,
          input.projectorVersion, input.evaluationRunId,
          input.profileId, input.expectedLastEvaluationRunId, input.evaluationRunId,
        ),
    ]);
    return changed(results[1]) === 1;
  }

  async listStatus(profileId: number, filter: NotificationStatusFilter) {
    const conditions = ['o.profile_id = ?'];
    const bindings: Array<string | number> = [profileId];
    if (filter.state) {
      conditions.push('o.state = ?');
      bindings.push(filter.state);
    }
    if (filter.category) {
      conditions.push('i.category = ?');
      bindings.push(filter.category);
    }
    bindings.push(filter.limit);
    const rows = await this.d1.prepare(`SELECT o.id AS outboxId, o.intent_id AS intentId,
      i.category, o.state, pd.decision AS policyDecision,
      pd.reason_code AS policyReason, pd.preference_revision AS preferenceRevision,
      i.event_occurred_at AS eventOccurredAt, o.available_at AS availableAt,
      o.attempt_count AS attemptCount, o.lease_expires_at AS leaseExpiresAt,
      o.last_attempt_at AS lastAttemptAt, o.succeeded_at AS succeededAt,
      o.dead_lettered_at AS deadLetteredAt,
      o.last_failure_category AS lastFailureCategory,
      o.created_at AS createdAt, o.updated_at AS updatedAt
      FROM forecast_notification_outbox o
      JOIN forecast_notification_intents i
        ON i.id = o.intent_id AND i.profile_id = o.profile_id
      JOIN forecast_notification_policy_decisions pd
        ON pd.id = o.policy_decision_id AND pd.profile_id = o.profile_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY o.created_at DESC, o.id DESC LIMIT ?`)
      .bind(...bindings).all<StatusRow>();
    return rows.results;
  }

  async statusCounts(profileId: number) {
    const rows = await this.d1.prepare(`SELECT i.category, o.state, COUNT(*) AS count
      FROM forecast_notification_outbox o
      JOIN forecast_notification_intents i
        ON i.id = o.intent_id AND i.profile_id = o.profile_id
      WHERE o.profile_id = ? GROUP BY i.category, o.state
      ORDER BY i.category, o.state`).bind(profileId).all<StatusCountRow>();
    return rows.results.map((row) => ({ ...row, count: Number(row.count) }));
  }

  private async candidate(profileId: number, now: string) {
    return this.d1.prepare(`SELECT id, intent_id AS intentId, state,
      attempt_count AS attemptCount, lease_token AS leaseToken
      FROM forecast_notification_outbox
      WHERE profile_id = ? AND (
        (state IN ('pending', 'deferred', 'retry_scheduled') AND available_at <= ?)
        OR (state = 'claimed' AND lease_expires_at <= ?)
      ) ORDER BY COALESCE(available_at, lease_expires_at), id LIMIT 1`)
      .bind(profileId, now, now).first<{
        id: string;
        intentId: string;
        state: NotificationOutboxState;
        attemptCount: number;
        leaseToken: string | null;
      }>();
  }

  private async deadLetterExpiredMaximum(
    profileId: number,
    outboxId: string,
    ownerToken: string,
    now: string,
  ) {
    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE forecast_notification_delivery_attempts
        SET state = 'interrupted', finished_at = ?, failure_classification = 'interrupted',
          redacted_error_category = 'lease_expired_at_attempt_limit'
        WHERE outbox_id = ? AND profile_id = ? AND owner_token = ? AND state = 'started'
          AND EXISTS (SELECT 1 FROM forecast_notification_outbox
            WHERE id = ? AND profile_id = ? AND state = 'claimed'
              AND lease_token = ? AND lease_expires_at <= ?
              AND attempt_count >= ?)`)
        .bind(now, outboxId, profileId, ownerToken, outboxId, profileId,
          ownerToken, now, NOTIFICATION_MAX_ATTEMPTS),
      this.d1.prepare(`UPDATE forecast_notification_outbox
        SET state = 'dead_letter', lease_token = NULL, lease_expires_at = NULL,
          dead_lettered_at = ?, last_failure_category = 'lease_expired_at_attempt_limit',
          updated_at = ?
        WHERE id = ? AND profile_id = ? AND state = 'claimed'
          AND lease_token = ? AND lease_expires_at <= ? AND attempt_count >= ?`)
        .bind(now, now, outboxId, profileId, ownerToken, now, NOTIFICATION_MAX_ATTEMPTS),
    ]);
    return changed(results[1]) === 1;
  }

  async claimNext(input: {
    profileId: number;
    attemptId: string;
    ownerToken: string;
    now: string;
    expiresAt: string;
    adapterKind: string;
    adapterVersion: string;
  }) {
    const candidate = await this.candidate(input.profileId, input.now);
    if (!candidate) return null;
    if (candidate.state === 'claimed' && candidate.attemptCount >= NOTIFICATION_MAX_ATTEMPTS) {
      if (candidate.leaseToken) {
        await this.deadLetterExpiredMaximum(
          input.profileId, candidate.id, candidate.leaseToken, input.now,
        );
      }
      return null;
    }
    if (candidate.attemptCount >= NOTIFICATION_MAX_ATTEMPTS) return null;

    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE forecast_notification_outbox
        SET state = 'claimed', attempt_count = attempt_count + 1,
          lease_token = ?, lease_expires_at = ?, last_attempt_at = ?, updated_at = ?
        WHERE id = ? AND profile_id = ? AND attempt_count = ? AND attempt_count < ?
          AND ((state IN ('pending', 'deferred', 'retry_scheduled') AND available_at <= ?)
            OR (state = 'claimed' AND lease_expires_at <= ?))`)
        .bind(
          input.ownerToken, input.expiresAt, input.now, input.now, candidate.id,
          input.profileId, candidate.attemptCount, NOTIFICATION_MAX_ATTEMPTS,
          input.now, input.now,
        ),
      this.d1.prepare(`UPDATE forecast_notification_delivery_attempts
        SET state = 'interrupted', finished_at = ?, failure_classification = 'interrupted',
          redacted_error_category = 'lease_expired'
        WHERE outbox_id = ? AND profile_id = ? AND state = 'started'
          AND owner_token <> ? AND EXISTS (
            SELECT 1 FROM forecast_notification_outbox
            WHERE id = ? AND profile_id = ? AND state = 'claimed'
              AND lease_token = ? AND lease_expires_at > ?
          )`)
        .bind(input.now, candidate.id, input.profileId, input.ownerToken,
          candidate.id, input.profileId, input.ownerToken, input.now),
      this.d1.prepare(`INSERT INTO forecast_notification_delivery_attempts
        (id, outbox_id, profile_id, attempt_number, owner_token, state,
         retry_policy_version, adapter_kind, adapter_version, started_at, created_at)
        SELECT ?, id, profile_id, attempt_count, ?, 'started',
          retry_policy_version, ?, ?, ?, ?
        FROM forecast_notification_outbox
        WHERE id = ? AND profile_id = ? AND state = 'claimed'
          AND lease_token = ? AND lease_expires_at > ?
          AND attempt_count = ?`)
        .bind(
          input.attemptId, input.ownerToken, input.adapterKind, input.adapterVersion,
          input.now, input.now, candidate.id, input.profileId, input.ownerToken,
          input.now, candidate.attemptCount + 1,
        ),
    ]);
    if (changed(results[0]) !== 1 || changed(results[2]) !== 1) return null;
    return this.d1.prepare(`SELECT o.id AS outboxId, o.intent_id AS intentId,
      a.id AS attemptId, a.attempt_number AS attemptNumber, i.category,
      i.payload_json AS payloadJson, o.retry_policy_version AS retryPolicyVersion,
      o.lease_expires_at AS leaseExpiresAt
      FROM forecast_notification_outbox o
      JOIN forecast_notification_delivery_attempts a
        ON a.outbox_id = o.id AND a.profile_id = o.profile_id
      JOIN forecast_notification_intents i
        ON i.id = o.intent_id AND i.profile_id = o.profile_id
      WHERE o.id = ? AND o.profile_id = ? AND o.state = 'claimed'
        AND o.lease_token = ? AND a.id = ? AND a.owner_token = ? AND a.state = 'started'`)
      .bind(candidate.id, input.profileId, input.ownerToken,
        input.attemptId, input.ownerToken).first<NotificationOutboxClaim>();
  }

  async renewClaim(
    profileId: number,
    outboxId: string,
    ownerToken: string,
    now: string,
    expiresAt: string,
  ) {
    const result = await this.d1.prepare(`UPDATE forecast_notification_outbox
      SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND profile_id = ? AND state = 'claimed'
        AND lease_token = ? AND lease_expires_at > ?`)
      .bind(expiresAt, now, outboxId, profileId, ownerToken, now).run();
    return changed(result) === 1;
  }

  async completeSuccess(input: {
    profileId: number;
    outboxId: string;
    attemptId: string;
    ownerToken: string;
    completedAt: string;
  }) {
    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE forecast_notification_delivery_attempts
        SET state = 'succeeded', finished_at = ?
        WHERE id = ? AND outbox_id = ? AND profile_id = ?
          AND owner_token = ? AND state = 'started'
          AND EXISTS (SELECT 1 FROM forecast_notification_outbox
            WHERE id = ? AND profile_id = ? AND state = 'claimed'
              AND lease_token = ? AND lease_expires_at > ?)`)
        .bind(
          input.completedAt, input.attemptId, input.outboxId, input.profileId,
          input.ownerToken, input.outboxId, input.profileId, input.ownerToken,
          input.completedAt,
        ),
      this.d1.prepare(`UPDATE forecast_notification_outbox
        SET state = 'succeeded', lease_token = NULL, lease_expires_at = NULL,
          succeeded_at = ?, updated_at = ?
        WHERE id = ? AND profile_id = ? AND state = 'claimed'
          AND lease_token = ? AND lease_expires_at > ? AND changes() = 1`)
        .bind(input.completedAt, input.completedAt, input.outboxId,
          input.profileId, input.ownerToken, input.completedAt),
    ]);
    return changed(results[0]) === 1 && changed(results[1]) === 1;
  }

  async completeFailure(input: {
    profileId: number;
    outboxId: string;
    attemptId: string;
    ownerToken: string;
    completedAt: string;
    failure: NotificationDeliveryFailure;
  }) {
    const attempt = await this.d1.prepare(`SELECT attempt_number AS attemptNumber
      FROM forecast_notification_delivery_attempts
      WHERE id = ? AND outbox_id = ? AND profile_id = ? AND owner_token = ?
        AND state = 'started'`)
      .bind(input.attemptId, input.outboxId, input.profileId, input.ownerToken)
      .first<{ attemptNumber: number }>();
    if (!attempt) return null;
    const decision = calculateNotificationRetry({
      policyVersion: NOTIFICATION_RETRY_POLICY_VERSION,
      completedAttemptNumber: attempt.attemptNumber,
      completedAt: input.completedAt,
      failure: input.failure,
    });
    const retry = decision.disposition === 'retry_scheduled';
    const attemptState = retry ? 'retry_scheduled' : 'terminal_failure';
    const failureClass = retry || decision.reason === 'attempts_exhausted'
      ? 'retryable'
      : 'terminal';
    const outboxState = retry ? 'retry_scheduled' : 'dead_letter';
    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE forecast_notification_delivery_attempts
        SET state = ?, finished_at = ?, failure_classification = ?,
          redacted_error_category = ?, next_attempt_at = ?
        WHERE id = ? AND outbox_id = ? AND profile_id = ?
          AND owner_token = ? AND state = 'started'
          AND EXISTS (SELECT 1 FROM forecast_notification_outbox
            WHERE id = ? AND profile_id = ? AND state = 'claimed'
              AND lease_token = ? AND lease_expires_at > ?)`)
        .bind(
          attemptState, input.completedAt, failureClass, input.failure,
          decision.nextAttemptAt, input.attemptId, input.outboxId, input.profileId,
          input.ownerToken, input.outboxId, input.profileId, input.ownerToken,
          input.completedAt,
        ),
      this.d1.prepare(`UPDATE forecast_notification_outbox
        SET state = ?, available_at = ?, lease_token = NULL, lease_expires_at = NULL,
          dead_lettered_at = ?, last_failure_category = ?, updated_at = ?
        WHERE id = ? AND profile_id = ? AND state = 'claimed'
          AND lease_token = ? AND lease_expires_at > ? AND changes() = 1`)
        .bind(
          outboxState, decision.nextAttemptAt,
          retry ? null : input.completedAt, input.failure, input.completedAt,
          input.outboxId, input.profileId, input.ownerToken, input.completedAt,
        ),
    ]);
    return changed(results[0]) === 1 && changed(results[1]) === 1 ? decision : null;
  }

  async listAttempts(profileId: number, outboxId: string) {
    const rows = await this.d1.prepare(`${ATTEMPT_SELECT}
      WHERE profile_id = ? AND outbox_id = ? ORDER BY attempt_number ASC`)
      .bind(profileId, outboxId).all<AttemptRow>();
    return rows.results;
  }
}
