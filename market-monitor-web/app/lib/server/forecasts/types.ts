export const FORECAST_DIRECTIONS = ['bullish', 'bearish', 'neutral'] as const;
export const FORECAST_STATUSES = ['draft', 'active', 'target_hit', 'invalidated', 'expired', 'cancelled'] as const;
export const FORECAST_NOTE_KINDS = ['amendment', 'review_note'] as const;

export type ForecastDirection = typeof FORECAST_DIRECTIONS[number];
export type ForecastStatus = typeof FORECAST_STATUSES[number];
export type ForecastNoteKind = typeof FORECAST_NOTE_KINDS[number];

export type ForecastTarget =
  | { kind: 'price'; price: number }
  | { kind: 'range'; lower: number; upper: number };

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
};

export type ForecastEvent = {
  id: number;
  revision: number;
  eventType: 'draft_created' | 'draft_updated' | 'activated' | 'cancelled' | 'evaluated' | 'evaluation_review_acknowledged' | ForecastNoteKind;
  note: string;
  payload: unknown;
  createdAt: string;
};

export type AnalysisSnapshot = {
  id: number;
  generatedAt: string;
  analysisAsOf: string;
  completedBarAsOf: string | null;
  provider: string;
  adjustmentMode: string;
  engineVersion: string;
  rulesetVersion: string;
  dataHash: string;
  scenarioId: string;
  setup: string;
  timeframe: string;
  lifecycleState: string;
  direction: string;
  rangeLower: number;
  rangeUpper: number;
  rangeHeight: number;
  measuredTarget: number | null;
  evidence: unknown[];
  warnings: string[];
  report: unknown;
  createdAt: string;
};

export type Forecast = ForecastDraftInput & {
  id: number;
  profileId: number;
  status: ForecastStatus;
  activatedAt: string | null;
  marketDataAsOf: string | null;
  activationPrice: number | null;
  activationCurrency: string | null;
  marketProvider: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  pendingAnalysis: {
    scenarioId: string;
    generatedAt: string;
    provider: string;
    lifecycleState: string;
    direction: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  events: ForecastEvent[];
  analysisSnapshot: AnalysisSnapshot | null;
};

export type ForecastFilters = {
  status?: ForecastStatus;
  symbol?: string;
};

export type QuoteSnapshot = {
  price: number;
  currency: string;
  providerAsOf: string;
  provider: string;
};

export type NormalizedAnalysisSnapshot = Omit<AnalysisSnapshot, 'id' | 'createdAt'>;
