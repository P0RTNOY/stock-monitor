import type {
  AnalysisSnapshot,
  Forecast,
  ForecastDraftInput,
  ForecastEvent,
  ForecastFilters,
  ForecastNoteKind,
  ForecastStatus,
  NormalizedAnalysisSnapshot,
  QuoteSnapshot,
} from './types.ts';

type ForecastRow = {
  id: number;
  profileId: number;
  symbol: string;
  direction: Forecast['direction'];
  confidence: number;
  thesis: string;
  supportingEvidence: string;
  counterEvidence: string;
  setupTag: string;
  evaluationDate: string;
  targetKind: 'price' | 'range';
  targetPrice: number | null;
  targetLower: number | null;
  targetUpper: number | null;
  invalidationPrice: number | null;
  analysisSeedJson: string | null;
  analysisSeedScenarioId: string | null;
  status: ForecastStatus;
  activatedAt: string | null;
  marketDataAsOf: string | null;
  activationPrice: number | null;
  activationCurrency: string | null;
  marketProvider: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  createdAt: string;
  updatedAt: string;
};

type EventRow = Omit<ForecastEvent, 'payload'> & { payloadJson: string };
type SnapshotRow = Omit<AnalysisSnapshot, 'evidence' | 'warnings' | 'report'> & {
  evidenceJson: string;
  warningsJson: string;
  reportJson: string;
};

const FORECAST_SELECT = `SELECT
  id, profile_id AS profileId, symbol, direction, confidence, thesis,
  supporting_evidence AS supportingEvidence, counter_evidence AS counterEvidence,
  setup_tag AS setupTag, evaluation_date AS evaluationDate, target_kind AS targetKind,
  target_price AS targetPrice, target_lower AS targetLower, target_upper AS targetUpper,
  invalidation_price AS invalidationPrice, analysis_seed_json AS analysisSeedJson,
  analysis_seed_scenario_id AS analysisSeedScenarioId, status, activated_at AS activatedAt,
  market_data_as_of AS marketDataAsOf, activation_price AS activationPrice,
  activation_currency AS activationCurrency, market_provider AS marketProvider,
  resolved_at AS resolvedAt, resolution_reason AS resolutionReason,
  created_at AS createdAt, updated_at AS updatedAt
FROM forecasts`;

function parseJson(value: string) {
  return JSON.parse(value) as unknown;
}

function mapForecast(row: ForecastRow): Forecast {
  const target = row.targetKind === 'price'
    ? { kind: 'price' as const, price: row.targetPrice as number }
    : { kind: 'range' as const, lower: row.targetLower as number, upper: row.targetUpper as number };
  let pendingAnalysis: Forecast['pendingAnalysis'] = null;
  if (row.analysisSeedJson && row.analysisSeedScenarioId) {
    const report = parseJson(row.analysisSeedJson) as Record<string, unknown>;
    const scenario = Array.isArray(report.scenarios)
      ? report.scenarios.find((value) => value && typeof value === 'object'
        && (value as Record<string, unknown>).scenario_id === row.analysisSeedScenarioId) as Record<string, unknown> | undefined
      : undefined;
    pendingAnalysis = {
      scenarioId: row.analysisSeedScenarioId,
      generatedAt: typeof report.generated_at === 'string' ? report.generated_at : '',
      provider: typeof report.provider === 'string' ? report.provider : '',
      lifecycleState: typeof scenario?.lifecycle_state === 'string' ? scenario.lifecycle_state : '',
      direction: typeof scenario?.direction === 'string' ? scenario.direction : '',
    };
  }
  return {
    id: row.id,
    profileId: row.profileId,
    symbol: row.symbol,
    direction: row.direction,
    confidence: row.confidence,
    thesis: row.thesis,
    supportingEvidence: row.supportingEvidence,
    counterEvidence: row.counterEvidence,
    setupTag: row.setupTag,
    evaluationDate: row.evaluationDate,
    target,
    invalidationPrice: row.invalidationPrice,
    status: row.status,
    activatedAt: row.activatedAt,
    marketDataAsOf: row.marketDataAsOf,
    activationPrice: row.activationPrice,
    activationCurrency: row.activationCurrency,
    marketProvider: row.marketProvider,
    resolvedAt: row.resolvedAt,
    resolutionReason: row.resolutionReason,
    pendingAnalysis,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    events: [],
    analysisSnapshot: null,
  };
}

function targetColumns(input: ForecastDraftInput) {
  return input.target.kind === 'price'
    ? [input.target.kind, input.target.price, null, null] as const
    : [input.target.kind, null, input.target.lower, input.target.upper] as const;
}

function changed(result: D1Result<unknown> | undefined) {
  return Number(result?.meta?.changes ?? 0);
}

export interface ForecastRepository {
  isTrackedSymbol(profileId: number, symbol: string): Promise<boolean>;
  profileCurrency(profileId: number): Promise<string | null>;
  list(profileId: number, filters: ForecastFilters): Promise<Forecast[]>;
  get(profileId: number, id: number): Promise<Forecast | null>;
  getAnalysisSeed(profileId: number, id: number): Promise<{ report: unknown; scenarioId: string } | null>;
  create(profileId: number, input: ForecastDraftInput, seed: NormalizedAnalysisSnapshot | null, now: string): Promise<number>;
  updateDraft(profileId: number, id: number, input: ForecastDraftInput, seed: NormalizedAnalysisSnapshot | null | undefined, now: string): Promise<boolean>;
  deleteDraft(profileId: number, id: number): Promise<boolean>;
  activate(profileId: number, id: number, expectedUpdatedAt: string, expectedRevision: number, quote: QuoteSnapshot, snapshot: NormalizedAnalysisSnapshot | null, now: string): Promise<boolean>;
  cancel(profileId: number, id: number, reason: string, now: string): Promise<boolean>;
  addNote(profileId: number, id: number, kind: ForecastNoteKind, note: string, now: string): Promise<boolean>;
}

export class D1ForecastRepository implements ForecastRepository {
  private readonly d1: D1Database;

  constructor(d1: D1Database) {
    this.d1 = d1;
  }

  async isTrackedSymbol(profileId: number, symbol: string) {
    const row = await this.d1.prepare(`SELECT symbol FROM positions WHERE profile_id = ? AND symbol = ?
      UNION SELECT symbol FROM watchlist_items WHERE profile_id = ? AND symbol = ? LIMIT 1`)
      .bind(profileId, symbol, profileId, symbol).first();
    return Boolean(row);
  }

  async profileCurrency(profileId: number) {
    const row = await this.d1.prepare('SELECT base_currency AS currency FROM investment_profiles WHERE id = ?')
      .bind(profileId).first<{ currency: string }>();
    return row?.currency?.toUpperCase() ?? null;
  }

  async list(profileId: number, filters: ForecastFilters) {
    const conditions = ['profile_id = ?'];
    const bindings: Array<string | number> = [profileId];
    if (filters.status) {
      conditions.push('status = ?');
      bindings.push(filters.status);
    }
    if (filters.symbol) {
      conditions.push('symbol = ?');
      bindings.push(filters.symbol);
    }
    const rows = await this.d1.prepare(`${FORECAST_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT 250`)
      .bind(...bindings).all<ForecastRow>();
    return rows.results.map(mapForecast);
  }

  async get(profileId: number, id: number) {
    const row = await this.d1.prepare(`${FORECAST_SELECT} WHERE id = ? AND profile_id = ?`)
      .bind(id, profileId).first<ForecastRow>();
    if (!row) return null;
    const [eventsResult, snapshotRow] = await Promise.all([
      this.d1.prepare(`SELECT id, revision, event_type AS eventType, note, payload_json AS payloadJson, created_at AS createdAt
        FROM forecast_events WHERE forecast_id = ? AND profile_id = ? ORDER BY revision`)
        .bind(id, profileId).all<EventRow>(),
      this.d1.prepare(`SELECT id, generated_at AS generatedAt, analysis_as_of AS analysisAsOf,
        completed_bar_as_of AS completedBarAsOf, provider, adjustment_mode AS adjustmentMode,
        engine_version AS engineVersion, ruleset_version AS rulesetVersion, data_hash AS dataHash,
        scenario_id AS scenarioId, setup, timeframe, lifecycle_state AS lifecycleState, direction,
        range_lower AS rangeLower, range_upper AS rangeUpper, range_height AS rangeHeight,
        measured_target AS measuredTarget, evidence_json AS evidenceJson, warnings_json AS warningsJson,
        report_json AS reportJson, created_at AS createdAt
        FROM analysis_snapshots WHERE forecast_id = ? AND profile_id = ?`)
        .bind(id, profileId).first<SnapshotRow>(),
    ]);
    const forecast = mapForecast(row);
    forecast.events = eventsResult.results.map((event) => ({
      id: event.id,
      revision: event.revision,
      eventType: event.eventType,
      note: event.note,
      payload: parseJson(event.payloadJson),
      createdAt: event.createdAt,
    }));
    forecast.analysisSnapshot = snapshotRow ? {
      id: snapshotRow.id,
      generatedAt: snapshotRow.generatedAt,
      analysisAsOf: snapshotRow.analysisAsOf,
      completedBarAsOf: snapshotRow.completedBarAsOf,
      provider: snapshotRow.provider,
      adjustmentMode: snapshotRow.adjustmentMode,
      engineVersion: snapshotRow.engineVersion,
      rulesetVersion: snapshotRow.rulesetVersion,
      dataHash: snapshotRow.dataHash,
      scenarioId: snapshotRow.scenarioId,
      setup: snapshotRow.setup,
      timeframe: snapshotRow.timeframe,
      lifecycleState: snapshotRow.lifecycleState,
      direction: snapshotRow.direction,
      rangeLower: snapshotRow.rangeLower,
      rangeUpper: snapshotRow.rangeUpper,
      rangeHeight: snapshotRow.rangeHeight,
      measuredTarget: snapshotRow.measuredTarget,
      evidence: parseJson(snapshotRow.evidenceJson) as unknown[],
      warnings: parseJson(snapshotRow.warningsJson) as string[],
      report: parseJson(snapshotRow.reportJson),
      createdAt: snapshotRow.createdAt,
    } : null;
    return forecast;
  }

  async getAnalysisSeed(profileId: number, id: number) {
    const row = await this.d1.prepare(`SELECT analysis_seed_json AS reportJson,
      analysis_seed_scenario_id AS scenarioId FROM forecasts WHERE id = ? AND profile_id = ?`)
      .bind(id, profileId).first<{ reportJson: string | null; scenarioId: string | null }>();
    return row?.reportJson && row.scenarioId
      ? { report: parseJson(row.reportJson), scenarioId: row.scenarioId }
      : null;
  }

  async create(profileId: number, input: ForecastDraftInput, seed: NormalizedAnalysisSnapshot | null, now: string) {
    const [targetKind, targetPrice, targetLower, targetUpper] = targetColumns(input);
    const payload = JSON.stringify({ after: input, analysisSeedScenarioId: seed?.scenarioId ?? null });
    const results = await this.d1.batch([
      this.d1.prepare(`INSERT INTO forecasts
        (profile_id, symbol, direction, confidence, thesis, supporting_evidence, counter_evidence,
         setup_tag, evaluation_date, target_kind, target_price, target_lower, target_upper,
         invalidation_price, analysis_seed_json, analysis_seed_scenario_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`)
        .bind(profileId, input.symbol, input.direction, input.confidence, input.thesis,
          input.supportingEvidence, input.counterEvidence, input.setupTag, input.evaluationDate,
          targetKind, targetPrice, targetLower, targetUpper, input.invalidationPrice,
          seed ? JSON.stringify(seed.report) : null, seed?.scenarioId ?? null, now, now),
      this.d1.prepare(`INSERT INTO forecast_events
        (forecast_id, profile_id, revision, event_type, note, payload_json, created_at)
        SELECT id, profile_id, 1, 'draft_created', '', ?, ? FROM forecasts
        WHERE id = last_insert_rowid() AND profile_id = ?`)
        .bind(payload, now, profileId),
    ]);
    return Number(results[0].meta.last_row_id);
  }

  async updateDraft(profileId: number, id: number, input: ForecastDraftInput, seed: NormalizedAnalysisSnapshot | null | undefined, now: string) {
    const [targetKind, targetPrice, targetLower, targetUpper] = targetColumns(input);
    const payload = JSON.stringify({
      after: input,
      analysisSeedScenarioId: seed === undefined ? 'preserved' : seed?.scenarioId ?? null,
    });
    const seedClause = seed === undefined
      ? ''
      : ', analysis_seed_json = ?, analysis_seed_scenario_id = ?';
    const seedBindings = seed === undefined
      ? []
      : [seed ? JSON.stringify(seed.report) : null, seed?.scenarioId ?? null];
    const results = await this.d1.batch([
      this.d1.prepare(`INSERT INTO forecast_events
        (forecast_id, profile_id, revision, event_type, note, payload_json, created_at)
        SELECT id, profile_id,
          (SELECT COALESCE(MAX(revision), 0) + 1 FROM forecast_events WHERE forecast_id = forecasts.id),
          'draft_updated', '', ?, ? FROM forecasts
        WHERE id = ? AND profile_id = ? AND status = 'draft'`)
        .bind(payload, now, id, profileId),
      this.d1.prepare(`UPDATE forecasts SET symbol = ?, direction = ?, confidence = ?, thesis = ?,
        supporting_evidence = ?, counter_evidence = ?, setup_tag = ?, evaluation_date = ?,
        target_kind = ?, target_price = ?, target_lower = ?, target_upper = ?, invalidation_price = ?${seedClause},
        updated_at = ? WHERE id = ? AND profile_id = ? AND status = 'draft'`)
        .bind(input.symbol, input.direction, input.confidence, input.thesis, input.supportingEvidence,
          input.counterEvidence, input.setupTag, input.evaluationDate, targetKind, targetPrice,
          targetLower, targetUpper, input.invalidationPrice, ...seedBindings, now, id, profileId),
    ]);
    return changed(results[1]) === 1;
  }

  async deleteDraft(profileId: number, id: number) {
    const result = await this.d1.prepare(`DELETE FROM forecasts WHERE id = ? AND profile_id = ? AND status = 'draft'`)
      .bind(id, profileId).run();
    return changed(result) === 1;
  }

  async activate(profileId: number, id: number, expectedUpdatedAt: string, expectedRevision: number, quote: QuoteSnapshot, snapshot: NormalizedAnalysisSnapshot | null, now: string) {
    const statements: D1PreparedStatement[] = [
      this.d1.prepare(`UPDATE forecasts SET status = 'active', activated_at = ?, market_data_as_of = ?,
        activation_price = ?, activation_currency = ?, market_provider = ?, analysis_seed_json = NULL,
        analysis_seed_scenario_id = NULL, updated_at = ?
        WHERE id = ? AND profile_id = ? AND status = 'draft' AND updated_at = ?
        AND (SELECT COALESCE(MAX(revision), 0) FROM forecast_events WHERE forecast_id = forecasts.id) = ?
        AND (
          EXISTS (SELECT 1 FROM positions WHERE profile_id = forecasts.profile_id AND symbol = forecasts.symbol)
          OR EXISTS (SELECT 1 FROM watchlist_items WHERE profile_id = forecasts.profile_id AND symbol = forecasts.symbol)
        )`)
        .bind(now, quote.providerAsOf, quote.price, quote.currency, quote.provider, now, id, profileId, expectedUpdatedAt, expectedRevision),
      this.d1.prepare(`INSERT INTO forecast_events
        (forecast_id, profile_id, revision, event_type, note, payload_json, created_at)
        SELECT id, profile_id,
          (SELECT COALESCE(MAX(revision), 0) + 1 FROM forecast_events WHERE forecast_id = forecasts.id),
          'activated', '', ?, ? FROM forecasts
        WHERE id = ? AND profile_id = ? AND status = 'active' AND activated_at = ? AND changes() = 1`)
        .bind(JSON.stringify({ quote }), now, id, profileId, now),
    ];
    if (snapshot) {
      statements.push(this.d1.prepare(`INSERT INTO analysis_snapshots
        (forecast_id, profile_id, symbol, generated_at, analysis_as_of, completed_bar_as_of,
         provider, adjustment_mode, engine_version, ruleset_version, data_hash, scenario_id,
         setup, timeframe, lifecycle_state, direction, range_lower, range_upper, range_height,
         measured_target, evidence_json, warnings_json, report_json, created_at)
        SELECT id, profile_id, symbol, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM forecasts WHERE id = ? AND profile_id = ? AND status = 'active' AND activated_at = ? AND changes() = 1`)
        .bind(snapshot.generatedAt, snapshot.analysisAsOf, snapshot.completedBarAsOf, snapshot.provider,
          snapshot.adjustmentMode, snapshot.engineVersion, snapshot.rulesetVersion, snapshot.dataHash,
          snapshot.scenarioId, snapshot.setup, snapshot.timeframe, snapshot.lifecycleState,
          snapshot.direction, snapshot.rangeLower, snapshot.rangeUpper, snapshot.rangeHeight,
          snapshot.measuredTarget, JSON.stringify(snapshot.evidence), JSON.stringify(snapshot.warnings),
          JSON.stringify(snapshot.report), now, id, profileId, now));
    }
    const results = await this.d1.batch(statements);
    return changed(results[0]) === 1;
  }

  async cancel(profileId: number, id: number, reason: string, now: string) {
    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE forecasts SET status = 'cancelled', resolved_at = ?, resolution_reason = ?,
        updated_at = ? WHERE id = ? AND profile_id = ? AND status = 'active'`)
        .bind(now, reason, now, id, profileId),
      this.d1.prepare(`INSERT INTO forecast_events
        (forecast_id, profile_id, revision, event_type, note, payload_json, created_at)
        SELECT id, profile_id,
          (SELECT COALESCE(MAX(revision), 0) + 1 FROM forecast_events WHERE forecast_id = forecasts.id),
          'cancelled', ?, ?, ? FROM forecasts
        WHERE id = ? AND profile_id = ? AND status = 'cancelled' AND resolved_at = ? AND changes() = 1`)
        .bind(reason, JSON.stringify({ reason }), now, id, profileId, now),
    ]);
    return changed(results[0]) === 1;
  }

  async addNote(profileId: number, id: number, kind: ForecastNoteKind, note: string, now: string) {
    const result = await this.d1.prepare(`INSERT INTO forecast_events
      (forecast_id, profile_id, revision, event_type, note, payload_json, created_at)
      SELECT id, profile_id,
        (SELECT COALESCE(MAX(revision), 0) + 1 FROM forecast_events WHERE forecast_id = forecasts.id),
        ?, ?, ?, ? FROM forecasts
      WHERE id = ? AND profile_id = ? AND status <> 'draft'`)
      .bind(kind, note, JSON.stringify({ note }), now, id, profileId).run();
    return changed(result) === 1;
  }
}
