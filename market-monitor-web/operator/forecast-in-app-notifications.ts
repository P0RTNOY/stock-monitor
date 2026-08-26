import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { inAppNotificationInitializationStatements } from '../db/in-app-notification-initialization.ts';
import { isCanonicalUtcInstant } from '../app/lib/server/coordinator/contract.ts';
import {
  IN_APP_MAX_PROJECTION_LIMIT,
  IN_APP_PROJECTOR_VERSION,
} from '../app/lib/server/in-app-notifications/contract.ts';
import { D1InAppNotificationRepository } from '../app/lib/server/in-app-notifications/repository.ts';
import {
  InAppNotificationService,
  type InAppProjectionReport,
} from '../app/lib/server/in-app-notifications/service.ts';
import { resolveCurrentProfile } from '../app/lib/server/profile.ts';

const CONFIG_PATH = fileURLToPath(new URL('./wrangler.operator.jsonc', import.meta.url));
const DEFAULT_PERSIST_PATH = '.wrangler/state/v3';
const DEFAULT_LIMIT = 25;

export const IN_APP_PROJECT_USAGE = `Usage:
  npm run --silent forecast:notifications:in-app:project -- --cutoff <UTC> [options]

Required:
  --cutoff <UTC>  Canonical UTC instant with milliseconds and Z

Options:
  --limit <1-100>  Maximum trusted intent sources (default: ${DEFAULT_LIMIT})
  --dry-run         Preview only; this is the default
  --commit          Persist projection decisions and in-app entries
  --json            Print stable machine-readable JSON
  --help            Show this help without opening D1

This command never evaluates forecasts, sends email, or calls an external provider.`;

export const IN_APP_BACKFILL_USAGE = `Usage:
  npm run --silent forecast:notifications:in-app:backfill -- --from-id <id> --through-id <id> --cutoff <UTC> --confirm-historical-preview [options]

Required:
  --from-id <id>                  First bounded evaluation-run ID
  --through-id <id>               Last bounded evaluation-run ID
  --cutoff <UTC>                  Canonical UTC intent-materialization cutoff
  --confirm-historical-preview    Confirm historical scope

Options:
  --limit <1-100>                 Maximum trusted intent sources (default: ${DEFAULT_LIMIT})
  --dry-run                       Preview only; this is the default
  --commit --confirm-historical-commit
                                  Explicitly materialize the bounded historical page
  --json                          Print stable machine-readable JSON
  --help                          Show this help without opening D1

Historical commits are idempotent, do not move the forward checkpoint, and never reset read state.`;

export const IN_APP_STATUS_USAGE = `Usage:
  npm run --silent forecast:notifications:in-app:status -- [--json] [--help]

Status is local and read-only. Remote migration and deployment state remain unknown.`;

export class InAppOperatorUsageError extends Error {
  constructor(message: string) { super(message); this.name = 'InAppOperatorUsageError'; }
}

type Flags = Map<string, string | true>;

function flags(argv: string[], valued: Set<string>, booleans: Set<string>): Flags {
  const result: Flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!valued.has(flag) && !booleans.has(flag)) throw new InAppOperatorUsageError(`Unknown argument: ${flag}`);
    if (result.has(flag)) throw new InAppOperatorUsageError(`Duplicate argument: ${flag}`);
    if (booleans.has(flag)) { result.set(flag, true); continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new InAppOperatorUsageError(`${flag} requires a value.`);
    result.set(flag, value); index += 1;
  }
  return result;
}

function integer(value: string | true | undefined, name: string, fallback?: number) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) throw new InAppOperatorUsageError(`${name} must be a whole number.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new InAppOperatorUsageError(`${name} is out of range.`);
  return parsed;
}

function cutoff(value: string | true | undefined) {
  if (typeof value !== 'string' || !isCanonicalUtcInstant(value)) {
    throw new InAppOperatorUsageError('--cutoff must be a canonical UTC instant.');
  }
  return value;
}

export type InAppProjectOptions = {
  help: boolean; json: boolean; mode: 'dry_run' | 'commit'; cutoff?: string; limit: number;
};

export function parseInAppProjectArgs(argv: string[]): InAppProjectOptions {
  const values = flags(argv, new Set(['--cutoff', '--limit']), new Set(['--dry-run', '--commit', '--json', '--help']));
  if (values.has('--help')) {
    if (values.size !== 1) throw new InAppOperatorUsageError('--help cannot be combined with other arguments.');
    return { help: true, json: false, mode: 'dry_run', limit: DEFAULT_LIMIT };
  }
  if (values.has('--dry-run') && values.has('--commit')) throw new InAppOperatorUsageError('Choose either --dry-run or --commit.');
  const limit = integer(values.get('--limit'), '--limit', DEFAULT_LIMIT);
  if (limit > IN_APP_MAX_PROJECTION_LIMIT) throw new InAppOperatorUsageError('--limit must not exceed 100.');
  return { help: false, json: values.has('--json'), mode: values.has('--commit') ? 'commit' : 'dry_run', cutoff: cutoff(values.get('--cutoff')), limit };
}

export type InAppBackfillOptions = InAppProjectOptions & {
  fromEvaluationRunId?: number; throughEvaluationRunId?: number;
};

export function parseInAppBackfillArgs(argv: string[]): InAppBackfillOptions {
  const values = flags(argv, new Set(['--from-id', '--through-id', '--cutoff', '--limit']),
    new Set(['--confirm-historical-preview', '--confirm-historical-commit', '--dry-run', '--commit', '--json', '--help']));
  if (values.has('--help')) {
    if (values.size !== 1) throw new InAppOperatorUsageError('--help cannot be combined with other arguments.');
    return { help: true, json: false, mode: 'dry_run', limit: DEFAULT_LIMIT };
  }
  if (!values.has('--confirm-historical-preview')) throw new InAppOperatorUsageError('--confirm-historical-preview is required.');
  if (values.has('--dry-run') && values.has('--commit')) throw new InAppOperatorUsageError('Choose either --dry-run or --commit.');
  const mode = values.has('--commit') ? 'commit' : 'dry_run';
  if (mode === 'commit' && !values.has('--confirm-historical-commit')) {
    throw new InAppOperatorUsageError('Historical commit requires --confirm-historical-commit.');
  }
  if (mode === 'dry_run' && values.has('--confirm-historical-commit')) {
    throw new InAppOperatorUsageError('--confirm-historical-commit requires --commit.');
  }
  const fromEvaluationRunId = integer(values.get('--from-id'), '--from-id');
  const throughEvaluationRunId = integer(values.get('--through-id'), '--through-id');
  if (throughEvaluationRunId < fromEvaluationRunId) throw new InAppOperatorUsageError('--through-id must be at least --from-id.');
  const limit = integer(values.get('--limit'), '--limit', DEFAULT_LIMIT);
  if (limit > IN_APP_MAX_PROJECTION_LIMIT) throw new InAppOperatorUsageError('--limit must not exceed 100.');
  return { help: false, json: values.has('--json'), mode, cutoff: cutoff(values.get('--cutoff')), limit, fromEvaluationRunId, throughEvaluationRunId };
}

export function parseInAppStatusArgs(argv: string[]) {
  const values = flags(argv, new Set(), new Set(['--json', '--help']));
  if (values.has('--help') && values.size !== 1) throw new InAppOperatorUsageError('--help cannot be combined with other arguments.');
  return { help: values.has('--help'), json: values.has('--json') };
}

function platformOptions() {
  const override = process.env.NORTHSTAR_COORDINATOR_PERSIST_PATH;
  const path = override ? (override.endsWith('/v3') ? override : `${override}/v3`) : DEFAULT_PERSIST_PATH;
  return { configPath: CONFIG_PATH, persist: { path }, remoteBindings: false } as const;
}

function service(repository: D1InAppNotificationRepository) {
  return new InAppNotificationService(repository, {
    now: () => new Date().toISOString(), token: () => `in_app_${randomUUID()}`,
  });
}

async function maybeInitialize(d1: D1Database, commit: boolean, profileId: number) {
  if (!commit) return;
  await d1.batch(inAppNotificationInitializationStatements().map((statement) => d1.prepare(statement)));
  await d1.prepare(`INSERT OR IGNORE INTO investment_profiles
    (id, name, base_currency, cash_balance, created_at) VALUES (?, 'My portfolio', 'USD', 0, ?)`)
    .bind(profileId, new Date().toISOString()).run();
}

export async function invokeInAppProject(options: InAppProjectOptions) {
  if (options.help || !options.cutoff) throw new InAppOperatorUsageError('A runnable projection is required.');
  const platform = await getPlatformProxy<{ DB: D1Database }>(platformOptions());
  try {
    const d1 = platform.env.DB;
    if (!d1) throw new Error('MissingLocalD1Binding');
    const { profileId } = await resolveCurrentProfile();
    await maybeInitialize(d1, options.mode === 'commit', profileId);
    return await service(new D1InAppNotificationRepository(d1)).project({ profileId, cutoff: options.cutoff, limit: options.limit, mode: options.mode }, profileId);
  } finally { await platform.dispose(); }
}

export async function invokeInAppBackfill(options: InAppBackfillOptions) {
  if (options.help || !options.cutoff || !options.fromEvaluationRunId || !options.throughEvaluationRunId) {
    throw new InAppOperatorUsageError('A runnable bounded historical action is required.');
  }
  const platform = await getPlatformProxy<{ DB: D1Database }>(platformOptions());
  try {
    const d1 = platform.env.DB;
    if (!d1) throw new Error('MissingLocalD1Binding');
    const { profileId } = await resolveCurrentProfile();
    await maybeInitialize(d1, options.mode === 'commit', profileId);
    return await service(new D1InAppNotificationRepository(d1)).backfill({
      profileId, cutoff: options.cutoff, limit: options.limit, mode: options.mode,
      fromEvaluationRunId: options.fromEvaluationRunId,
      throughEvaluationRunId: options.throughEvaluationRunId,
    }, profileId);
  } finally { await platform.dispose(); }
}

export async function inspectInAppStatus() {
  const platform = await getPlatformProxy<{ DB: D1Database }>(platformOptions());
  try {
    const d1 = platform.env.DB;
    if (!d1) throw new Error('MissingLocalD1Binding');
    const { profileId } = await resolveCurrentProfile();
    const repository = new D1InAppNotificationRepository(d1);
    if (!await repository.hasSchema()) return {
      state: 'configuration_error', localSchema: 'missing', remoteMigrationState: 'unknown',
      projectorVersion: IN_APP_PROJECTOR_VERSION, checkpoint: null, counts: [], unreadCount: 0,
    } as const;
    const [checkpoint, counts, unread] = await Promise.all([
      repository.getCheckpoint(profileId, IN_APP_PROJECTOR_VERSION),
      repository.countsByState(profileId), repository.unreadSnapshot(profileId),
    ]);
    return {
      state: 'inspection_ready', localSchema: 'present', remoteMigrationState: 'unknown',
      projectorVersion: IN_APP_PROJECTOR_VERSION,
      checkpoint: checkpoint ? {
        baselineEvaluationRunId: checkpoint.baselineEvaluationRunId,
        lastEvaluationRunId: checkpoint.lastEvaluationRunId,
        activatedAt: checkpoint.activatedAt,
        leaseExpiresAt: checkpoint.leaseExpiresAt,
        recoveryCount: checkpoint.recoveryCount,
      } : null,
      counts, unreadCount: unread.unreadCount,
    } as const;
  } finally { await platform.dispose(); }
}

export function renderInAppProjection(report: InAppProjectionReport) {
  return [
    `Northstar in-app notification ${report.operation === 'forward' ? 'projection' : 'historical backfill'}`,
    `Disposition: ${report.disposition} | mode=${report.mode}`,
    `Progress: baseline=${report.baselineEvaluationRunId} start=${report.startingEvaluationRunId} end=${report.endingEvaluationRunId}`,
    `Counts: selected=${report.selectedCount} materialized=${report.materializedCount} duplicate=${report.duplicateCount} malformed=${report.invalidSourceCount} unsupported=${report.unsupportedSourceCount}`,
    `Continuation: hasMore=${report.hasMore} stoppedByCutoff=${report.stoppedByCutoff}`,
    'Forecast evaluation: not attempted | external delivery: not attempted',
    report.warnings.length ? `Warnings: ${report.warnings.join('; ')}` : 'Warnings: none',
  ].join('\n');
}

export function visibleInAppProjection(report: InAppProjectionReport) {
  return {
    ...report,
    items: report.items.map(({ sourceIntentId, ...item }) => {
      void sourceIntentId;
      return item;
    }),
  };
}

export function renderInAppStatus(report: Awaited<ReturnType<typeof inspectInAppStatus>>) {
  return [
    'Northstar in-app notification status (local, read-only)',
    `Inspection: ${report.state} | schema=${report.localSchema} | projector=${report.projectorVersion}`,
    `Remote migration: ${report.remoteMigrationState}`,
    report.checkpoint ? `Checkpoint: baseline=${report.checkpoint.baselineEvaluationRunId} last=${report.checkpoint.lastEvaluationRunId}` : 'Checkpoint: none',
    `Unread: ${report.unreadCount}`,
    report.counts.length ? `Counts: ${report.counts.map((entry) => `${entry.state}=${entry.count}`).join(', ')}` : 'Counts: none',
  ].join('\n');
}

function safeFailure(error: unknown) {
  return error instanceof InAppOperatorUsageError ? error.message : 'In-app notification operation failed safely.';
}

export async function runInAppProjectOperator(argv: string[]) {
  try {
    const options = parseInAppProjectArgs(argv);
    if (options.help) { console.log(IN_APP_PROJECT_USAGE); return 0; }
    const report = await invokeInAppProject(options);
    console.log(options.json ? JSON.stringify(visibleInAppProjection(report)) : renderInAppProjection(report)); return 0;
  } catch (error) { console.error(safeFailure(error)); return 1; }
}

export async function runInAppBackfillOperator(argv: string[]) {
  try {
    const options = parseInAppBackfillArgs(argv);
    if (options.help) { console.log(IN_APP_BACKFILL_USAGE); return 0; }
    const report = await invokeInAppBackfill(options);
    console.log(options.json ? JSON.stringify(visibleInAppProjection(report)) : renderInAppProjection(report)); return 0;
  } catch (error) { console.error(safeFailure(error)); return 1; }
}

export async function runInAppStatusOperator(argv: string[]) {
  try {
    const options = parseInAppStatusArgs(argv);
    if (options.help) { console.log(IN_APP_STATUS_USAGE); return 0; }
    const report = await inspectInAppStatus();
    console.log(options.json ? JSON.stringify(report) : renderInAppStatus(report)); return 0;
  } catch (error) { console.error(safeFailure(error)); return 1; }
}
