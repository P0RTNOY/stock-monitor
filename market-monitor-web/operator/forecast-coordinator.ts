import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import {
  forecastEventUpgradeStatements,
  forecastInitializationStatements,
} from '../db/forecast-initialization.ts';
import {
  COORDINATOR_DEFAULT_LIMIT,
  COORDINATOR_MAX_CURSOR_LENGTH,
  COORDINATOR_MAX_LIMIT,
  COORDINATOR_MIN_LIMIT,
  COORDINATOR_MODES,
  CoordinatorContractError,
  isCanonicalUtcInstant,
  type CoordinatorMode,
} from '../app/lib/server/coordinator/contract.ts';
import { D1CoordinatorRepository } from '../app/lib/server/coordinator/repository.ts';
import {
  CoordinatorSystemError,
  ForecastCoordinatorService,
  type CoordinatorRuntime,
} from '../app/lib/server/coordinator/service.ts';
import type { CoordinatorRunReport } from '../app/lib/server/coordinator/types.ts';
import { evaluateWithPython } from '../app/lib/server/evaluation/client.ts';
import { D1EvaluationRepository } from '../app/lib/server/evaluation/repository.ts';
import { ForecastEvaluationService } from '../app/lib/server/evaluation/service.ts';
import { D1ForecastRepository } from '../app/lib/server/forecasts/repository.ts';
import { resolveCurrentProfile } from '../app/lib/server/profile.ts';

const CONFIG_PATH = fileURLToPath(new URL('./wrangler.operator.jsonc', import.meta.url));
const DEFAULT_PERSIST_PATH = '.wrangler/state/v3';
const LEASE_DURATION_MS = 5 * 60 * 1_000;

export const OPERATOR_USAGE = `Usage:
  npm run --silent forecast:coordinate -- --cutoff <UTC> --mode <dry_run|execute> [options]

Required:
  --cutoff <UTC>       Canonical UTC instant, for example 2026-08-24T12:00:00.000Z
  --mode <mode>        dry_run previews due candidates; execute evaluates them

Options:
  --limit <1-100>      Maximum candidates for this page (default: 25)
  --cursor <token>     Opaque continuation cursor returned by an earlier page
  --run-key <key>      Optional idempotency key for safe operator replay
  --json               Print the machine-readable report instead of the human summary
  --help               Show this help without opening D1

The profile is resolved internally and cannot be supplied as an argument.`;

export type OperatorCliOptions = {
  help: boolean;
  json: boolean;
  cutoff?: string;
  mode?: CoordinatorMode;
  limit: number;
  cursor?: string;
  operatorRunKey?: string;
};

export class OperatorUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorUsageError';
  }
}

function requiredValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new OperatorUsageError(`${flag} requires a value.`);
  }
  return value;
}

function nonEmptyBounded(value: string, flag: string, maximum: number) {
  if (!value || value.trim() !== value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OperatorUsageError(`${flag} is invalid.`);
  }
  return value;
}

export function parseOperatorArgs(argv: string[]): OperatorCliOptions {
  const values = new Map<string, string | true>();
  const valueFlags = new Set(['--cutoff', '--mode', '--limit', '--cursor', '--run-key']);
  const booleanFlags = new Set(['--json', '--help']);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!valueFlags.has(flag) && !booleanFlags.has(flag)) {
      throw new OperatorUsageError(`Unknown argument: ${flag}`);
    }
    if (values.has(flag)) throw new OperatorUsageError(`Duplicate argument: ${flag}`);
    if (booleanFlags.has(flag)) {
      values.set(flag, true);
      continue;
    }
    const value = requiredValue(argv, index, flag);
    values.set(flag, value);
    index += 1;
  }

  const help = values.has('--help');
  if (help) {
    if (values.size !== 1) throw new OperatorUsageError('--help cannot be combined with other arguments.');
    return { help: true, json: false, limit: COORDINATOR_DEFAULT_LIMIT };
  }

  const cutoff = values.get('--cutoff');
  if (typeof cutoff !== 'string') throw new OperatorUsageError('--cutoff is required.');
  if (!isCanonicalUtcInstant(cutoff)) {
    throw new OperatorUsageError('--cutoff must be a canonical UTC instant with millisecond precision.');
  }
  const mode = values.get('--mode');
  if (typeof mode !== 'string') throw new OperatorUsageError('--mode is required.');
  if (!COORDINATOR_MODES.includes(mode as CoordinatorMode)) {
    throw new OperatorUsageError('--mode must be dry_run or execute.');
  }
  const limitValue = values.get('--limit');
  const limit = limitValue === undefined ? COORDINATOR_DEFAULT_LIMIT : Number(limitValue);
  if (typeof limitValue === 'string' && !/^\d+$/u.test(limitValue)) {
    throw new OperatorUsageError('--limit must be a whole number.');
  }
  if (!Number.isSafeInteger(limit) || limit < COORDINATOR_MIN_LIMIT || limit > COORDINATOR_MAX_LIMIT) {
    throw new OperatorUsageError(`--limit must be from ${COORDINATOR_MIN_LIMIT} through ${COORDINATOR_MAX_LIMIT}.`);
  }

  const cursorValue = values.get('--cursor');
  const runKeyValue = values.get('--run-key');
  const cursor = typeof cursorValue === 'string'
    ? nonEmptyBounded(cursorValue, '--cursor', COORDINATOR_MAX_CURSOR_LENGTH)
    : undefined;
  const operatorRunKey = typeof runKeyValue === 'string'
    ? nonEmptyBounded(runKeyValue, '--run-key', 128)
    : undefined;
  return {
    help: false,
    json: values.has('--json'),
    cutoff,
    mode: mode as CoordinatorMode,
    limit,
    ...(cursor ? { cursor } : {}),
    ...(operatorRunKey ? { operatorRunKey } : {}),
  };
}

export function renderJsonReport(report: CoordinatorRunReport) {
  return JSON.stringify(report, null, 2);
}

function text(value: string | number | boolean | null) {
  return value === null ? 'none' : String(value);
}

export function renderHumanReport(report: CoordinatorRunReport) {
  const outcomes = Object.entries(report.outcomeCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([outcome, count]) => `${outcome}=${count}`)
    .join(', ') || 'none';
  const lines = [
    'Northstar due-forecast coordinator',
    `Run: ${report.runId} (${report.coordinatorVersion})`,
    `Status: ${report.status} | mode=${report.mode} | profile=${report.profileId} | cutoff=${report.cutoff}`,
    `Counts: selected=${report.selectedCount} attempted=${report.attemptedCount} mutated=${report.mutatedCount} unexpected=${report.unexpectedErrorCount}`,
    `Outcomes: ${outcomes}`,
    `Duration: ${text(report.totalDurationMs)} ms | replay=${report.replayUsedExistingRun} | hasMore=${report.hasMore}`,
    `Initial cursor: ${text(report.initialCursor)}`,
    `Resume cursor: ${text(report.resumeCursor)}`,
    `Next cursor: ${text(report.nextCursor)}`,
  ];

  if (report.items.length) {
    lines.push('Items:');
    for (const item of report.items) {
      lines.push(
        `  ${item.ordinal}. ${item.symbol} #${item.forecastId}: ${text(item.classification)} (${item.previousStatus} -> ${text(item.currentStatus)})`,
        `     reason=${text(item.reasonCode)} mutated=${item.mutated} retryUseful=${item.retryUseful} run=${text(item.evaluationRunId)} review=${text(item.reviewItemId)}`,
        `     ${text(item.safeExplanation)}`,
      );
    }
  } else {
    lines.push('Items: none');
  }
  if (report.warnings.length) {
    lines.push('Warnings:', ...report.warnings.map((warning) => `  - ${warning}`));
  } else {
    lines.push('Warnings: none');
  }
  return lines.join('\n');
}

function operatorRuntime(): CoordinatorRuntime {
  return {
    now: () => new Date().toISOString(),
    leaseExpiresAt: (acquiredAt) => new Date(Date.parse(acquiredAt) + LEASE_DURATION_MS).toISOString(),
    durationMs: (startedAt, finishedAt) => Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    id: (kind) => `${kind}_${randomUUID()}`,
  };
}

async function initializeOperatorDatabase(d1: D1Database) {
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

export async function invokeCoordinator(options: OperatorCliOptions) {
  if (options.help || !options.cutoff || !options.mode) {
    throw new OperatorUsageError('A runnable coordinator invocation is required.');
  }
  const persistPath = process.env.NORTHSTAR_COORDINATOR_PERSIST_PATH || DEFAULT_PERSIST_PATH;
  const platform = await getPlatformProxy<{ DB: D1Database }>({
    configPath: CONFIG_PATH,
    persist: { path: persistPath },
    remoteBindings: false,
  });
  try {
    const d1 = platform.env.DB;
    if (!d1) throw new CoordinatorSystemError('The local operator D1 binding is unavailable.');
    await initializeOperatorDatabase(d1);
    const { profileId } = await resolveCurrentProfile();
    const existingProfile = await d1.prepare('SELECT id FROM investment_profiles WHERE id = ?')
      .bind(profileId).first<{ id: number }>();
    if (!existingProfile) {
      await d1.prepare(`INSERT INTO investment_profiles
        (id, name, base_currency, cash_balance, created_at) VALUES (?, ?, 'USD', 0, ?)`)
        .bind(profileId, 'My portfolio', new Date().toISOString()).run();
    }

    const forecasts = new D1ForecastRepository(d1);
    const evaluator = new ForecastEvaluationService(
      forecasts,
      new D1EvaluationRepository(d1),
      evaluateWithPython,
      () => new Date(),
    );
    const coordinator = new ForecastCoordinatorService(
      new D1CoordinatorRepository(d1),
      forecasts,
      evaluator,
      operatorRuntime(),
    );
    return await coordinator.coordinate({
      profileId,
      cutoff: options.cutoff,
      limit: options.limit,
      mode: options.mode,
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.operatorRunKey ? { operatorRunKey: options.operatorRunKey } : {}),
    }, profileId);
  } finally {
    await platform.dispose();
  }
}

function safeFailure(error: unknown) {
  if (error instanceof OperatorUsageError || error instanceof CoordinatorContractError) {
    return { exitCode: 2, category: 'invalid_invocation', message: error.message };
  }
  return {
    exitCode: 1,
    category: 'system_failure',
    message: 'The coordinator could not produce a run report.',
  };
}

export async function runOperator(
  argv: string[],
  io: { out(value: string): void; error(value: string): void } = {
    out: (value) => console.log(value),
    error: (value) => console.error(value),
  },
  invoke: (options: OperatorCliOptions) => Promise<CoordinatorRunReport> = invokeCoordinator,
) {
  let options: OperatorCliOptions | undefined;
  try {
    options = parseOperatorArgs(argv);
    if (options.help) {
      io.out(OPERATOR_USAGE);
      return 0;
    }
    const report = await invoke(options);
    io.out(options.json ? renderJsonReport(report) : renderHumanReport(report));
    return 0;
  } catch (error) {
    const failure = safeFailure(error);
    const json = options?.json || argv.includes('--json');
    io.error(json
      ? JSON.stringify({ error: { category: failure.category, message: failure.message } })
      : `${failure.message}\nRun with --help for usage.`);
    return failure.exitCode;
  }
}
