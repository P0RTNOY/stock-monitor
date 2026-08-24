import type { Forecast, ForecastStatus } from '../forecasts/types.ts';

export const EVALUATION_RULESET_VERSION = 'forecast-evaluation-ruleset-v1';
export const EVALUATION_KINDS = ['no_change', 'target_hit', 'invalidated', 'expired', 'needs_review'] as const;

export type EvaluationKind = typeof EVALUATION_KINDS[number];
export type TerminalEvaluationKind = Extract<EvaluationKind, ForecastStatus>;

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

export type EvaluationResult = {
  kind: EvaluationKind;
  reason_code: string;
  explanation: string;
  evaluator_version: string;
  ruleset_version: string;
  forecast_id: number;
  evaluation_cutoff: string;
  evaluated_through: string | null;
  input_fingerprint: string;
  evidence: EvaluationEvidence;
};

export type EvaluationRequest = {
  forecast: {
    forecast_id: number;
    symbol: string;
    direction: Forecast['direction'];
    activated_at: string;
    activation_market_data_as_of: string;
    activation_price: number;
    currency: string;
    evaluation_date: string;
    target_price: number | null;
    target_range: [number, number] | null;
    invalidation_price: number | null;
    adjustment_mode: 'raw';
  };
  evaluation_cutoff: string;
  ruleset_version: typeof EVALUATION_RULESET_VERSION;
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
  target: Forecast['target'];
  invalidationPrice: number | null;
  analysisSnapshotId: number | null;
  run: EvaluationRun;
};
