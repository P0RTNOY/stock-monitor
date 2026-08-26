import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import {
  forecastEventUpgradeStatements,
  forecastInitializationStatements,
} from '../db/forecast-initialization.ts';
import { isCanonicalUtcInstant } from '../app/lib/server/coordinator/contract.ts';
import { trustedOperatorScope } from '../app/lib/server/auth/system.ts';
import { AuthorizedSchedulerService } from '../app/lib/server/auth/system-services.ts';
import { profileIdFromScope } from '../app/lib/server/auth/enforcement.ts';
import {
  SCHEDULER_VERSION,
  SchedulerConfigurationError,
  parseSchedulerConfig,
  validateSchedulerProviderUrl,
  type SchedulerRawConfig,
} from '../app/lib/server/scheduler/contract.ts';
import { createForecastScheduler } from '../app/lib/server/scheduler/factory.ts';
import { D1SchedulerRepository } from '../app/lib/server/scheduler/repository.ts';
import { disabledScheduledInvocation } from '../app/lib/server/scheduler/service.ts';
import type {
  ScheduleInvocationRecord,
  SchedulePageRecord,
  ScheduledInvocationReport,
  SchedulerLogger,
} from '../app/lib/server/scheduler/types.ts';

const CONFIG_PATH = fileURLToPath(new URL('./wrangler.operator.jsonc', import.meta.url));
const DEFAULT_PERSIST_PATH = '.wrangler/state/v3';
const DEFAULT_CRON = '30 6 * * *';

export const SIMULATE_USAGE = `Usage:
  npm run --silent forecast:schedule:simulate -- --scheduled-at <UTC> --enabled <true|false> [options]

Required:
  --scheduled-at <UTC>  Canonical scheduled event time with milliseconds and Z
  --enabled <boolean>   Explicit scheduler kill-switch value

Options:
  --cron <expression>   Trusted schedule expression (default: ${DEFAULT_CRON})
  --environment <name>  local, preview, staging, or production (default: local)
  --page-size <n>       Coordinator page size
  --max-pages <n>       Maximum pages in this invocation
  --max-items <n>       Maximum selected items in this invocation
  --max-runtime-ms <n>  Page-boundary wall-clock budget
  --min-remaining-ms <n> Runtime reserve required before another page
  --json                Print stable machine-readable JSON
  --help                Show this help without opening D1

The fixed profile is resolved internally. This command never calls a public route.`;

export const STATUS_USAGE = `Usage:
  npm run --silent forecast:schedule:status -- [--limit <1-100>] [--run-id <id>] [--json]

Options:
  --limit <1-100>  Recent invocations to display (default: 20)
  --run-id <id>    Inspect one scheduler invocation and its coordinator page links
  --json           Print stable machine-readable JSON
  --help           Show this help without opening D1

Status is local and read-only. Remote migration and cron-trigger state remain unknown.`;

export class SchedulerOperatorUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerOperatorUsageError';
  }
}

type Parsed = Map<string, string | true>;

function parseFlags(argv: string[], valueFlags: Set<string>, booleanFlags: Set<string>): Parsed {
  const parsed = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!valueFlags.has(flag) && !booleanFlags.has(flag)) {
      throw new SchedulerOperatorUsageError(`Unknown argument: ${flag}`);
    }
    if (parsed.has(flag)) throw new SchedulerOperatorUsageError(`Duplicate argument: ${flag}`);
    if (booleanFlags.has(flag)) {
      parsed.set(flag, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new SchedulerOperatorUsageError(`${flag} requires a value.`);
    }
    parsed.set(flag, value);
    index += 1;
  }
  return parsed;
}

function bounded(value: string, flag: string, maximum: number) {
  if (!value || value.trim() !== value || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new SchedulerOperatorUsageError(`${flag} is invalid.`);
  }
  return value;
}

export type SchedulerSimulationOptions = {
  help: boolean;
  json: boolean;
  scheduledAt?: string;
  cron: string;
  rawConfig: SchedulerRawConfig;
};

export function parseSimulationArgs(argv: string[]): SchedulerSimulationOptions {
  const values = parseFlags(argv,
    new Set(['--scheduled-at', '--enabled', '--cron', '--environment', '--page-size',
      '--max-pages', '--max-items', '--max-runtime-ms', '--min-remaining-ms']),
    new Set(['--json', '--help']));
  if (values.has('--help')) {
    if (values.size !== 1) throw new SchedulerOperatorUsageError('--help cannot be combined with other arguments.');
    return { help: true, json: false, cron: DEFAULT_CRON, rawConfig: {} };
  }
  const scheduledAt = values.get('--scheduled-at');
  if (typeof scheduledAt !== 'string' || !isCanonicalUtcInstant(scheduledAt)) {
    throw new SchedulerOperatorUsageError('--scheduled-at must be a canonical UTC instant with millisecond precision.');
  }
  const enabled = values.get('--enabled');
  if (enabled !== 'true' && enabled !== 'false') {
    throw new SchedulerOperatorUsageError('--enabled must be explicitly true or false.');
  }
  const cronValue = values.get('--cron');
  const cron = typeof cronValue === 'string' ? bounded(cronValue, '--cron', 100) : DEFAULT_CRON;
  return {
    help: false,
    json: values.has('--json'),
    scheduledAt,
    cron,
    rawConfig: {
      enabled,
      ...(values.has('--environment') ? { environment: values.get('--environment') } : {}),
      ...(values.has('--page-size') ? { pageSize: values.get('--page-size') } : {}),
      ...(values.has('--max-pages') ? { maxPages: values.get('--max-pages') } : {}),
      ...(values.has('--max-items') ? { maxItems: values.get('--max-items') } : {}),
      ...(values.has('--max-runtime-ms') ? { maxRuntimeMs: values.get('--max-runtime-ms') } : {}),
      ...(values.has('--min-remaining-ms') ? { minRemainingMs: values.get('--min-remaining-ms') } : {}),
      schedulerVersion: SCHEDULER_VERSION,
    },
  };
}

export type SchedulerStatusOptions = {
  help: boolean;
  json: boolean;
  limit: number;
  runId?: string;
};

export function parseStatusArgs(argv: string[]): SchedulerStatusOptions {
  const values = parseFlags(argv, new Set(['--limit', '--run-id']), new Set(['--json', '--help']));
  if (values.has('--help')) {
    if (values.size !== 1) throw new SchedulerOperatorUsageError('--help cannot be combined with other arguments.');
    return { help: true, json: false, limit: 20 };
  }
  const limitValue = values.get('--limit');
  if (typeof limitValue === 'string' && !/^\d+$/u.test(limitValue)) {
    throw new SchedulerOperatorUsageError('--limit must be a whole number.');
  }
  const limit = typeof limitValue === 'string' ? Number(limitValue) : 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new SchedulerOperatorUsageError('--limit must be from 1 through 100.');
  }
  const runIdValue = values.get('--run-id');
  const runId = typeof runIdValue === 'string' ? bounded(runIdValue, '--run-id', 128) : undefined;
  return { help: false, json: values.has('--json'), limit, ...(runId ? { runId } : {}) };
}

function quietLogger(): SchedulerLogger { return { log() {} }; }

async function initializeSimulationDatabase(d1: D1Database) {
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS investment_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      base_currency TEXT NOT NULL DEFAULT 'USD', cash_balance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL)`),
    ...forecastInitializationStatements().map((statement) => d1.prepare(statement)),
  ]);
  const eventTable = await d1.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'forecast_events'",
  ).first<{ sql: string }>();
  if (eventTable && !eventTable.sql.includes('evaluation_review_acknowledged')) {
    await d1.batch(forecastEventUpgradeStatements().map((statement) => d1.prepare(statement)));
  }
}

function platformOptions() {
  return {
    configPath: CONFIG_PATH,
    persist: { path: process.env.NORTHSTAR_COORDINATOR_PERSIST_PATH || DEFAULT_PERSIST_PATH },
    remoteBindings: false,
  } as const;
}

export async function invokeSchedulerSimulation(options: SchedulerSimulationOptions) {
  if (options.help || !options.scheduledAt) {
    throw new SchedulerOperatorUsageError('A runnable scheduler simulation is required.');
  }
  const config = parseSchedulerConfig(options.rawConfig);
  const scope = trustedOperatorScope(process.env, 'scheduler_coordinate', 'forecast:schedule:simulate');
  const profileId = profileIdFromScope(scope, 'scheduler_coordinate');
  if (!config.enabled) {
    return disabledScheduledInvocation({
      config, profileId, scheduledTime: options.scheduledAt, scheduleExpression: options.cron,
    }, quietLogger());
  }
  const analysisApiUrl = validateSchedulerProviderUrl(
    process.env.ANALYSIS_API_URL || 'http://127.0.0.1:8502', config.environment,
  );
  const platform = await getPlatformProxy<{ DB: D1Database }>(platformOptions());
  try {
    const d1 = platform.env.DB;
    if (!d1) throw new Error('MissingLocalD1Binding');
    await initializeSimulationDatabase(d1);
    const existing = await d1.prepare('SELECT id FROM investment_profiles WHERE id = ?')
      .bind(profileId).first<{ id: number }>();
    if (!existing) throw new Error('ConfiguredOperatorProfileUnavailable');
    return await new AuthorizedSchedulerService(
      scope,
      createForecastScheduler({ d1, analysisApiUrl, uuid: randomUUID, logger: quietLogger() }),
    ).run({ config, scheduledTime: options.scheduledAt, scheduleExpression: options.cron });
  } finally {
    await platform.dispose();
  }
}

export type SchedulerStatusReport = {
  state: 'inspection_ready' | 'configuration_error';
  localSchema: 'present' | 'missing';
  remoteMigrationState: 'unknown';
  remoteCronState: 'unknown';
  invocations: Array<
    Omit<ScheduleInvocationRecord,
      'profileId' | 'leaseToken' | 'configFingerprint' | 'configurationJson' |
      'outcomeCountsJson' | 'coordinatorRunIdsJson'> & {
      outcomeCounts: Record<string, number>;
      coordinatorRunIds: string[];
      pages: Array<Omit<SchedulePageRecord,
        'profileId' | 'outcomeCountsJson' | 'createdAt'> & { outcomeCounts: Record<string, number> }>;
    }
  >;
};

function safeOutcomeCounts(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, number> : {};
  } catch { return {}; }
}

function safeCoordinatorRunIds(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch { return []; }
}

export async function inspectSchedulerStatus(options: SchedulerStatusOptions): Promise<SchedulerStatusReport> {
  if (options.help) throw new SchedulerOperatorUsageError('A runnable status inspection is required.');
  const scope = trustedOperatorScope(process.env, 'operator_status_inspect', 'forecast:schedule:status');
  const profileId = profileIdFromScope(scope, 'operator_status_inspect');
  const platform = await getPlatformProxy<{ DB: D1Database }>(platformOptions());
  try {
    const d1 = platform.env.DB;
    if (!d1) throw new Error('MissingLocalD1Binding');
    const table = await d1.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'forecast_scheduler_invocations'`).first<{ name: string }>();
    if (!table) {
      return {
        state: 'configuration_error', localSchema: 'missing',
        remoteMigrationState: 'unknown', remoteCronState: 'unknown', invocations: [],
      };
    }
    const repository = new D1SchedulerRepository(d1);
    const records = options.runId
      ? [await repository.getInvocation(profileId, options.runId)].filter(
          (value): value is ScheduleInvocationRecord => value !== null,
        )
      : await repository.listRecent(profileId, options.limit);
    const invocations = await Promise.all(records.map(async (record) => {
      const visible = Object.fromEntries(Object.entries(record).filter(([key]) => ![
        'profileId', 'leaseToken', 'configFingerprint', 'configurationJson',
        'outcomeCountsJson', 'coordinatorRunIdsJson',
      ].includes(key))) as Omit<ScheduleInvocationRecord,
        'profileId' | 'leaseToken' | 'configFingerprint' | 'configurationJson' |
        'outcomeCountsJson' | 'coordinatorRunIdsJson'>;
      const pages = (await repository.getPages(profileId, record.id)).map((page) => ({
        ...Object.fromEntries(Object.entries(page).filter(([key]) => ![
          'profileId', 'outcomeCountsJson', 'createdAt',
        ].includes(key))) as Omit<SchedulePageRecord,
          'profileId' | 'outcomeCountsJson' | 'createdAt'>,
        outcomeCounts: safeOutcomeCounts(page.outcomeCountsJson),
      }));
      return {
        ...visible,
        outcomeCounts: safeOutcomeCounts(record.outcomeCountsJson),
        coordinatorRunIds: safeCoordinatorRunIds(record.coordinatorRunIdsJson),
        pages,
      };
    }));
    return {
      state: 'inspection_ready', localSchema: 'present', remoteMigrationState: 'unknown',
      remoteCronState: 'unknown', invocations,
    };
  } finally {
    await platform.dispose();
  }
}

function humanInvocation(record: SchedulerStatusReport['invocations'][number]) {
  const outcomes = Object.entries(record.outcomeCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`).join(', ') || 'none';
  return [
    `${record.scheduledTime} ${record.status} ${record.id}`,
    `  stop=${record.stopReason ?? 'none'} moreWork=${record.moreWork} recovery=${record.recoveryCount} replays=${record.replayCount} lastReplay=${record.lastReplayedAt ?? 'none'} error=${record.errorCategory ?? 'none'}`,
    `  pages=${record.pagesCompleted}/${record.pagesRequested} selected=${record.selectedCount} attempted=${record.attemptedCount} mutated=${record.mutationCount} unexpected=${record.unexpectedErrorCount}`,
    `  outcomes=${outcomes} replayedCoordinatorPage=${record.pages.some((page) => page.replayUsedExistingRun)}`,
    `  coordinatorRuns=${record.pages.map((page) => page.coordinatorRunId).filter(Boolean).join(',') || 'none'}`,
  ].join('\n');
}

export function renderSimulationHuman(report: ScheduledInvocationReport) {
  const outcomes = Object.entries(report.outcomeCounts).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`).join(', ') || 'none';
  return [
    'Northstar scheduled forecast operations',
    `Invocation: ${report.invocationId ?? 'none'} (${report.schedulerVersion})`,
    `State: ${report.state} | scheduled=${report.scheduledTime} | cutoff=${report.cutoff}`,
    `Counts: pages=${report.pagesCompleted}/${report.pagesRequested} selected=${report.selectedCount} attempted=${report.attemptedCount} mutated=${report.mutatedCount} unexpected=${report.unexpectedErrorCount}`,
    `Outcomes: ${outcomes}`,
    `Stop: ${report.stopReason ?? 'none'} | moreWork=${report.moreWork} | replayed=${report.replayed} | recovered=${report.recovered}`,
    `Coordinator runs: ${report.coordinatorRunIds.join(', ') || 'none'}`,
  ].join('\n');
}

export function renderStatusHuman(report: SchedulerStatusReport) {
  const lines = [
    'Northstar scheduler status (local, read-only)',
    `Inspection: ${report.state} | schema=${report.localSchema}`,
    `Remote migration: ${report.remoteMigrationState} | remote cron: ${report.remoteCronState}`,
  ];
  if (!report.invocations.length) lines.push('Invocations: none');
  else lines.push('Invocations:', ...report.invocations.map(humanInvocation));
  return lines.join('\n');
}

function safeFailure(error: unknown) {
  if (error instanceof SchedulerOperatorUsageError || error instanceof SchedulerConfigurationError) {
    return { code: 2, category: 'invalid_invocation', message: error.message };
  }
  return { code: 1, category: 'system_failure', message: 'Scheduled operation could not produce a report.' };
}

type Io = { out(value: string): void; error(value: string): void };
const defaultIo: Io = { out: console.log, error: console.error };

export async function runSimulationOperator(
  argv: string[], io: Io = defaultIo,
  invoke = invokeSchedulerSimulation,
) {
  let options: SchedulerSimulationOptions | undefined;
  try {
    options = parseSimulationArgs(argv);
    if (options.help) { io.out(SIMULATE_USAGE); return 0; }
    const report = await invoke(options);
    io.out(options.json ? JSON.stringify(report, null, 2) : renderSimulationHuman(report));
    return 0;
  } catch (error) {
    const failure = safeFailure(error);
    io.error(options?.json || argv.includes('--json')
      ? JSON.stringify({ error: { category: failure.category, message: failure.message } })
      : `${failure.message}\nRun with --help for usage.`);
    return failure.code;
  }
}

export async function runStatusOperator(
  argv: string[], io: Io = defaultIo,
  inspect = inspectSchedulerStatus,
) {
  let options: SchedulerStatusOptions | undefined;
  try {
    options = parseStatusArgs(argv);
    if (options.help) { io.out(STATUS_USAGE); return 0; }
    const report = await inspect(options);
    io.out(options.json ? JSON.stringify(report, null, 2) : renderStatusHuman(report));
    return 0;
  } catch (error) {
    const failure = safeFailure(error);
    io.error(options?.json || argv.includes('--json')
      ? JSON.stringify({ error: { category: failure.category, message: failure.message } })
      : `${failure.message}\nRun with --help for usage.`);
    return failure.code;
  }
}
