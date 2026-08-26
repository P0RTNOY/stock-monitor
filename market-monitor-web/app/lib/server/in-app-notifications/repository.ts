import type { NotificationCategory } from '../notifications/types.ts';
import type { InAppFilterCategory, InAppFilterState } from './contract.ts';

const TABLES = [
  'forecast_in_app_notification_projection_checkpoints',
  'forecast_in_app_notification_entries',
  'forecast_in_app_notification_projection_items',
  'forecast_in_app_notification_state_events',
] as const;

export type InAppCheckpoint = {
  profileId: number;
  projectorVersion: string;
  baselineEvaluationRunId: number;
  baselineIntentId: string;
  lastEvaluationRunId: number;
  lastIntentId: string;
  activatedAt: string;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  recoveryCount: number;
  createdAt: string;
  updatedAt: string;
};

export type InAppIntentSource = {
  id: string;
  profileId: number;
  forecastId: number;
  evaluationRunId: number;
  reviewItemId: number;
  analysisSnapshotId: number | null;
  category: string;
  payloadSchemaVersion: string;
  payloadJson: string;
  payloadFingerprint: string;
  eventOccurredAt: string;
  createdAt: string;
};

export type InAppPersistedRow = {
  sequence: number;
  id: string;
  category: NotificationCategory;
  symbol: string;
  state: 'read' | 'unread';
  occurredAt: string;
  firstReadAt: string | null;
  presentationJson: string;
  presentationVersion: string;
  presentationFingerprint: string;
  emailState: string | null;
  emailReconciliationState: string | null;
};

export type InAppPage = { rows: InAppPersistedRow[]; hasMore: boolean };

export type InAppEvidenceRow = {
  forecastId: number;
  direction: string;
  confidence: number;
  targetKind: string;
  targetPrice: number | null;
  targetLower: number | null;
  targetUpper: number | null;
  invalidationPrice: number | null;
  activatedAt: string | null;
  activationPrice: number | null;
  activationCurrency: string | null;
  currentForecastStatus: string;
  evaluationRunId: number;
  resultKind: string;
  reasonCode: string;
  evaluatedThrough: string | null;
  evaluationCutoff: string;
  evaluatorVersion: string;
  rulesetVersion: string;
  reviewItemId: number;
  reviewKind: string;
  acknowledgedAt: string | null;
  analysisSnapshotId: number | null;
};

type Authority = {
  profileId: number;
  projectorVersion: string;
  expectedLastEvaluationRunId: number;
  expectedLastIntentId: string;
  sourceEvaluationRunId: number;
  sourceIntentId: string;
  leaseToken: string;
  checkedAt: string;
};

export type PersistProjectionInput = Authority & {
  projectionItemId: string;
  source: InAppIntentSource;
  entry: null | {
    id: string;
    symbol: string;
    occurredAt: string;
    presentationVersion: string;
    presentationJson: string;
    presentationFingerprint: string;
  };
  classification: 'materialized' | 'unsupported_source' | 'malformed_source';
  reasonCode: string;
  processedAt: string;
};

const CHECKPOINT_SELECT = `SELECT profile_id AS profileId, projector_version AS projectorVersion,
  baseline_evaluation_run_id AS baselineEvaluationRunId,
  baseline_intent_id AS baselineIntentId,
  last_evaluation_run_id AS lastEvaluationRunId, last_intent_id AS lastIntentId,
  activated_at AS activatedAt,
  lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt,
  recovery_count AS recoveryCount, created_at AS createdAt, updated_at AS updatedAt
  FROM forecast_in_app_notification_projection_checkpoints`;

const SOURCE_SELECT = `SELECT id, profile_id AS profileId, forecast_id AS forecastId,
  evaluation_run_id AS evaluationRunId, review_item_id AS reviewItemId,
  analysis_snapshot_id AS analysisSnapshotId, category,
  payload_schema_version AS payloadSchemaVersion, payload_json AS payloadJson,
  payload_fingerprint AS payloadFingerprint, event_occurred_at AS eventOccurredAt,
  created_at AS createdAt FROM forecast_notification_intents`;

const ENTRY_SELECT = `SELECT e.sequence, e.id, e.category, e.symbol, e.state,
  e.occurred_at AS occurredAt, e.first_read_at AS firstReadAt,
  e.presentation_version AS presentationVersion, e.presentation_json AS presentationJson,
  e.presentation_fingerprint AS presentationFingerprint,
  d.state AS emailState, d.reconciliation_state AS emailReconciliationState
  FROM forecast_in_app_notification_entries e
  LEFT JOIN forecast_notification_outbox o
    ON o.intent_id = e.source_intent_id AND o.profile_id = e.profile_id
  LEFT JOIN forecast_email_deliveries d
    ON d.outbox_id = o.id AND d.profile_id = e.profile_id`;

function changes(result: D1Result<unknown> | undefined) {
  return Number(result?.meta?.changes ?? 0);
}

function authoritySql() {
  return `EXISTS (
    SELECT 1 FROM forecast_in_app_notification_projection_checkpoints c
    WHERE c.profile_id = ? AND c.projector_version = ?
      AND c.last_evaluation_run_id = ? AND c.lease_token = ? AND c.lease_expires_at > ?
      AND c.last_intent_id = ?
  ) AND NOT EXISTS (
    SELECT 1 FROM forecast_notification_intents intervening
    WHERE intervening.profile_id = ?
      AND (intervening.evaluation_run_id > ?
        OR (intervening.evaluation_run_id = ? AND intervening.id > ?))
      AND (intervening.evaluation_run_id < ?
        OR (intervening.evaluation_run_id = ? AND intervening.id < ?))
  )`;
}

function authorityBindings(input: Authority) {
  return [
    input.profileId, input.projectorVersion, input.expectedLastEvaluationRunId,
    input.leaseToken, input.checkedAt, input.expectedLastIntentId, input.profileId,
    input.expectedLastEvaluationRunId, input.expectedLastEvaluationRunId,
    input.expectedLastIntentId, input.sourceEvaluationRunId,
    input.sourceEvaluationRunId, input.sourceIntentId,
  ] as const;
}

export class D1InAppNotificationRepository {
  private readonly d1: D1Database;

  constructor(d1: D1Database) { this.d1 = d1; }

  async hasSchema() {
    const placeholders = TABLES.map(() => '?').join(', ');
    const row = await this.d1.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name IN (${placeholders})`).bind(...TABLES).first<{ count: number }>();
    return Number(row?.count ?? 0) === TABLES.length;
  }

  async getCheckpoint(profileId: number, projectorVersion: string) {
    return this.d1.prepare(`${CHECKPOINT_SELECT} WHERE profile_id = ? AND projector_version = ?`)
      .bind(profileId, projectorVersion).first<InAppCheckpoint>();
  }

  async prospectiveBaseline(profileId: number) {
    const row = await this.d1.prepare(`SELECT evaluation_run_id AS evaluationRunId, id AS intentId
      FROM forecast_notification_intents WHERE profile_id = ?
      ORDER BY evaluation_run_id DESC, id DESC LIMIT 1`)
      .bind(profileId).first<{ evaluationRunId: number; intentId: string }>();
    return { evaluationRunId: Number(row?.evaluationRunId ?? 0), intentId: row?.intentId ?? '' };
  }

  async createBaseline(profileId: number, projectorVersion: string, now: string) {
    await this.d1.prepare(`INSERT OR IGNORE INTO forecast_in_app_notification_projection_checkpoints
      (profile_id, projector_version, baseline_evaluation_run_id, baseline_intent_id,
       last_evaluation_run_id, last_intent_id,
       activated_at, lease_token, lease_expires_at, recovery_count, created_at, updated_at)
      SELECT ?, ?, COALESCE(position.evaluation_run_id, 0), COALESCE(position.id, ''),
        COALESCE(position.evaluation_run_id, 0), COALESCE(position.id, ''),
        ?, NULL, NULL, 0, ?, ?
      FROM (SELECT 1) seed LEFT JOIN (
        SELECT evaluation_run_id, id FROM forecast_notification_intents
        WHERE profile_id = ? ORDER BY evaluation_run_id DESC, id DESC LIMIT 1
      ) position ON 1 = 1`)
      .bind(profileId, projectorVersion, now, now, now, profileId).run();
    const checkpoint = await this.getCheckpoint(profileId, projectorVersion);
    if (!checkpoint) throw new Error('InAppBaselineCreationFailed');
    return checkpoint;
  }

  async acquireLease(profileId: number, projectorVersion: string, token: string, now: string, expiresAt: string) {
    const result = await this.d1.prepare(`UPDATE forecast_in_app_notification_projection_checkpoints
      SET lease_token = ?, lease_expires_at = ?, recovery_count = recovery_count
        + CASE WHEN lease_token IS NOT NULL AND lease_expires_at <= ? THEN 1 ELSE 0 END,
        updated_at = ?
      WHERE profile_id = ? AND projector_version = ?
        AND (lease_token IS NULL OR lease_expires_at <= ?)`)
      .bind(token, expiresAt, now, now, profileId, projectorVersion, now).run();
    return changes(result) === 1;
  }

  async releaseLease(profileId: number, projectorVersion: string, token: string, now: string) {
    await this.d1.prepare(`UPDATE forecast_in_app_notification_projection_checkpoints
      SET lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE profile_id = ? AND projector_version = ? AND lease_token = ?`)
      .bind(now, profileId, projectorVersion, token).run();
  }

  async selectSources(profileId: number, afterEvaluationRunId: number, afterIntentId: string, limit: number) {
    const result = await this.d1.prepare(`${SOURCE_SELECT}
      WHERE profile_id = ? AND (evaluation_run_id > ? OR (evaluation_run_id = ? AND id > ?))
      ORDER BY evaluation_run_id ASC, id ASC LIMIT ?`)
      .bind(profileId, afterEvaluationRunId, afterEvaluationRunId, afterIntentId, limit + 1)
      .all<InAppIntentSource>();
    return { sources: result.results.slice(0, limit), hasMore: result.results.length > limit };
  }

  async selectHistoricalSources(
    profileId: number,
    fromEvaluationRunId: number,
    throughEvaluationRunId: number,
    cutoff: string,
    limit: number,
    projectorVersion: string,
  ) {
    const result = await this.d1.prepare(`${SOURCE_SELECT}
      WHERE profile_id = ? AND evaluation_run_id BETWEEN ? AND ? AND created_at <= ?
        AND NOT EXISTS (SELECT 1 FROM forecast_in_app_notification_projection_items processed
          WHERE processed.profile_id = forecast_notification_intents.profile_id
            AND processed.projector_version = ?
            AND processed.source_intent_id = forecast_notification_intents.id)
      ORDER BY evaluation_run_id ASC, id ASC LIMIT ?`)
      .bind(profileId, fromEvaluationRunId, throughEvaluationRunId, cutoff, projectorVersion, limit + 1)
      .all<InAppIntentSource>();
    return { sources: result.results.slice(0, limit), hasMore: result.results.length > limit };
  }

  async persistProjection(input: PersistProjectionInput) {
    const authority = authoritySql();
    const bindings = authorityBindings(input);
    const statements: D1PreparedStatement[] = [];
    if (input.entry) {
      statements.push(this.d1.prepare(`INSERT OR IGNORE INTO forecast_in_app_notification_entries
        (id, profile_id, source_intent_id, forecast_id, evaluation_run_id, review_item_id,
         analysis_snapshot_id, category, symbol, occurred_at, presentation_version,
         presentation_json, presentation_fingerprint, deep_link_kind, state, first_read_at,
         state_updated_at, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'notification_evidence',
          'unread', NULL, ?, ?, ? WHERE ${authority}`)
        .bind(
          input.entry.id, input.profileId, input.source.id, input.source.forecastId,
          input.source.evaluationRunId, input.source.reviewItemId, input.source.analysisSnapshotId,
          input.source.category, input.entry.symbol, input.entry.occurredAt,
          input.entry.presentationVersion, input.entry.presentationJson,
          input.entry.presentationFingerprint, input.processedAt, input.processedAt,
          input.processedAt, ...bindings,
        ));
    }
    statements.push(this.d1.prepare(`INSERT OR IGNORE INTO forecast_in_app_notification_projection_items
      (id, profile_id, projector_version, source_intent_id, evaluation_run_id, entry_id,
       classification, reason_code, source_created_at, processed_at, created_at)
      SELECT ?, ?, ?, ?, ?, ?,
        ${input.entry ? "CASE WHEN changes() = 1 THEN ? ELSE 'duplicate' END" : '?'},
        ${input.entry ? "CASE WHEN changes() = 1 THEN ? ELSE 'trusted_intent_already_materialized' END" : '?'},
        ?, ?, ? WHERE ${authority}`)
      .bind(
        input.projectionItemId, input.profileId, input.projectorVersion, input.source.id,
        input.source.evaluationRunId, input.entry?.id ?? null, input.classification,
        input.reasonCode, input.source.createdAt, input.processedAt, input.processedAt,
        ...bindings,
      ));
    statements.push(this.d1.prepare(`UPDATE forecast_in_app_notification_projection_checkpoints
      SET last_evaluation_run_id = ?, last_intent_id = ?, updated_at = ?
      WHERE profile_id = ? AND projector_version = ? AND last_evaluation_run_id = ?
        AND last_intent_id = ? AND lease_token = ? AND lease_expires_at > ?
        AND NOT EXISTS (SELECT 1 FROM forecast_notification_intents intervening
          WHERE intervening.profile_id = ?
            AND (intervening.evaluation_run_id > ?
              OR (intervening.evaluation_run_id = ? AND intervening.id > ?))
            AND (intervening.evaluation_run_id < ?
              OR (intervening.evaluation_run_id = ? AND intervening.id < ?)))`)
      .bind(
        input.sourceEvaluationRunId, input.sourceIntentId, input.processedAt,
        input.profileId, input.projectorVersion, input.expectedLastEvaluationRunId,
        input.expectedLastIntentId, input.leaseToken, input.checkedAt, input.profileId,
        input.expectedLastEvaluationRunId, input.expectedLastEvaluationRunId,
        input.expectedLastIntentId, input.sourceEvaluationRunId,
        input.sourceEvaluationRunId, input.sourceIntentId,
      ));
    const results = await this.d1.batch(statements);
    if (changes(results.at(-1)) !== 1) throw new Error('InAppProjectionAuthorityLost');
    return { entryCreated: Boolean(input.entry) && changes(results[0]) === 1 };
  }

  async persistHistorical(input: Omit<PersistProjectionInput, keyof Authority> & {
    profileId: number; projectorVersion: string;
  }) {
    const statements: D1PreparedStatement[] = [];
    if (input.entry) {
      statements.push(this.d1.prepare(`INSERT OR IGNORE INTO forecast_in_app_notification_entries
        (id, profile_id, source_intent_id, forecast_id, evaluation_run_id, review_item_id,
         analysis_snapshot_id, category, symbol, occurred_at, presentation_version,
         presentation_json, presentation_fingerprint, deep_link_kind, state, first_read_at,
         state_updated_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'notification_evidence',
          'unread', NULL, ?, ?, ?)`)
        .bind(
          input.entry.id, input.profileId, input.source.id, input.source.forecastId,
          input.source.evaluationRunId, input.source.reviewItemId, input.source.analysisSnapshotId,
          input.source.category, input.entry.symbol, input.entry.occurredAt,
          input.entry.presentationVersion, input.entry.presentationJson,
          input.entry.presentationFingerprint, input.processedAt, input.processedAt, input.processedAt,
        ));
    }
    statements.push(this.d1.prepare(`INSERT OR IGNORE INTO forecast_in_app_notification_projection_items
      (id, profile_id, projector_version, source_intent_id, evaluation_run_id, entry_id,
       classification, reason_code, source_created_at, processed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?,
        ${input.entry ? "CASE WHEN changes() = 1 THEN ? ELSE 'duplicate' END" : '?'},
        ${input.entry ? "CASE WHEN changes() = 1 THEN ? ELSE 'trusted_intent_already_materialized' END" : '?'},
        ?, ?, ?)`)
      .bind(
        input.projectionItemId, input.profileId, input.projectorVersion, input.source.id,
        input.source.evaluationRunId, input.entry?.id ?? null, input.classification,
        input.reasonCode, input.source.createdAt, input.processedAt, input.processedAt,
      ));
    const results = await this.d1.batch(statements);
    return { entryCreated: Boolean(input.entry) && changes(results[0]) === 1 };
  }

  async list(profileId: number, input: {
    state: InAppFilterState;
    category: InAppFilterCategory;
    limit: number;
    after?: { occurredAt: string; id: string };
    highWaterSequence?: number;
  }): Promise<InAppPage> {
    const conditions = ['e.profile_id = ?'];
    const values: Array<string | number> = [profileId];
    if (input.state !== 'all') { conditions.push('e.state = ?'); values.push(input.state); }
    if (input.category !== 'all') { conditions.push('e.category = ?'); values.push(input.category); }
    if (input.highWaterSequence !== undefined) {
      conditions.push('e.sequence <= ?'); values.push(input.highWaterSequence);
    }
    if (input.after) {
      conditions.push('(e.occurred_at < ? OR (e.occurred_at = ? AND e.id < ?))');
      values.push(input.after.occurredAt, input.after.occurredAt, input.after.id);
    }
    const result = await this.d1.prepare(`${ENTRY_SELECT} WHERE ${conditions.join(' AND ')}
      ORDER BY e.occurred_at DESC, e.id DESC LIMIT ?`)
      .bind(...values, input.limit + 1).all<InAppPersistedRow>();
    return { rows: result.results.slice(0, input.limit), hasMore: result.results.length > input.limit };
  }

  async get(profileId: number, id: string) {
    return this.d1.prepare(`${ENTRY_SELECT} WHERE e.profile_id = ? AND e.id = ?`)
      .bind(profileId, id).first<InAppPersistedRow>();
  }

  async getEvidence(profileId: number, id: string) {
    return this.d1.prepare(`SELECT f.id AS forecastId, f.direction, f.confidence,
      f.target_kind AS targetKind, f.target_price AS targetPrice,
      f.target_lower AS targetLower, f.target_upper AS targetUpper,
      f.invalidation_price AS invalidationPrice, f.activated_at AS activatedAt,
      f.activation_price AS activationPrice, f.activation_currency AS activationCurrency,
      f.status AS currentForecastStatus, er.id AS evaluationRunId,
      er.result_kind AS resultKind, er.reason_code AS reasonCode,
      er.evaluated_through AS evaluatedThrough, er.evaluation_cutoff AS evaluationCutoff,
      er.evaluator_version AS evaluatorVersion, er.ruleset_version AS rulesetVersion,
      ri.id AS reviewItemId, ri.review_kind AS reviewKind,
      ri.acknowledged_at AS acknowledgedAt, e.analysis_snapshot_id AS analysisSnapshotId
      FROM forecast_in_app_notification_entries e
      JOIN forecasts f ON f.id = e.forecast_id AND f.profile_id = e.profile_id
      JOIN evaluation_runs er ON er.id = e.evaluation_run_id AND er.profile_id = e.profile_id
      JOIN forecast_review_items ri ON ri.id = e.review_item_id AND ri.profile_id = e.profile_id
      WHERE e.profile_id = ? AND e.id = ?`)
      .bind(profileId, id).first<InAppEvidenceRow>();
  }

  async unreadSnapshot(profileId: number) {
    const row = await this.d1.prepare(`SELECT COALESCE(MAX(sequence), 0) AS highWaterSequence,
      COALESCE(SUM(CASE WHEN state = 'unread' THEN 1 ELSE 0 END), 0) AS unreadCount
      FROM forecast_in_app_notification_entries WHERE profile_id = ?`)
      .bind(profileId).first<{ unreadCount: number; highWaterSequence: number }>();
    return {
      unreadCount: Number(row?.unreadCount ?? 0),
      highWaterSequence: Number(row?.highWaterSequence ?? 0),
    };
  }

  async setState(profileId: number, id: string, state: 'read' | 'unread', eventId: string, now: string) {
    const eventKind = state;
    const result = await this.d1.batch([
      this.d1.prepare(`INSERT INTO forecast_in_app_notification_state_events
        (id, profile_id, entry_id, event_kind, high_water_sequence, affected_count, occurred_at, created_at)
        SELECT ?, ?, id, ?, NULL, 1, ?, ? FROM forecast_in_app_notification_entries
        WHERE profile_id = ? AND id = ? AND state <> ?`)
        .bind(eventId, profileId, eventKind, now, now, profileId, id, state),
      this.d1.prepare(`UPDATE forecast_in_app_notification_entries
        SET state = ?, first_read_at = CASE WHEN ? = 'read' THEN COALESCE(first_read_at, ?) ELSE first_read_at END,
          state_updated_at = ?, updated_at = ?
        WHERE profile_id = ? AND id = ? AND EXISTS (
          SELECT 1 FROM forecast_in_app_notification_state_events
          WHERE id = ? AND profile_id = ? AND entry_id = ?
        )`).bind(state, state, now, now, now, profileId, id, eventId, profileId, id),
    ]);
    const exists = await this.d1.prepare(`SELECT id FROM forecast_in_app_notification_entries
      WHERE profile_id = ? AND id = ?`).bind(profileId, id).first<{ id: string }>();
    return { found: Boolean(exists), changed: changes(result[1]) === 1 };
  }

  async markAllRead(profileId: number, highWaterSequence: number, eventId: string, now: string) {
    const result = await this.d1.batch([
      this.d1.prepare(`INSERT INTO forecast_in_app_notification_state_events
        (id, profile_id, entry_id, event_kind, high_water_sequence, affected_count, occurred_at, created_at)
        SELECT ?, ?, NULL, 'mark_all_read', ?, COUNT(*), ?, ?
        FROM forecast_in_app_notification_entries
        WHERE profile_id = ? AND sequence <= ? AND state = 'unread' HAVING COUNT(*) > 0`)
        .bind(eventId, profileId, highWaterSequence, now, now, profileId, highWaterSequence),
      this.d1.prepare(`UPDATE forecast_in_app_notification_entries
        SET state = 'read', first_read_at = COALESCE(first_read_at, ?),
          state_updated_at = ?, updated_at = ?
        WHERE profile_id = ? AND sequence <= ? AND state = 'unread'
          AND EXISTS (SELECT 1 FROM forecast_in_app_notification_state_events
            WHERE id = ? AND profile_id = ? AND event_kind = 'mark_all_read')`)
        .bind(now, now, now, profileId, highWaterSequence, eventId, profileId),
    ]);
    return changes(result[1]);
  }

  async countsByState(profileId: number) {
    const result = await this.d1.prepare(`SELECT state, COUNT(*) AS count
      FROM forecast_in_app_notification_entries WHERE profile_id = ? GROUP BY state ORDER BY state`)
      .bind(profileId).all<{ state: 'read' | 'unread'; count: number }>();
    return result.results.map((row) => ({ state: row.state, count: Number(row.count) }));
  }
}
