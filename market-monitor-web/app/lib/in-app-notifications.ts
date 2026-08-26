export const IN_APP_CATEGORY_LABELS = {
  target_hit: 'Target reached',
  invalidated: 'Invalidated',
  expired: 'Expired',
  needs_review: 'Needs review',
} as const;

export type ClientNotificationCategory = keyof typeof IN_APP_CATEGORY_LABELS;
export type ClientNotificationState = 'read' | 'unread';

export type ClientNotification = {
  id: string;
  category: ClientNotificationCategory;
  symbol: string;
  state: ClientNotificationState;
  occurredAt: string;
  firstReadAt: string | null;
  presentation: {
    version: string;
    title: string;
    summary: string;
    details: string[];
    evidence: {
      forecastId: number;
      evaluationRunId: number;
      reviewItemId: number;
      analysisSnapshotId: number | null;
    };
  };
  deepLink: string;
  email: { state: string; label: string; tone: 'neutral' | 'positive' | 'negative' };
};

export type ClientNotificationList = {
  items: ClientNotification[];
  nextCursor: string | null;
  unreadCount: number;
  markAllReadToken: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function isClientNotification(value: unknown): value is ClientNotification {
  const item = record(value);
  const presentation = record(item?.presentation);
  const evidence = record(presentation?.evidence);
  const email = record(item?.email);
  return Boolean(item && typeof item.id === 'string' && /^[a-f0-9]{64}$/u.test(item.id)
    && typeof item.category === 'string' && Object.hasOwn(IN_APP_CATEGORY_LABELS, item.category)
    && typeof item.symbol === 'string' && (item.state === 'read' || item.state === 'unread')
    && typeof item.occurredAt === 'string'
    && (item.firstReadAt === null || typeof item.firstReadAt === 'string')
    && typeof item.deepLink === 'string' && item.deepLink === `/notifications/${item.id}`
    && presentation && typeof presentation.version === 'string'
    && typeof presentation.title === 'string' && typeof presentation.summary === 'string'
    && Array.isArray(presentation.details) && presentation.details.every((detail) => typeof detail === 'string')
    && evidence && Number.isSafeInteger(evidence.forecastId)
    && Number.isSafeInteger(evidence.evaluationRunId) && Number.isSafeInteger(evidence.reviewItemId)
    && (evidence.analysisSnapshotId === null || Number.isSafeInteger(evidence.analysisSnapshotId))
    && email && typeof email.state === 'string' && typeof email.label === 'string'
    && (email.tone === 'neutral' || email.tone === 'positive' || email.tone === 'negative'));
}

export function parseClientNotificationList(value: unknown): ClientNotificationList | null {
  const row = record(value);
  if (!row || !Array.isArray(row.items) || !row.items.every(isClientNotification)
    || (row.nextCursor !== null && typeof row.nextCursor !== 'string')
    || !Number.isSafeInteger(row.unreadCount) || (row.unreadCount as number) < 0
    || typeof row.markAllReadToken !== 'string') return null;
  return row as ClientNotificationList;
}

export function notificationBadge(count: number) {
  return count > 99 ? '99+' : String(Math.max(0, count));
}

export function notificationCountLabel(count: number | null, loading = false) {
  if (loading) return 'Notifications, unread count loading';
  if (count === null) return 'Notifications, unread count unavailable';
  return count === 0 ? 'Notifications, no unread items' : `Notifications, ${count} unread items`;
}

export function notificationTimestamp(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf())
    ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(parsed)
    : 'Time unavailable';
}
