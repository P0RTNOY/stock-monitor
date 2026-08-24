export type Profile = {
  id: number;
  name: string;
  baseCurrency: string;
  cashBalance: number;
};

export type Position = {
  id: number;
  symbol: string;
  companyName: string;
  shares: number;
  averageCost: number;
  createdAt: string;
};

export type WatchlistItem = {
  id: number;
  symbol: string;
  companyName: string;
  createdAt: string;
};

export type JournalEntry = {
  id: number;
  entryDate: string;
  symbol: string;
  direction: 'Bullish' | 'Bearish' | 'Neutral' | 'Watching';
  confidence: number;
  thesis: string;
  target: string;
  createdAt: string;
};

export type ReviewAlert = {
  id: number;
  symbol: string;
  conditionType: 'Price above' | 'Price below' | 'Daily move above %' | 'Daily move below %';
  threshold: number;
  note: string;
  active: boolean;
  createdAt: string;
};

export type WorkspaceData = {
  profile: Profile;
  positions: Position[];
  watchlist: WatchlistItem[];
  journalEntries: JournalEntry[];
  alerts: ReviewAlert[];
};

export type Quote = {
  symbol: string;
  currency: string | null;
  price: number | null;
  previousClose: number | null;
  change: number | null;
  changePct: number | null;
  history: number[];
  updatedAt: string | null;
};

export type QuoteMap = Record<string, Quote>;

export type AnalysisLevel = {
  role: 'support' | 'resistance' | 'decision';
  lower: number;
  upper: number;
  touch_count: number;
  last_touch: string;
};

export type AnalysisTimeframe = {
  timeframe: '1d' | '1wk';
  bar_count: number;
  last_bar: string | null;
  atr: number | null;
  relative_volume: number | null;
  moving_averages: Record<string, number | null>;
  structure: {
    trend: 'uptrend' | 'downtrend' | 'range' | 'insufficient_data';
    reason: string;
  };
  levels: AnalysisLevel[];
};

export type AnalysisRisk = {
  entry_price: number;
  execution_stop_price: number;
  measured_target: number;
  account_risk: number | null;
  commission_per_unit: number;
  expected_slippage_per_unit: number;
  risk_per_unit: number;
  reward_per_unit: number | null;
  reward_risk_ratio: number | null;
  position_size: number | null;
};

export type AnalysisScenario = {
  scenario_id: string;
  setup: 'rectangle';
  timeframe: '1d' | '1wk';
  direction: 'bullish' | 'bearish' | 'undetermined';
  lifecycle_state: 'candidate' | 'confirmed' | 'retest' | 'failed_breakout' | 'invalidated' | 'target_reached' | 'expired';
  range_lower: number;
  range_upper: number;
  range_height: number;
  range_started_at: string;
  established_at: string;
  retested_at: string | null;
  terminal_at: string | null;
  last_event_at: string;
  event_reason: string | null;
  confirmation_condition: string;
  confirmed_at: string | null;
  entry_trigger: string;
  entry_assumption: number | null;
  analytical_invalidation: string;
  measured_target: number | null;
  intermediate_levels: AnalysisLevel[];
  risk: AnalysisRisk | null;
  evidence_ids: string[];
  warnings: string[];
};

export type AnalysisEvidence = {
  rule_id: string;
  category: string;
  status: 'passed' | 'failed' | 'warning' | 'unknown' | 'not_applicable';
  explanation: string;
};

export type TechnicalAnalysisReport = {
  symbol: string;
  as_of: string;
  generated_at: string;
  engine_version: string;
  ruleset_version: string;
  provider: string;
  adjustment_mode: string;
  data_hash: string;
  status: 'no_setup' | 'scenario_detected' | 'insufficient_data';
  summary: string;
  timeframes: Record<string, AnalysisTimeframe>;
  scenarios: AnalysisScenario[];
  evidence: AnalysisEvidence[];
  warnings: string[];
};

export type AnalysisAssumptions = {
  accountRisk: number | null;
  commissionPerUnit: number;
  expectedSlippagePerUnit: number;
  executionStopPrice: number | null;
};

export type ForecastDirection = 'bullish' | 'bearish' | 'neutral';

export type ForecastStatus =
  | 'draft'
  | 'active'
  | 'target_hit'
  | 'invalidated'
  | 'expired'
  | 'cancelled';

export type ForecastEvent = {
  id: number;
  revision: number;
  eventType: string;
  note: string;
  payload: unknown;
  createdAt: string;
};

export type ForecastAnalysisSnapshot = {
  id?: number;
  scenarioId: string;
  setup: string;
  timeframe: string;
  generatedAt: string;
  analysisAsOf: string;
  completedBarAsOf: string | null;
  provider: string;
  adjustmentMode: string;
  engineVersion: string;
  rulesetVersion: string;
  dataHash: string;
  lifecycleState: string;
  direction: string;
  rangeLower: number;
  rangeUpper: number;
  rangeHeight: number;
  measuredTarget: number | null;
  evidence: AnalysisEvidence[];
  warnings: string[];
  report: TechnicalAnalysisReport;
  createdAt: string;
};

export type ForecastPendingAnalysis = {
  scenarioId: string;
  generatedAt: string;
  provider: string;
  lifecycleState: string;
  direction: string;
};

export type ForecastTarget =
  | { kind: 'price'; price: number }
  | { kind: 'range'; lower: number; upper: number };

export type Forecast = {
  id: number;
  symbol: string;
  direction: ForecastDirection;
  confidence: number;
  thesis: string;
  supportingEvidence: string;
  counterEvidence: string;
  setupTag: string;
  evaluationDate: string;
  target: ForecastTarget;
  invalidationPrice: number | null;
  status: ForecastStatus;
  activatedAt: string | null;
  activationPrice: number | null;
  activationCurrency: string | null;
  marketDataAsOf: string | null;
  marketProvider: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  createdAt: string;
  updatedAt: string;
  events: ForecastEvent[];
  analysisSnapshot: ForecastAnalysisSnapshot | null;
  pendingAnalysis: ForecastPendingAnalysis | null;
};

export type ForecastDraftInput = {
  symbol: string;
  direction: ForecastDirection;
  confidence: number;
  thesis: string;
  supportingEvidence: string;
  counterEvidence: string;
  setupTag: string;
  evaluationDate: string;
  target: ForecastTarget;
  invalidationPrice: number | null;
  analysisSeed?: { report: TechnicalAnalysisReport; scenarioId: string } | null;
};

export type ForecastSeed = {
  symbol: string;
  direction: ForecastDirection;
  setupTag: string;
  target: ForecastTarget;
  analysisReport: TechnicalAnalysisReport;
  analysisScenarioId: string;
};

export type EvaluationKind = 'no_change' | 'target_hit' | 'invalidated' | 'expired' | 'needs_review';

export type EvaluationObservation = {
  symbol: string;
  market_date: string;
  timestamp: string;
  completed_at: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  provider: string;
  adjustment_mode: string;
  corporate_action_flags: string[];
};

export type EvaluationEvidence = {
  activation_cutoff: string;
  activation_currency: string;
  observed_currency: string | null;
  observation_count: number;
  first_eligible_observation: EvaluationObservation | null;
  last_eligible_observation: EvaluationObservation | null;
  triggering_observation: EvaluationObservation | null;
  target_boundary: number | null;
  target_range: [number, number] | null;
  invalidation_boundary: number | null;
  detected_at: 'open' | 'within_bar' | null;
  observed_open: number | null;
  crossed_boundary: number | null;
  corporate_action_findings: string[];
  coverage_findings: Record<string, unknown>;
  warnings: string[];
};

export type EvaluationRun = {
  id: number;
  profileId: number;
  forecastId: number;
  resultKind: EvaluationKind;
  reasonCode: string;
  explanation: string;
  evaluatorVersion: string;
  rulesetVersion: string;
  evaluatedThrough: string | null;
  evaluationCutoff: string;
  evidence: EvaluationEvidence;
  warnings: string[];
  inputFingerprint: string;
  createdAt: string;
};

export type ForecastReviewItem = {
  id: number;
  profileId: number;
  forecastId: number;
  evaluationRunId: number;
  reviewKind: 'resolved' | 'needs_review';
  acknowledgedAt: string | null;
  createdAt: string;
  symbol: string;
  forecastStatus: ForecastStatus;
  target: ForecastTarget;
  invalidationPrice: number | null;
  analysisSnapshotId: number | null;
  run: EvaluationRun;
};
