import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationPolicyDecision,
  type NotificationProjectionClassification,
  type TrustedNotificationSourceRow,
} from './types.ts';
import {
  NOTIFICATION_PROJECTOR_VERSION,
  NOTIFICATION_POLICY_VERSION,
  NotificationContractError,
  createNotificationCursorPayload,
  decodeNotificationCursor,
  encodeNotificationCursor,
  parseNotificationProjectionInput,
  type NotificationProjectionInput,
} from './contract.ts';
import {
  canonicalNotificationPayloadJson,
  materializeNotificationPayload,
  notificationIntentId,
  notificationPayloadFingerprint,
  notificationSourceDedupKey,
} from './payload.ts';
import { evaluateNotificationPolicy } from './policy.ts';
import type { NotificationPolicyResult } from './policy.ts';
import type {
  NotificationProjectionSource,
  NotificationRepository,
} from './repository.ts';
import { isCanonicalUtcInstant } from '../coordinator/contract.ts';

const PROJECTION_LEASE_MS = 5 * 60 * 1_000;

export type NotificationProjectorRuntime = {
  now(): string;
  leaseToken(): string;
};

export type NotificationProjectionItemReport = {
  evaluationRunId: number;
  forecastId: number;
  category: NotificationCategory | null;
  classification: NotificationProjectionClassification;
  reasonCode: string;
  policyDecision: NotificationPolicyDecision | null;
  intentWouldBeCreated: boolean;
  intentCreated: boolean;
};

export type NotificationProjectionReport = {
  projectorVersion: typeof NOTIFICATION_PROJECTOR_VERSION;
  profileId: number;
  cutoff: string;
  mode: 'dry_run' | 'commit';
  disposition:
    | 'baseline_would_be_established'
    | 'baseline_established'
    | 'page_completed'
    | 'overlap_rejected';
  baselineEvaluationRunId: number;
  startingEvaluationRunId: number;
  endingEvaluationRunId: number;
  selectedCount: number;
  processedCount: number;
  materializedCount: number;
  excludedCount: number;
  invalidSourceCount: number;
  hasMore: boolean;
  stoppedByCutoff: boolean;
  nextCursor: string | null;
  items: NotificationProjectionItemReport[];
  warnings: string[];
};

export type NotificationHistoricalPreviewInput = {
  profileId: number;
  fromEvaluationRunId: number;
  throughEvaluationRunId: number;
  cutoff: string;
  limit: number;
  includeNeedsReview: boolean;
};

export class NotificationProjectionSystemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationProjectionSystemError';
  }
}

function canonicalInstant(value: string, label: string) {
  if (!isCanonicalUtcInstant(value)) {
    throw new NotificationProjectionSystemError(`Notification runtime returned an invalid ${label}.`);
  }
  return value;
}

function canonicalInstantOrNull(value: string) {
  return isCanonicalUtcInstant(value) ? value : null;
}

function leaseExpiry(acquiredAt: string) {
  return new Date(Date.parse(acquiredAt) + PROJECTION_LEASE_MS).toISOString();
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function entityId(domain: string, sourceKey: string) {
  return sha256(JSON.stringify({ domain, sourceKey }));
}

function supportedCategory(value: string): value is NotificationCategory {
  return NOTIFICATION_CATEGORIES.includes(value as NotificationCategory);
}

function sourceForPayload(source: NotificationProjectionSource): TrustedNotificationSourceRow {
  if (source.reviewItemId === null || source.reviewKind === null) {
    throw new NotificationContractError(
      'A notification source requires its durable review item.',
      'invalid_source',
    );
  }
  return {
    ...source,
    reviewItemId: source.reviewItemId,
    reviewKind: source.reviewKind,
  };
}

function excludedReport(
  source: NotificationProjectionSource,
  classification: Exclude<NotificationProjectionClassification, 'intent_materialized'>,
  reasonCode: string,
): NotificationProjectionItemReport {
  return {
    evaluationRunId: source.evaluationRunId,
    forecastId: source.forecastId,
    category: null,
    classification,
    reasonCode,
    policyDecision: null,
    intentWouldBeCreated: false,
    intentCreated: false,
  };
}

function counts(items: NotificationProjectionItemReport[]) {
  return {
    materializedCount: items.filter((item) => item.classification === 'intent_materialized').length,
    excludedCount: items.filter((item) => item.classification.startsWith('excluded_')).length,
    invalidSourceCount: items.filter((item) => item.classification === 'invalid_source_needs_review').length,
  };
}

export class NotificationProjectorService {
  private readonly repository: NotificationRepository;
  private readonly runtime: NotificationProjectorRuntime;

  constructor(repository: NotificationRepository, runtime: NotificationProjectorRuntime) {
    this.repository = repository;
    this.runtime = runtime;
  }

  private now(label: string) {
    return canonicalInstant(this.runtime.now(), label);
  }

  private async cursor(
    profileId: number,
    cutoff: string,
    after: { evaluationRunId: number; createdAt: string | null } | null,
  ) {
    return encodeNotificationCursor(createNotificationCursorPayload({ profileId, cutoff, after }));
  }

  private async classify(
    source: NotificationProjectionSource,
    profileId: number,
    decisionAt: string,
    historicalCutoverSuppressed: boolean,
  ) {
    if (source.resultKind === 'no_change') {
      return {
        report: excludedReport(source, 'excluded_no_change', 'evaluation_result_no_change'),
        persist: null,
      };
    }
    if (!supportedCategory(source.resultKind)) {
      return {
        report: excludedReport(source, 'excluded_unsupported', 'evaluation_result_not_notification_eligible'),
        persist: null,
      };
    }

    let payload;
    try {
      payload = materializeNotificationPayload(sourceForPayload(source));
    } catch {
      return {
        report: excludedReport(
          source,
          'invalid_source_needs_review',
          'trusted_source_validation_failed',
        ),
        persist: null,
      };
    }
    // Persistence, policy-runtime, and cryptographic failures are operational.
    // They must stop this source without advancing it as malformed evidence.
    const preferences = await this.repository.getCurrentPreference(profileId);
    const policy = evaluateNotificationPolicy({
      policyVersion: NOTIFICATION_POLICY_VERSION,
      decisionAt,
      trustedProfileId: profileId,
      category: payload.category,
      sourceValid: true,
      historicalCutoverSuppressed,
      preferences,
    });
    if (policy.decision === 'invalid_source_needs_review') {
      throw new NotificationProjectionSystemError('Validated notification source produced an invalid policy decision.');
    }
    const persistedPolicy = policy as Omit<NotificationPolicyResult, 'decision'> & {
      decision: Exclude<NotificationPolicyDecision, 'invalid_source_needs_review'>;
    };
    const payloadJson = canonicalNotificationPayloadJson(payload);
    const [dedupKey, intentId, payloadFingerprint] = await Promise.all([
      notificationSourceDedupKey(payload),
      notificationIntentId(payload),
      notificationPayloadFingerprint(payload),
    ]);
    return {
      report: {
        evaluationRunId: source.evaluationRunId,
        forecastId: source.forecastId,
        category: payload.category,
        classification: 'intent_materialized' as const,
        reasonCode: policy.reason,
        policyDecision: policy.decision,
        intentWouldBeCreated: true,
        intentCreated: false,
      },
      persist: {
        payload,
        payloadJson,
        payloadFingerprint,
        dedupKey,
        intentId,
        policy: persistedPolicy,
      },
    };
  }

  async project(value: unknown, trustedProfileId: number): Promise<NotificationProjectionReport> {
    const input = parseNotificationProjectionInput(value, trustedProfileId);
    if (!await this.repository.hasSchema()) {
      throw new NotificationProjectionSystemError('Notification persistence schema is unavailable.');
    }
    const existing = await this.repository.getBaseline(input.profileId, NOTIFICATION_PROJECTOR_VERSION);
    if (!existing) {
      const prospective = await this.repository.prospectiveBaseline(input.profileId);
      if (input.mode === 'dry_run') {
        return {
          projectorVersion: NOTIFICATION_PROJECTOR_VERSION,
          profileId: input.profileId,
          cutoff: input.cutoff,
          mode: input.mode,
          disposition: 'baseline_would_be_established',
          baselineEvaluationRunId: prospective,
          startingEvaluationRunId: prospective,
          endingEvaluationRunId: prospective,
          selectedCount: 0,
          processedCount: 0,
          materializedCount: 0,
          excludedCount: 0,
          invalidSourceCount: 0,
          hasMore: false,
          stoppedByCutoff: false,
          nextCursor: null,
          items: [],
          warnings: ['First commit establishes a high-water mark and creates no notification intents.'],
        };
      }
      if (input.cursor) {
        throw new NotificationContractError('A baseline-establishing commit cannot accept a cursor.', 'invalid_cursor');
      }
      const checkpoint = await this.repository.createBaseline(
        input.profileId,
        NOTIFICATION_PROJECTOR_VERSION,
        this.now('baseline activation time'),
      );
      return {
        projectorVersion: NOTIFICATION_PROJECTOR_VERSION,
        profileId: input.profileId,
        cutoff: input.cutoff,
        mode: input.mode,
        disposition: 'baseline_established',
        baselineEvaluationRunId: checkpoint.baselineEvaluationRunId,
        startingEvaluationRunId: checkpoint.lastEvaluationRunId,
        endingEvaluationRunId: checkpoint.lastEvaluationRunId,
        selectedCount: 0,
        processedCount: 0,
        materializedCount: 0,
        excludedCount: 0,
        invalidSourceCount: 0,
        hasMore: false,
        stoppedByCutoff: false,
        nextCursor: null,
        items: [],
        warnings: ['Projection baseline established; pre-existing evaluations were not materialized.'],
      };
    }

    const decoded = input.cursor
      ? await decodeNotificationCursor(input.cursor, { profileId: input.profileId, cutoff: input.cutoff })
      : null;
    const requestedAfter = decoded?.after?.evaluationRunId ?? existing.lastEvaluationRunId;
    if (input.mode === 'commit' && requestedAfter !== existing.lastEvaluationRunId) {
      throw new NotificationContractError('Commit cursor does not match durable projection progress.', 'invalid_cursor');
    }
    if (requestedAfter < existing.baselineEvaluationRunId) {
      throw new NotificationContractError('Projection cursor precedes the notification baseline.', 'invalid_cursor');
    }

    let leaseToken: string | null = null;
    if (input.mode === 'commit') {
      leaseToken = this.runtime.leaseToken();
      if (!leaseToken || leaseToken.length > 200) {
        throw new NotificationProjectionSystemError('Notification runtime returned an invalid lease token.');
      }
      const acquiredAt = this.now('projection lease acquisition time');
      const acquired = await this.repository.acquireProjectionLease(
        input.profileId,
        NOTIFICATION_PROJECTOR_VERSION,
        leaseToken,
        acquiredAt,
        leaseExpiry(acquiredAt),
      );
      if (!acquired) {
        return {
          projectorVersion: NOTIFICATION_PROJECTOR_VERSION,
          profileId: input.profileId,
          cutoff: input.cutoff,
          mode: input.mode,
          disposition: 'overlap_rejected',
          baselineEvaluationRunId: existing.baselineEvaluationRunId,
          startingEvaluationRunId: existing.lastEvaluationRunId,
          endingEvaluationRunId: existing.lastEvaluationRunId,
          selectedCount: 0,
          processedCount: 0,
          materializedCount: 0,
          excludedCount: 0,
          invalidSourceCount: 0,
          hasMore: true,
          stoppedByCutoff: false,
          nextCursor: null,
          items: [],
          warnings: ['Another projector owns the active projection lease.'],
        };
      }
    }

    let lastEvaluationRunId = requestedAfter;
    let lastPosition = decoded?.after ?? null;
    const items: NotificationProjectionItemReport[] = [];
    try {
      const page = await this.repository.selectSources(
        input.profileId,
        requestedAfter,
        input.cutoff,
        input.limit,
      );
      for (const source of page.sources) {
        const processedAt = this.now('projection item time');
        const classified = await this.classify(source, input.profileId, processedAt, false);
        if (input.mode === 'commit') {
          const token = leaseToken as string;
          const renewed = await this.repository.renewProjectionLease(
            input.profileId,
            NOTIFICATION_PROJECTOR_VERSION,
            token,
            processedAt,
            leaseExpiry(processedAt),
          );
          if (!renewed) throw new NotificationProjectionSystemError('Notification projection lease was lost.');
          const projectionItemId = await entityId(
            'notification_projection_item',
            `${NOTIFICATION_PROJECTOR_VERSION}:${input.profileId}:${source.evaluationRunId}`,
          );
          if (classified.persist) {
            const policyDecisionId = await entityId('notification_policy_decision', classified.persist.intentId);
            const outboxId = await entityId('notification_outbox', classified.persist.intentId);
            const result = await this.repository.materialize({
              profileId: input.profileId,
              projectorVersion: NOTIFICATION_PROJECTOR_VERSION,
              expectedLastEvaluationRunId: lastEvaluationRunId,
              leaseToken: token,
              leaseCheckedAt: processedAt,
              projectionItemId,
              intentId: classified.persist.intentId,
              policyDecisionId,
              outboxId,
              dedupKey: classified.persist.dedupKey,
              payloadJson: classified.persist.payloadJson,
              payloadFingerprint: classified.persist.payloadFingerprint,
              payload: classified.persist.payload,
              policy: classified.persist.policy,
              processedAt,
            });
            if (!result.committed) {
              throw new NotificationProjectionSystemError('Notification materialization did not advance durable progress.');
            }
            classified.report.intentCreated = result.intentCreated;
          } else {
            const committed = await this.repository.recordProjectionDecision({
              profileId: input.profileId,
              projectorVersion: NOTIFICATION_PROJECTOR_VERSION,
              expectedLastEvaluationRunId: lastEvaluationRunId,
              leaseToken: token,
              leaseCheckedAt: processedAt,
              projectionItemId,
              evaluationRunId: source.evaluationRunId,
              sourceCreatedAt: source.createdAt,
              classification: classified.report.classification as Exclude<NotificationProjectionClassification, 'intent_materialized'>,
              reasonCode: classified.report.reasonCode,
              warnings: [],
              processedAt,
            });
            if (!committed) {
              throw new NotificationProjectionSystemError('Notification exclusion did not advance durable progress.');
            }
          }
        }
        items.push(classified.report);
        lastEvaluationRunId = source.evaluationRunId;
        lastPosition = {
          evaluationRunId: source.evaluationRunId,
          createdAt: canonicalInstantOrNull(source.createdAt),
        };
      }
      const nextCursor = lastPosition && items.length
        ? await this.cursor(input.profileId, input.cutoff, lastPosition)
        : input.cursor ?? null;
      const totals = counts(items);
      return {
        projectorVersion: NOTIFICATION_PROJECTOR_VERSION,
        profileId: input.profileId,
        cutoff: input.cutoff,
        mode: input.mode,
        disposition: 'page_completed',
        baselineEvaluationRunId: existing.baselineEvaluationRunId,
        startingEvaluationRunId: requestedAfter,
        endingEvaluationRunId: lastEvaluationRunId,
        selectedCount: page.sources.length,
        processedCount: items.length,
        ...totals,
        hasMore: page.hasMore,
        stoppedByCutoff: page.blockedByCutoff !== null,
        nextCursor,
        items,
        warnings: page.blockedByCutoff
          ? ['Projection stopped before a lower evaluation-run ID created after the cutoff.']
          : [],
      };
    } finally {
      if (leaseToken) {
        const releasedAt = this.now('projection lease release time');
        await this.repository.releaseProjectionLease(
          input.profileId,
          NOTIFICATION_PROJECTOR_VERSION,
          leaseToken,
          releasedAt,
        );
      }
    }
  }

  async previewHistoricalBackfill(
    input: NotificationHistoricalPreviewInput,
    trustedProfileId: number,
  ): Promise<NotificationProjectionReport> {
    const parsed: NotificationProjectionInput = parseNotificationProjectionInput({
      profileId: input.profileId,
      cutoff: input.cutoff,
      limit: input.limit,
      mode: 'dry_run',
    }, trustedProfileId);
    if (!Number.isSafeInteger(input.fromEvaluationRunId) || input.fromEvaluationRunId <= 0
      || !Number.isSafeInteger(input.throughEvaluationRunId)
      || input.throughEvaluationRunId < input.fromEvaluationRunId
      || typeof input.includeNeedsReview !== 'boolean') {
      throw new NotificationContractError('Historical preview bounds are invalid.', 'invalid_input');
    }
    if (!await this.repository.hasSchema()) {
      throw new NotificationProjectionSystemError('Notification persistence schema is unavailable.');
    }
    const page = await this.repository.selectSources(
      parsed.profileId,
      input.fromEvaluationRunId - 1,
      parsed.cutoff,
      parsed.limit,
    );
    const bounded = page.sources.filter((source) => source.evaluationRunId <= input.throughEvaluationRunId);
    const items: NotificationProjectionItemReport[] = [];
    for (const source of bounded) {
      if (source.resultKind === 'needs_review' && !input.includeNeedsReview) {
        items.push(excludedReport(source, 'excluded_unsupported', 'historical_needs_review_not_explicitly_included'));
        continue;
      }
      items.push((await this.classify(
        source,
        parsed.profileId,
        this.now('historical preview item time'),
        true,
      )).report);
    }
    const totals = counts(items);
    const endingEvaluationRunId = bounded.at(-1)?.evaluationRunId ?? input.fromEvaluationRunId - 1;
    const crossedUpperBound = page.sources.some(
      (source) => source.evaluationRunId > input.throughEvaluationRunId,
    );
    const hasMoreWithinBounds = !crossedUpperBound && page.hasMore
      && endingEvaluationRunId < input.throughEvaluationRunId;
    return {
      projectorVersion: NOTIFICATION_PROJECTOR_VERSION,
      profileId: parsed.profileId,
      cutoff: parsed.cutoff,
      mode: 'dry_run',
      disposition: 'page_completed',
      baselineEvaluationRunId: 0,
      startingEvaluationRunId: input.fromEvaluationRunId - 1,
      endingEvaluationRunId,
      selectedCount: bounded.length,
      processedCount: items.length,
      ...totals,
      hasMore: hasMoreWithinBounds,
      stoppedByCutoff: page.blockedByCutoff !== null,
      nextCursor: null,
      items,
      warnings: ['Historical backfill is preview-only in Phase 2C2A and performed no writes.'],
    };
  }
}
