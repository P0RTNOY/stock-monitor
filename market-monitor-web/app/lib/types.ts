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
  direction: 'bullish' | 'bearish' | 'undetermined';
  lifecycle_state: 'candidate' | 'confirmed' | 'retest' | 'failed_breakout' | 'invalidated' | 'target_reached' | 'expired';
  range_lower: number;
  range_upper: number;
  range_height: number;
  established_at: string;
  retested_at: string | null;
  terminal_at: string | null;
  last_event_at: string;
  event_reason: string | null;
  confirmation_condition: string;
  entry_trigger: string;
  entry_assumption: number | null;
  analytical_invalidation: string;
  measured_target: number | null;
  intermediate_levels: AnalysisLevel[];
  risk: AnalysisRisk | null;
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
