import type {
  EmailReconciliationState,
  EmailRecipientSuppressionReason,
} from './types.ts';

export type ResendWebhookPersistenceInput = {
  id: string;
  providerEventId: string;
  providerEmailId: string;
  eventType: string;
  supported: boolean;
  payloadHash: string;
  occurredAt: string;
  receivedAt: string;
  reconciliationState: EmailReconciliationState | null;
  suppressionReason: EmailRecipientSuppressionReason | null;
  revokeConsent: boolean;
};

export type ResendWebhookPersistenceResult = {
  disposition: 'applied' | 'unsupported' | 'unknown_delivery' | 'ignored_precedence' | 'duplicate';
};

export interface EmailWebhookRepository {
  persistResendWebhook(
    input: ResendWebhookPersistenceInput,
  ): Promise<ResendWebhookPersistenceResult>;
}

type DeliveryRow = {
  id: string;
  profileId: number;
  recipientId: string;
};

type EventStateRow = {
  handlingState: 'applied' | 'unsupported' | 'unknown_delivery' | 'ignored_precedence' | 'pending';
};

type OrphanedEventRow = {
  id: string;
  providerEventId: string;
  providerEmailId: string;
  eventType: string;
  payloadHash: string;
  occurredAt: string;
  receivedAt: string;
};

function changed(result: D1Result<unknown> | undefined): number {
  return Number(result?.meta?.changes ?? 0);
}

function suppressionEventId(providerEventId: string): string {
  return `suppression_${providerEventId}`;
}

function precedencePredicate(next: EmailReconciliationState): {
  sql: string;
  occurrenceBindings: number;
} {
  // Delivered and failed are terminal transport results ordered by the signed
  // provider occurrence time; failure wins an exact timestamp tie. Permanent
  // recipient evidence may still advance either result to bounced, suppressed,
  // or complained. Delayed evidence can never downgrade a terminal state.
  switch (next) {
    case 'delayed':
      return { sql: "reconciliation_state IN ('none', 'delayed') AND (reconciliation_event_at IS NULL OR reconciliation_event_at <= ?)", occurrenceBindings: 1 };
    case 'delivered':
      return { sql: "(reconciliation_state IN ('none', 'delayed') OR (reconciliation_state IN ('delivered', 'failed') AND reconciliation_event_at < ?))", occurrenceBindings: 1 };
    case 'failed':
      return { sql: "(reconciliation_state IN ('none', 'delayed') OR (reconciliation_state IN ('delivered', 'failed') AND reconciliation_event_at <= ?))", occurrenceBindings: 1 };
    case 'bounced':
      return {
        sql: "reconciliation_state <> 'complained' AND (reconciliation_state NOT IN ('bounced', 'suppressed') OR reconciliation_event_at < ? OR (reconciliation_event_at = ? AND reconciliation_state = 'suppressed'))",
        occurrenceBindings: 2,
      };
    case 'complained':
      return { sql: "reconciliation_state <> 'complained' OR reconciliation_event_at <= ?", occurrenceBindings: 1 };
    case 'suppressed':
      return {
        sql: "reconciliation_state <> 'complained' AND (reconciliation_state NOT IN ('bounced', 'suppressed') OR reconciliation_event_at < ?)",
        occurrenceBindings: 1,
      };
    case 'none':
      return { sql: '0 = 1', occurrenceBindings: 0 };
  }
}

function recordedEventSemantics(eventType: string): Pick<ResendWebhookPersistenceInput,
  'reconciliationState' | 'suppressionReason' | 'revokeConsent'> | null {
  switch (eventType) {
    case 'email.delivered':
      return { reconciliationState: 'delivered', suppressionReason: null, revokeConsent: false };
    case 'email.delivery_delayed':
      return { reconciliationState: 'delayed', suppressionReason: null, revokeConsent: false };
    case 'email.failed':
      return { reconciliationState: 'failed', suppressionReason: null, revokeConsent: false };
    case 'email.bounced':
      return { reconciliationState: 'bounced', suppressionReason: 'hard_bounce', revokeConsent: false };
    case 'email.complained':
      return { reconciliationState: 'complained', suppressionReason: 'complaint', revokeConsent: true };
    case 'email.suppressed':
      return { reconciliationState: 'suppressed', suppressionReason: 'provider_suppressed', revokeConsent: false };
    default:
      return null;
  }
}

/** D1 implementation kept behind the narrow webhook service contract. */
export class D1EmailWebhookRepository implements EmailWebhookRepository {
  private readonly d1: D1Database;

  constructor(d1: D1Database) {
    this.d1 = d1;
  }

  async reconcilePendingForProviderEmail(providerEmailId: string): Promise<void> {
    const rows = await this.d1.prepare(`SELECT id, provider_event_id AS providerEventId,
      provider_email_id AS providerEmailId, event_type AS eventType,
      payload_hash AS payloadHash, event_occurred_at AS occurredAt,
      received_at AS receivedAt FROM forecast_email_provider_events
      WHERE provider = 'resend' AND provider_email_id = ?
        AND handling_state = 'unknown_delivery' AND supported = 1
      ORDER BY event_occurred_at ASC, id ASC LIMIT 101`)
      .bind(providerEmailId).all<OrphanedEventRow>();
    for (const row of rows.results.slice(0, 100)) {
      const semantics = recordedEventSemantics(row.eventType);
      if (!semantics) continue;
      await this.persistResendWebhook({
        ...row,
        supported: true,
        ...semantics,
      });
    }
    // Preserve bounded work while making forward progress. The accepted
    // delivery remains recoverable and the next invocation consumes the next
    // page without issuing another provider request.
    if (rows.results.length > 100) throw new Error('ResendWebhookReconciliationLimitExceeded');
  }

  async persistResendWebhook(
    input: ResendWebhookPersistenceInput,
  ): Promise<ResendWebhookPersistenceResult> {
    const existing = await this.d1.prepare(`SELECT handling_state AS handlingState
      FROM forecast_email_provider_events
      WHERE provider = 'resend' AND provider_event_id = ?`)
      .bind(input.providerEventId).first<EventStateRow>();
    if (existing && existing.handlingState !== 'unknown_delivery') {
      return { disposition: 'duplicate' };
    }

    const delivery = await this.d1.prepare(`SELECT id, profile_id AS profileId,
        recipient_id AS recipientId
      FROM forecast_email_deliveries
      WHERE provider = 'resend' AND provider_email_id = ? LIMIT 1`)
      .bind(input.providerEmailId).first<DeliveryRow>();
    if (!delivery) {
      if (existing) return { disposition: 'unknown_delivery' };
      const inserted = await this.d1.prepare(`INSERT OR IGNORE INTO forecast_email_provider_events
        (id, provider, provider_event_id, provider_email_id, delivery_id, profile_id,
         event_type, supported, payload_hash, event_occurred_at, received_at,
         handling_state, created_at)
        VALUES (?, 'resend', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          input.id,
          input.providerEventId,
          input.providerEmailId,
          input.eventType,
          input.supported ? 1 : 0,
          input.payloadHash,
          input.occurredAt,
          input.receivedAt,
          input.supported ? 'unknown_delivery' : 'unsupported',
          input.receivedAt,
        ).run();
      return {
        disposition: changed(inserted) === 0
          ? 'duplicate'
          : input.supported ? 'unknown_delivery' : 'unsupported',
      };
    }

    if (!input.supported || input.reconciliationState === null) {
      const inserted = await this.d1.prepare(`INSERT OR IGNORE INTO forecast_email_provider_events
        (id, provider, provider_event_id, provider_email_id, delivery_id, profile_id,
         event_type, supported, payload_hash, event_occurred_at, received_at,
         handling_state, created_at)
        VALUES (?, 'resend', ?, ?, ?, ?, ?, 0, ?, ?, ?, 'unsupported', ?)`)
        .bind(
          input.id,
          input.providerEventId,
          input.providerEmailId,
          delivery.id,
          delivery.profileId,
          input.eventType,
          input.payloadHash,
          input.occurredAt,
          input.receivedAt,
          input.receivedAt,
        ).run();
      return { disposition: changed(inserted) === 0 ? 'duplicate' : 'unsupported' };
    }

    const eventInsert = existing
      ? this.d1.prepare(`UPDATE forecast_email_provider_events
        SET delivery_id = ?, profile_id = ?, handling_state = 'pending'
        WHERE provider = 'resend' AND provider_event_id = ?
          AND provider_email_id = ? AND handling_state = 'unknown_delivery'`)
        .bind(delivery.id, delivery.profileId, input.providerEventId, input.providerEmailId)
      : this.d1.prepare(`INSERT OR IGNORE INTO forecast_email_provider_events
      (id, provider, provider_event_id, provider_email_id, delivery_id, profile_id,
       event_type, supported, payload_hash, event_occurred_at, received_at,
       handling_state, created_at)
      VALUES (?, 'resend', ?, ?, ?, ?, ?, 1, ?, ?, ?, 'pending', ?)`)
      .bind(
        input.id,
        input.providerEventId,
        input.providerEmailId,
        delivery.id,
        delivery.profileId,
        input.eventType,
        input.payloadHash,
        input.occurredAt,
        input.receivedAt,
        input.receivedAt,
      );
    const precedence = precedencePredicate(input.reconciliationState);
    const deliveryUpdate = this.d1.prepare(`UPDATE forecast_email_deliveries
      SET reconciliation_state = ?, reconciliation_event_at = ?, updated_at = ?
      WHERE id = ? AND profile_id = ?
        AND EXISTS (SELECT 1 FROM forecast_email_provider_events
          WHERE id = ? AND handling_state = 'pending')
        AND ${precedence.sql}`)
      .bind(
        input.reconciliationState,
        input.occurredAt,
        input.receivedAt,
        delivery.id,
        delivery.profileId,
        input.id,
        ...Array.from({ length: precedence.occurrenceBindings }, () => input.occurredAt),
      );
    const eventFinalize = this.d1.prepare(`UPDATE forecast_email_provider_events
      SET handling_state = CASE WHEN changes() = 1 THEN 'applied' ELSE 'ignored_precedence' END
      WHERE id = ? AND handling_state = 'pending'`).bind(input.id);
    const statements: D1PreparedStatement[] = [eventInsert, deliveryUpdate, eventFinalize];

    if (input.suppressionReason) {
      statements.push(
        this.d1.prepare(`UPDATE forecast_email_recipients
          SET suppression_state = 'suppressed', suppression_reason = ?, suppressed_at = ?, updated_at = ?
          WHERE id = ? AND profile_id = ?
            AND EXISTS (SELECT 1 FROM forecast_email_provider_events
              WHERE id = ? AND handling_state = 'applied')`)
          .bind(
            input.suppressionReason,
            input.occurredAt,
            input.receivedAt,
            delivery.recipientId,
            delivery.profileId,
            input.id,
          ),
        this.d1.prepare(`INSERT OR IGNORE INTO forecast_email_suppression_events
          (id, profile_id, recipient_id, provider_event_id, action, reason, occurred_at, created_at)
          SELECT ?, ?, ?, ?, 'suppressed', ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM forecast_email_provider_events
            WHERE id = ? AND handling_state = 'applied')`)
          .bind(
            suppressionEventId(input.id),
            delivery.profileId,
            delivery.recipientId,
            input.id,
            input.suppressionReason,
            input.occurredAt,
            input.receivedAt,
            input.id,
          ),
      );
    }

    if (input.revokeConsent) {
      statements.push(
        this.d1.prepare(`INSERT INTO forecast_email_consent_revisions
          (profile_id, revision, recipient_id, master_consent, target_hit_enabled,
           invalidated_enabled, expired_enabled, needs_review_enabled, consent_source,
           consented_at, revoked_at, created_at)
          SELECT c.profile_id, c.current_revision + 1, c.recipient_id,
            0, 0, 0, 0, 0, 'provider_complaint', NULL, ?, ?
          FROM forecast_email_consents c
          JOIN forecast_email_consent_revisions current_consent
            ON current_consent.profile_id = c.profile_id
              AND current_consent.revision = c.current_revision
              AND current_consent.recipient_id = c.recipient_id
          WHERE c.profile_id = ? AND c.recipient_id = ?
            AND current_consent.master_consent = 1
            AND EXISTS (SELECT 1 FROM forecast_email_provider_events
              WHERE id = ? AND handling_state = 'applied')
            AND EXISTS (SELECT 1 FROM forecast_email_suppression_events WHERE provider_event_id = ?)`)
          .bind(
            input.occurredAt,
            input.receivedAt,
            delivery.profileId,
            delivery.recipientId,
            input.id,
            input.id,
          ),
        this.d1.prepare(`UPDATE forecast_email_consents
          SET current_revision = current_revision + 1, updated_at = ?
          WHERE profile_id = ? AND recipient_id = ? AND changes() = 1`)
          .bind(input.receivedAt, delivery.profileId, delivery.recipientId),
      );
    }

    const results = await this.d1.batch(statements);
    if (changed(results[0]) === 0) return { disposition: 'duplicate' };
    const state = await this.d1.prepare(`SELECT handling_state AS handlingState
      FROM forecast_email_provider_events WHERE id = ?`)
      .bind(input.id).first<EventStateRow>();
    return {
      disposition: state?.handlingState === 'applied' ? 'applied' : 'ignored_precedence',
    };
  }
}
