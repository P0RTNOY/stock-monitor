import { Temporal } from '@js-temporal/polyfill';
import {
  NOTIFICATION_PREFERENCE_SCHEMA_VERSION,
  type NotificationPreferenceSnapshot,
} from '../notifications/preference.ts';
import {
  NOTIFICATION_RETRY_POLICY_VERSION,
} from '../notifications/contract.ts';
import {
  calculateNotificationRetry,
  type NotificationDeliveryFailure,
} from '../notifications/retry.ts';
import type { NotificationCategory } from '../notifications/types.ts';
import type {
  BeginEmailProviderAttemptResult,
  CompleteEmailProviderResult,
  EmailDispatchCandidate,
  EmailDispatchClaim,
  EmailDispatchContext,
  EmailDispatchDelivery,
  EmailDispatchPosition,
  EmailDispatcherRepository,
} from './dispatcher.ts';
import type {
  EmailRecipientRepository,
  EmailRecipientState,
  EnableEmailConsentRepositoryInput,
  ReplaceRecipientRepositoryInput,
  RevokeRecipientRepositoryInput,
  StoredEmailCapability,
} from './recipient-service.ts';
import type { EmailPreSendPolicyResult } from './presend-policy.ts';
import type { ResendProviderIdentity, ResendSendResult } from './resend.ts';
import { D1EmailWebhookRepository } from './webhook-repository.ts';
import type {
  BeginVerificationProviderAttemptResult,
  VerificationDeliveryContext,
  VerificationEmailDeliveryRepository,
  VerificationProviderCompletion,
} from './verification-delivery.ts';
import {
  FORECAST_EMAIL_CAPABILITY_VERSION,
  FORECAST_EMAIL_CONSENT_VERSION,
  type EmailConsentSnapshot,
  type EmailDeliveryState,
  type EmailRecipient,
  type EmailReconciliationState,
} from './types.ts';

const RESEND_SAFE_RETRY_HOURS = 24;

function changed(result: D1Result<unknown> | undefined) {
  return Number(result?.meta?.changes ?? 0);
}

function enabledCategoryColumn(alias: string, category: NotificationCategory) {
  const column = category === 'target_hit' ? 'target_hit_enabled'
    : category === 'invalidated' ? 'invalidated_enabled'
      : category === 'expired' ? 'expired_enabled' : 'needs_review_enabled';
  return `${alias}.${column}`;
}

type RecipientRow = {
  id: string; profileId: number; revision: number; canonicalEmail: string; maskedEmail: string;
  lifecycle: EmailRecipient['lifecycle']; verificationRequestedAt: string | null;
  verifiedAt: string | null; revokedAt: string | null;
  suppressionState: EmailRecipient['suppressionState'];
  suppressionReason: EmailRecipient['suppressionReason']; suppressedAt: string | null;
  createdAt: string; updatedAt: string;
};

type ConsentRow = {
  profileId: number; revision: number; recipientId: string; masterConsent: number;
  targetHitEnabled: number; invalidatedEnabled: number; expiredEnabled: number;
  needsReviewEnabled: number; source: EmailConsentSnapshot['source'];
  consentedAt: string | null; revokedAt: string | null; createdAt: string;
};

type PreferenceRow = {
  profileId: number; revision: number; preferenceVersion: string; masterConsent: number;
  targetHitEnabled: number; invalidatedEnabled: number; expiredEnabled: number;
  needsReviewEnabled: number; timeZone: string; quietHoursStart: string | null;
  quietHoursEnd: string | null; createdAt: string; updatedAt: string;
};

type CapabilityRow = {
  id: string; profileId: number; recipientId: string;
  purpose: StoredEmailCapability['purpose']; tokenHash: string; tokenVersion: string;
  state: StoredEmailCapability['state']; expiresAt: string | null; consentRevision: number | null;
  attemptCount: number; lastAttemptAt: string | null; consumedAt: string | null;
  revokedAt: string | null; createdAt: string;
};

type DeliveryRow = EmailDispatchDelivery & { profileId: number };

const RECIPIENT_SELECT = `SELECT id, profile_id AS profileId,
  recipient_revision AS revision, canonical_email AS canonicalEmail,
  masked_email AS maskedEmail, state AS lifecycle,
  verification_requested_at AS verificationRequestedAt, verified_at AS verifiedAt,
  revoked_at AS revokedAt, suppression_state AS suppressionState,
  suppression_reason AS suppressionReason, suppressed_at AS suppressedAt,
  created_at AS createdAt, updated_at AS updatedAt
  FROM forecast_email_recipients`;

const CONSENT_SELECT = `SELECT r.profile_id AS profileId, r.revision,
  r.recipient_id AS recipientId, r.master_consent AS masterConsent,
  r.target_hit_enabled AS targetHitEnabled,
  r.invalidated_enabled AS invalidatedEnabled, r.expired_enabled AS expiredEnabled,
  r.needs_review_enabled AS needsReviewEnabled, r.consent_source AS source,
  r.consented_at AS consentedAt, r.revoked_at AS revokedAt, r.created_at AS createdAt
  FROM forecast_email_consents c
  JOIN forecast_email_consent_revisions r
    ON r.profile_id = c.profile_id AND r.revision = c.current_revision
      AND r.recipient_id = c.recipient_id`;

const PREFERENCE_SELECT = `SELECT r.profile_id AS profileId, r.revision,
  r.preference_version AS preferenceVersion, r.master_consent AS masterConsent,
  r.target_hit_enabled AS targetHitEnabled,
  r.invalidated_enabled AS invalidatedEnabled, r.expired_enabled AS expiredEnabled,
  r.needs_review_enabled AS needsReviewEnabled, r.timezone AS timeZone,
  r.quiet_hours_start AS quietHoursStart, r.quiet_hours_end AS quietHoursEnd,
  r.created_at AS createdAt, p.updated_at AS updatedAt
  FROM forecast_notification_preferences p
  JOIN forecast_notification_preference_revisions r
    ON r.profile_id = p.profile_id AND r.revision = p.current_revision`;

const CAPABILITY_SELECT = `SELECT id, profile_id AS profileId, recipient_id AS recipientId,
  purpose, token_hash AS tokenHash, token_version AS tokenVersion, state,
  expires_at AS expiresAt, consent_revision AS consentRevision,
  attempt_count AS attemptCount, last_attempt_at AS lastAttemptAt,
  consumed_at AS consumedAt, revoked_at AS revokedAt, created_at AS createdAt
  FROM forecast_email_capabilities`;

const DELIVERY_SELECT = `SELECT id, profile_id AS profileId, recipient_id AS recipientId,
  template_version AS templateVersion, content_hash AS contentHash,
  idempotency_key AS idempotencyKey, canonical_request_hash AS canonicalRequestHash,
  state, request_started_at AS requestStartedAt, safe_retry_until AS safeRetryUntil,
  provider_email_id AS providerEmailId FROM forecast_email_deliveries`;

function consent(row: ConsentRow | null): EmailConsentSnapshot | null {
  if (!row) return null;
  return {
    profileId: row.profileId,
    revision: row.revision,
    recipientId: row.recipientId,
    schemaVersion: FORECAST_EMAIL_CONSENT_VERSION,
    masterConsent: row.masterConsent === 1,
    categories: {
      target_hit: row.targetHitEnabled === 1,
      invalidated: row.invalidatedEnabled === 1,
      expired: row.expiredEnabled === 1,
      needs_review: row.needsReviewEnabled === 1,
    },
    source: row.source,
    consentedAt: row.consentedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

function preference(row: PreferenceRow | null): NotificationPreferenceSnapshot | null {
  if (!row) return null;
  return {
    profileId: row.profileId,
    schemaVersion: NOTIFICATION_PREFERENCE_SCHEMA_VERSION,
    revision: row.revision,
    masterConsent: row.masterConsent === 1,
    categories: {
      target_hit: row.targetHitEnabled === 1,
      invalidated: row.invalidatedEnabled === 1,
      expired: row.expiredEnabled === 1,
      needs_review: row.needsReviewEnabled === 1,
    },
    timeZone: row.timeZone,
    quietHours: row.quietHoursStart && row.quietHoursEnd
      ? { start: row.quietHoursStart, end: row.quietHoursEnd } : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function capability(row: CapabilityRow | null): StoredEmailCapability | null {
  if (!row || row.tokenVersion !== FORECAST_EMAIL_CAPABILITY_VERSION) return null;
  return {
    id: row.id,
    profileId: row.profileId,
    recipientId: row.recipientId,
    purpose: row.purpose,
    tokenHash: row.tokenHash,
    tokenVersion: FORECAST_EMAIL_CAPABILITY_VERSION,
    state: row.state,
    consentRevision: row.consentRevision,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    revokedAt: row.revokedAt,
    attemptCount: row.attemptCount,
    lastAttemptAt: row.lastAttemptAt,
    createdAt: row.createdAt,
  };
}

function consentBindings(value: EmailConsentSnapshot) {
  return [
    value.profileId, value.revision, value.recipientId, value.masterConsent ? 1 : 0,
    value.categories.target_hit ? 1 : 0, value.categories.invalidated ? 1 : 0,
    value.categories.expired ? 1 : 0, value.categories.needs_review ? 1 : 0,
    value.source, value.consentedAt, value.revokedAt, value.createdAt,
  ] as const;
}

function capabilityBindings(value: StoredEmailCapability) {
  return [
    value.id, value.profileId, value.recipientId, value.purpose, value.tokenHash,
    value.tokenVersion, value.state, value.expiresAt, value.consentRevision,
    value.attemptCount, value.lastAttemptAt, value.consumedAt, value.revokedAt,
    value.createdAt,
  ] as const;
}

function delivery(row: DeliveryRow | null): EmailDispatchDelivery | null {
  if (!row) return null;
  return {
    id: row.id,
    recipientId: row.recipientId,
    templateVersion: row.templateVersion,
    contentHash: row.contentHash,
    idempotencyKey: row.idempotencyKey,
    canonicalRequestHash: row.canonicalRequestHash,
    state: row.state,
    requestStartedAt: row.requestStartedAt,
    safeRetryUntil: row.safeRetryUntil,
    providerEmailId: row.providerEmailId,
  };
}

function providerFailure(result: Exclude<ResendSendResult, { disposition: 'accepted' }>): {
  notificationFailure: NotificationDeliveryFailure;
  providerClass: 'retryable' | 'terminal' | 'ambiguous';
} {
  if (result.disposition === 'terminal') {
    return { notificationFailure: 'provider_rejected', providerClass: 'terminal' };
  }
  if (result.disposition === 'ambiguous') {
    return { notificationFailure: 'provider_unavailable', providerClass: 'ambiguous' };
  }
  return {
    notificationFailure: result.classification === 'provider_rate_limited'
      ? 'rate_limited' : 'temporary_provider_error',
    providerClass: 'retryable',
  };
}

export type EmailDeliveryStatusFilter = {
  limit: number;
  state?: EmailDeliveryState;
  templateKind?: NotificationCategory;
};

/** Deliberately excludes canonical recipient addresses and provider payloads. */
export type SafeEmailDeliveryStatus = {
  deliveryId: string;
  recipientId: string;
  maskedEmail: string;
  sourceKind: 'forecast_notification' | 'recipient_verification';
  outboxId: string | null;
  templateKind: string;
  templateVersion: string;
  state: EmailDeliveryState;
  providerAcceptedAt: string | null;
  reconciliationState: EmailReconciliationState;
  reconciliationEventAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SafeEmailDeliveryCount = {
  state: EmailDeliveryState;
  reconciliationState: EmailReconciliationState;
  count: number;
};

/** Stateful D1 persistence for recipient management and forecast email dispatch. */
export class D1EmailRepository implements EmailRecipientRepository, EmailDispatcherRepository {
  private readonly d1: D1Database;

  constructor(d1: D1Database) {
    this.d1 = d1;
  }

  async hasSchema() {
    const required = [
      'forecast_email_recipients', 'forecast_email_consent_revisions',
      'forecast_email_consents', 'forecast_email_capabilities',
      'forecast_email_pre_send_decisions', 'forecast_email_deliveries',
      'forecast_email_provider_attempts', 'forecast_email_provider_events',
      'forecast_email_suppression_events',
    ];
    const row = await this.d1.prepare(`SELECT count(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name IN (${required.map(() => '?').join(', ')})`)
      .bind(...required).first<{ count: number }>();
    return Number(row?.count ?? 0) === required.length;
  }

  async readRecipientState(profileId: number): Promise<EmailRecipientState> {
    const [recipientRow, consentRow, preferenceRow, revisionRow] = await Promise.all([
      this.d1.prepare(`${RECIPIENT_SELECT} WHERE profile_id = ?
        AND state IN ('pending', 'verified') LIMIT 1`).bind(profileId).first<RecipientRow>(),
      this.d1.prepare(`${CONSENT_SELECT} WHERE c.profile_id = ?`).bind(profileId).first<ConsentRow>(),
      this.d1.prepare(`${PREFERENCE_SELECT} WHERE p.profile_id = ?`).bind(profileId).first<PreferenceRow>(),
      this.d1.prepare(`SELECT COALESCE(MAX(recipient_revision), 0) AS revision
        FROM forecast_email_recipients WHERE profile_id = ?`)
        .bind(profileId).first<{ revision: number }>(),
    ]);
    return {
      currentRecipient: recipientRow ?? null,
      currentConsent: consent(consentRow),
      notificationPreference: preference(preferenceRow),
      latestRecipientRevision: Number(revisionRow?.revision ?? 0),
    };
  }

  private consentInsert(value: EmailConsentSnapshot, predicate: string, ...predicateBindings: unknown[]) {
    return this.d1.prepare(`INSERT INTO forecast_email_consent_revisions
      (profile_id, revision, recipient_id, master_consent, target_hit_enabled,
       invalidated_enabled, expired_enabled, needs_review_enabled, consent_source,
       consented_at, revoked_at, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${predicate}`)
      .bind(...consentBindings(value), ...predicateBindings);
  }

  private consentPointer(value: EmailConsentSnapshot, expectedRevision: number) {
    if (expectedRevision === 0) {
      return this.d1.prepare(`INSERT INTO forecast_email_consents
        (profile_id, current_revision, recipient_id, created_at, updated_at)
        SELECT ?, ?, ?, ?, ? WHERE changes() = 1
          AND NOT EXISTS (SELECT 1 FROM forecast_email_consents WHERE profile_id = ?)`)
        .bind(value.profileId, value.revision, value.recipientId, value.createdAt,
          value.createdAt, value.profileId);
    }
    return this.d1.prepare(`UPDATE forecast_email_consents
      SET current_revision = ?, recipient_id = ?, updated_at = ?
      WHERE profile_id = ? AND current_revision = ? AND changes() = 1`)
      .bind(value.revision, value.recipientId, value.createdAt, value.profileId, expectedRevision);
  }

  async replaceRecipient(input: ReplaceRecipientRepositoryInput): Promise<boolean> {
    const recipient = input.recipient;
    const statements: D1PreparedStatement[] = [];
    if (input.expectedRecipientId === null) {
      statements.push(this.d1.prepare(`INSERT INTO forecast_email_recipients
        (id, profile_id, recipient_revision, canonical_email, masked_email, state,
         verification_requested_at, verified_at, revoked_at, suppression_state,
         suppression_reason, suppressed_at, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, 'none', NULL, NULL, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM forecast_email_recipients
          WHERE profile_id = ? AND state IN ('pending', 'verified'))`)
        .bind(recipient.id, input.profileId, recipient.revision, recipient.canonicalEmail,
          recipient.maskedEmail, recipient.createdAt, recipient.updatedAt, input.profileId));
    } else {
      statements.push(
        this.d1.prepare(`UPDATE forecast_email_recipients
          SET state = 'replaced', revoked_at = ?, updated_at = ?
          WHERE id = ? AND profile_id = ? AND state IN ('pending', 'verified')`)
          .bind(recipient.createdAt, recipient.createdAt, input.expectedRecipientId, input.profileId),
        this.d1.prepare(`INSERT INTO forecast_email_recipients
          (id, profile_id, recipient_revision, canonical_email, masked_email, state,
           verification_requested_at, verified_at, revoked_at, suppression_state,
           suppression_reason, suppressed_at, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, 'none', NULL, NULL, ?, ?
          WHERE changes() = 1`)
          .bind(recipient.id, input.profileId, recipient.revision, recipient.canonicalEmail,
            recipient.maskedEmail, recipient.createdAt, recipient.updatedAt),
      );
    }
    statements.push(
      this.consentInsert(input.disabledConsent,
        `changes() = 1 AND EXISTS (SELECT 1 FROM forecast_email_recipients
          WHERE id = ? AND profile_id = ? AND state = 'pending')`, recipient.id, input.profileId),
      this.consentPointer(input.disabledConsent, input.expectedConsentRevision),
      this.d1.prepare(`UPDATE forecast_email_capabilities SET state = 'revoked', revoked_at = ?
        WHERE profile_id = ? AND recipient_id <> ? AND state = 'active' AND changes() = 1`)
        .bind(recipient.createdAt, input.profileId, recipient.id),
    );
    const results = await this.d1.batch(statements);
    const pointerIndex = statements.length - 2;
    return changed(results[0]) === 1 && changed(results[pointerIndex]) === 1;
  }

  async revokeRecipient(input: RevokeRecipientRepositoryInput): Promise<boolean> {
    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE forecast_email_recipients
        SET state = 'revoked', revoked_at = ?, updated_at = ?
        WHERE id = ? AND profile_id = ? AND state IN ('pending', 'verified')`)
        .bind(input.revokedAt, input.revokedAt, input.expectedRecipientId, input.profileId),
      this.consentInsert(input.disabledConsent, 'changes() = 1'),
      this.consentPointer(input.disabledConsent, input.expectedConsentRevision),
      this.d1.prepare(`UPDATE forecast_email_capabilities SET state = 'revoked', revoked_at = ?
        WHERE profile_id = ? AND recipient_id = ? AND state = 'active' AND changes() = 1`)
        .bind(input.revokedAt, input.profileId, input.expectedRecipientId),
    ]);
    return changed(results[0]) === 1 && changed(results[2]) === 1;
  }

  async storeVerificationCapability(input: {
    profileId: number; expectedRecipientId: string; requestedAt: string;
    capability: StoredEmailCapability;
  }): Promise<boolean> {
    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE forecast_email_capabilities
        SET state = 'revoked', revoked_at = ? WHERE profile_id = ? AND recipient_id = ?
          AND purpose = 'verification' AND state = 'active'
          AND EXISTS (SELECT 1 FROM forecast_email_recipients WHERE id = ?
            AND profile_id = ? AND state = 'pending')`)
        .bind(input.requestedAt, input.profileId, input.expectedRecipientId,
          input.expectedRecipientId, input.profileId),
      this.d1.prepare(`INSERT INTO forecast_email_capabilities
        (id, profile_id, recipient_id, purpose, token_hash, token_version, state,
         expires_at, consent_revision, attempt_count, last_attempt_at, consumed_at,
         revoked_at, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM forecast_email_recipients WHERE id = ?
          AND profile_id = ? AND state = 'pending')`)
        .bind(...capabilityBindings(input.capability), input.expectedRecipientId, input.profileId),
      this.d1.prepare(`UPDATE forecast_email_recipients
        SET verification_requested_at = ?, updated_at = ?
        WHERE id = ? AND profile_id = ? AND state = 'pending' AND changes() = 1`)
        .bind(input.requestedAt, input.requestedAt, input.expectedRecipientId, input.profileId),
    ]);
    return changed(results[1]) === 1 && changed(results[2]) === 1;
  }

  async loadCapabilityForAttemptByLocator(input: {
    capabilityId: string; purpose: 'verification' | 'unsubscribe';
    attemptedAt: string; maximumAttempts: number;
  }): Promise<StoredEmailCapability | null> {
    await this.d1.prepare(`UPDATE forecast_email_capabilities
      SET state = 'expired'
      WHERE id = ? AND purpose = ? AND state = 'active'
        AND expires_at IS NOT NULL AND expires_at <= ?`)
      .bind(input.capabilityId, input.purpose, input.attemptedAt).run();
    const updated = await this.d1.prepare(`UPDATE forecast_email_capabilities
      SET attempt_count = attempt_count + 1, last_attempt_at = ?
      WHERE id = ? AND purpose = ? AND state = 'active'
        AND attempt_count < ? AND (expires_at IS NULL OR expires_at > ?)`)
      .bind(input.attemptedAt, input.capabilityId, input.purpose,
        input.maximumAttempts, input.attemptedAt).run();
    if (changed(updated) !== 1) return null;
    return capability(await this.d1.prepare(`${CAPABILITY_SELECT}
      WHERE id = ? AND purpose = ? AND state = 'active'`)
      .bind(input.capabilityId, input.purpose).first<CapabilityRow>());
  }

  async consumeVerification(input: {
    profileId: number; recipientId: string; capabilityId: string;
    tokenHash: string; confirmedAt: string;
  }): Promise<boolean> {
    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE forecast_email_capabilities
        SET state = 'consumed', consumed_at = ?
        WHERE id = ? AND profile_id = ? AND recipient_id = ?
          AND purpose = 'verification' AND token_hash = ? AND state = 'active'
          AND expires_at > ? AND EXISTS (SELECT 1 FROM forecast_email_recipients
            WHERE id = ? AND profile_id = ? AND state = 'pending')`)
        .bind(input.confirmedAt, input.capabilityId, input.profileId, input.recipientId,
          input.tokenHash, input.confirmedAt, input.recipientId, input.profileId),
      this.d1.prepare(`UPDATE forecast_email_recipients
        SET state = 'verified', verified_at = ?, updated_at = ?
        WHERE id = ? AND profile_id = ? AND state = 'pending' AND changes() = 1`)
        .bind(input.confirmedAt, input.confirmedAt, input.recipientId, input.profileId),
    ]);
    return changed(results[0]) === 1 && changed(results[1]) === 1;
  }

  async enableEmailConsent(input: EnableEmailConsentRepositoryInput): Promise<boolean> {
    const p = input.notificationPreference;
    const preferencePointer = input.expectedNotificationPreferenceRevision === 0
      ? this.d1.prepare(`INSERT INTO forecast_notification_preferences
          (profile_id, current_revision, created_at, updated_at)
          SELECT ?, ?, ?, ? WHERE changes() = 1
            AND NOT EXISTS (SELECT 1 FROM forecast_notification_preferences
              WHERE profile_id = ?)`)
        .bind(p.profileId, p.revision, p.createdAt, p.updatedAt, p.profileId)
      : this.d1.prepare(`UPDATE forecast_notification_preferences
          SET current_revision = ?, updated_at = ?
          WHERE profile_id = ? AND current_revision = ? AND changes() = 1`)
        .bind(p.revision, p.updatedAt, p.profileId,
          input.expectedNotificationPreferenceRevision);
    const results = await this.d1.batch([
      this.d1.prepare(`INSERT INTO forecast_notification_preference_revisions
        (profile_id, revision, preference_version, master_consent, target_hit_enabled,
         invalidated_enabled, expired_enabled, needs_review_enabled, timezone,
         quiet_hours_start, quiet_hours_end, change_source, change_reason, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'email_channel', 'email_consent_enabled', ?
        WHERE EXISTS (SELECT 1 FROM forecast_email_recipients WHERE id = ?
          AND profile_id = ? AND state = 'verified' AND suppression_state = 'none')
          AND ((? = 0 AND NOT EXISTS (SELECT 1 FROM forecast_notification_preferences
            WHERE profile_id = ?)) OR EXISTS (SELECT 1 FROM forecast_notification_preferences
            WHERE profile_id = ? AND current_revision = ?))`)
        .bind(p.profileId, p.revision, p.schemaVersion, p.masterConsent ? 1 : 0,
          p.categories.target_hit ? 1 : 0, p.categories.invalidated ? 1 : 0,
          p.categories.expired ? 1 : 0, p.categories.needs_review ? 1 : 0,
          p.timeZone, p.quietHours?.start ?? null, p.quietHours?.end ?? null,
          p.createdAt, input.expectedRecipientId, input.profileId,
          input.expectedNotificationPreferenceRevision, input.profileId,
          input.profileId, input.expectedNotificationPreferenceRevision),
      preferencePointer,
      this.consentInsert(input.emailConsent, `changes() = 1 AND
        ((? = 0 AND NOT EXISTS (SELECT 1 FROM forecast_email_consents WHERE profile_id = ?))
          OR EXISTS (SELECT 1 FROM forecast_email_consents
            WHERE profile_id = ? AND current_revision = ? AND recipient_id = ?))`,
        input.expectedEmailConsentRevision, input.profileId, input.profileId,
        input.expectedEmailConsentRevision, input.expectedRecipientId),
      this.consentPointer(input.emailConsent, input.expectedEmailConsentRevision),
      this.d1.prepare(`UPDATE forecast_email_capabilities SET state = 'revoked', revoked_at = ?
        WHERE profile_id = ? AND recipient_id = ? AND purpose = 'unsubscribe'
          AND state = 'active' AND changes() = 1`)
        .bind(p.updatedAt, input.profileId, input.expectedRecipientId),
      this.d1.prepare(`INSERT INTO forecast_email_capabilities
        (id, profile_id, recipient_id, purpose, token_hash, token_version, state,
         expires_at, consent_revision, attempt_count, last_attempt_at, consumed_at,
         revoked_at, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() >= 0
          AND EXISTS (SELECT 1 FROM forecast_email_consents
            WHERE profile_id = ? AND current_revision = ? AND recipient_id = ?)`)
        .bind(...capabilityBindings(input.unsubscribeCapability), input.profileId,
          input.emailConsent.revision, input.expectedRecipientId),
    ]);
    return changed(results[0]) === 1 && changed(results[1]) === 1
      && changed(results[2]) === 1 && changed(results[3]) === 1 && changed(results[5]) === 1;
  }

  async disableEmailConsent(input: {
    profileId: number; expectedRecipientId: string; expectedConsentRevision: number;
    consent: EmailConsentSnapshot;
  }): Promise<boolean> {
    const results = await this.d1.batch([
      this.consentInsert(input.consent, `EXISTS (SELECT 1 FROM forecast_email_consents
        WHERE profile_id = ? AND current_revision = ? AND recipient_id = ?)`,
      input.profileId, input.expectedConsentRevision, input.expectedRecipientId),
      this.consentPointer(input.consent, input.expectedConsentRevision),
      this.d1.prepare(`UPDATE forecast_email_capabilities SET state = 'revoked', revoked_at = ?
        WHERE profile_id = ? AND recipient_id = ? AND purpose = 'unsubscribe'
          AND state = 'active' AND changes() = 1`)
        .bind(input.consent.createdAt, input.profileId, input.expectedRecipientId),
    ]);
    return changed(results[0]) === 1 && changed(results[1]) === 1;
  }

  async consumeUnsubscribe(input: {
    profileId: number; expectedRecipientId: string; capabilityId: string;
    tokenHash: string; expectedConsentRevision: number; consent: EmailConsentSnapshot;
  }): Promise<boolean> {
    const results = await this.d1.batch([
      this.consentInsert(input.consent, `EXISTS (SELECT 1 FROM forecast_email_capabilities
        WHERE id = ? AND profile_id = ? AND recipient_id = ? AND purpose = 'unsubscribe'
          AND token_hash = ? AND consent_revision = ? AND state = 'active')
        AND EXISTS (SELECT 1 FROM forecast_email_consents
          WHERE profile_id = ? AND recipient_id = ? AND current_revision = ?)`,
      input.capabilityId, input.profileId, input.expectedRecipientId, input.tokenHash,
      input.expectedConsentRevision, input.profileId, input.expectedRecipientId,
      input.expectedConsentRevision),
      this.consentPointer(input.consent, input.expectedConsentRevision),
      this.d1.prepare(`UPDATE forecast_email_capabilities
        SET state = 'consumed', consumed_at = ? WHERE id = ? AND profile_id = ?
          AND recipient_id = ? AND purpose = 'unsubscribe' AND token_hash = ?
          AND consent_revision = ? AND state = 'active' AND changes() = 1`)
        .bind(input.consent.createdAt, input.capabilityId, input.profileId,
          input.expectedRecipientId, input.tokenHash, input.expectedConsentRevision),
    ]);
    return changed(results[0]) === 1 && changed(results[1]) === 1 && changed(results[2]) === 1;
  }

  async selectCandidates(input: {
    profileId: number; cutoff: string; after: EmailDispatchPosition | null; limit: number;
  }): Promise<EmailDispatchCandidate[]> {
    const after = input.after;
    const rows = await this.d1.prepare(`SELECT id AS outboxId,
      COALESCE(available_at, created_at) AS eligibleAt
      FROM forecast_notification_outbox
      WHERE profile_id = ? AND state IN ('pending', 'deferred', 'retry_scheduled')
        AND available_at <= ?
        AND (? IS NULL OR available_at > ? OR (available_at = ? AND id > ?))
      ORDER BY available_at ASC, id ASC LIMIT ?`)
      .bind(input.profileId, input.cutoff, after?.eligibleAt ?? null,
        after?.eligibleAt ?? null, after?.eligibleAt ?? null, after?.outboxId ?? null,
        input.limit).all<EmailDispatchCandidate>();
    return rows.results;
  }

  private async context(input: {
    profileId: number; outboxId: string; checkedAt: string;
    notificationAttemptId?: string; ownerToken?: string;
  }): Promise<EmailDispatchContext | null> {
    const exact = input.notificationAttemptId !== undefined && input.ownerToken !== undefined;
    const outbox = await this.d1.prepare(`SELECT i.category, i.payload_json AS payloadJson,
      o.available_at AS availableAt, o.created_at AS outboxCreatedAt,
      ${exact ? `CASE WHEN o.state = 'claimed' AND o.lease_token = ? AND o.lease_expires_at > ?
        AND EXISTS (SELECT 1 FROM forecast_notification_delivery_attempts a
          WHERE a.id = ? AND a.outbox_id = o.id AND a.profile_id = o.profile_id
            AND a.owner_token = ? AND a.state = 'started') THEN 1 ELSE 0 END` : '1'} AS claimValid
      FROM forecast_notification_outbox o JOIN forecast_notification_intents i
        ON i.id = o.intent_id AND i.profile_id = o.profile_id
      WHERE o.id = ? AND o.profile_id = ?`)
      .bind(...(exact ? [input.ownerToken, input.checkedAt, input.notificationAttemptId,
        input.ownerToken, input.outboxId, input.profileId] : [input.outboxId, input.profileId]))
      .first<{ category: NotificationCategory; payloadJson: string; availableAt: string;
        outboxCreatedAt: string; claimValid: number }>();
    if (!outbox) return null;
    const [recipientRow, consentRow, preferenceRow, capabilityRow, deliveryRow] = await Promise.all([
      this.d1.prepare(`${RECIPIENT_SELECT} WHERE profile_id = ?
        AND state IN ('pending', 'verified') LIMIT 1`).bind(input.profileId).first<RecipientRow>(),
      this.d1.prepare(`${CONSENT_SELECT} WHERE c.profile_id = ?`).bind(input.profileId).first<ConsentRow>(),
      this.d1.prepare(`${PREFERENCE_SELECT} WHERE p.profile_id = ?`).bind(input.profileId).first<PreferenceRow>(),
      this.d1.prepare(`${CAPABILITY_SELECT} WHERE profile_id = ? AND purpose = 'unsubscribe'
        AND state = 'active' AND EXISTS (SELECT 1 FROM forecast_email_consents c
          WHERE c.profile_id = forecast_email_capabilities.profile_id
            AND c.recipient_id = forecast_email_capabilities.recipient_id
            AND c.current_revision = forecast_email_capabilities.consent_revision)
        ORDER BY created_at DESC LIMIT 1`)
        .bind(input.profileId).first<CapabilityRow>(),
      this.d1.prepare(`${DELIVERY_SELECT} WHERE outbox_id = ? AND profile_id = ?`)
        .bind(input.outboxId, input.profileId).first<DeliveryRow>(),
    ]);
    let payload: unknown;
    try { payload = JSON.parse(outbox.payloadJson); } catch { payload = null; }
    return {
      category: outbox.category,
      payload,
      availableAt: outbox.availableAt,
      outboxCreatedAt: outbox.outboxCreatedAt,
      claimValid: outbox.claimValid === 1,
      supportedTemplate: true,
      currentRecipient: recipientRow ?? null,
      notificationPreference: preference(preferenceRow),
      emailConsent: consent(consentRow),
      unsubscribeCapability: capability(capabilityRow),
      existingDelivery: delivery(deliveryRow),
    };
  }

  previewContext(input: { profileId: number; outboxId: string; checkedAt: string }) {
    return this.context(input);
  }

  async claimCandidate(input: {
    profileId: number; outboxId: string; notificationAttemptId: string; ownerToken: string;
    claimedAt: string; leaseExpiresAt: string; adapterKind: string; adapterVersion: string;
  }): Promise<EmailDispatchClaim | null> {
    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE forecast_notification_delivery_attempts
        SET state = 'interrupted', finished_at = ?, failure_classification = 'interrupted',
          redacted_error_category = 'expired_claim', next_attempt_at = NULL
        WHERE outbox_id = ? AND profile_id = ? AND state = 'started'
          AND EXISTS (SELECT 1 FROM forecast_notification_outbox WHERE id = ?
            AND profile_id = ? AND state = 'claimed' AND lease_expires_at <= ?)`)
        .bind(input.claimedAt, input.outboxId, input.profileId, input.outboxId,
          input.profileId, input.claimedAt),
      this.d1.prepare(`UPDATE forecast_notification_outbox
        SET state = 'claimed', attempt_count = attempt_count + 1, lease_token = ?,
          lease_expires_at = ?, last_attempt_at = ?, updated_at = ?
        WHERE id = ? AND profile_id = ? AND available_at <= ?
          AND (state IN ('pending', 'deferred', 'retry_scheduled')
            OR (state = 'claimed' AND lease_expires_at <= ?))`)
        .bind(input.ownerToken, input.leaseExpiresAt, input.claimedAt, input.claimedAt,
          input.outboxId, input.profileId, input.claimedAt, input.claimedAt),
      this.d1.prepare(`INSERT INTO forecast_notification_delivery_attempts
        (id, outbox_id, profile_id, attempt_number, owner_token, state,
         retry_policy_version, adapter_kind, adapter_version, started_at, created_at)
        SELECT ?, id, profile_id, attempt_count, ?, 'started', retry_policy_version,
          ?, ?, ?, ? FROM forecast_notification_outbox
        WHERE id = ? AND profile_id = ? AND lease_token = ? AND changes() = 1`)
        .bind(input.notificationAttemptId, input.ownerToken, input.adapterKind,
          input.adapterVersion, input.claimedAt, input.claimedAt, input.outboxId,
          input.profileId, input.ownerToken),
    ]);
    if (changed(results[1]) !== 1 || changed(results[2]) !== 1) return null;
    const row = await this.d1.prepare(`SELECT o.id AS outboxId, o.intent_id AS intentId,
      a.id AS notificationAttemptId, a.attempt_number AS notificationAttemptNumber,
      i.category, i.payload_json AS payloadJson, o.available_at AS availableAt,
      o.created_at AS outboxCreatedAt, o.lease_expires_at AS leaseExpiresAt
      FROM forecast_notification_outbox o JOIN forecast_notification_intents i
        ON i.id = o.intent_id AND i.profile_id = o.profile_id
      JOIN forecast_notification_delivery_attempts a
        ON a.outbox_id = o.id AND a.profile_id = o.profile_id
      WHERE o.id = ? AND o.profile_id = ? AND o.lease_token = ?
        AND a.id = ? AND a.owner_token = ? AND a.state = 'started'`)
      .bind(input.outboxId, input.profileId, input.ownerToken,
        input.notificationAttemptId, input.ownerToken)
      .first<Omit<EmailDispatchClaim, 'payload'> & { payloadJson: string }>();
    if (!row) return null;
    let payload: unknown;
    try { payload = JSON.parse(row.payloadJson); } catch { payload = null; }
    return {
      outboxId: row.outboxId,
      intentId: row.intentId,
      notificationAttemptId: row.notificationAttemptId,
      notificationAttemptNumber: row.notificationAttemptNumber,
      category: row.category,
      payload,
      availableAt: row.availableAt,
      outboxCreatedAt: row.outboxCreatedAt,
      leaseExpiresAt: row.leaseExpiresAt,
    };
  }

  loadClaimContext(input: {
    profileId: number; outboxId: string; notificationAttemptId: string;
    ownerToken: string; checkedAt: string;
  }) { return this.context(input); }

  async renewClaim(input: {
    profileId: number; outboxId: string; ownerToken: string;
    renewedAt: string; leaseExpiresAt: string;
  }) {
    const result = await this.d1.prepare(`UPDATE forecast_notification_outbox
      SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND profile_id = ?
        AND state = 'claimed' AND lease_token = ? AND lease_expires_at > ?`)
      .bind(input.leaseExpiresAt, input.renewedAt, input.outboxId, input.profileId,
        input.ownerToken, input.renewedAt).run();
    return changed(result) === 1;
  }

  private preSendInsert(input: {
    profileId: number; outboxId: string; notificationAttemptId: string;
    preSendDecisionId: string; checkedAt: string; policy: EmailPreSendPolicyResult;
  }, ownerToken: string, authorization?: {
    templateKind: NotificationCategory;
    unsubscribeCapabilityId: string;
  }) {
    const stored = input.policy.decision === 'eligible' ? 'eligible'
      : input.policy.decision === 'deferred_quiet_hours' ? 'deferred_quiet_hours' : 'suppressed';
    if ((stored === 'eligible') !== Boolean(authorization)) {
      throw new Error('EligibleEmailAuthorizationBoundaryMissing');
    }
    const notificationCategory = authorization
      ? enabledCategoryColumn('npr', authorization.templateKind) : null;
    const emailCategory = authorization
      ? enabledCategoryColumn('ecr', authorization.templateKind) : null;
    const authorizationSql = authorization ? `
        AND EXISTS (SELECT 1 FROM forecast_email_recipients er
          WHERE er.id = ? AND er.profile_id = ? AND er.state = 'verified'
            AND er.verified_at IS NOT NULL AND er.revoked_at IS NULL
            AND er.suppression_state = 'none'
            AND er.verified_at <= (SELECT created_at FROM forecast_notification_outbox
              WHERE id = ? AND profile_id = ?))
        AND EXISTS (SELECT 1 FROM forecast_notification_preferences np
          JOIN forecast_notification_preference_revisions npr
            ON npr.profile_id = np.profile_id AND npr.revision = np.current_revision
          WHERE np.profile_id = ? AND np.current_revision = ?
            AND npr.preference_version = ? AND npr.master_consent = 1
            AND ${notificationCategory} = 1)
        AND EXISTS (SELECT 1 FROM forecast_email_consents ec
          JOIN forecast_email_consent_revisions ecr
            ON ecr.profile_id = ec.profile_id AND ecr.revision = ec.current_revision
              AND ecr.recipient_id = ec.recipient_id
          WHERE ec.profile_id = ? AND ec.current_revision = ? AND ec.recipient_id = ?
            AND ecr.master_consent = 1 AND ${emailCategory} = 1
            AND ecr.consented_at IS NOT NULL AND ecr.revoked_at IS NULL
            AND ecr.consented_at <= (SELECT created_at FROM forecast_notification_outbox
              WHERE id = ? AND profile_id = ?))
        AND EXISTS (SELECT 1 FROM forecast_email_capabilities cap
          WHERE cap.id = ? AND cap.profile_id = ? AND cap.recipient_id = ?
            AND cap.purpose = 'unsubscribe' AND cap.state = 'active'
            AND cap.token_version = ? AND cap.consent_revision = ?
            AND cap.consumed_at IS NULL AND cap.revoked_at IS NULL)
        AND EXISTS (SELECT 1 FROM forecast_notification_intents ni
          JOIN forecast_notification_outbox no ON no.intent_id = ni.id
            AND no.profile_id = ni.profile_id
          WHERE no.id = ? AND no.profile_id = ? AND ni.category = ?)` : '';
    return this.d1.prepare(`INSERT INTO forecast_email_pre_send_decisions
      (id, outbox_id, attempt_id, profile_id, recipient_id,
       notification_preference_revision, email_consent_revision, decision,
       reason_code, checked_at, next_available_at, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM forecast_notification_outbox WHERE id = ?
        AND profile_id = ? AND state = 'claimed' AND lease_token = ?
        AND lease_expires_at > ?)
        AND EXISTS (SELECT 1 FROM forecast_notification_delivery_attempts
          WHERE id = ? AND outbox_id = ? AND profile_id = ? AND owner_token = ?
            AND state = 'started')${authorizationSql}`)
      .bind(input.preSendDecisionId, input.outboxId, input.notificationAttemptId,
        input.profileId, input.policy.recipientId,
        input.policy.notificationPreferenceRevision, input.policy.emailConsentRevision,
        stored, input.policy.reason, input.checkedAt, input.policy.nextAvailableAt,
        input.checkedAt, input.outboxId, input.profileId, ownerToken, input.checkedAt,
        input.notificationAttemptId, input.outboxId, input.profileId, ownerToken,
        ...(authorization ? [
          input.policy.recipientId, input.profileId, input.outboxId, input.profileId,
          input.profileId, input.policy.notificationPreferenceRevision,
          NOTIFICATION_PREFERENCE_SCHEMA_VERSION,
          input.profileId, input.policy.emailConsentRevision, input.policy.recipientId,
          input.outboxId, input.profileId,
          authorization.unsubscribeCapabilityId, input.profileId, input.policy.recipientId,
          FORECAST_EMAIL_CAPABILITY_VERSION, input.policy.emailConsentRevision,
          input.outboxId, input.profileId, authorization.templateKind,
        ] : []));
  }

  async completePolicyOutcome(input: {
    profileId: number; outboxId: string; notificationAttemptId: string;
    ownerToken: string; preSendDecisionId: string; checkedAt: string;
    policy: EmailPreSendPolicyResult;
  }) {
    if (input.policy.decision === 'eligible') return false;
    const deferred = input.policy.decision === 'deferred_quiet_hours';
    const results = await this.d1.batch([
      this.preSendInsert(input, input.ownerToken),
      this.d1.prepare(`UPDATE forecast_notification_delivery_attempts
        SET state = ?, finished_at = ?, next_attempt_at = ?
        WHERE id = ? AND outbox_id = ? AND profile_id = ? AND owner_token = ?
          AND state = 'started' AND changes() = 1`)
        .bind(deferred ? 'policy_deferred' : 'policy_suppressed', input.checkedAt,
          input.policy.nextAvailableAt, input.notificationAttemptId, input.outboxId,
          input.profileId, input.ownerToken),
      this.d1.prepare(`UPDATE forecast_notification_outbox
        SET state = ?, available_at = ?, lease_token = NULL, lease_expires_at = NULL,
          suppressed_at = ?, suppression_reason = ?, updated_at = ?
        WHERE id = ? AND profile_id = ? AND state = 'claimed' AND lease_token = ?
          AND changes() = 1`)
        .bind(deferred ? 'deferred' : 'suppressed', input.policy.nextAvailableAt,
          deferred ? null : input.checkedAt, deferred ? null : input.policy.reason,
          input.checkedAt, input.outboxId, input.profileId, input.ownerToken),
    ]);
    return results.every((result) => changed(result) === 1);
  }

  async beginProviderAttempt(input: {
    profileId: number; claim: EmailDispatchClaim; ownerToken: string;
    preSendDecisionId: string; deliveryId: string; providerAttemptId: string;
    recipientId: string; unsubscribeCapabilityId: string;
    notificationPreferenceRevision: number;
    emailConsentRevision: number; templateKind: NotificationCategory;
    templateVersion: string; locale: string; contentHash: string;
    identity: ResendProviderIdentity; startedAt: string;
  }): Promise<BeginEmailProviderAttemptResult> {
    const existingRow = await this.d1.prepare(`${DELIVERY_SELECT}
      WHERE outbox_id = ? AND profile_id = ?`).bind(input.claim.outboxId, input.profileId)
      .first<DeliveryRow>();
    const existing = delivery(existingRow);
    if (existing) {
      if (existing.recipientId !== input.recipientId
        || existing.templateVersion !== input.templateVersion
        || existing.contentHash !== input.contentHash
        || existing.idempotencyKey !== input.identity.idempotencyKey
        || existing.canonicalRequestHash !== input.identity.canonicalRequestHash) {
        return { disposition: 'integrity_conflict', delivery: existing };
      }
      if (existing.state === 'provider_accepted') {
        return { disposition: 'already_accepted', delivery: existing };
      }
      if (!existing.safeRetryUntil || existing.safeRetryUntil <= input.startedAt) {
        return { disposition: 'safe_retry_window_expired', delivery: existing };
      }
    }
    const safeRetryUntil = existing?.safeRetryUntil
      ?? Temporal.Instant.from(input.startedAt).add({ hours: RESEND_SAFE_RETRY_HOURS })
        .toString({ smallestUnit: 'millisecond' });
    const policy: EmailPreSendPolicyResult = {
      decision: 'eligible', reason: 'eligible', recipientId: input.recipientId,
      notificationPreferenceRevision: input.notificationPreferenceRevision,
      emailConsentRevision: input.emailConsentRevision, nextAvailableAt: null,
    };
    const statements: D1PreparedStatement[] = [];
    if (!existing) {
      statements.push(
        this.preSendInsert({
          profileId: input.profileId, outboxId: input.claim.outboxId,
          notificationAttemptId: input.claim.notificationAttemptId,
          preSendDecisionId: input.preSendDecisionId, checkedAt: input.startedAt, policy,
        }, input.ownerToken, {
          templateKind: input.templateKind,
          unsubscribeCapabilityId: input.unsubscribeCapabilityId,
        }),
        this.d1.prepare(`INSERT INTO forecast_email_deliveries
          (id, profile_id, recipient_id, source_kind, outbox_id, pre_send_decision_id,
           verification_capability_id, template_kind, template_version, locale,
           content_hash, provider, idempotency_key, canonical_request_hash, state,
           request_started_at, last_request_at, safe_retry_until,
           reconciliation_state, created_at, updated_at)
          SELECT ?, ?, ?, 'forecast_notification', ?, ?, NULL, ?, ?, ?, ?, 'resend',
            ?, ?, 'request_started', ?, ?, ?, 'none', ?, ? WHERE changes() = 1`)
          .bind(input.deliveryId, input.profileId, input.recipientId, input.claim.outboxId,
            input.preSendDecisionId, input.templateKind, input.templateVersion, input.locale,
            input.contentHash, input.identity.idempotencyKey,
            input.identity.canonicalRequestHash, input.startedAt, input.startedAt,
            safeRetryUntil, input.startedAt, input.startedAt),
      );
    } else {
      statements.push(this.preSendInsert({
        profileId: input.profileId, outboxId: input.claim.outboxId,
        notificationAttemptId: input.claim.notificationAttemptId,
        preSendDecisionId: input.preSendDecisionId, checkedAt: input.startedAt, policy,
      }, input.ownerToken, {
        templateKind: input.templateKind,
        unsubscribeCapabilityId: input.unsubscribeCapabilityId,
      }));
      if (existing.state === 'request_started') {
        statements.push(this.d1.prepare(`UPDATE forecast_email_provider_attempts
          SET state = 'ambiguous', finished_at = ?, failure_classification = 'ambiguous',
            redacted_error_category = 'interrupted_before_local_finalize', next_attempt_at = NULL
          WHERE delivery_id = ? AND profile_id = ? AND state = 'started'
            AND notification_attempt_id <> ?`)
          .bind(input.startedAt, existing.id, input.profileId,
            input.claim.notificationAttemptId));
      }
      statements.push(this.d1.prepare(`UPDATE forecast_email_deliveries
        SET state = 'request_started', last_request_at = ?, updated_at = ?
        WHERE id = ? AND profile_id = ? AND outbox_id = ?
          AND state IN ('request_started', 'ambiguous', 'terminal_failure')
          AND safe_retry_until > ?
          AND NOT EXISTS (SELECT 1 FROM forecast_email_provider_attempts
            WHERE delivery_id = ? AND profile_id = ? AND state = 'started')
          AND EXISTS (SELECT 1 FROM forecast_notification_outbox WHERE id = ?
            AND profile_id = ? AND state = 'claimed' AND lease_token = ?
            AND lease_expires_at > ?)`)
        .bind(input.startedAt, input.startedAt, existing.id, input.profileId,
          input.claim.outboxId, input.startedAt, existing.id, input.profileId, input.claim.outboxId,
          input.profileId, input.ownerToken, input.startedAt));
    }
    const deliveryIndex = statements.length - 1;
    statements.push(this.d1.prepare(`INSERT INTO forecast_email_provider_attempts
      (id, delivery_id, profile_id, attempt_number, notification_attempt_id, state,
       started_at, safe_retry_until, created_at)
      SELECT ?, ?, ?, COALESCE(MAX(attempt_number), 0) + 1, ?, 'started', ?, ?, ?
      FROM forecast_email_provider_attempts WHERE delivery_id = ? AND profile_id = ? HAVING changes() = 1`)
      .bind(input.providerAttemptId, input.deliveryId, input.profileId,
        input.claim.notificationAttemptId, input.startedAt, safeRetryUntil,
        input.startedAt, input.deliveryId, input.profileId));
    const results = await this.d1.batch(statements);
    if (changed(results[deliveryIndex]) !== 1 || changed(results[statements.length - 1]) !== 1) {
      return { disposition: 'claim_lost', delivery: existing };
    }
    const created = delivery(await this.d1.prepare(`${DELIVERY_SELECT} WHERE id = ? AND profile_id = ?`)
      .bind(input.deliveryId, input.profileId).first<DeliveryRow>());
    return created
      ? { disposition: 'ready', delivery: created, providerAttemptId: input.providerAttemptId }
      : { disposition: 'claim_lost', delivery: null };
  }

  async finalizeAcceptedRecovery(input: {
    profileId: number; outboxId: string; notificationAttemptId: string;
    ownerToken: string; deliveryId: string; completedAt: string;
  }) {
    const accepted = await this.d1.prepare(`SELECT provider_email_id AS providerEmailId
      FROM forecast_email_deliveries WHERE id = ? AND profile_id = ? AND outbox_id = ?
        AND state = 'provider_accepted' AND provider_email_id IS NOT NULL`)
      .bind(input.deliveryId, input.profileId, input.outboxId)
      .first<{ providerEmailId: string }>();
    if (!accepted) return false;
    try {
      await new D1EmailWebhookRepository(this.d1)
        .reconcilePendingForProviderEmail(accepted.providerEmailId);
    } catch {
      // Provider acceptance is already durable. Leave the notification claim
      // recoverable instead of losing an earlier webhook or retrying the send.
      return false;
    }
    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE forecast_notification_delivery_attempts
        SET state = 'succeeded', finished_at = ?
        WHERE id = ? AND outbox_id = ? AND profile_id = ? AND owner_token = ?
          AND state = 'started' AND EXISTS (SELECT 1 FROM forecast_email_deliveries
            WHERE id = ? AND profile_id = ? AND outbox_id = ?
              AND state = 'provider_accepted')`)
        .bind(input.completedAt, input.notificationAttemptId, input.outboxId,
          input.profileId, input.ownerToken, input.deliveryId, input.profileId,
          input.outboxId),
      this.d1.prepare(`UPDATE forecast_notification_outbox
        SET state = 'succeeded', available_at = NULL, lease_token = NULL,
          lease_expires_at = NULL, succeeded_at = ?, updated_at = ?
        WHERE id = ? AND profile_id = ? AND state = 'claimed' AND lease_token = ?
          AND lease_expires_at > ? AND changes() = 1`)
        .bind(input.completedAt, input.completedAt, input.outboxId,
          input.profileId, input.ownerToken, input.completedAt),
    ]);
    return changed(results[0]) === 1 && changed(results[1]) === 1;
  }

  async recordProviderAcceptance(input: {
    profileId: number; outboxId: string; notificationAttemptId: string;
    ownerToken: string; deliveryId: string; providerAttemptId: string;
    identity: ResendProviderIdentity; providerEmailId: string; acceptedAt: string;
  }): Promise<'accepted' | 'accepted_claim_lost' | 'integrity_conflict'> {
    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE forecast_email_provider_attempts
        SET state = 'accepted', finished_at = ? WHERE id = ? AND delivery_id = ?
          AND profile_id = ? AND notification_attempt_id = ? AND state = 'started'
          AND EXISTS (SELECT 1 FROM forecast_email_deliveries WHERE id = ?
            AND profile_id = ? AND outbox_id = ? AND idempotency_key = ?
            AND canonical_request_hash = ? AND state = 'request_started')`)
        .bind(input.acceptedAt, input.providerAttemptId, input.deliveryId,
          input.profileId, input.notificationAttemptId, input.deliveryId,
          input.profileId, input.outboxId, input.identity.idempotencyKey,
          input.identity.canonicalRequestHash),
      this.d1.prepare(`UPDATE forecast_email_deliveries
        SET state = 'provider_accepted', provider_accepted_at = ?, provider_email_id = ?,
          updated_at = ? WHERE id = ? AND profile_id = ? AND outbox_id = ?
          AND idempotency_key = ? AND canonical_request_hash = ?
          AND state = 'request_started' AND changes() = 1`)
        .bind(input.acceptedAt, input.providerEmailId, input.acceptedAt,
          input.deliveryId, input.profileId, input.outboxId,
          input.identity.idempotencyKey, input.identity.canonicalRequestHash),
    ]);
    if (changed(results[0]) !== 1 || changed(results[1]) !== 1) return 'integrity_conflict';
    return await this.finalizeAcceptedRecovery({
      profileId: input.profileId, outboxId: input.outboxId,
      notificationAttemptId: input.notificationAttemptId, ownerToken: input.ownerToken,
      deliveryId: input.deliveryId, completedAt: input.acceptedAt,
    }) ? 'accepted' : 'accepted_claim_lost';
  }

  async completeProviderResult(input: {
    profileId: number; outboxId: string; notificationAttemptId: string;
    ownerToken: string; deliveryId: string; providerAttemptId: string;
    result: Exclude<ResendSendResult, { disposition: 'accepted' }>; completedAt: string;
  }): Promise<CompleteEmailProviderResult> {
    const attempt = await this.d1.prepare(`SELECT a.attempt_number AS attemptNumber,
      d.safe_retry_until AS safeRetryUntil FROM forecast_notification_delivery_attempts a
      JOIN forecast_email_deliveries d ON d.outbox_id = a.outbox_id
        AND d.profile_id = a.profile_id
      WHERE a.id = ? AND a.outbox_id = ? AND a.profile_id = ? AND a.owner_token = ?
        AND a.state = 'started' AND d.id = ?`)
      .bind(input.notificationAttemptId, input.outboxId, input.profileId,
        input.ownerToken, input.deliveryId)
      .first<{ attemptNumber: number; safeRetryUntil: string }>();
    if (!attempt) return { disposition: 'claim_lost', nextAttemptAt: null };
    const failure = providerFailure(input.result);
    let retry = calculateNotificationRetry({
      policyVersion: NOTIFICATION_RETRY_POLICY_VERSION,
      completedAttemptNumber: attempt.attemptNumber,
      completedAt: input.completedAt,
      failure: failure.notificationFailure,
    });
    if (retry.disposition === 'retry_scheduled'
      && retry.nextAttemptAt >= attempt.safeRetryUntil) {
      retry = calculateNotificationRetry({
        policyVersion: NOTIFICATION_RETRY_POLICY_VERSION,
        completedAttemptNumber: attempt.attemptNumber,
        completedAt: input.completedAt,
        failure: 'provider_rejected',
      });
    }
    const scheduled = retry.disposition === 'retry_scheduled';
    const providerState = failure.providerClass === 'ambiguous' ? 'ambiguous'
      : scheduled ? 'retry_scheduled' : 'terminal_failure';
    const providerCategory = input.result.classification;
    const notificationClass = scheduled || retry.reason === 'attempts_exhausted'
      ? 'retryable' : 'terminal';
    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE forecast_email_provider_attempts
        SET state = ?, finished_at = ?, failure_classification = ?,
          redacted_error_category = ?, next_attempt_at = ?
        WHERE id = ? AND delivery_id = ? AND profile_id = ?
          AND notification_attempt_id = ? AND state = 'started'`)
        .bind(providerState, input.completedAt, failure.providerClass,
          providerCategory, providerState === 'retry_scheduled' ? retry.nextAttemptAt : null,
          input.providerAttemptId, input.deliveryId, input.profileId,
          input.notificationAttemptId),
      this.d1.prepare(`UPDATE forecast_email_deliveries SET state = ?,
        dead_lettered_at = ?, updated_at = ? WHERE id = ? AND profile_id = ?
          AND outbox_id = ? AND state = 'request_started' AND changes() = 1`)
        .bind(scheduled ? (failure.providerClass === 'ambiguous' ? 'ambiguous' : 'terminal_failure') : 'dead_letter',
          scheduled ? null : input.completedAt, input.completedAt,
          input.deliveryId, input.profileId, input.outboxId),
      this.d1.prepare(`UPDATE forecast_notification_delivery_attempts
        SET state = ?, finished_at = ?, failure_classification = ?,
          redacted_error_category = ?, next_attempt_at = ?
        WHERE id = ? AND outbox_id = ? AND profile_id = ? AND owner_token = ?
          AND state = 'started' AND changes() = 1`)
        .bind(scheduled ? 'retry_scheduled' : 'terminal_failure', input.completedAt,
          notificationClass, providerCategory, scheduled ? retry.nextAttemptAt : null,
          input.notificationAttemptId, input.outboxId, input.profileId, input.ownerToken),
      this.d1.prepare(`UPDATE forecast_notification_outbox SET state = ?, available_at = ?,
        lease_token = NULL, lease_expires_at = NULL, dead_lettered_at = ?,
        last_failure_category = ?, updated_at = ? WHERE id = ? AND profile_id = ?
          AND state = 'claimed' AND lease_token = ? AND lease_expires_at > ?
          AND changes() = 1`)
        .bind(scheduled ? 'retry_scheduled' : 'dead_letter',
          scheduled ? retry.nextAttemptAt : null, scheduled ? null : input.completedAt,
          providerCategory, input.completedAt, input.outboxId, input.profileId,
          input.ownerToken, input.completedAt),
    ]);
    return results.every((result) => changed(result) === 1)
      ? { disposition: scheduled ? 'retry_scheduled' : 'dead_letter',
        nextAttemptAt: scheduled ? retry.nextAttemptAt : null }
      : { disposition: 'claim_lost', nextAttemptAt: null };
  }

  completeUnexpected(input: {
    profileId: number; outboxId: string; notificationAttemptId: string;
    ownerToken: string; completedAt: string;
  }): Promise<CompleteEmailProviderResult> {
    return this.completeUnexpectedInternal(input);
  }

  private async completeUnexpectedInternal(input: {
    profileId: number; outboxId: string; notificationAttemptId: string;
    ownerToken: string; completedAt: string;
  }): Promise<CompleteEmailProviderResult> {
    const active = await this.d1.prepare(`SELECT a.id, a.delivery_id AS deliveryId
      FROM forecast_email_provider_attempts a JOIN forecast_email_deliveries d
        ON d.id = a.delivery_id AND d.profile_id = a.profile_id
      WHERE a.profile_id = ? AND a.notification_attempt_id = ? AND a.state = 'started'
        AND d.outbox_id = ? LIMIT 1`)
      .bind(input.profileId, input.notificationAttemptId, input.outboxId)
      .first<{ id: string; deliveryId: string }>();
    if (active) {
      const results = await this.d1.batch([
        this.d1.prepare(`UPDATE forecast_email_provider_attempts
          SET state = 'ambiguous', finished_at = ?, failure_classification = 'ambiguous',
            redacted_error_category = 'unexpected_dispatch_error', next_attempt_at = NULL
          WHERE id = ? AND delivery_id = ? AND profile_id = ? AND state = 'started'`)
          .bind(input.completedAt, active.id, active.deliveryId, input.profileId),
        this.d1.prepare(`UPDATE forecast_email_deliveries
          SET state = 'ambiguous', updated_at = ? WHERE id = ? AND profile_id = ?
            AND outbox_id = ? AND state = 'request_started' AND changes() = 1`)
          .bind(input.completedAt, active.deliveryId, input.profileId, input.outboxId),
      ]);
      if (changed(results[0]) !== 1 || changed(results[1]) !== 1) {
        return { disposition: 'claim_lost', nextAttemptAt: null };
      }
    }
    return this.completeClaimFailure(input, 'adapter_exception');
  }

  async completeIntegrityFailure(input: {
    profileId: number; outboxId: string; notificationAttemptId: string;
    ownerToken: string; deliveryId: string | null; completedAt: string;
    classification: 'idempotency_integrity_failure' | 'safe_retry_window_expired';
  }): Promise<CompleteEmailProviderResult> {
    const statements: D1PreparedStatement[] = [];
    if (input.deliveryId !== null) {
      statements.push(this.d1.prepare(`UPDATE forecast_email_deliveries
        SET state = 'dead_letter', dead_lettered_at = ?, updated_at = ?
        WHERE id = ? AND profile_id = ? AND outbox_id = ?
          AND state <> 'provider_accepted'`)
        .bind(input.completedAt, input.completedAt, input.deliveryId,
          input.profileId, input.outboxId));
    }
    statements.push(
      this.d1.prepare(`UPDATE forecast_notification_delivery_attempts
        SET state = 'terminal_failure', finished_at = ?, failure_classification = 'terminal',
          redacted_error_category = ?, next_attempt_at = NULL
        WHERE id = ? AND outbox_id = ? AND profile_id = ? AND owner_token = ?
          AND state = 'started' AND EXISTS (SELECT 1 FROM forecast_notification_outbox
            WHERE id = ? AND profile_id = ? AND state = 'claimed' AND lease_token = ?
              AND lease_expires_at > ?)`)
        .bind(input.completedAt, input.classification, input.notificationAttemptId,
          input.outboxId, input.profileId, input.ownerToken, input.outboxId,
          input.profileId, input.ownerToken, input.completedAt),
      this.d1.prepare(`UPDATE forecast_notification_outbox
        SET state = 'dead_letter', available_at = NULL, lease_token = NULL,
          lease_expires_at = NULL, dead_lettered_at = ?, last_failure_category = ?,
          updated_at = ? WHERE id = ? AND profile_id = ? AND state = 'claimed'
          AND lease_token = ? AND changes() = 1`)
        .bind(input.completedAt, input.classification, input.completedAt,
          input.outboxId, input.profileId, input.ownerToken),
    );
    const results = await this.d1.batch(statements);
    const attemptIndex = input.deliveryId === null ? 0 : 1;
    return changed(results[attemptIndex]) === 1 && changed(results[attemptIndex + 1]) === 1
      ? { disposition: 'dead_letter', nextAttemptAt: null }
      : { disposition: 'claim_lost', nextAttemptAt: null };
  }

  private async completeClaimFailure(input: {
    profileId: number; outboxId: string; notificationAttemptId: string;
    ownerToken: string; completedAt: string;
  }, failure: NotificationDeliveryFailure): Promise<CompleteEmailProviderResult> {
    const attempt = await this.d1.prepare(`SELECT attempt_number AS attemptNumber
      FROM forecast_notification_delivery_attempts WHERE id = ? AND outbox_id = ?
        AND profile_id = ? AND owner_token = ? AND state = 'started'`)
      .bind(input.notificationAttemptId, input.outboxId, input.profileId,
        input.ownerToken).first<{ attemptNumber: number }>();
    if (!attempt) return { disposition: 'claim_lost', nextAttemptAt: null };
    const retry = calculateNotificationRetry({
      policyVersion: NOTIFICATION_RETRY_POLICY_VERSION,
      completedAttemptNumber: attempt.attemptNumber, completedAt: input.completedAt, failure,
    });
    const scheduled = retry.disposition === 'retry_scheduled';
    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE forecast_notification_delivery_attempts
        SET state = ?, finished_at = ?, failure_classification = ?,
          redacted_error_category = ?, next_attempt_at = ? WHERE id = ?
          AND outbox_id = ? AND profile_id = ? AND owner_token = ? AND state = 'started'
          AND EXISTS (SELECT 1 FROM forecast_notification_outbox WHERE id = ?
            AND profile_id = ? AND state = 'claimed' AND lease_token = ?
            AND lease_expires_at > ?)`)
        .bind(scheduled ? 'retry_scheduled' : 'terminal_failure', input.completedAt,
          scheduled || retry.reason === 'attempts_exhausted' ? 'retryable' : 'terminal',
          failure, scheduled ? retry.nextAttemptAt : null, input.notificationAttemptId,
          input.outboxId, input.profileId, input.ownerToken, input.outboxId,
          input.profileId, input.ownerToken, input.completedAt),
      this.d1.prepare(`UPDATE forecast_notification_outbox SET state = ?, available_at = ?,
        lease_token = NULL, lease_expires_at = NULL, dead_lettered_at = ?,
        last_failure_category = ?, updated_at = ? WHERE id = ? AND profile_id = ?
          AND state = 'claimed' AND lease_token = ? AND changes() = 1`)
        .bind(scheduled ? 'retry_scheduled' : 'dead_letter',
          scheduled ? retry.nextAttemptAt : null, scheduled ? null : input.completedAt,
          failure, input.completedAt, input.outboxId, input.profileId, input.ownerToken),
    ]);
    return changed(results[0]) === 1 && changed(results[1]) === 1
      ? { disposition: scheduled ? 'retry_scheduled' : 'dead_letter',
        nextAttemptAt: scheduled ? retry.nextAttemptAt : null }
      : { disposition: 'claim_lost', nextAttemptAt: null };
  }

  async listDeliveryStatus(profileId: number, filter: EmailDeliveryStatusFilter) {
    const stateClause = filter.state ? 'AND d.state = ?' : '';
    const templateClause = filter.templateKind ? 'AND d.template_kind = ?' : '';
    const bindings: unknown[] = [profileId];
    if (filter.state) bindings.push(filter.state);
    if (filter.templateKind) bindings.push(filter.templateKind);
    bindings.push(filter.limit);
    const rows = await this.d1.prepare(`SELECT d.id AS deliveryId,
      d.recipient_id AS recipientId, r.masked_email AS maskedEmail,
      d.source_kind AS sourceKind, d.outbox_id AS outboxId,
      d.template_kind AS templateKind, d.template_version AS templateVersion,
      d.state, d.provider_accepted_at AS providerAcceptedAt,
      d.reconciliation_state AS reconciliationState,
      d.reconciliation_event_at AS reconciliationEventAt,
      d.created_at AS createdAt, d.updated_at AS updatedAt
      FROM forecast_email_deliveries d JOIN forecast_email_recipients r
        ON r.id = d.recipient_id AND r.profile_id = d.profile_id
      WHERE d.profile_id = ? ${stateClause} ${templateClause}
      ORDER BY d.created_at DESC, d.id DESC LIMIT ?`)
      .bind(...bindings).all<SafeEmailDeliveryStatus>();
    return rows.results;
  }

  async countDeliveryStatus(profileId: number) {
    const rows = await this.d1.prepare(`SELECT state,
      reconciliation_state AS reconciliationState, count(*) AS count
      FROM forecast_email_deliveries WHERE profile_id = ?
      GROUP BY state, reconciliation_state ORDER BY state, reconciliation_state`)
      .bind(profileId).all<SafeEmailDeliveryCount>();
    return rows.results;
  }
}

/** D1 lifecycle for verification messages, isolated from notification claims. */
export class D1VerificationEmailRepository implements VerificationEmailDeliveryRepository {
  private readonly d1: D1Database;

  constructor(d1: D1Database) {
    this.d1 = d1;
  }

  async loadVerificationContext(input: {
    profileId: number; checkedAt: string;
  }): Promise<VerificationDeliveryContext> {
    const recipientRow = await this.d1.prepare(`${RECIPIENT_SELECT}
      WHERE profile_id = ? AND state IN ('pending', 'verified') LIMIT 1`)
      .bind(input.profileId).first<RecipientRow>();
    const capabilityRow = recipientRow ? await this.d1.prepare(`${CAPABILITY_SELECT}
      WHERE profile_id = ? AND recipient_id = ? AND purpose = 'verification'
      ORDER BY created_at DESC LIMIT 1`)
      .bind(input.profileId, recipientRow.id).first<CapabilityRow>() : null;
    const persisted = capability(capabilityRow);
    const deliveryRow = capabilityRow ? await this.d1.prepare(`${DELIVERY_SELECT}
      WHERE profile_id = ? AND verification_capability_id = ?`)
      .bind(input.profileId, capabilityRow.id).first<DeliveryRow>() : null;
    return {
      recipient: recipientRow ?? null,
      capability: persisted ? { state: persisted.state, record: persisted } : null,
      existingDelivery: delivery(deliveryRow),
    };
  }

  async beginProviderAttempt(input: {
    profileId: number; recipientId: string; capabilityId: string; deliveryId: string;
    providerAttemptId: string; templateVersion: string; locale: string;
    contentHash: string; identity: ResendProviderIdentity; startedAt: string;
    minimumSafeRetryUntil: string;
  }): Promise<BeginVerificationProviderAttemptResult> {
    const existingRow = await this.d1.prepare(`${DELIVERY_SELECT}
      WHERE profile_id = ? AND verification_capability_id = ?`)
      .bind(input.profileId, input.capabilityId).first<DeliveryRow>();
    const existing = delivery(existingRow);
    if (existing) {
      if (existing.recipientId !== input.recipientId
        || existing.templateVersion !== input.templateVersion
        || existing.contentHash !== input.contentHash
        || existing.idempotencyKey !== input.identity.idempotencyKey
        || existing.canonicalRequestHash !== input.identity.canonicalRequestHash) {
        return { disposition: 'integrity_conflict', delivery: existing };
      }
      if (existing.state === 'provider_accepted') {
        return { disposition: 'already_accepted', delivery: existing };
      }
      if (!existing.safeRetryUntil || existing.safeRetryUntil <= input.minimumSafeRetryUntil) {
        return { disposition: 'safe_retry_window_expired', delivery: existing };
      }
    }
    const context = await this.d1.prepare(`SELECT 1 AS valid
      FROM forecast_email_recipients r JOIN forecast_email_capabilities c
        ON c.recipient_id = r.id AND c.profile_id = r.profile_id
      WHERE r.id = ? AND r.profile_id = ? AND r.state = 'pending'
        AND c.id = ? AND c.purpose = 'verification' AND c.state = 'active'
        AND c.consent_revision IS NULL AND c.expires_at > ?`)
      .bind(input.recipientId, input.profileId, input.capabilityId, input.startedAt)
      .first<{ valid: number }>();
    if (!context) return { disposition: 'context_changed', delivery: existing };
    const safeRetryUntil = existing?.safeRetryUntil
      ?? Temporal.Instant.from(input.startedAt).add({ hours: RESEND_SAFE_RETRY_HOURS })
        .toString({ smallestUnit: 'millisecond' });
    const statements: D1PreparedStatement[] = [];
    if (!existing) {
      statements.push(this.d1.prepare(`INSERT INTO forecast_email_deliveries
        (id, profile_id, recipient_id, source_kind, outbox_id, pre_send_decision_id,
         verification_capability_id, template_kind, template_version, locale,
         content_hash, provider, idempotency_key, canonical_request_hash, state,
         request_started_at, last_request_at, safe_retry_until, reconciliation_state,
         created_at, updated_at)
        SELECT ?, ?, ?, 'recipient_verification', NULL, NULL, ?, 'verification', ?, ?,
          ?, 'resend', ?, ?, 'request_started', ?, ?, ?, 'none', ?, ?
        WHERE EXISTS (SELECT 1 FROM forecast_email_recipients r
          JOIN forecast_email_capabilities c
            ON c.recipient_id = r.id AND c.profile_id = r.profile_id
          WHERE r.id = ? AND r.profile_id = ? AND r.state = 'pending'
            AND c.id = ? AND c.purpose = 'verification' AND c.state = 'active'
            AND c.expires_at > ?)`)
        .bind(input.deliveryId, input.profileId, input.recipientId, input.capabilityId,
          input.templateVersion, input.locale, input.contentHash,
          input.identity.idempotencyKey, input.identity.canonicalRequestHash,
          input.startedAt, input.startedAt, safeRetryUntil, input.startedAt,
          input.startedAt, input.recipientId, input.profileId, input.capabilityId,
          input.startedAt));
    } else {
      if (existing.state === 'request_started') {
        statements.push(this.d1.prepare(`UPDATE forecast_email_provider_attempts
          SET state = 'ambiguous', finished_at = ?, failure_classification = 'ambiguous',
            redacted_error_category = 'interrupted_before_local_finalize', next_attempt_at = NULL
          WHERE delivery_id = ? AND profile_id = ? AND state = 'started'`)
          .bind(input.startedAt, existing.id, input.profileId));
      }
      statements.push(this.d1.prepare(`UPDATE forecast_email_deliveries
        SET state = 'request_started', last_request_at = ?, updated_at = ?
        WHERE id = ? AND profile_id = ? AND verification_capability_id = ?
          AND state IN ('request_started', 'ambiguous', 'terminal_failure')
          AND safe_retry_until > ? AND NOT EXISTS (
            SELECT 1 FROM forecast_email_provider_attempts
              WHERE delivery_id = ? AND profile_id = ? AND state = 'started')
          AND EXISTS (SELECT 1 FROM forecast_email_capabilities WHERE id = ?
            AND profile_id = ? AND recipient_id = ? AND purpose = 'verification'
            AND state = 'active' AND expires_at > ?)`)
        .bind(input.startedAt, input.startedAt, existing.id, input.profileId,
          input.capabilityId, input.minimumSafeRetryUntil, existing.id, input.profileId, input.capabilityId,
          input.profileId, input.recipientId, input.startedAt));
    }
    const deliveryIndex = statements.length - 1;
    statements.push(this.d1.prepare(`INSERT INTO forecast_email_provider_attempts
      (id, delivery_id, profile_id, attempt_number, notification_attempt_id, state,
       started_at, safe_retry_until, created_at)
      SELECT ?, ?, ?, COALESCE(MAX(attempt_number), 0) + 1, NULL, 'started', ?, ?, ?
      FROM forecast_email_provider_attempts WHERE delivery_id = ? AND profile_id = ? HAVING changes() = 1`)
      .bind(input.providerAttemptId, input.deliveryId, input.profileId,
        input.startedAt, safeRetryUntil, input.startedAt, input.deliveryId, input.profileId));
    const results = await this.d1.batch(statements);
    if (changed(results[deliveryIndex]) !== 1) {
      return { disposition: 'context_changed', delivery: existing };
    }
    if (changed(results[statements.length - 1]) !== 1) {
      return { disposition: 'attempt_conflict', delivery: existing };
    }
    const created = delivery(await this.d1.prepare(`${DELIVERY_SELECT}
      WHERE id = ? AND profile_id = ?`).bind(input.deliveryId, input.profileId)
      .first<DeliveryRow>());
    return created
      ? { disposition: 'ready', delivery: created, providerAttemptId: input.providerAttemptId }
      : { disposition: 'attempt_conflict', delivery: null };
  }

  async finalizeAcceptedRecovery(input: {
    profileId: number; recipientId: string; capabilityId: string;
    deliveryId: string; completedAt: string;
  }) {
    const row = await this.d1.prepare(`SELECT provider_email_id AS providerEmailId
      FROM forecast_email_deliveries WHERE id = ? AND profile_id = ?
        AND recipient_id = ? AND verification_capability_id = ?
        AND state = 'provider_accepted' AND provider_email_id IS NOT NULL`)
      .bind(input.deliveryId, input.profileId, input.recipientId, input.capabilityId)
      .first<{ providerEmailId: string }>();
    if (!row) return false;
    try {
      await new D1EmailWebhookRepository(this.d1)
        .reconcilePendingForProviderEmail(row.providerEmailId);
      return true;
    } catch {
      // The accepted delivery remains the recovery marker. A later invocation
      // can retry webhook reconciliation without issuing another provider send.
      return false;
    }
  }

  async recordProviderAcceptance(input: {
    profileId: number; recipientId: string; capabilityId: string; deliveryId: string;
    providerAttemptId: string; identity: ResendProviderIdentity;
    providerEmailId: string; acceptedAt: string;
  }): Promise<'accepted' | 'accepted_context_changed' | 'integrity_conflict'> {
    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE forecast_email_provider_attempts
        SET state = 'accepted', finished_at = ? WHERE id = ? AND delivery_id = ?
          AND profile_id = ? AND notification_attempt_id IS NULL AND state = 'started'
          AND EXISTS (SELECT 1 FROM forecast_email_deliveries WHERE id = ?
            AND profile_id = ? AND recipient_id = ? AND verification_capability_id = ?
            AND idempotency_key = ? AND canonical_request_hash = ?
            AND state = 'request_started')`)
        .bind(input.acceptedAt, input.providerAttemptId, input.deliveryId,
          input.profileId, input.deliveryId, input.profileId, input.recipientId,
          input.capabilityId, input.identity.idempotencyKey,
          input.identity.canonicalRequestHash),
      this.d1.prepare(`UPDATE forecast_email_deliveries
        SET state = 'provider_accepted', provider_accepted_at = ?, provider_email_id = ?,
          updated_at = ? WHERE id = ? AND profile_id = ? AND recipient_id = ?
          AND verification_capability_id = ? AND idempotency_key = ?
          AND canonical_request_hash = ? AND state = 'request_started' AND changes() = 1`)
        .bind(input.acceptedAt, input.providerEmailId, input.acceptedAt,
          input.deliveryId, input.profileId, input.recipientId, input.capabilityId,
          input.identity.idempotencyKey, input.identity.canonicalRequestHash),
    ]);
    if (changed(results[0]) !== 1 || changed(results[1]) !== 1) return 'integrity_conflict';
    if (!await this.finalizeAcceptedRecovery({
      profileId: input.profileId,
      recipientId: input.recipientId,
      capabilityId: input.capabilityId,
      deliveryId: input.deliveryId,
      completedAt: input.acceptedAt,
    })) return 'accepted_context_changed';
    const current = await this.d1.prepare(`SELECT 1 AS valid
      FROM forecast_email_recipients r JOIN forecast_email_capabilities c
        ON c.recipient_id = r.id AND c.profile_id = r.profile_id
      WHERE r.id = ? AND r.profile_id = ? AND r.state = 'pending'
        AND c.id = ? AND c.state = 'active' AND c.purpose = 'verification'`)
      .bind(input.recipientId, input.profileId, input.capabilityId)
      .first<{ valid: number }>();
    return current ? 'accepted' : 'accepted_context_changed';
  }

  async completeProviderResult(input: {
    profileId: number; recipientId: string; capabilityId: string; deliveryId: string;
    providerAttemptId: string;
    result: Exclude<ResendSendResult, { disposition: 'accepted' }>; completedAt: string;
  }): Promise<VerificationProviderCompletion> {
    const attempt = await this.d1.prepare(`SELECT attempt_number AS attemptNumber,
      safe_retry_until AS safeRetryUntil FROM forecast_email_provider_attempts
      WHERE id = ? AND delivery_id = ? AND profile_id = ? AND state = 'started'`)
      .bind(input.providerAttemptId, input.deliveryId, input.profileId)
      .first<{ attemptNumber: number; safeRetryUntil: string }>();
    if (!attempt) return { disposition: 'attempt_lost', nextAttemptAt: null };
    const failure = providerFailure(input.result);
    let retry = calculateNotificationRetry({
      policyVersion: NOTIFICATION_RETRY_POLICY_VERSION,
      completedAttemptNumber: attempt.attemptNumber, completedAt: input.completedAt,
      failure: failure.notificationFailure,
    });
    if (retry.disposition === 'retry_scheduled'
      && retry.nextAttemptAt >= attempt.safeRetryUntil) {
      retry = calculateNotificationRetry({
        policyVersion: NOTIFICATION_RETRY_POLICY_VERSION,
        completedAttemptNumber: attempt.attemptNumber, completedAt: input.completedAt,
        failure: 'provider_rejected',
      });
    }
    const scheduled = retry.disposition === 'retry_scheduled';
    const attemptState = failure.providerClass === 'ambiguous' ? 'ambiguous'
      : scheduled ? 'retry_scheduled' : 'terminal_failure';
    const results = await this.d1.batch([
      this.d1.prepare(`UPDATE forecast_email_provider_attempts
        SET state = ?, finished_at = ?, failure_classification = ?,
          redacted_error_category = ?, next_attempt_at = ?
        WHERE id = ? AND delivery_id = ? AND profile_id = ? AND state = 'started'`)
        .bind(attemptState, input.completedAt, failure.providerClass,
          input.result.classification,
          attemptState === 'retry_scheduled' ? retry.nextAttemptAt : null,
          input.providerAttemptId, input.deliveryId, input.profileId),
      this.d1.prepare(`UPDATE forecast_email_deliveries
        SET state = ?, dead_lettered_at = ?, updated_at = ?
        WHERE id = ? AND profile_id = ? AND recipient_id = ?
          AND verification_capability_id = ? AND state = 'request_started'
          AND changes() = 1`)
        .bind(scheduled ? (failure.providerClass === 'ambiguous'
          ? 'ambiguous' : 'terminal_failure') : 'dead_letter',
        scheduled ? null : input.completedAt, input.completedAt, input.deliveryId,
        input.profileId, input.recipientId, input.capabilityId),
    ]);
    return changed(results[0]) === 1 && changed(results[1]) === 1
      ? { disposition: scheduled ? 'retry_scheduled' : 'dead_letter',
        nextAttemptAt: scheduled ? retry.nextAttemptAt : null }
      : { disposition: 'attempt_lost', nextAttemptAt: null };
  }

  async completeIntegrityFailure(input: {
    profileId: number; recipientId: string; capabilityId: string;
    deliveryId: string | null; completedAt: string;
    classification: 'idempotency_integrity_failure' | 'safe_retry_window_expired';
  }): Promise<VerificationProviderCompletion> {
    if (!input.deliveryId) return { disposition: 'attempt_lost', nextAttemptAt: null };
    await this.d1.prepare(`UPDATE forecast_email_provider_attempts
      SET state = 'terminal_failure', finished_at = ?, failure_classification = 'terminal',
        redacted_error_category = ?, next_attempt_at = NULL
      WHERE delivery_id = ? AND profile_id = ? AND state = 'started'`)
      .bind(input.completedAt, input.classification, input.deliveryId, input.profileId).run();
    const result = await this.d1.prepare(`UPDATE forecast_email_deliveries
      SET state = 'dead_letter', dead_lettered_at = ?, updated_at = ?
      WHERE id = ? AND profile_id = ? AND recipient_id = ?
        AND verification_capability_id = ? AND state <> 'provider_accepted'`)
      .bind(input.completedAt, input.completedAt, input.deliveryId, input.profileId,
        input.recipientId, input.capabilityId).run();
    return changed(result) === 1
      ? { disposition: 'dead_letter', nextAttemptAt: null }
      : { disposition: 'attempt_lost', nextAttemptAt: null };
  }

  completeUnexpected(input: {
    profileId: number; recipientId: string; capabilityId: string;
    deliveryId: string; providerAttemptId: string; completedAt: string;
  }): Promise<VerificationProviderCompletion> {
    return this.completeProviderResult({
      ...input,
      result: { disposition: 'ambiguous', classification: 'provider_unavailable' },
    });
  }
}
