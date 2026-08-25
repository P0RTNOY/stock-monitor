import {
  normalizeNotificationPreferenceSnapshot,
  type NotificationPreferenceSnapshot,
} from './preference.ts';
import type {
  NotificationPreferenceAuditRecord,
  NotificationRepository,
} from './repository.ts';

export const NOTIFICATION_PREFERENCE_CHANGE_SOURCES = ['operator', 'internal'] as const;
export type NotificationPreferenceChangeSource =
  typeof NOTIFICATION_PREFERENCE_CHANGE_SOURCES[number];

export class NotificationPreferenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationPreferenceConflictError';
  }
}

function auditReason(value: unknown) {
  if (typeof value !== 'string' || value.length > 200 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new NotificationPreferenceConflictError('Notification preference audit reason is invalid.');
  }
  return value;
}

export class NotificationPreferenceService {
  private readonly repository: NotificationRepository;

  constructor(repository: NotificationRepository) {
    this.repository = repository;
  }

  async current(profileId: number): Promise<NotificationPreferenceSnapshot | null> {
    return this.repository.getCurrentPreference(profileId);
  }

  async history(profileId: number, limit = 20): Promise<NotificationPreferenceAuditRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new NotificationPreferenceConflictError('Notification preference history limit is invalid.');
    }
    return this.repository.listPreferenceHistory(profileId, limit);
  }

  async update(input: {
    trustedProfileId: number;
    expectedRevision: number;
    snapshot: unknown;
    changeSource: NotificationPreferenceChangeSource;
    changeReason: string;
  }): Promise<NotificationPreferenceSnapshot> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new NotificationPreferenceConflictError('Expected notification preference revision is invalid.');
    }
    if (!NOTIFICATION_PREFERENCE_CHANGE_SOURCES.includes(input.changeSource)) {
      throw new NotificationPreferenceConflictError('Notification preference change source is invalid.');
    }
    const snapshot = normalizeNotificationPreferenceSnapshot(input.snapshot);
    if (snapshot.profileId !== input.trustedProfileId
      || snapshot.revision !== input.expectedRevision + 1) {
      throw new NotificationPreferenceConflictError('Notification preference revision or profile conflicts.');
    }
    const changed = await this.repository.appendPreference(
      snapshot,
      input.expectedRevision,
      input.changeSource,
      auditReason(input.changeReason),
    );
    if (!changed) {
      throw new NotificationPreferenceConflictError('Notification preference changed concurrently.');
    }
    return snapshot;
  }
}
