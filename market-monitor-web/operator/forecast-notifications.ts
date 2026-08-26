import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import {
  forecastEventUpgradeStatements,
  forecastInitializationStatements,
} from '../db/forecast-initialization.ts';
import { isCanonicalUtcInstant } from '../app/lib/server/coordinator/contract.ts';
import {
  NOTIFICATION_DEFAULT_PROJECTION_LIMIT,
  NOTIFICATION_MAX_CURSOR_LENGTH,
  NOTIFICATION_MAX_PROJECTION_LIMIT,
  NOTIFICATION_MIN_PROJECTION_LIMIT,
  NOTIFICATION_PROJECTOR_VERSION,
  NotificationContractError,
  type NotificationProjectionMode,
} from '../app/lib/server/notifications/contract.ts';
import {
  D1NotificationRepository,
  type NotificationAttemptRecord,
  type NotificationProjectionCheckpoint,
  type NotificationStatusCount,
  type NotificationStatusRow,
} from '../app/lib/server/notifications/repository.ts';
import {
  NotificationProjectorService,
  type NotificationHistoricalPreviewInput,
  type NotificationProjectionReport,
} from '../app/lib/server/notifications/service.ts';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_OUTBOX_STATES,
  type NotificationCategory,
  type NotificationOutboxState,
} from '../app/lib/server/notifications/types.ts';
import { trustedOperatorScope } from '../app/lib/server/auth/system.ts';
import { AuthorizedNotificationProjectorService } from '../app/lib/server/auth/system-services.ts';
import { profileIdFromScope } from '../app/lib/server/auth/enforcement.ts';

const CONFIG_PATH = fileURLToPath(new URL('./wrangler.operator.jsonc', import.meta.url));
const DEFAULT_PERSIST_PATH = '.wrangler/state/v3';
const DEFAULT_STATUS_LIMIT = 20;

export const PROJECT_USAGE = `Usage:
  npm run --silent forecast:notifications:project -- --cutoff <UTC> [options]

Required:
  --cutoff <UTC>  Canonical UTC instant with milliseconds and Z

Options:
  --limit <1-100>  Maximum trusted evaluation sources (default: ${NOTIFICATION_DEFAULT_PROJECTION_LIMIT})
  --cursor <token>  Opaque continuation cursor returned by an earlier projection
  --dry-run         Preview only; this is the default when no mode flag is supplied
  --commit          Explicitly persist projection decisions and outbox records
  --json            Print stable machine-readable JSON
  --help            Show this help without opening D1

The fixed profile is resolved internally. This command never sends a notification or calls a provider.`;

export const BACKFILL_USAGE = `Usage:
  npm run --silent forecast:notifications:backfill -- --from-id <id> --through-id <id> --cutoff <UTC> --confirm-historical-preview [options]

Required:
  --from-id <id>                  First evaluation-run ID in the bounded preview
  --through-id <id>               Last evaluation-run ID in the bounded preview
  --cutoff <UTC>                  Canonical UTC instant with milliseconds and Z
  --confirm-historical-preview    Confirm this is a preview of historical records

Options:
  --include-needs-review  Explicitly include historical needs-review sources
  --limit <1-100>         Maximum trusted evaluation sources (default: ${NOTIFICATION_DEFAULT_PROJECTION_LIMIT})
  --dry-run               Optional explicit preview mode; historical backfill is always dry-run
  --json                  Print stable machine-readable JSON
  --help                  Show this help without opening D1

Phase 2C2A historical backfill is preview-only. It performs no writes and never sends a notification.`;

export const STATUS_USAGE = `Usage:
  npm run --silent forecast:notifications:status -- [options]

Options:
  --state <state>        Filter by: ${NOTIFICATION_OUTBOX_STATES.join(', ')}
  --category <category>  Filter by: ${NOTIFICATION_CATEGORIES.join(', ')}
  --limit <1-100>        Recent outbox records to display (default: ${DEFAULT_STATUS_LIMIT})
  --json                 Print stable machine-readable JSON
  --help                 Show this help without opening D1

Status is local and read-only. Remote migration and future delivery-worker state remain unknown.`;

export class NotificationOperatorUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationOperatorUsageError';
  }
}

type ParsedFlags = Map<string, string | true>;

function parseFlags(argv: string[], valueFlags: ReadonlySet<string>, booleanFlags: ReadonlySet<string>) {
  const parsed: ParsedFlags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!valueFlags.has(flag) && !booleanFlags.has(flag)) {
      throw new NotificationOperatorUsageError(`Unknown argument: ${flag}`);
    }
    if (parsed.has(flag)) throw new NotificationOperatorUsageError(`Duplicate argument: ${flag}`);
    if (booleanFlags.has(flag)) {
      parsed.set(flag, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new NotificationOperatorUsageError(`${flag} requires a value.`);
    }
    parsed.set(flag, value);
    index += 1;
  }
  return parsed;
}

function bounded(value: string, flag: string, maximum: number) {
  if (!value || value.trim() !== value || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new NotificationOperatorUsageError(`${flag} is invalid.`);
  }
  return value;
}

function wholeNumber(
  value: string | true | undefined,
  flag: string,
  minimum: number,
  maximum: number,
  fallback?: number,
) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    throw new NotificationOperatorUsageError(`${flag} must be a whole number.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new NotificationOperatorUsageError(`${flag} must be from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function canonicalCutoff(value: string | true | undefined) {
  if (typeof value !== 'string' || !isCanonicalUtcInstant(value)) {
    throw new NotificationOperatorUsageError(
      '--cutoff must be a canonical UTC instant with millisecond precision.',
    );
  }
  return value;
}

export type NotificationProjectionOptions = {
  help: boolean;
  json: boolean;
  cutoff?: string;
  limit: number;
  mode: NotificationProjectionMode;
  cursor?: string;
};

export function parseProjectionArgs(argv: string[]): NotificationProjectionOptions {
  const values = parseFlags(
    argv,
    new Set(['--cutoff', '--limit', '--cursor']),
    new Set(['--dry-run', '--commit', '--json', '--help']),
  );
  if (values.has('--help')) {
    if (values.size !== 1) {
      throw new NotificationOperatorUsageError('--help cannot be combined with other arguments.');
    }
    return {
      help: true,
      json: false,
      limit: NOTIFICATION_DEFAULT_PROJECTION_LIMIT,
      mode: 'dry_run',
    };
  }
  if (values.has('--dry-run') && values.has('--commit')) {
    throw new NotificationOperatorUsageError('--dry-run and --commit cannot be combined.');
  }
  const cutoff = canonicalCutoff(values.get('--cutoff'));
  const limit = wholeNumber(
    values.get('--limit'),
    '--limit',
    NOTIFICATION_MIN_PROJECTION_LIMIT,
    NOTIFICATION_MAX_PROJECTION_LIMIT,
    NOTIFICATION_DEFAULT_PROJECTION_LIMIT,
  );
  const cursorValue = values.get('--cursor');
  const cursor = typeof cursorValue === 'string'
    ? bounded(cursorValue, '--cursor', NOTIFICATION_MAX_CURSOR_LENGTH)
    : undefined;
  return {
    help: false,
    json: values.has('--json'),
    cutoff,
    limit,
    mode: values.has('--commit') ? 'commit' : 'dry_run',
    ...(cursor ? { cursor } : {}),
  };
}

export type NotificationBackfillOptions = {
  help: boolean;
  json: boolean;
  cutoff?: string;
  fromEvaluationRunId?: number;
  throughEvaluationRunId?: number;
  limit: number;
  includeNeedsReview: boolean;
};

export function parseBackfillArgs(argv: string[]): NotificationBackfillOptions {
  const values = parseFlags(
    argv,
    new Set(['--from-id', '--through-id', '--cutoff', '--limit']),
    new Set(['--confirm-historical-preview', '--include-needs-review', '--dry-run', '--json', '--help']),
  );
  if (values.has('--help')) {
    if (values.size !== 1) {
      throw new NotificationOperatorUsageError('--help cannot be combined with other arguments.');
    }
    return {
      help: true,
      json: false,
      limit: NOTIFICATION_DEFAULT_PROJECTION_LIMIT,
      includeNeedsReview: false,
    };
  }
  if (!values.has('--confirm-historical-preview')) {
    throw new NotificationOperatorUsageError('--confirm-historical-preview is required.');
  }
  const cutoff = canonicalCutoff(values.get('--cutoff'));
  const fromEvaluationRunId = wholeNumber(
    values.get('--from-id'), '--from-id', 1, Number.MAX_SAFE_INTEGER,
  );
  const throughEvaluationRunId = wholeNumber(
    values.get('--through-id'), '--through-id', 1, Number.MAX_SAFE_INTEGER,
  );
  if (throughEvaluationRunId < fromEvaluationRunId) {
    throw new NotificationOperatorUsageError('--through-id must be greater than or equal to --from-id.');
  }
  const limit = wholeNumber(
    values.get('--limit'),
    '--limit',
    NOTIFICATION_MIN_PROJECTION_LIMIT,
    NOTIFICATION_MAX_PROJECTION_LIMIT,
    NOTIFICATION_DEFAULT_PROJECTION_LIMIT,
  );
  return {
    help: false,
    json: values.has('--json'),
    cutoff,
    fromEvaluationRunId,
    throughEvaluationRunId,
    limit,
    includeNeedsReview: values.has('--include-needs-review'),
  };
}

export type NotificationStatusOptions = {
  help: boolean;
  json: boolean;
  limit: number;
  state?: NotificationOutboxState;
  category?: NotificationCategory;
};

export function parseStatusArgs(argv: string[]): NotificationStatusOptions {
  const values = parseFlags(
    argv,
    new Set(['--state', '--category', '--limit']),
    new Set(['--json', '--help']),
  );
  if (values.has('--help')) {
    if (values.size !== 1) {
      throw new NotificationOperatorUsageError('--help cannot be combined with other arguments.');
    }
    return { help: true, json: false, limit: DEFAULT_STATUS_LIMIT };
  }
  const limit = wholeNumber(values.get('--limit'), '--limit', 1, 100, DEFAULT_STATUS_LIMIT);
  const stateValue = values.get('--state');
  if (stateValue !== undefined
    && (typeof stateValue !== 'string'
      || !NOTIFICATION_OUTBOX_STATES.includes(stateValue as NotificationOutboxState))) {
    throw new NotificationOperatorUsageError('--state must be a supported notification outbox state.');
  }
  const categoryValue = values.get('--category');
  if (categoryValue !== undefined
    && (typeof categoryValue !== 'string'
      || !NOTIFICATION_CATEGORIES.includes(categoryValue as NotificationCategory))) {
    throw new NotificationOperatorUsageError('--category must be a supported notification category.');
  }
  return {
    help: false,
    json: values.has('--json'),
    limit,
    ...(typeof stateValue === 'string' ? { state: stateValue as NotificationOutboxState } : {}),
    ...(typeof categoryValue === 'string'
      ? { category: categoryValue as NotificationCategory }
      : {}),
  };
}

function platformOptions() {
  return {
    configPath: CONFIG_PATH,
    persist: { path: process.env.NORTHSTAR_COORDINATOR_PERSIST_PATH || DEFAULT_PERSIST_PATH },
    remoteBindings: false,
  } as const;
}

async function initializeProjectionDatabase(d1: D1Database) {
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS investment_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_currency TEXT NOT NULL DEFAULT 'USD',
      cash_balance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`),
    ...forecastInitializationStatements().map((statement) => d1.prepare(statement)),
  ]);
  const eventTable = await d1.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'forecast_events'",
  ).first<{ sql: string }>();
  if (eventTable && !eventTable.sql.includes('evaluation_review_acknowledged')) {
    await d1.batch(forecastEventUpgradeStatements().map((statement) => d1.prepare(statement)));
  }
}

function projector(repository: D1NotificationRepository) {
  return new NotificationProjectorService(repository, {
    now: () => new Date().toISOString(),
    leaseToken: () => `notification_projector_${randomUUID()}`,
  });
}

export async function invokeNotificationProjection(options: NotificationProjectionOptions) {
  if (options.help || !options.cutoff) {
    throw new NotificationOperatorUsageError('A runnable notification projection is required.');
  }
  const platform = await getPlatformProxy<{ DB: D1Database }>(platformOptions());
  try {
    const d1 = platform.env.DB;
    if (!d1) throw new Error('MissingLocalD1Binding');
    const scope = trustedOperatorScope(process.env, 'notification_projection', 'forecast:notifications:project');
    const profileId = profileIdFromScope(scope, 'notification_projection');
    const repository = new D1NotificationRepository(d1);
    if (options.mode === 'commit') {
      await initializeProjectionDatabase(d1);
      const profile = await d1.prepare('SELECT id FROM investment_profiles WHERE id = ?')
        .bind(profileId).first<{ id: number }>();
      if (!profile) throw new Error('ConfiguredOperatorProfileUnavailable');
    }
    return await new AuthorizedNotificationProjectorService(scope, projector(repository)).project({
      cutoff: options.cutoff,
      limit: options.limit,
      mode: options.mode,
      ...(options.cursor ? { cursor: options.cursor } : {}),
    });
  } finally {
    await platform.dispose();
  }
}

export async function invokeNotificationBackfill(options: NotificationBackfillOptions) {
  if (options.help || !options.cutoff || options.fromEvaluationRunId === undefined
    || options.throughEvaluationRunId === undefined) {
    throw new NotificationOperatorUsageError('A runnable historical notification preview is required.');
  }
  const platform = await getPlatformProxy<{ DB: D1Database }>(platformOptions());
  try {
    const d1 = platform.env.DB;
    if (!d1) throw new Error('MissingLocalD1Binding');
    const scope = trustedOperatorScope(process.env, 'notification_projection', 'forecast:notifications:backfill');
    const repository = new D1NotificationRepository(d1);
    return await new AuthorizedNotificationProjectorService(scope, projector(repository)).previewHistoricalBackfill({
      fromEvaluationRunId: options.fromEvaluationRunId,
      throughEvaluationRunId: options.throughEvaluationRunId,
      cutoff: options.cutoff,
      limit: options.limit,
      includeNeedsReview: options.includeNeedsReview,
    } satisfies Omit<NotificationHistoricalPreviewInput, 'profileId'>);
  } finally {
    await platform.dispose();
  }
}

type VisibleAttempt = {
  id: string;
  attemptNumber: number;
  state: NotificationAttemptRecord['state'];
  retryPolicyVersion: string;
  adapterKind: string;
  adapterVersion: string;
  startedAt: string;
  finishedAt: string | null;
  failureClassification: NotificationAttemptRecord['failureClassification'];
  redactedErrorCategory: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
};

type VisibleStatusRow = NotificationStatusRow & { attempts: VisibleAttempt[] };

export type NotificationStatusReport = {
  state: 'inspection_ready' | 'configuration_error';
  localSchema: 'present' | 'missing';
  remoteMigrationState: 'unknown';
  deliveryWorkerState: 'not_configured';
  projectorVersion: typeof NOTIFICATION_PROJECTOR_VERSION;
  filters: {
    limit: number;
    state: NotificationOutboxState | null;
    category: NotificationCategory | null;
  };
  checkpoint: null | {
    baselineEvaluationRunId: number;
    lastEvaluationRunId: number;
    activatedAt: string;
    leaseExpiresAt: string | null;
    recoveryCount: number;
    createdAt: string;
    updatedAt: string;
  };
  counts: NotificationStatusCount[];
  outbox: VisibleStatusRow[];
};

function visibleCheckpoint(value: NotificationProjectionCheckpoint | null) {
  if (!value) return null;
  return {
    baselineEvaluationRunId: value.baselineEvaluationRunId,
    lastEvaluationRunId: value.lastEvaluationRunId,
    activatedAt: value.activatedAt,
    leaseExpiresAt: value.leaseExpiresAt,
    recoveryCount: value.recoveryCount,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function visibleAttempt(value: NotificationAttemptRecord): VisibleAttempt {
  return {
    id: value.id,
    attemptNumber: value.attemptNumber,
    state: value.state,
    retryPolicyVersion: value.retryPolicyVersion,
    adapterKind: value.adapterKind,
    adapterVersion: value.adapterVersion,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    failureClassification: value.failureClassification,
    redactedErrorCategory: value.redactedErrorCategory,
    nextAttemptAt: value.nextAttemptAt,
    createdAt: value.createdAt,
  };
}

function visibleStatusRow(value: NotificationStatusRow, attempts: NotificationAttemptRecord[]): VisibleStatusRow {
  return {
    outboxId: value.outboxId,
    intentId: value.intentId,
    category: value.category,
    state: value.state,
    policyDecision: value.policyDecision,
    policyReason: value.policyReason,
    preferenceRevision: value.preferenceRevision,
    eventOccurredAt: value.eventOccurredAt,
    availableAt: value.availableAt,
    attemptCount: value.attemptCount,
    leaseExpiresAt: value.leaseExpiresAt,
    lastAttemptAt: value.lastAttemptAt,
    succeededAt: value.succeededAt,
    deadLetteredAt: value.deadLetteredAt,
    lastFailureCategory: value.lastFailureCategory,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    attempts: attempts.map(visibleAttempt),
  };
}

export async function inspectNotificationStatus(
  options: NotificationStatusOptions,
): Promise<NotificationStatusReport> {
  if (options.help) {
    throw new NotificationOperatorUsageError('A runnable notification status inspection is required.');
  }
  const platform = await getPlatformProxy<{ DB: D1Database }>(platformOptions());
  try {
    const d1 = platform.env.DB;
    if (!d1) throw new Error('MissingLocalD1Binding');
    const scope = trustedOperatorScope(process.env, 'operator_status_inspect', 'forecast:notifications:status');
    const profileId = profileIdFromScope(scope, 'operator_status_inspect');
    const repository = new D1NotificationRepository(d1);
    const filters = {
      limit: options.limit,
      state: options.state ?? null,
      category: options.category ?? null,
    };
    if (!await repository.hasSchema()) {
      return {
        state: 'configuration_error',
        localSchema: 'missing',
        remoteMigrationState: 'unknown',
        deliveryWorkerState: 'not_configured',
        projectorVersion: NOTIFICATION_PROJECTOR_VERSION,
        filters,
        checkpoint: null,
        counts: [],
        outbox: [],
      };
    }
    const [checkpoint, rows, counts] = await Promise.all([
      repository.getBaseline(profileId, NOTIFICATION_PROJECTOR_VERSION),
      repository.listStatus(profileId, {
        limit: options.limit,
        ...(options.state ? { state: options.state } : {}),
        ...(options.category ? { category: options.category } : {}),
      }),
      repository.statusCounts(profileId),
    ]);
    const outbox = await Promise.all(rows.map(async (row) => visibleStatusRow(
      row,
      await repository.listAttempts(profileId, row.outboxId),
    )));
    return {
      state: 'inspection_ready',
      localSchema: 'present',
      remoteMigrationState: 'unknown',
      deliveryWorkerState: 'not_configured',
      projectorVersion: NOTIFICATION_PROJECTOR_VERSION,
      filters,
      checkpoint: visibleCheckpoint(checkpoint),
      counts,
      outbox,
    };
  } finally {
    await platform.dispose();
  }
}

function text(value: string | number | boolean | null) {
  return value === null ? 'none' : String(value);
}

export function renderProjectionHuman(report: NotificationProjectionReport) {
  const lines = [
    'Northstar notification projection',
    `Disposition: ${report.disposition} | mode=${report.mode} | cutoff=${report.cutoff}`,
    `Progress: baseline=${report.baselineEvaluationRunId} start=${report.startingEvaluationRunId} end=${report.endingEvaluationRunId}`,
    `Counts: selected=${report.selectedCount} processed=${report.processedCount} materialized=${report.materializedCount} excluded=${report.excludedCount} invalid=${report.invalidSourceCount}`,
    `Continuation: hasMore=${report.hasMore} stoppedByCutoff=${report.stoppedByCutoff} nextCursor=${text(report.nextCursor)}`,
    'External delivery: not attempted',
  ];
  if (report.items.length) {
    lines.push('Items:');
    for (const item of report.items) {
      lines.push(
        `  evaluation=${item.evaluationRunId} forecast=${item.forecastId} category=${text(item.category)} classification=${item.classification}`,
        `    policy=${text(item.policyDecision)} reason=${item.reasonCode} wouldCreate=${item.intentWouldBeCreated} created=${item.intentCreated}`,
      );
    }
  } else {
    lines.push('Items: none');
  }
  lines.push(report.warnings.length
    ? `Warnings: ${report.warnings.join('; ')}`
    : 'Warnings: none');
  return lines.join('\n');
}

function visibleProjectionReport(report: NotificationProjectionReport) {
  const { profileId, ...visible } = report;
  void profileId;
  return visible;
}

export function renderBackfillHuman(report: NotificationProjectionReport) {
  return [
    'Northstar historical notification preview (read-only)',
    renderProjectionHuman(report),
    'Historical writes: none',
  ].join('\n');
}

export function renderStatusHuman(report: NotificationStatusReport) {
  const lines = [
    'Northstar notification status (local, read-only)',
    `Inspection: ${report.state} | schema=${report.localSchema} | projector=${report.projectorVersion}`,
    `Remote migration: ${report.remoteMigrationState} | delivery worker: ${report.deliveryWorkerState}`,
    `Filters: state=${text(report.filters.state)} category=${text(report.filters.category)} limit=${report.filters.limit}`,
  ];
  if (report.checkpoint) {
    lines.push(
      `Checkpoint: baseline=${report.checkpoint.baselineEvaluationRunId} last=${report.checkpoint.lastEvaluationRunId} activated=${report.checkpoint.activatedAt}`,
      `  leaseExpires=${text(report.checkpoint.leaseExpiresAt)} recovery=${report.checkpoint.recoveryCount}`,
    );
  } else {
    lines.push('Checkpoint: none');
  }
  lines.push(report.counts.length
    ? `Counts: ${report.counts.map((entry) => `${entry.category}/${entry.state}=${entry.count}`).join(', ')}`
    : 'Counts: none');
  if (!report.outbox.length) {
    lines.push('Outbox: none');
  } else {
    lines.push('Outbox:');
    for (const entry of report.outbox) {
      lines.push(
        `  ${entry.createdAt} ${entry.category}/${entry.state} outbox=${entry.outboxId} intent=${entry.intentId}`,
        `    policy=${entry.policyDecision}/${entry.policyReason} preferenceRevision=${text(entry.preferenceRevision)} available=${text(entry.availableAt)}`,
        `    attempts=${entry.attemptCount} lastFailure=${text(entry.lastFailureCategory)} leaseExpires=${text(entry.leaseExpiresAt)}`,
      );
      for (const attempt of entry.attempts) {
        lines.push(
          `      attempt=${attempt.attemptNumber} state=${attempt.state} started=${attempt.startedAt} finished=${text(attempt.finishedAt)} failure=${text(attempt.redactedErrorCategory)} next=${text(attempt.nextAttemptAt)}`,
        );
      }
    }
  }
  return lines.join('\n');
}

function safeFailure(error: unknown) {
  if (error instanceof NotificationOperatorUsageError || error instanceof NotificationContractError) {
    return { code: 2, category: 'invalid_invocation', message: error.message };
  }
  return {
    code: 1,
    category: 'system_failure',
    message: 'The notification operator could not produce a report.',
  };
}

type Io = { out(value: string): void; error(value: string): void };
const defaultIo: Io = { out: console.log, error: console.error };

async function runWithReport<TOptions extends { help: boolean; json: boolean }, TReport>(
  argv: string[],
  io: Io,
  parse: (value: string[]) => TOptions,
  usage: string,
  invoke: (options: TOptions) => Promise<TReport>,
  human: (report: TReport) => string,
  jsonValue: (report: TReport) => unknown = (report) => report,
) {
  let options: TOptions | undefined;
  try {
    options = parse(argv);
    if (options.help) {
      io.out(usage);
      return 0;
    }
    const report = await invoke(options);
    io.out(options.json ? JSON.stringify(jsonValue(report), null, 2) : human(report));
    return 0;
  } catch (error) {
    const failure = safeFailure(error);
    io.error(options?.json || argv.includes('--json')
      ? JSON.stringify({ error: { category: failure.category, message: failure.message } })
      : `${failure.message}\nRun with --help for usage.`);
    return failure.code;
  }
}

export function runProjectionOperator(
  argv: string[],
  io: Io = defaultIo,
  invoke = invokeNotificationProjection,
) {
  return runWithReport(
    argv,
    io,
    parseProjectionArgs,
    PROJECT_USAGE,
    invoke,
    renderProjectionHuman,
    visibleProjectionReport,
  );
}

export function runBackfillOperator(
  argv: string[],
  io: Io = defaultIo,
  invoke = invokeNotificationBackfill,
) {
  return runWithReport(
    argv,
    io,
    parseBackfillArgs,
    BACKFILL_USAGE,
    invoke,
    renderBackfillHuman,
    visibleProjectionReport,
  );
}

export function runStatusOperator(
  argv: string[],
  io: Io = defaultIo,
  inspect = inspectNotificationStatus,
) {
  return runWithReport(argv, io, parseStatusArgs, STATUS_USAGE, inspect, renderStatusHuman);
}
