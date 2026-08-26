import { isCanonicalUtcInstant, isPositiveSafeInteger } from '../coordinator/contract.ts';
import {
  NOTIFICATION_PAYLOAD_SCHEMA_VERSION,
} from '../notifications/contract.ts';
import {
  canonicalNotificationPayloadJson,
  notificationPayloadFingerprint,
} from '../notifications/payload.ts';
import {
  IN_APP_MAX_PROJECTION_LIMIT,
  IN_APP_PRESENTATION_VERSION,
  IN_APP_PROJECTOR_VERSION,
  InAppNotificationError,
  decodeHighWater,
  decodeListCursor,
  encodeHighWater,
  encodeListCursor,
  type InAppListInput,
} from './contract.ts';
import { buildInAppPresentation, mapEmailStatus, parseStoredInAppPresentation } from './presentation.ts';
import {
  D1InAppNotificationRepository,
  type InAppIntentSource,
  type PersistProjectionInput,
} from './repository.ts';
import type { InAppEntry, InAppListResult } from './types.ts';

const LEASE_MS = 5 * 60_000;

export type InAppRuntime = { now(): string; token(): string };
export type InAppCrypto = {
  sha256(value: string): Promise<string>;
  notificationPayloadFingerprint(value: Parameters<typeof notificationPayloadFingerprint>[0]): Promise<string>;
};

export type InAppProjectionInput = {
  profileId: number;
  cutoff: string;
  limit?: number;
  mode?: 'dry_run' | 'commit';
};

export type InAppBackfillInput = InAppProjectionInput & {
  fromEvaluationRunId: number;
  throughEvaluationRunId: number;
};

export type InAppProjectionItem = {
  sourceIntentId: string;
  evaluationRunId: number;
  classification: 'materialized' | 'duplicate' | 'unsupported_source' | 'malformed_source';
  reasonCode: string;
  entryWouldBeCreated: boolean;
};

export type InAppProjectionReport = {
  projectorVersion: typeof IN_APP_PROJECTOR_VERSION;
  presentationVersion: typeof IN_APP_PRESENTATION_VERSION;
  mode: 'dry_run' | 'commit';
  operation: 'forward' | 'historical_backfill';
  disposition: 'baseline_would_be_established' | 'baseline_established' | 'page_completed' | 'overlap_rejected';
  baselineEvaluationRunId: number;
  startingEvaluationRunId: number;
  endingEvaluationRunId: number;
  selectedCount: number;
  materializedCount: number;
  duplicateCount: number;
  invalidSourceCount: number;
  unsupportedSourceCount: number;
  hasMore: boolean;
  stoppedByCutoff: boolean;
  items: InAppProjectionItem[];
  warnings: string[];
};

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function now(runtime: InAppRuntime) {
  const value = runtime.now();
  if (!isCanonicalUtcInstant(value)) throw new Error('InAppRuntimeInvalidClock');
  return value;
}

function parseProjectionInput(value: InAppProjectionInput, trustedProfileId: number) {
  if (!isPositiveSafeInteger(trustedProfileId) || value.profileId !== trustedProfileId) {
    throw new InAppNotificationError('Notification profile does not match the trusted context.');
  }
  if (!isCanonicalUtcInstant(value.cutoff)) {
    throw new InAppNotificationError('cutoff must be a canonical UTC instant.');
  }
  const limit = value.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > IN_APP_MAX_PROJECTION_LIMIT) {
    throw new InAppNotificationError(`limit must be from 1 through ${IN_APP_MAX_PROJECTION_LIMIT}.`);
  }
  const mode = value.mode ?? 'dry_run';
  if (mode !== 'dry_run' && mode !== 'commit') throw new InAppNotificationError('mode is invalid.');
  return { ...value, limit, mode } as const;
}

async function classify(source: InAppIntentSource, processedAt: string, cryptoRuntime: InAppCrypto): Promise<{
  item: InAppProjectionItem;
  persist: Omit<PersistProjectionInput, 'profileId' | 'projectorVersion' | 'expectedLastEvaluationRunId'
    | 'expectedLastIntentId' | 'sourceEvaluationRunId' | 'sourceIntentId'
    | 'leaseToken' | 'checkedAt'>;
}> {
  const projectionItemId = await cryptoRuntime.sha256(JSON.stringify({
    domain: 'forecast_in_app_projection_item',
    projectorVersion: IN_APP_PROJECTOR_VERSION,
    profileId: source.profileId,
    sourceIntentId: source.id,
  }));
  const invalid = (classification: 'unsupported_source' | 'malformed_source', reasonCode: string) => ({
    item: {
      sourceIntentId: source.id,
      evaluationRunId: source.evaluationRunId,
      classification,
      reasonCode,
      entryWouldBeCreated: false,
    },
    persist: {
      projectionItemId,
      source,
      entry: null,
      classification,
      reasonCode,
      processedAt,
    },
  });
  if (!/^[a-f0-9]{64}$/u.test(source.id)) {
    return invalid('malformed_source', 'source_intent_id_invalid');
  }
  if (!isCanonicalUtcInstant(source.createdAt)) {
    return invalid('malformed_source', 'source_created_at_invalid');
  }
  if (source.payloadSchemaVersion !== NOTIFICATION_PAYLOAD_SCHEMA_VERSION) {
    return invalid('unsupported_source', 'unsupported_payload_schema');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.payloadJson) as unknown;
  } catch {
    return invalid('malformed_source', 'payload_json_invalid');
  }
  let built: ReturnType<typeof buildInAppPresentation>;
  try { built = buildInAppPresentation(parsed); }
  catch {
    return invalid('malformed_source', 'presentation_validation_failed');
  }
  const { payload, presentation } = built;
  const fingerprint = await cryptoRuntime.notificationPayloadFingerprint(payload);
  if (fingerprint !== source.payloadFingerprint
    || canonicalNotificationPayloadJson(payload) !== source.payloadJson
    || payload.profileId !== source.profileId || payload.forecastId !== source.forecastId
    || payload.evaluationRunId !== source.evaluationRunId || payload.reviewItemId !== source.reviewItemId
    || payload.analysisSnapshotId !== source.analysisSnapshotId || payload.category !== source.category
    || payload.occurredAt !== source.eventOccurredAt) {
    return invalid('malformed_source', 'intent_identity_or_fingerprint_mismatch');
  }
  const presentationJson = JSON.stringify(presentation);
  const entryId = await cryptoRuntime.sha256(JSON.stringify({
    domain: 'forecast_in_app_entry',
    projectorVersion: IN_APP_PROJECTOR_VERSION,
    profileId: source.profileId,
    sourceIntentId: source.id,
  }));
  return {
    item: {
      sourceIntentId: source.id,
      evaluationRunId: source.evaluationRunId,
      classification: 'materialized',
      reasonCode: 'trusted_intent_materialized',
      entryWouldBeCreated: true,
    },
    persist: {
      projectionItemId,
      source,
      entry: {
        id: entryId,
        symbol: payload.symbol,
        occurredAt: payload.occurredAt,
        presentationVersion: IN_APP_PRESENTATION_VERSION,
        presentationJson,
        presentationFingerprint: await cryptoRuntime.sha256(presentationJson),
      },
      classification: 'materialized',
      reasonCode: 'trusted_intent_materialized',
      processedAt,
    },
  };
}

function counts(items: InAppProjectionItem[]) {
  return {
    materializedCount: items.filter((item) => item.classification === 'materialized').length,
    duplicateCount: items.filter((item) => item.classification === 'duplicate').length,
    invalidSourceCount: items.filter((item) => item.classification === 'malformed_source').length,
    unsupportedSourceCount: items.filter((item) => item.classification === 'unsupported_source').length,
  };
}

function baseReport(input: {
  mode: 'dry_run' | 'commit'; operation: 'forward' | 'historical_backfill';
  disposition: InAppProjectionReport['disposition']; baseline: number; start: number;
  end: number; items: InAppProjectionItem[]; hasMore: boolean; stoppedByCutoff: boolean;
  warnings?: string[];
}): InAppProjectionReport {
  return {
    projectorVersion: IN_APP_PROJECTOR_VERSION,
    presentationVersion: IN_APP_PRESENTATION_VERSION,
    mode: input.mode,
    operation: input.operation,
    disposition: input.disposition,
    baselineEvaluationRunId: input.baseline,
    startingEvaluationRunId: input.start,
    endingEvaluationRunId: input.end,
    selectedCount: input.items.length,
    ...counts(input.items),
    hasMore: input.hasMore,
    stoppedByCutoff: input.stoppedByCutoff,
    items: input.items,
    warnings: input.warnings ?? [],
  };
}

export class InAppNotificationService {
  private readonly repository: D1InAppNotificationRepository;
  private readonly runtime: InAppRuntime;
  private readonly cryptoRuntime: InAppCrypto;

  constructor(repository: D1InAppNotificationRepository, runtime: InAppRuntime, cryptoRuntime: InAppCrypto = {
    sha256,
    notificationPayloadFingerprint,
  }) {
    this.repository = repository;
    this.runtime = runtime;
    this.cryptoRuntime = cryptoRuntime;
  }

  async project(value: InAppProjectionInput, trustedProfileId: number): Promise<InAppProjectionReport> {
    const input = parseProjectionInput(value, trustedProfileId);
    if (!await this.repository.hasSchema()) throw new InAppNotificationError(
      'In-app notification schema is unavailable.', 'schema_unavailable', 503,
    );
    const existing = await this.repository.getCheckpoint(input.profileId, IN_APP_PROJECTOR_VERSION);
    if (!existing) {
      const prospective = await this.repository.prospectiveBaseline(input.profileId);
      if (input.mode === 'dry_run') return baseReport({
        mode: input.mode, operation: 'forward', disposition: 'baseline_would_be_established',
        baseline: prospective.evaluationRunId, start: prospective.evaluationRunId,
        end: prospective.evaluationRunId, items: [], hasMore: false,
        stoppedByCutoff: false,
        warnings: ['First commit establishes an intent high-water mark and creates no entries.'],
      });
      const checkpoint = await this.repository.createBaseline(
        input.profileId, IN_APP_PROJECTOR_VERSION, now(this.runtime),
      );
      return baseReport({
        mode: input.mode, operation: 'forward', disposition: 'baseline_established',
        baseline: checkpoint.baselineEvaluationRunId, start: checkpoint.lastEvaluationRunId,
        end: checkpoint.lastEvaluationRunId, items: [], hasMore: false, stoppedByCutoff: false,
        warnings: ['Projection baseline established; pre-existing intents were not materialized.'],
      });
    }

    let leaseToken: string | null = null;
    if (input.mode === 'commit') {
      leaseToken = this.runtime.token();
      if (!leaseToken || leaseToken.length > 200) throw new Error('InAppRuntimeInvalidToken');
      const acquiredAt = now(this.runtime);
      const acquired = await this.repository.acquireLease(
        input.profileId, IN_APP_PROJECTOR_VERSION, leaseToken, acquiredAt,
        new Date(Date.parse(acquiredAt) + LEASE_MS).toISOString(),
      );
      if (!acquired) return baseReport({
        mode: input.mode, operation: 'forward', disposition: 'overlap_rejected',
        baseline: existing.baselineEvaluationRunId, start: existing.lastEvaluationRunId,
        end: existing.lastEvaluationRunId, items: [], hasMore: true, stoppedByCutoff: false,
        warnings: ['Another projector owns the active lease.'],
      });
    }

    const items: InAppProjectionItem[] = [];
    let lastEvaluationRunId = existing.lastEvaluationRunId;
    let lastIntentId = existing.lastIntentId;
    let stoppedByCutoff = false;
    let hasMore = false;
    try {
      const page = await this.repository.selectSources(
        input.profileId, lastEvaluationRunId, lastIntentId, input.limit,
      );
      hasMore = page.hasMore;
      for (const source of page.sources) {
        if (isCanonicalUtcInstant(source.createdAt) && source.createdAt > input.cutoff) {
          stoppedByCutoff = true; hasMore = true; break;
        }
        const processedAt = now(this.runtime);
        const classified = await classify(source, processedAt, this.cryptoRuntime);
        if (input.mode === 'commit') {
          const persisted = await this.repository.persistProjection({
            ...classified.persist,
            profileId: input.profileId,
            projectorVersion: IN_APP_PROJECTOR_VERSION,
            expectedLastEvaluationRunId: lastEvaluationRunId,
            expectedLastIntentId: lastIntentId,
            sourceEvaluationRunId: source.evaluationRunId,
            sourceIntentId: source.id,
            leaseToken: leaseToken as string,
            checkedAt: processedAt,
          });
          if (classified.persist.entry && !persisted.entryCreated) {
            classified.item.classification = 'duplicate';
            classified.item.reasonCode = 'trusted_intent_already_materialized';
            classified.item.entryWouldBeCreated = false;
          }
        }
        items.push(classified.item);
        lastEvaluationRunId = source.evaluationRunId;
        lastIntentId = source.id;
      }
      return baseReport({
        mode: input.mode, operation: 'forward', disposition: 'page_completed',
        baseline: existing.baselineEvaluationRunId, start: existing.lastEvaluationRunId,
        end: lastEvaluationRunId, items, hasMore, stoppedByCutoff,
      });
    } finally {
      if (leaseToken) await this.repository.releaseLease(
        input.profileId, IN_APP_PROJECTOR_VERSION, leaseToken, now(this.runtime),
      );
    }
  }

  async backfill(value: InAppBackfillInput, trustedProfileId: number) {
    const input = parseProjectionInput(value, trustedProfileId);
    if (!isPositiveSafeInteger(value.fromEvaluationRunId)
      || !isPositiveSafeInteger(value.throughEvaluationRunId)
      || value.throughEvaluationRunId < value.fromEvaluationRunId) {
      throw new InAppNotificationError('Historical bounds are invalid.');
    }
    if (!await this.repository.hasSchema()) throw new InAppNotificationError(
      'In-app notification schema is unavailable.', 'schema_unavailable', 503,
    );
    const checkpoint = await this.repository.getCheckpoint(input.profileId, IN_APP_PROJECTOR_VERSION);
    if (!checkpoint) throw new InAppNotificationError(
      'Establish the forward projection baseline before historical backfill.', 'conflict', 409,
    );
    const page = await this.repository.selectHistoricalSources(
      input.profileId, value.fromEvaluationRunId, value.throughEvaluationRunId,
      input.cutoff, input.limit,
      IN_APP_PROJECTOR_VERSION,
    );
    const items: InAppProjectionItem[] = [];
    for (const source of page.sources) {
      const classified = await classify(source, now(this.runtime), this.cryptoRuntime);
      if (input.mode === 'commit') {
        const persisted = await this.repository.persistHistorical({
          ...classified.persist,
          profileId: input.profileId,
          projectorVersion: IN_APP_PROJECTOR_VERSION,
        });
        if (classified.persist.entry && !persisted.entryCreated) {
          classified.item.classification = 'duplicate';
          classified.item.reasonCode = 'trusted_intent_already_materialized';
          classified.item.entryWouldBeCreated = false;
        }
      }
      items.push(classified.item);
    }
    return baseReport({
      mode: input.mode, operation: 'historical_backfill', disposition: 'page_completed',
      baseline: checkpoint.baselineEvaluationRunId, start: value.fromEvaluationRunId - 1,
      end: items.at(-1)?.evaluationRunId ?? value.fromEvaluationRunId - 1,
      items, hasMore: page.hasMore, stoppedByCutoff: false,
      warnings: input.mode === 'dry_run'
        ? ['Historical preview performed no writes.']
        : ['Historical entries were materialized without moving the forward checkpoint.'],
    });
  }

  private async entry(row: Awaited<ReturnType<D1InAppNotificationRepository['get']>> extends infer R
    ? Exclude<R, null> : never): Promise<InAppEntry> {
    let parsed: unknown;
    try { parsed = JSON.parse(row.presentationJson) as unknown; }
    catch { throw new Error('InAppStoredPresentationInvalid'); }
    const presentation = parseStoredInAppPresentation(parsed, row.presentationVersion);
    if (await this.cryptoRuntime.sha256(row.presentationJson) !== row.presentationFingerprint) {
      throw new Error('InAppStoredPresentationFingerprintMismatch');
    }
    return {
      id: row.id,
      category: row.category,
      symbol: row.symbol,
      state: row.state,
      occurredAt: row.occurredAt,
      firstReadAt: row.firstReadAt,
      presentation,
      deepLink: `/notifications/${row.id}`,
      email: mapEmailStatus(row.emailReconciliationState !== null
        && row.emailReconciliationState !== 'none' ? row.emailReconciliationState : row.emailState),
    };
  }

  async list(profileId: number, input: InAppListInput): Promise<InAppListResult> {
    const after = input.cursor ? await decodeListCursor(input.cursor, {
      profileId, state: input.state, category: input.category,
    }) : undefined;
    const snapshot = await this.repository.unreadSnapshot(profileId);
    const page = await this.repository.list(profileId, {
      ...input, highWaterSequence: snapshot.highWaterSequence, ...(after ? { after } : {}),
    });
    const last = page.rows.at(-1);
    return {
      items: await Promise.all(page.rows.map((row) => this.entry(row))),
      nextCursor: page.hasMore && last ? await encodeListCursor({
        profileId, state: input.state, category: input.category,
        after: { occurredAt: last.occurredAt, id: last.id },
      }) : null,
      unreadCount: snapshot.unreadCount,
      markAllReadToken: await encodeHighWater(profileId, snapshot.highWaterSequence),
    };
  }

  async get(profileId: number, id: string) {
    const row = await this.repository.get(profileId, id);
    if (!row) throw new InAppNotificationError('Notification entry was not found.', 'not_found', 404);
    return this.entry(row);
  }

  async detail(profileId: number, id: string) {
    const entry = await this.get(profileId, id);
    const evidence = await this.repository.getEvidence(profileId, id);
    return {
      entry,
      evidenceAvailable: Boolean(evidence),
      evidence: evidence ? {
        forecast: {
          id: evidence.forecastId,
          direction: evidence.direction,
          confidence: evidence.confidence,
          targetKind: evidence.targetKind,
          targetPrice: evidence.targetPrice,
          targetLower: evidence.targetLower,
          targetUpper: evidence.targetUpper,
          invalidationPrice: evidence.invalidationPrice,
          activatedAt: evidence.activatedAt,
          activationPrice: evidence.activationPrice,
          activationCurrency: evidence.activationCurrency,
          currentStatus: evidence.currentForecastStatus,
        },
        evaluation: {
          id: evidence.evaluationRunId,
          resultKind: evidence.resultKind,
          reasonCode: evidence.reasonCode,
          evaluatedThrough: evidence.evaluatedThrough,
          evaluationCutoff: evidence.evaluationCutoff,
          evaluatorVersion: evidence.evaluatorVersion,
          rulesetVersion: evidence.rulesetVersion,
        },
        review: {
          id: evidence.reviewItemId,
          kind: evidence.reviewKind,
          acknowledgedAt: evidence.acknowledgedAt,
        },
        analysisSnapshotId: evidence.analysisSnapshotId,
      } : null,
    };
  }

  async unreadCount(profileId: number) {
    const snapshot = await this.repository.unreadSnapshot(profileId);
    return {
      unreadCount: snapshot.unreadCount,
      markAllReadToken: await encodeHighWater(profileId, snapshot.highWaterSequence),
    };
  }

  async setState(profileId: number, id: string, state: 'read' | 'unread') {
    const result = await this.repository.setState(profileId, id, state, this.runtime.token(), now(this.runtime));
    if (!result.found) throw new InAppNotificationError('Notification entry was not found.', 'not_found', 404);
    return { entry: await this.get(profileId, id), ...(await this.unreadCount(profileId)) };
  }

  async markAllRead(profileId: number, token: string) {
    const highWater = await decodeHighWater(token, profileId);
    const changedCount = await this.repository.markAllRead(
      profileId, highWater, this.runtime.token(), now(this.runtime),
    );
    return { changedCount, ...(await this.unreadCount(profileId)) };
  }
}
