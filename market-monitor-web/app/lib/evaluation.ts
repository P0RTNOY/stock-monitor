import type {
  EvaluationEvidence,
  EvaluationKind,
  EvaluationObservation,
  EvaluationRun,
  ForecastReviewItem,
  ForecastStatus,
  ForecastTarget,
} from './types.ts';

const EVALUATION_KINDS: EvaluationKind[] = ['no_change', 'target_hit', 'invalidated', 'expired', 'needs_review'];
const FORECAST_STATUSES: ForecastStatus[] = ['draft', 'active', 'target_hit', 'invalidated', 'expired', 'cancelled'];

export type ReviewVisibility = 'unacknowledged' | 'acknowledged' | 'all';
export type EvaluationTone = 'proven' | 'attention' | 'pending';

export type EvaluationPresentation = {
  eyebrow: string;
  heading: string;
  description: string;
  tone: EvaluationTone;
};

export type LatestRequestGate = {
  begin: () => number;
  isCurrent: (requestId: number) => boolean;
};

export function createLatestRequestGate(): LatestRequestGate {
  let latestRequestId = 0;
  return {
    begin: () => { latestRequestId += 1; return latestRequestId; },
    isCurrent: (requestId) => requestId === latestRequestId,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function integer(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function instant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nullableInstant(value: unknown): value is string | null {
  return value === null || instant(value);
}

function localDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function nullableLocalDate(value: unknown): value is string | null {
  return value === null || localDate(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function target(value: unknown): value is ForecastTarget {
  if (!record(value)) return false;
  return value.kind === 'price'
    ? finite(value.price)
    : value.kind === 'range' && finite(value.lower) && finite(value.upper) && value.lower <= value.upper;
}

export function isEvaluationObservation(value: unknown): value is EvaluationObservation {
  if (!record(value)) return false;
  return typeof value.symbol === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(String(value.market_date))
    && instant(value.timestamp)
    && instant(value.completed_at)
    && finite(value.open)
    && finite(value.high)
    && finite(value.low)
    && finite(value.close)
    && finite(value.volume)
    && value.low <= value.open
    && value.open <= value.high
    && value.low <= value.close
    && value.close <= value.high
    && typeof value.provider === 'string'
    && typeof value.adjustment_mode === 'string'
    && strings(value.corporate_action_flags);
}

function nullableObservation(value: unknown): value is EvaluationObservation | null {
  return value === null || isEvaluationObservation(value);
}

function nullableFinite(value: unknown): value is number | null {
  return value === null || finite(value);
}

export function isEvaluationEvidence(value: unknown): value is EvaluationEvidence {
  if (!record(value)) return false;
  const range = value.target_range;
  const observationCount = value.observation_count;
  const observationBoundsMatchCount = Number(observationCount) === 0
    ? value.first_eligible_observation === null && value.last_eligible_observation === null
    : isEvaluationObservation(value.first_eligible_observation) && isEvaluationObservation(value.last_eligible_observation);
  return instant(value.activation_cutoff)
    && typeof value.activation_currency === 'string'
    && value.activation_currency.length > 0
    && (value.observed_currency === null || (typeof value.observed_currency === 'string' && value.observed_currency.length > 0))
    && Number.isInteger(observationCount)
    && Number(observationCount) >= 0
    && observationBoundsMatchCount
    && nullableObservation(value.first_eligible_observation)
    && nullableObservation(value.last_eligible_observation)
    && nullableObservation(value.triggering_observation)
    && nullableFinite(value.target_boundary)
    && (range === null || (Array.isArray(range) && range.length === 2 && finite(range[0]) && finite(range[1]) && range[0] <= range[1]))
    && nullableFinite(value.invalidation_boundary)
    && (value.detected_at === null || value.detected_at === 'open' || value.detected_at === 'within_bar')
    && nullableFinite(value.observed_open)
    && nullableFinite(value.crossed_boundary)
    && strings(value.corporate_action_findings)
    && record(value.coverage_findings)
    && strings(value.warnings);
}

export function isEvaluationRun(value: unknown): value is EvaluationRun {
  if (!record(value)) return false;
  return integer(value.id)
    && integer(value.profileId)
    && integer(value.forecastId)
    && EVALUATION_KINDS.includes(value.resultKind as EvaluationKind)
    && typeof value.reasonCode === 'string'
    && typeof value.explanation === 'string'
    && typeof value.evaluatorVersion === 'string'
    && typeof value.rulesetVersion === 'string'
    && nullableLocalDate(value.evaluatedThrough)
    && instant(value.evaluationCutoff)
    && isEvaluationEvidence(value.evidence)
    && strings(value.warnings)
    && typeof value.inputFingerprint === 'string'
    && instant(value.createdAt);
}

export function isForecastReviewItem(value: unknown): value is ForecastReviewItem {
  if (!record(value)) return false;
  return integer(value.id)
    && integer(value.profileId)
    && integer(value.forecastId)
    && integer(value.evaluationRunId)
    && (value.reviewKind === 'resolved' || value.reviewKind === 'needs_review')
    && nullableInstant(value.acknowledgedAt)
    && instant(value.createdAt)
    && typeof value.symbol === 'string'
    && FORECAST_STATUSES.includes(value.forecastStatus as ForecastStatus)
    && target(value.target)
    && nullableFinite(value.invalidationPrice)
    && (value.analysisSnapshotId === null || integer(value.analysisSnapshotId))
    && isEvaluationRun(value.run)
    && value.run.id === value.evaluationRunId
    && value.run.forecastId === value.forecastId;
}

export function evaluationPresentation(kind: EvaluationKind, reasonCode = ''): EvaluationPresentation {
  if (kind === 'target_hit') return {
    eyebrow: 'Proven terminal result',
    heading: 'Target boundary reached',
    description: 'Completed-bar evidence proves the saved target was reached under the frozen ruleset.',
    tone: 'proven',
  };
  if (kind === 'invalidated') return {
    eyebrow: 'Proven terminal result',
    heading: 'Invalidation boundary reached',
    description: 'Completed-bar evidence proves the saved invalidation condition was reached.',
    tone: 'proven',
  };
  if (kind === 'expired') return {
    eyebrow: 'Proven terminal result',
    heading: 'Evaluation horizon completed',
    description: 'Coverage was sufficient to prove the horizon ended without another terminal event.',
    tone: 'proven',
  };
  if (kind === 'needs_review') {
    const insufficient = /(insufficient|missing|coverage|corporate_action|unsupported|unavailable|currency_mismatch|currency_unverified)/i.test(reasonCode);
    return {
      eyebrow: insufficient ? 'Insufficient evidence' : 'Ambiguous evidence',
      heading: insufficient ? 'The available bars cannot prove an outcome' : 'The event order cannot be proven',
      description: insufficient
        ? 'The forecast remains unchanged. Review the evidence and warnings; Northstar did not infer a result.'
        : 'The forecast remains unchanged because completed OHLC bars cannot establish a trustworthy outcome.',
      tone: 'attention',
    };
  }
  return {
    eyebrow: 'Latest evaluation complete',
    heading: 'No terminal outcome proven',
    description: 'The latest completed-bar evaluation found no proven target, invalidation, or completed horizon. The forecast remains active.',
    tone: 'pending',
  };
}

export function readableEvaluationReason(value: string) {
  if (!value.trim()) return 'No reason code supplied';
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function evaluationCurrency(run: EvaluationRun) {
  return run.evidence.activation_currency;
}

export function filterReviewItems(items: ForecastReviewItem[], visibility: ReviewVisibility) {
  if (visibility === 'all') return items;
  const acknowledged = visibility === 'acknowledged';
  return items.filter((item) => Boolean(item.acknowledgedAt) === acknowledged);
}
