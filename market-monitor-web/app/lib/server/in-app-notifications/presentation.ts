import { NOTIFICATION_CATEGORIES, type NotificationPayload } from '../notifications/types.ts';
import { parseNotificationPayload } from '../notifications/payload.ts';
import { IN_APP_PRESENTATION_VERSION, InAppNotificationError } from './contract.ts';
import type { InAppEmailState, InAppEmailStatus, InAppPresentationSnapshot } from './types.ts';

const TITLES = {
  target_hit: 'Forecast target reached',
  invalidated: 'Forecast invalidated',
  expired: 'Forecast expired',
  needs_review: 'Forecast needs review',
} as const;

const REASON_LABELS: Record<string, string> = {
  target_boundary_touched: 'The target boundary was touched.',
  invalidation_boundary_touched: 'The invalidation boundary was touched.',
  horizon_complete_without_terminal_touch: 'The forecast horizon completed without a terminal boundary touch.',
  same_bar_target_invalidation_collision: 'Target and invalidation evidence occurred in the same completed bar.',
  insufficient_horizon_coverage: 'Completed market coverage is insufficient for a terminal result.',
  insufficient_observation_path_coverage: 'The completed observation path is incomplete.',
  corporate_action_price_discontinuity: 'A corporate action may have disrupted price continuity.',
  adjustment_mode_mismatch: 'Market-data adjustment modes do not match.',
  neutral_policy_unsupported: 'The neutral forecast policy requires review.',
  currency_mismatch: 'Observed and activation currencies do not match.',
  currency_unverified: 'The observed currency could not be verified.',
};

const EMAIL_PRESENTATION: Record<InAppEmailState, InAppEmailStatus> = {
  not_configured: { state: 'not_configured', label: 'Email not configured', tone: 'neutral' },
  queued: { state: 'queued', label: 'Email queued', tone: 'neutral' },
  in_progress: { state: 'in_progress', label: 'Email in progress', tone: 'neutral' },
  provider_accepted: { state: 'provider_accepted', label: 'Email provider accepted', tone: 'positive' },
  delivered: { state: 'delivered', label: 'Delivered to mail server', tone: 'positive' },
  delayed: { state: 'delayed', label: 'Email delayed', tone: 'neutral' },
  ambiguous: { state: 'ambiguous', label: 'Email outcome unconfirmed', tone: 'neutral' },
  failed: { state: 'failed', label: 'Email failed', tone: 'negative' },
  bounced: { state: 'bounced', label: 'Email bounced', tone: 'negative' },
  complained: { state: 'complained', label: 'Recipient complaint recorded', tone: 'negative' },
  suppressed: { state: 'suppressed', label: 'Email suppressed', tone: 'neutral' },
};

function plainText(value: unknown, maximum: number) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !/[<>\u0000-\u001f\u007f]/u.test(value);
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function parseStoredInAppPresentation(
  value: unknown,
  storedVersion: string,
): InAppPresentationSnapshot {
  if (storedVersion !== IN_APP_PRESENTATION_VERSION
    || !exactObject(value, ['version', 'title', 'summary', 'details', 'evidence'])
    || value.version !== storedVersion
    || !plainText(value.title, 120) || !plainText(value.summary, 240)
    || !Array.isArray(value.details) || value.details.length < 1 || value.details.length > 8
    || !value.details.every((detail) => plainText(detail, 240))
    || !exactObject(value.evidence, [
      'forecastId', 'evaluationRunId', 'reviewItemId', 'analysisSnapshotId',
    ])
    || !Number.isSafeInteger(value.evidence.forecastId) || (value.evidence.forecastId as number) < 1
    || !Number.isSafeInteger(value.evidence.evaluationRunId)
    || (value.evidence.evaluationRunId as number) < 1
    || !Number.isSafeInteger(value.evidence.reviewItemId) || (value.evidence.reviewItemId as number) < 1
    || (value.evidence.analysisSnapshotId !== null
      && (!Number.isSafeInteger(value.evidence.analysisSnapshotId)
        || (value.evidence.analysisSnapshotId as number) < 1))) {
    throw new Error('InAppStoredPresentationInvalid');
  }
  return value as unknown as InAppPresentationSnapshot;
}

function price(value: number, currency: string) {
  return `${currency} ${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
}

function details(payload: NotificationPayload) {
  const reason = REASON_LABELS[payload.reasonCode];
  if (!reason) throw new InAppNotificationError('Trusted intent reason is unsupported.', 'conflict', 409);
  const values = [reason];
  if (payload.triggeringMarketDate) values.push(`Market date: ${payload.triggeringMarketDate}`);
  if (payload.targetBoundary !== null) values.push(`Target boundary: ${price(payload.targetBoundary, payload.activationCurrency)}`);
  if (payload.targetRange !== null) values.push(`Target range: ${price(payload.targetRange[0], payload.activationCurrency)}–${price(payload.targetRange[1], payload.activationCurrency)}`);
  if (payload.invalidationBoundary !== null) values.push(`Invalidation boundary: ${price(payload.invalidationBoundary, payload.activationCurrency)}`);
  if (payload.evaluatedThrough) values.push(`Evaluated through: ${payload.evaluatedThrough}`);
  return values;
}

export function buildInAppPresentation(payloadValue: unknown): {
  payload: NotificationPayload;
  presentation: InAppPresentationSnapshot;
} {
  let payload: NotificationPayload;
  try {
    payload = parseNotificationPayload(payloadValue);
  } catch {
    throw new InAppNotificationError('Trusted intent payload is malformed.', 'conflict', 409);
  }
  if (!NOTIFICATION_CATEGORIES.includes(payload.category)) {
    throw new InAppNotificationError('Trusted intent category is unsupported.', 'conflict', 409);
  }
  return {
    payload,
    presentation: {
      version: IN_APP_PRESENTATION_VERSION,
      title: TITLES[payload.category],
      summary: `${payload.symbol}: ${TITLES[payload.category].toLowerCase()}.`,
      details: details(payload),
      evidence: {
        forecastId: payload.forecastId,
        evaluationRunId: payload.evaluationRunId,
        reviewItemId: payload.reviewItemId,
        analysisSnapshotId: payload.analysisSnapshotId,
      },
    },
  };
}

export function mapEmailStatus(value: string | null): InAppEmailStatus {
  const state: InAppEmailState = value === 'delivered'
    ? 'delivered'
    : value === 'provider_accepted'
      ? 'provider_accepted'
      : value === 'delayed'
        ? 'delayed'
        : value === 'bounced'
          ? 'bounced'
          : value === 'complained'
            ? 'complained'
    : value === 'prepared' || value === 'retry_scheduled' || value === 'pending' || value === 'deferred'
      ? 'queued'
      : value === 'request_started' || value === 'claimed'
        ? 'in_progress'
        : value === 'ambiguous'
          ? 'ambiguous'
        : value === 'suppressed'
          ? 'suppressed'
          : value === 'failed' || value === 'terminal_failure' || value === 'dead_letter'
            ? 'failed'
            : 'not_configured';
  return EMAIL_PRESENTATION[state];
}
