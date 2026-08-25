export const NOTIFICATION_CATEGORIES = [
  'target_hit',
  'invalidated',
  'expired',
  'needs_review',
] as const;

export type NotificationCategory = typeof NOTIFICATION_CATEGORIES[number];

export const NOTIFICATION_POLICY_DECISIONS = [
  'eligible',
  'suppressed_no_consent',
  'suppressed_category_disabled',
  'suppressed_unsupported_category',
  'suppressed_historical_cutover',
  'deferred_quiet_hours',
  'invalid_source_needs_review',
] as const;

export type NotificationPolicyDecision = typeof NOTIFICATION_POLICY_DECISIONS[number];

export const NOTIFICATION_OUTBOX_STATES = [
  'pending',
  'deferred',
  'suppressed',
  'claimed',
  'retry_scheduled',
  'succeeded',
  'dead_letter',
] as const;

export type NotificationOutboxState = typeof NOTIFICATION_OUTBOX_STATES[number];

export const NOTIFICATION_ATTEMPT_STATES = [
  'started',
  'retry_scheduled',
  'succeeded',
  'terminal_failure',
  'interrupted',
] as const;

export type NotificationAttemptState = typeof NOTIFICATION_ATTEMPT_STATES[number];

export const NOTIFICATION_FAILURE_CLASSES = ['retryable', 'terminal', 'interrupted'] as const;
export type NotificationFailureClass = typeof NOTIFICATION_FAILURE_CLASSES[number];

export const NOTIFICATION_PROJECTION_CLASSIFICATIONS = [
  'intent_materialized',
  'excluded_no_change',
  'excluded_unsupported',
  'invalid_source_needs_review',
] as const;

export type NotificationProjectionClassification =
  typeof NOTIFICATION_PROJECTION_CLASSIFICATIONS[number];

/**
 * A profile-scoped Phase 2A projection row. Implementations must populate this
 * with a same-profile join across evaluation_runs, forecast_review_items,
 * forecasts, and (optionally) analysis_snapshots. Values are validated again
 * before they cross into the notification domain.
 */
export type TrustedNotificationSourceRow = {
  profileId: number;
  forecastId: number;
  evaluationRunId: number;
  reviewItemId: number;
  reviewKind: string;
  resultKind: string;
  reasonCode: string;
  evaluatorVersion: string;
  rulesetVersion: string;
  evaluatedThrough: string | null;
  evaluationCutoff: string;
  createdAt: string;
  symbol: string;
  analysisSnapshotId: number | null;
  evidenceJson: string;
};

export type NotificationTargetRange = readonly [number, number];

export type NotificationPayload = {
  payloadVersion: string;
  profileId: number;
  forecastId: number;
  evaluationRunId: number;
  reviewItemId: number;
  category: NotificationCategory;
  previousStatus: 'active';
  resultingStatus: 'active' | 'target_hit' | 'invalidated' | 'expired';
  symbol: string;
  reasonCode: string;
  evaluatedThrough: string | null;
  triggeringMarketDate: string | null;
  occurredAt: string;
  evaluationCutoff: string;
  targetBoundary: number | null;
  targetRange: NotificationTargetRange | null;
  invalidationBoundary: number | null;
  detectedAt: 'open' | 'within_bar' | null;
  crossedBoundary: number | null;
  activationCurrency: string;
  observedCurrency: string | null;
  analysisSnapshotId: number | null;
  evaluatorVersion: string;
  rulesetVersion: string;
};
