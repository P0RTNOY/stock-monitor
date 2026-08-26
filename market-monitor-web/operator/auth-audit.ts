import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTE_AUTHORIZATION_MANIFEST } from '../app/lib/server/auth/route-manifest.ts';
import {
  PLATFORM_MANAGED_TABLES,
  TABLE_OWNERSHIP_MANIFEST,
} from '../app/lib/server/auth/ownership-manifest.ts';
import { authorizationIntegrityStatements } from '../db/authorization-initialization.ts';

const WEB_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CONFIG_PATH = fileURLToPath(new URL('./wrangler.operator.jsonc', import.meta.url));
const DEFAULT_PERSIST_PATH = '.wrangler/state/v3';
const AUTH_TABLES = ['identity_users', 'profile_memberships', 'profile_membership_events'] as const;
const REQUIRED_AUTH_TRIGGERS = authorizationIntegrityStatements().map((statement) => {
  const name = statement.match(/TRIGGER IF NOT EXISTS ([a-z0-9_]+)/u)?.[1];
  if (!name) throw new Error('AuthorizationTriggerManifestInvalid');
  return name;
});
const REQUIRED_AUTH_TRIGGER_SQL = new Map(authorizationIntegrityStatements().map((statement) => {
  const name = statement.match(/TRIGGER IF NOT EXISTS ([a-z0-9_]+)/u)?.[1];
  if (!name) throw new Error('AuthorizationTriggerManifestInvalid');
  return [name, statement] as const;
}));

function normalizedTriggerSql(value: string) {
  return value.toLowerCase()
    .replace(/\bif\s+not\s+exists\b/gu, '')
    .replace(/[`";]/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/\s*([(),])\s*/gu, '$1')
    .trim();
}
const BOOTSTRAP_IDS = {
  user: 'northstar-bootstrap-user-v1',
  membership: 'northstar-bootstrap-owner-v1',
  event: 'northstar-bootstrap-owner-created-v1',
} as const;

export type AuditArguments = { json: boolean; help: boolean };

export function parseAuditArguments(argv: string[]): AuditArguments {
  let json = false;
  let help = false;
  for (const argument of argv) {
    if (argument === '--json' && !json) json = true;
    else if (argument === '--help' && !help) help = true;
    else throw new Error('InvalidAuditArguments');
  }
  if (help && json) throw new Error('InvalidAuditArguments');
  return { json, help };
}

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return files(path);
    return [path];
  });
}

function safePath(path: string) {
  return relative(WEB_ROOT, path).split(sep).join('/');
}

function unexpectedGlobalIdSql(root: string) {
  const repositories = files(join(root, 'app', 'lib', 'server'))
    .filter((path) => path.endsWith('repository.ts'));
  const violations: string[] = [];
  for (const path of repositories) {
    const source = safePath(path);
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/`([\s\S]*?)`/gu)) {
      const sql = match[1];
      if (!/\bWHERE\s+(?:[a-z]+\.)?id\s*=\s*\?/iu.test(sql)
        || /\b(?:[a-z]+\.)?profile_id\s*=\s*\?/iu.test(sql)) continue;
      const trustedBootstrapIdentity = source === 'app/lib/server/auth/repository.ts'
        && /\bu\.id\s*=\s*\?\s+AND\s+m\.id\s*=\s*\?/iu.test(sql);
      const purposeBoundCapability = source === 'app/lib/server/email/repository.ts'
        && (sql.includes('forecast_email_capabilities') || sql.includes('CAPABILITY_SELECT'))
        && /\bpurpose\s*=\s*\?/iu.test(sql);
      const verifiedProviderEvidence = source === 'app/lib/server/email/webhook-repository.ts'
        && (sql.includes('forecast_email_provider_events')
          || sql.includes('forecast_email_suppression_events'));
      if (!trustedBootstrapIdentity && !purposeBoundCapability && !verifiedProviderEvidence) {
        violations.push(source);
      }
    }
  }
  return violations;
}

export type RouteAuditReport = {
  schemaVersion: 'northstar-auth-route-audit-1';
  command: 'auth:route-audit';
  readOnly: true;
  status: 'ready' | 'blocked';
  releaseBlocking: boolean;
  summary: {
    discoveredCount: number;
    classifiedCount: number;
    unclassifiedCount: number;
    staleCount: number;
    duplicateCount: number;
    fixedResolverReferenceCount: number;
    unexpectedGlobalIdRepositoryReferenceCount: number;
    routeActionMismatchCount: number;
  };
  blockers: string[];
};

export function auditRoutes(root = WEB_ROOT): RouteAuditReport {
  const appRoot = join(root, 'app');
  const sourceFiles = files(appRoot).filter((path) => /\.(?:ts|tsx)$/u.test(path));
  const discovered: string[] = [];
  for (const path of sourceFiles) {
    const sourcePath = safePath(path);
    const text = readFileSync(path, 'utf8');
    if (sourcePath.endsWith('/page.tsx') || sourcePath === 'app/page.tsx') {
      discovered.push(`${sourcePath}#GET`);
    }
    if (sourcePath.endsWith('/route.ts')) {
      for (const match of text.matchAll(/export\s+(?:(?:async\s+)?function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gu)) {
        discovered.push(`${sourcePath}#${match[1]}`);
      }
    }
  }
  const classified = ROUTE_AUTHORIZATION_MANIFEST.map((entry) => `${entry.source}#${entry.method}`);
  const discoveredSet = new Set(discovered);
  const classifiedSet = new Set(classified);
  const duplicates = classified.filter((value, index) => classified.indexOf(value) !== index);
  const unclassified = discovered.filter((value) => !classifiedSet.has(value));
  const stale = classified.filter((value) => !discoveredSet.has(value));
  const fixedResolverReferences = files(root)
    .filter((path) => /\.(?:ts|tsx)$/u.test(path) && !path.includes(`${sep}node_modules${sep}`))
    .filter((path) => {
      const value = safePath(path);
      return (value.startsWith('app/api/') || value.startsWith('app/lib/server/')
        || value.startsWith('operator/') || value.startsWith('worker/'))
        && value !== 'operator/auth-audit.ts';
    })
    .filter((path) => readFileSync(path, 'utf8').includes('resolveCurrentProfile'))
    .map(safePath);
  const unexpectedGlobalIdReferences = unexpectedGlobalIdSql(root);
  const routeActionMismatches = ROUTE_AUTHORIZATION_MANIFEST.filter((entry) => {
    if (!entry.action) return false;
    const text = readFileSync(join(root, entry.enforcementSource ?? entry.source), 'utf8');
    return [entry.action, ...(entry.additionalActions ?? [])]
      .some((action) => !text.includes(`'${action}'`) && !text.includes(`"${action}"`));
  });
  const blockers = [
    ...unclassified.map(() => 'route_unclassified'),
    ...stale.map(() => 'route_manifest_stale'),
    ...duplicates.map(() => 'route_manifest_duplicate'),
    ...fixedResolverReferences.map(() => 'fixed_profile_resolver_reference'),
    ...unexpectedGlobalIdReferences.map(() => 'unscoped_repository_id_lookup'),
    ...routeActionMismatches.map(() => 'route_action_mismatch'),
  ].sort();
  return {
    schemaVersion: 'northstar-auth-route-audit-1',
    command: 'auth:route-audit',
    readOnly: true,
    status: blockers.length ? 'blocked' : 'ready',
    releaseBlocking: blockers.length > 0,
    summary: {
      discoveredCount: discovered.length,
      classifiedCount: classified.length,
      unclassifiedCount: unclassified.length,
      staleCount: stale.length,
      duplicateCount: duplicates.length,
      fixedResolverReferenceCount: fixedResolverReferences.length,
      unexpectedGlobalIdRepositoryReferenceCount: unexpectedGlobalIdReferences.length,
      routeActionMismatchCount: routeActionMismatches.length,
    },
    blockers,
  };
}

async function tableNames(d1: D1Database) {
  const result = await d1.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all<{ name: string }>();
  return result.results.map((row) => row.name);
}

async function scalar(d1: D1Database, sql: string, bindings: unknown[] = []) {
  const row = await d1.prepare(sql).bind(...bindings).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function crossProfileCount(d1: D1Database, available: Set<string>) {
  const checks = [
    ['forecast_events', `SELECT COUNT(*) AS count FROM forecast_events c LEFT JOIN forecasts p ON p.id = c.forecast_id WHERE p.id IS NULL OR p.profile_id <> c.profile_id`],
    ['evaluation_runs', `SELECT COUNT(*) AS count FROM evaluation_runs c LEFT JOIN forecasts p ON p.id = c.forecast_id WHERE p.id IS NULL OR p.profile_id <> c.profile_id`],
    ['analysis_snapshots', `SELECT COUNT(*) AS count FROM analysis_snapshots c LEFT JOIN forecasts p ON p.id = c.forecast_id WHERE p.id IS NULL OR p.profile_id <> c.profile_id`],
    ['forecast_review_items', `SELECT COUNT(*) AS count FROM forecast_review_items c LEFT JOIN forecasts p ON p.id = c.forecast_id LEFT JOIN evaluation_runs r ON r.id = c.evaluation_run_id WHERE p.id IS NULL OR p.profile_id <> c.profile_id OR r.id IS NULL OR r.profile_id <> c.profile_id OR r.forecast_id <> c.forecast_id`],
  ] as const;
  let count = 0;
  for (const [table, sql] of checks) if (available.has(table)) count += await scalar(d1, sql);
  return count;
}

export type TenantAuditReport = {
  schemaVersion: 'northstar-auth-tenant-audit-1';
  command: 'auth:tenant-audit' | 'auth:bootstrap:status';
  readOnly: true;
  status: 'ready' | 'migration_required' | 'blocked';
  releaseBlocking: boolean;
  summary: {
    profileCount: number;
    authorizationTableCount: number;
    authorizationSchemaPresent: boolean;
    bootstrapIdentityState: 'missing' | 'active' | 'disabled' | 'invalid';
    activeBootstrapOwnerMembershipCount: number;
    membershipIntegrityViolationCount: number;
    missingAuthorizationTriggerCount: number;
    invalidAuthorizationTriggerCount: number;
    orphanCount: number;
    crossProfileViolationCount: number;
    foreignKeyViolationCount: number;
    unclassifiedTableCount: number;
    missingExpectedTableCount: number;
    migrationReady: boolean;
  };
  blockers: string[];
};

export async function auditTenant(
  d1: D1Database,
  command: TenantAuditReport['command'] = 'auth:tenant-audit',
): Promise<TenantAuditReport> {
  const tables = await tableNames(d1);
  const available = new Set(tables);
  const classified = new Set(TABLE_OWNERSHIP_MANIFEST.map((entry) => entry.table));
  const unclassified = tables.filter((table) => !classified.has(table) && !PLATFORM_MANAGED_TABLES.has(table));
  const missingExpected = [...classified].filter((table) => !available.has(table));
  const profileCount = available.has('investment_profiles')
    ? await scalar(d1, 'SELECT COUNT(*) AS count FROM investment_profiles') : 0;
  const authorizationTableCount = AUTH_TABLES.filter((table) => available.has(table)).length;
  const authorizationSchemaPresent = authorizationTableCount === AUTH_TABLES.length;
  const authorizationSchemaPartial = authorizationTableCount > 0 && !authorizationSchemaPresent;
  const foreignKeyViolationCount = available.size
    ? (await d1.prepare('PRAGMA foreign_key_check').all()).results.length : 0;
  let orphanCount = 0;
  if (available.has('investment_profiles')) {
    for (const entry of TABLE_OWNERSHIP_MANIFEST) {
      if (!available.has(entry.table) || !['profile_direct', 'profile_inherited'].includes(entry.ownership)) continue;
      orphanCount += await scalar(d1, `SELECT COUNT(*) AS count FROM ${entry.table} c
        LEFT JOIN investment_profiles p ON p.id = c.profile_id WHERE p.id IS NULL`);
    }
    if (available.has('forecast_email_provider_events')) {
      orphanCount += await scalar(d1, `SELECT COUNT(*) AS count FROM forecast_email_provider_events c
        LEFT JOIN investment_profiles p ON p.id = c.profile_id
        WHERE c.profile_id IS NOT NULL AND p.id IS NULL`);
    }
  }
  const crossProfileViolationCount = await crossProfileCount(d1, available);
  let bootstrapIdentityState: TenantAuditReport['summary']['bootstrapIdentityState'] = 'missing';
  let activeBootstrapOwnerMembershipCount = 0;
  let membershipIntegrityViolationCount = 0;
  let missingAuthorizationTriggerCount = 0;
  let invalidAuthorizationTriggerCount = 0;
  if (authorizationSchemaPresent) {
    const user = await d1.prepare(`SELECT status, external_identity_state AS externalState
      FROM identity_users WHERE id = ?`).bind(BOOTSTRAP_IDS.user)
      .first<{ status: string; externalState: string }>();
    if (user) bootstrapIdentityState = user.status === 'active' && user.externalState === 'bootstrap_pending'
      ? 'active' : user.status === 'disabled' ? 'disabled' : 'invalid';
    activeBootstrapOwnerMembershipCount = await scalar(d1, `SELECT COUNT(*) AS count
      FROM profile_memberships m JOIN identity_users u ON u.id = m.user_id
      JOIN profile_membership_events e ON e.membership_id = m.id AND e.profile_id = m.profile_id
      WHERE m.id = ? AND u.id = ? AND e.id = ? AND m.role = 'owner'
        AND m.status = 'active' AND u.status = 'active'`,
    [BOOTSTRAP_IDS.membership, BOOTSTRAP_IDS.user, BOOTSTRAP_IDS.event]);
    membershipIntegrityViolationCount = await scalar(d1, `SELECT COUNT(*) AS count
      FROM profile_memberships m
      WHERE NOT EXISTS (
        SELECT 1 FROM profile_membership_events e
        WHERE e.membership_id = m.id AND e.user_id = m.user_id AND e.profile_id = m.profile_id
          AND e.revision = m.revision AND e.role = m.role AND e.status = m.status)
        OR m.revision <> (
          SELECT COALESCE(MAX(e.revision), 0) FROM profile_membership_events e
          WHERE e.membership_id = m.id)`);
    const triggers = await d1.prepare(`SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND name IN (${REQUIRED_AUTH_TRIGGERS.map(() => '?').join(', ')})`)
      .bind(...REQUIRED_AUTH_TRIGGERS).all<{ name: string; sql: string }>();
    missingAuthorizationTriggerCount = REQUIRED_AUTH_TRIGGERS.length - triggers.results.length;
    invalidAuthorizationTriggerCount = triggers.results.filter((trigger) =>
      normalizedTriggerSql(trigger.sql) !== normalizedTriggerSql(
        REQUIRED_AUTH_TRIGGER_SQL.get(trigger.name) ?? '',
      )).length;
  }
  const ambiguousLegacyProfiles = profileCount > 1 && bootstrapIdentityState === 'missing';
  const missingNonAuthorizationTables = missingExpected.filter((table) =>
    !(AUTH_TABLES as readonly string[]).includes(table));
  const missingExpectedBlocked = command === 'auth:tenant-audit'
    ? missingExpected.length > 0
    : profileCount > 0 && missingNonAuthorizationTables.length > 0;
  const integrityBlocked = ambiguousLegacyProfiles || authorizationSchemaPartial || missingExpectedBlocked
    || foreignKeyViolationCount > 0 || orphanCount > 0 || crossProfileViolationCount > 0
    || unclassified.length > 0 || membershipIntegrityViolationCount > 0
    || missingAuthorizationTriggerCount > 0 || invalidAuthorizationTriggerCount > 0;
  const migrationReady = !integrityBlocked && profileCount <= 1;
  const releaseBlocking = command === 'auth:tenant-audit'
    ? integrityBlocked || !authorizationSchemaPresent || bootstrapIdentityState !== 'active'
      || activeBootstrapOwnerMembershipCount !== 1
    : integrityBlocked;
  const blockers: string[] = [];
  if (ambiguousLegacyProfiles) blockers.push('ambiguous_legacy_profiles');
  if (authorizationSchemaPartial) blockers.push('authorization_schema_partial');
  if (missingExpectedBlocked) blockers.push('expected_table_missing');
  if (foreignKeyViolationCount) blockers.push('foreign_key_violation');
  if (orphanCount) blockers.push('orphaned_profile_rows');
  if (crossProfileViolationCount) blockers.push('cross_profile_relationship');
  if (membershipIntegrityViolationCount) blockers.push('membership_history_mismatch');
  if (missingAuthorizationTriggerCount) blockers.push('authorization_trigger_missing');
  if (invalidAuthorizationTriggerCount) blockers.push('authorization_trigger_invalid');
  if (unclassified.length) blockers.push('ownership_unclassified');
  if (command === 'auth:tenant-audit' && !authorizationSchemaPresent) blockers.push('authorization_schema_missing');
  if (command === 'auth:tenant-audit' && bootstrapIdentityState !== 'active') blockers.push('bootstrap_identity_not_active');
  if (command === 'auth:tenant-audit' && activeBootstrapOwnerMembershipCount !== 1) blockers.push('bootstrap_owner_membership_invalid');
  return {
    schemaVersion: 'northstar-auth-tenant-audit-1', command, readOnly: true,
    status: releaseBlocking ? 'blocked' : authorizationSchemaPresent ? 'ready' : 'migration_required',
    releaseBlocking,
    summary: {
      profileCount, authorizationTableCount, authorizationSchemaPresent, bootstrapIdentityState,
      activeBootstrapOwnerMembershipCount, membershipIntegrityViolationCount,
      missingAuthorizationTriggerCount, invalidAuthorizationTriggerCount,
      orphanCount, crossProfileViolationCount,
      foreignKeyViolationCount, unclassifiedTableCount: unclassified.length,
      missingExpectedTableCount: missingExpected.length, migrationReady,
    },
    blockers: [...new Set(blockers)].sort(),
  };
}

function platformOptions() {
  const override = process.env.NORTHSTAR_COORDINATOR_PERSIST_PATH;
  const path = override ? (override.endsWith('/v3') ? override : `${override}/v3`) : DEFAULT_PERSIST_PATH;
  return { configPath: CONFIG_PATH, persist: { path }, remoteBindings: false } as const;
}

export async function withLocalD1<T>(operation: (d1: D1Database) => Promise<T>): Promise<T> {
  // Keep the operator-only Wrangler runtime out of Vite's application dependency graph.
  const wranglerModule = 'wrangler';
  const { getPlatformProxy } = await import(wranglerModule) as typeof import('wrangler');
  const platform = await getPlatformProxy<{ DB: D1Database }>(platformOptions());
  try {
    if (!platform.env.DB) throw new Error('LocalD1Unavailable');
    return await operation(platform.env.DB);
  } finally {
    await platform.dispose();
  }
}

export function renderAudit(report: RouteAuditReport | TenantAuditReport, json: boolean) {
  if (json) return JSON.stringify(report);
  const lines = [
    `${report.command}: ${report.status}`,
    'Read-only: yes',
    `Release blocking: ${report.releaseBlocking ? 'yes' : 'no'}`,
    ...Object.entries(report.summary).map(([key, value]) => `${key}: ${String(value)}`),
  ];
  if (report.blockers.length) lines.push(`Blockers: ${report.blockers.join(', ')}`);
  return lines.join('\n');
}
