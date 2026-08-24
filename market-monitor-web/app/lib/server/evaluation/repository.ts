import type { ForecastStatus } from '../forecasts/types.ts';
import type { EvaluationResult, EvaluationRun, ForecastReviewItem, TerminalEvaluationKind } from './types.ts';

type RunRow = Omit<EvaluationRun, 'evidence' | 'warnings'> & { evidenceJson: string; warningsJson: string };
type ReviewRow = {
  id: number;
  profileId: number;
  forecastId: number;
  evaluationRunId: number;
  reviewKind: ForecastReviewItem['reviewKind'];
  acknowledgedAt: string | null;
  createdAt: string;
  symbol: string;
  forecastStatus: ForecastStatus;
  targetKind: 'price' | 'range';
  targetPrice: number | null;
  targetLower: number | null;
  targetUpper: number | null;
  invalidationPrice: number | null;
  analysisSnapshotId: number | null;
};

const RUN_SELECT = `SELECT id, profile_id AS profileId, forecast_id AS forecastId,
  result_kind AS resultKind, reason_code AS reasonCode, explanation,
  evaluator_version AS evaluatorVersion, ruleset_version AS rulesetVersion,
  evaluated_through AS evaluatedThrough, evaluation_cutoff AS evaluationCutoff,
  evidence_json AS evidenceJson, warnings_json AS warningsJson,
  input_fingerprint AS inputFingerprint, created_at AS createdAt
  FROM evaluation_runs`;

const REVIEW_SELECT = `SELECT ri.id, ri.profile_id AS profileId, ri.forecast_id AS forecastId,
  ri.evaluation_run_id AS evaluationRunId, ri.review_kind AS reviewKind,
  ri.acknowledged_at AS acknowledgedAt, ri.created_at AS createdAt,
  f.symbol, f.status AS forecastStatus, f.target_kind AS targetKind,
  f.target_price AS targetPrice, f.target_lower AS targetLower, f.target_upper AS targetUpper,
  f.invalidation_price AS invalidationPrice, s.id AS analysisSnapshotId
  FROM forecast_review_items ri
  JOIN forecasts f ON f.id = ri.forecast_id AND f.profile_id = ri.profile_id
  LEFT JOIN analysis_snapshots s ON s.forecast_id = f.id AND s.profile_id = f.profile_id`;

function changed(result: D1Result<unknown> | undefined) {
  return Number(result?.meta?.changes ?? 0);
}

function mapRun(row: RunRow): EvaluationRun {
  return {
    id: row.id,
    profileId: row.profileId,
    forecastId: row.forecastId,
    resultKind: row.resultKind,
    reasonCode: row.reasonCode,
    explanation: row.explanation,
    evaluatorVersion: row.evaluatorVersion,
    rulesetVersion: row.rulesetVersion,
    evaluatedThrough: row.evaluatedThrough,
    evaluationCutoff: row.evaluationCutoff,
    evidence: JSON.parse(row.evidenceJson) as EvaluationRun['evidence'],
    warnings: JSON.parse(row.warningsJson) as string[],
    inputFingerprint: row.inputFingerprint,
    createdAt: row.createdAt,
  };
}

function mapReview(row: ReviewRow, run: EvaluationRun): ForecastReviewItem {
  return {
    id: row.id,
    profileId: row.profileId,
    forecastId: row.forecastId,
    evaluationRunId: row.evaluationRunId,
    reviewKind: row.reviewKind,
    acknowledgedAt: row.acknowledgedAt,
    createdAt: row.createdAt,
    symbol: row.symbol,
    forecastStatus: row.forecastStatus,
    target: row.targetKind === 'price'
      ? { kind: 'price', price: row.targetPrice as number }
      : { kind: 'range', lower: row.targetLower as number, upper: row.targetUpper as number },
    invalidationPrice: row.invalidationPrice,
    analysisSnapshotId: row.analysisSnapshotId,
    run,
  };
}

export type PersistEvaluationResult = { run: EvaluationRun; duplicate: boolean } | null;

export interface EvaluationRepository {
  persist(
    profileId: number,
    forecastId: number,
    expectedUpdatedAt: string,
    expectedRevision: number,
    result: EvaluationResult,
    now: string,
  ): Promise<PersistEvaluationResult>;
  latestRun(profileId: number, forecastId: number): Promise<EvaluationRun | null>;
  listReviews(profileId: number, includeAcknowledged: boolean): Promise<ForecastReviewItem[]>;
  getReview(profileId: number, reviewId: number): Promise<ForecastReviewItem | null>;
  acknowledgeReview(profileId: number, reviewId: number, now: string): Promise<boolean>;
}

export class D1EvaluationRepository implements EvaluationRepository {
  private readonly d1: D1Database;

  constructor(d1: D1Database) { this.d1 = d1; }

  private async runByFingerprint(profileId: number, forecastId: number, result: EvaluationResult) {
    const row = await this.d1.prepare(`${RUN_SELECT} WHERE profile_id = ? AND forecast_id = ?
      AND evaluator_version = ? AND ruleset_version = ? AND input_fingerprint = ?`)
      .bind(profileId, forecastId, result.evaluator_version, result.ruleset_version, result.input_fingerprint)
      .first<RunRow>();
    return row ? mapRun(row) : null;
  }

  async latestRun(profileId: number, forecastId: number) {
    const row = await this.d1.prepare(`${RUN_SELECT} WHERE profile_id = ? AND forecast_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`)
      .bind(profileId, forecastId)
      .first<RunRow>();
    return row ? mapRun(row) : null;
  }

  private sameResult(run: EvaluationRun, result: EvaluationResult) {
    return run.resultKind === result.kind
      && run.reasonCode === result.reason_code
      && run.explanation === result.explanation
      && run.evaluatorVersion === result.evaluator_version
      && run.rulesetVersion === result.ruleset_version
      && run.evaluatedThrough === result.evaluated_through
      && JSON.stringify(run.evidence) === JSON.stringify(result.evidence)
      && JSON.stringify(run.warnings) === JSON.stringify(result.evidence.warnings);
  }

  private async duplicateStillEligible(
    profileId: number,
    forecastId: number,
    expectedUpdatedAt: string,
    expectedRevision: number,
    result: EvaluationResult,
    run: EvaluationRun,
  ) {
    const row = await this.d1.prepare(`SELECT status, updated_at AS updatedAt,
      (SELECT COALESCE(MAX(revision), 0) FROM forecast_events WHERE forecast_id = forecasts.id) AS revision,
      EXISTS (
        SELECT 1 FROM forecast_events WHERE forecast_id = forecasts.id AND profile_id = forecasts.profile_id
          AND event_type = 'evaluated' AND json_extract(payload_json, '$.evaluationRunId') = ?
      ) AS hasEvaluationEvent
      FROM forecasts WHERE id = ? AND profile_id = ?`)
      .bind(run.id, forecastId, profileId)
      .first<{ status: ForecastStatus; updatedAt: string; revision: number; hasEvaluationEvent: number }>();
    if (!row) return false;
    if (row.status === 'active' && row.updatedAt === expectedUpdatedAt && row.revision === expectedRevision) return true;
    return (result.kind === 'target_hit' || result.kind === 'invalidated' || result.kind === 'expired')
      && row.status === result.kind && Boolean(row.hasEvaluationEvent);
  }

  async persist(
    profileId: number,
    forecastId: number,
    expectedUpdatedAt: string,
    expectedRevision: number,
    result: EvaluationResult,
    now: string,
  ): Promise<PersistEvaluationResult> {
    const existing = await this.runByFingerprint(profileId, forecastId, result);
    if (existing) {
      if (!this.sameResult(existing, result)) throw new Error('EvaluationFingerprintConflict');
      return await this.duplicateStillEligible(
        profileId, forecastId, expectedUpdatedAt, expectedRevision, result, existing,
      ) ? { run: existing, duplicate: true } : null;
    }

    const statements: D1PreparedStatement[] = [this.d1.prepare(`INSERT OR IGNORE INTO evaluation_runs
      (profile_id, forecast_id, result_kind, reason_code, explanation, evaluator_version,
       ruleset_version, evaluated_through, evaluation_cutoff, evidence_json, warnings_json,
       input_fingerprint, created_at)
      SELECT profile_id, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM forecasts
      WHERE id = ? AND profile_id = ? AND status = 'active' AND updated_at = ?
      AND (SELECT COALESCE(MAX(revision), 0) FROM forecast_events WHERE forecast_id = forecasts.id) = ?`)
      .bind(result.kind, result.reason_code, result.explanation, result.evaluator_version,
        result.ruleset_version, result.evaluated_through, result.evaluation_cutoff,
        JSON.stringify(result.evidence), JSON.stringify(result.evidence.warnings),
        result.input_fingerprint, now, forecastId, profileId, expectedUpdatedAt, expectedRevision)];

    if (result.kind === 'target_hit' || result.kind === 'invalidated' || result.kind === 'expired') {
      const terminal = result.kind as TerminalEvaluationKind;
      statements.push(
        this.d1.prepare(`UPDATE forecasts SET status = ?, resolved_at = ?, resolution_reason = ?, updated_at = ?
          WHERE id = ? AND profile_id = ? AND status = 'active' AND updated_at = ? AND changes() = 1`)
          .bind(terminal, now, result.reason_code, now, forecastId, profileId, expectedUpdatedAt),
        this.d1.prepare(`INSERT INTO forecast_events
          (forecast_id, profile_id, revision, event_type, note, payload_json, created_at)
          SELECT id, profile_id,
            (SELECT COALESCE(MAX(revision), 0) + 1 FROM forecast_events WHERE forecast_id = forecasts.id),
            'evaluated', ?, json_object(
              'evaluationRunId', (SELECT id FROM evaluation_runs WHERE forecast_id = forecasts.id
                AND evaluator_version = ? AND ruleset_version = ? AND input_fingerprint = ?),
              'resultKind', ?, 'reasonCode', ?), ?
          FROM forecasts WHERE id = ? AND profile_id = ? AND status = ? AND resolved_at = ? AND changes() = 1`)
          .bind(result.explanation, result.evaluator_version, result.ruleset_version,
            result.input_fingerprint, terminal, result.reason_code, now, forecastId, profileId, terminal, now),
        this.d1.prepare(`INSERT INTO forecast_review_items
          (profile_id, forecast_id, evaluation_run_id, review_kind, created_at)
          SELECT profile_id, forecast_id, id, 'resolved', ? FROM evaluation_runs
          WHERE forecast_id = ? AND profile_id = ? AND evaluator_version = ? AND ruleset_version = ?
            AND input_fingerprint = ? AND changes() = 1`)
          .bind(now, forecastId, profileId, result.evaluator_version, result.ruleset_version, result.input_fingerprint),
      );
    } else if (result.kind === 'needs_review') {
      statements.push(this.d1.prepare(`INSERT INTO forecast_review_items
        (profile_id, forecast_id, evaluation_run_id, review_kind, created_at)
        SELECT profile_id, forecast_id, id, 'needs_review', ? FROM evaluation_runs
        WHERE forecast_id = ? AND profile_id = ? AND evaluator_version = ? AND ruleset_version = ?
          AND input_fingerprint = ? AND changes() = 1`)
        .bind(now, forecastId, profileId, result.evaluator_version, result.ruleset_version, result.input_fingerprint));
    }

    const results = await this.d1.batch(statements);
    if (changed(results[0]) !== 1) {
      const duplicate = await this.runByFingerprint(profileId, forecastId, result);
      if (duplicate && !this.sameResult(duplicate, result)) throw new Error('EvaluationFingerprintConflict');
      return duplicate && await this.duplicateStillEligible(
        profileId, forecastId, expectedUpdatedAt, expectedRevision, result, duplicate,
      ) ? { run: duplicate, duplicate: true } : null;
    }
    if ((result.kind === 'target_hit' || result.kind === 'invalidated' || result.kind === 'expired')
      && (changed(results[1]) !== 1 || changed(results[2]) !== 1 || changed(results[3]) !== 1)) {
      throw new Error('AtomicEvaluationPersistenceFailed');
    }
    if (result.kind === 'needs_review' && changed(results[1]) !== 1) throw new Error('AtomicEvaluationReviewPersistenceFailed');
    const stored = await this.runByFingerprint(profileId, forecastId, result);
    if (!stored) throw new Error('EvaluationRunUnavailableAfterPersistence');
    return { run: stored, duplicate: false };
  }

  async listReviews(profileId: number, includeAcknowledged: boolean) {
    const where = includeAcknowledged ? '' : ' AND ri.acknowledged_at IS NULL';
    const rows = await this.d1.prepare(`${REVIEW_SELECT} WHERE ri.profile_id = ?${where}
      ORDER BY CASE WHEN ri.acknowledged_at IS NULL THEN 0 ELSE 1 END, ri.created_at DESC, ri.id DESC LIMIT 250`)
      .bind(profileId).all<ReviewRow>();
    return Promise.all(rows.results.map(async (row) => {
      const runRow = await this.d1.prepare(`${RUN_SELECT} WHERE id = ? AND profile_id = ?`)
        .bind(row.evaluationRunId, profileId).first<RunRow>();
      if (!runRow) throw new Error('ReviewEvaluationRunMissing');
      return mapReview(row, mapRun(runRow));
    }));
  }

  async getReview(profileId: number, reviewId: number) {
    const row = await this.d1.prepare(`${REVIEW_SELECT} WHERE ri.id = ? AND ri.profile_id = ?`)
      .bind(reviewId, profileId).first<ReviewRow>();
    if (!row) return null;
    const runRow = await this.d1.prepare(`${RUN_SELECT} WHERE id = ? AND profile_id = ?`)
      .bind(row.evaluationRunId, profileId).first<RunRow>();
    if (!runRow) throw new Error('ReviewEvaluationRunMissing');
    return mapReview(row, mapRun(runRow));
  }

  async acknowledgeReview(profileId: number, reviewId: number, now: string) {
    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE forecast_review_items SET acknowledged_at = ?
        WHERE id = ? AND profile_id = ? AND acknowledged_at IS NULL`)
        .bind(now, reviewId, profileId),
      this.d1.prepare(`INSERT INTO forecast_events
        (forecast_id, profile_id, revision, event_type, note, payload_json, created_at)
        SELECT f.id, f.profile_id,
          (SELECT COALESCE(MAX(revision), 0) + 1 FROM forecast_events WHERE forecast_id = f.id),
          'evaluation_review_acknowledged', 'Evaluation review acknowledged.',
          json_object('reviewItemId', ri.id, 'evaluationRunId', ri.evaluation_run_id), ?
        FROM forecast_review_items ri JOIN forecasts f ON f.id = ri.forecast_id AND f.profile_id = ri.profile_id
        WHERE ri.id = ? AND ri.profile_id = ? AND ri.acknowledged_at = ? AND changes() = 1`)
        .bind(now, reviewId, profileId, now),
    ]);
    if (changed(results[0]) === 1 && changed(results[1]) !== 1) throw new Error('AtomicReviewAcknowledgementFailed');
    return changed(results[0]) === 1;
  }
}
