import type { NotificationCategory } from '../notifications/types.ts';

export const IN_APP_STATES = ['unread', 'read'] as const;
export type InAppState = typeof IN_APP_STATES[number];

export const IN_APP_EMAIL_STATES = [
  'not_configured', 'queued', 'in_progress', 'provider_accepted', 'delivered',
  'delayed', 'ambiguous', 'failed', 'bounced', 'complained', 'suppressed',
] as const;
export type InAppEmailState = typeof IN_APP_EMAIL_STATES[number];

export type InAppPresentationSnapshot = {
  version: string;
  title: string;
  summary: string;
  details: readonly string[];
  evidence: {
    forecastId: number;
    evaluationRunId: number;
    reviewItemId: number;
    analysisSnapshotId: number | null;
  };
};

export type InAppEmailStatus = {
  state: InAppEmailState;
  label: string;
  tone: 'neutral' | 'positive' | 'negative';
};

export type InAppEntry = {
  id: string;
  category: NotificationCategory;
  symbol: string;
  state: InAppState;
  occurredAt: string;
  firstReadAt: string | null;
  presentation: InAppPresentationSnapshot;
  deepLink: string;
  email: InAppEmailStatus;
};

export type InAppListResult = {
  items: InAppEntry[];
  nextCursor: string | null;
  unreadCount: number;
  markAllReadToken: string;
};
