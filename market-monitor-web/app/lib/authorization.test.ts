import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { authConfigurationFromEnv, AuthConfigurationError } from './server/auth/config.ts';
import { authorizationErrorResponse } from './server/auth/http.ts';
import { authorize, HUMAN_ROLE_ACTIONS } from './server/auth/policy.ts';
import { resolveRequestPrincipal } from './server/auth/resolver.ts';
import { trustedOperatorScope, trustedSchedulerScope } from './server/auth/system.ts';
import {
  AuthorizedCoordinatorService,
  AuthorizedEmailDispatcherService,
} from './server/auth/system-services.ts';
import {
  AUTHORIZATION_ACTIONS,
  type HumanPrincipal,
  type MembershipRole,
} from './server/auth/types.ts';
import { TABLE_OWNERSHIP_MANIFEST } from './server/auth/ownership-manifest.ts';
import {
  NON_ROUTE_EXECUTION_BOUNDARIES,
  ROUTE_AUTHORIZATION_MANIFEST,
} from './server/auth/route-manifest.ts';
import { AuthorizationBoundaryError } from './server/auth/enforcement.ts';
import {
  authorizationInitializationStatements,
  authorizationIntegrityStatements,
  assertAuthorizationInitializationReady,
  assertAuthorizationIntegrityReady,
  ensureAuthorizationBootstrap,
} from '../../db/authorization-initialization.ts';
import { auditRoutes, auditTenant, renderAudit } from '../../operator/auth-audit.ts';

class SQLitePrepared {
  private bindings: Array<string | number | null> = [];
  private readonly database: DatabaseSync;
  private readonly sql: string;
  constructor(database: DatabaseSync, sql: string) {
    this.database = database;
    this.sql = sql;
  }
  bind(...values: Array<string | number | null>) {
    const statement = new SQLitePrepared(this.database, this.sql);
    statement.bindings = values;
    return statement;
  }
  async first<T>() {
    return (this.database.prepare(this.sql).get(...this.bindings) ?? null) as T | null;
  }
  async all<T>() {
    return {
      success: true,
      results: this.database.prepare(this.sql).all(...this.bindings) as T[],
      meta: {},
    };
  }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, results: [], meta: { changes: result.changes } };
  }
}

class SQLiteD1 {
  private readonly database: DatabaseSync;
  constructor(database: DatabaseSync) { this.database = database; }
  prepare(sql: string) { return new SQLitePrepared(this.database, sql); }
  async batch(statements: SQLitePrepared[]) {
    this.database.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function human(role: MembershipRole, overrides: Partial<HumanPrincipal> = {}): HumanPrincipal {
  return {
    kind: 'human', userId: 'user-a', userStatus: 'active', membershipId: 'membership-a',
    membershipStatus: 'active', profileId: 1, role,
    assurance: { mechanism: 'local_bootstrap', externalIdentityLinked: false },
    ...overrides,
  };
}

test('authorization action vocabulary is exhaustive and human roles are deny-by-default', () => {
  const owner = human('owner');
  const editor = human('editor');
  const viewer = human('viewer');
  for (const action of AUTHORIZATION_ACTIONS) {
    const decisions = [owner, editor, viewer].map((principal) => authorize(principal, action, { profileId: 1 }));
    assert.equal(decisions.every((decision) => typeof decision.allowed === 'boolean'), true, action);
  }
  assert.equal(authorize(owner, 'forecast_read', {}).reason, 'wrong_profile');
  assert.equal(authorize(owner, 'unknown.future.action', { profileId: 1 }).reason, 'unknown_action');
  assert.equal(authorize({ kind: 'anonymous' }, 'workspace_read', { profileId: 1 }).reason, 'unauthenticated');
  assert.equal(authorize(human('owner', { userStatus: 'disabled' }), 'forecast_read', { profileId: 1 }).reason, 'user_disabled');
  assert.equal(authorize(human('owner', { membershipStatus: 'revoked' }), 'forecast_read', { profileId: 1 }).reason, 'membership_inactive');
  assert.equal(authorize(owner, 'forecast_read', { profileId: 2 }).reason, 'wrong_profile');
  assert.equal(authorize(human('owner', { role: 'administrator' as MembershipRole }),
    'forecast_read', { profileId: 1 }).reason, 'insufficient_role');

  assert.equal(authorize(viewer, 'forecast_read', { profileId: 1 }).allowed, true);
  assert.equal(authorize(viewer, 'forecast_edit', { profileId: 1 }).reason, 'insufficient_role');
  assert.equal(authorize(viewer, 'in_app_notification_state_update', { profileId: 1 }).allowed, false);
  assert.equal(authorize(editor, 'forecast_evaluate', { profileId: 1 }).allowed, true);
  assert.equal(authorize(editor, 'portfolio_write', { profileId: 1 }).allowed, false);
  assert.equal(authorize(owner, 'membership_administer', { profileId: 1 }).allowed, true);
});

test('every human route action follows the role matrix and rejects a second tenant principal', () => {
  const principals = { owner: human('owner'), editor: human('editor'), viewer: human('viewer') };
  const otherTenant = human('owner', {
    userId: 'user-b', membershipId: 'membership-b', profileId: 2,
  });
  for (const entry of ROUTE_AUTHORIZATION_MANIFEST.filter((value) =>
    value.boundary === 'human_protected')) {
    for (const action of [entry.action, ...(entry.additionalActions ?? [])]) {
      assert.ok(action, `${entry.source} must declare an action`);
      for (const [role, principal] of Object.entries(principals) as
        Array<[MembershipRole, HumanPrincipal]>) {
        assert.equal(authorize(principal, action, { profileId: 1 }).allowed,
          HUMAN_ROLE_ACTIONS[role].has(action), `${entry.path} ${entry.method} ${role} ${action}`);
      }
      assert.equal(authorize(otherTenant, action, { profileId: 1 }).reason, 'wrong_profile',
        `${entry.path} ${entry.method} must reject tenant B for tenant A`);
    }
  }
});

test('system, provider, and capability principals cannot expand their exact authority', () => {
  const scheduler = trustedSchedulerScope({
    NORTHSTAR_ENVIRONMENT: 'production', NORTHSTAR_AUTH_MODE: 'deny_all', NORTHSTAR_SYSTEM_PROFILE_ID: '7',
  }, 'scheduler-v1').principal;
  assert.equal(authorize(scheduler, 'scheduler_coordinate', { profileId: 7 }).allowed, true);
  assert.equal(authorize(scheduler, 'email_recipient_administer', { profileId: 7 }).reason, 'system_action_not_allowed');
  assert.equal(authorize(scheduler, 'scheduler_coordinate', { profileId: 8 }).reason, 'wrong_profile');

  const operatorScope = trustedOperatorScope({
    NORTHSTAR_ENVIRONMENT: 'local', NORTHSTAR_AUTH_MODE: 'deny_all', NORTHSTAR_SYSTEM_PROFILE_ID: '7',
  }, 'operator_status_inspect', 'forecast:email:status');
  assert.equal(authorize(operatorScope.principal, 'operator_status_inspect', { profileId: 7 }).allowed, true);
  assert.equal(authorize(operatorScope.principal, 'email_dispatch', { profileId: 7 }).allowed, false);
  assert.throws(() => trustedOperatorScope({
    NORTHSTAR_ENVIRONMENT: 'local', NORTHSTAR_AUTH_MODE: 'deny_all', NORTHSTAR_SYSTEM_PROFILE_ID: '7',
  }, 'email_dispatch', 'forecast:email:status'), AuthorizationBoundaryError);

  const provider = { kind: 'provider_resend', provider: 'resend', webhookId: 'evt_1', verifiedAt: '2026-08-26T00:00:00.000Z' } as const;
  assert.equal(authorize(provider, 'resend_webhook_reconcile', { providerEventId: 'evt_1' }).allowed, true);
  assert.equal(authorize(provider, 'forecast_read', { profileId: 1 }).reason, 'provider_action_not_allowed');
  assert.equal(authorize(provider, 'resend_webhook_reconcile', {}).reason, 'resource_unavailable');
  assert.equal(authorize(provider, 'resend_webhook_reconcile', { providerEventId: 'evt_2' }).allowed, false);

  const verification = {
    kind: 'capability_email_verification', profileId: 1, capabilityId: 'cap_1',
    recipientId: 'recipient_1', expiresAt: '2026-08-27T00:00:00.000Z',
  } as const;
  assert.equal(authorize(verification, 'email_verification_consume', {
    profileId: 1, capabilityId: 'cap_1', recipientId: 'recipient_1', now: '2026-08-26T00:00:00.000Z',
  }).allowed, true);
  assert.equal(authorize(verification, 'email_unsubscribe_consume', { profileId: 1 }).reason, 'capability_purpose_mismatch');
  assert.equal(authorize(verification, 'email_verification_consume', {
    profileId: 1, capabilityId: 'cap_1', recipientId: 'recipient_1',
  }).reason, 'resource_unavailable');
  assert.equal(authorize(verification, 'email_verification_consume', {
    profileId: 1, capabilityId: 'cap_1', recipientId: 'recipient_1',
    now: '2026-08-28T00:00:00.000Z',
  }).reason, 'capability_expired');
  assert.equal(authorize(verification, 'forecast_read', { profileId: 1 }).allowed, false);
});

test('system service adapters derive tenant scope and reject confused-deputy actions', async () => {
  const schedulerScope = trustedSchedulerScope({
    NORTHSTAR_ENVIRONMENT: 'production', NORTHSTAR_AUTH_MODE: 'deny_all', NORTHSTAR_SYSTEM_PROFILE_ID: '7',
  }, 'scheduler-v1');
  let coordinatorProfile = 0;
  const coordinator = new AuthorizedCoordinatorService(schedulerScope, {
    async coordinate(_value: unknown, profileId: number) {
      coordinatorProfile = profileId;
      return { profileId } as never;
    },
  });
  await coordinator.coordinate({ profileId: 999 });
  assert.equal(coordinatorProfile, 7);

  const statusScope = trustedOperatorScope({
    NORTHSTAR_ENVIRONMENT: 'local', NORTHSTAR_AUTH_MODE: 'deny_all', NORTHSTAR_SYSTEM_PROFILE_ID: '7',
  }, 'operator_status_inspect', 'forecast:email:status');
  const confusedDeputy = new AuthorizedEmailDispatcherService(statusScope as never, {
    async dispatch() { return {} as never; },
  });
  assert.throws(
    () => confusedDeputy.dispatch({ cutoff: '2026-08-26T00:00:00.000Z' }),
    AuthorizationBoundaryError,
  );
});

test('auth configuration defaults closed and rejects local bootstrap outside local or test', () => {
  assert.deepEqual(authConfigurationFromEnv({}), {
    environment: 'production', mode: 'deny_all', systemProfileId: null,
  });
  assert.equal(authConfigurationFromEnv({
    NORTHSTAR_ENVIRONMENT: 'local', NORTHSTAR_AUTH_MODE: 'local_bootstrap',
  }).mode, 'local_bootstrap');
  for (const environment of ['preview', 'staging', 'production']) {
    assert.throws(() => authConfigurationFromEnv({
      NORTHSTAR_ENVIRONMENT: environment, NORTHSTAR_AUTH_MODE: 'local_bootstrap',
    }), AuthConfigurationError);
  }
  assert.throws(() => authConfigurationFromEnv({ NORTHSTAR_AUTH_MODE: 'external' }), AuthConfigurationError);
  assert.throws(() => authConfigurationFromEnv({ NORTHSTAR_SYSTEM_PROFILE_ID: '01' }), AuthConfigurationError);
});

test('request resolver ignores forged headers and only explicit local bootstrap can load a human', async () => {
  let loads = 0;
  const owner = human('owner');
  const repository = { async loadLocalBootstrapPrincipal() { loads += 1; return owner; } };
  const forged = new Request('https://northstar.example/api/workspace', {
    headers: { 'X-User-ID': 'attacker', 'X-Profile-ID': '999', 'X-Role': 'owner', Cookie: 'role=owner' },
  });
  assert.deepEqual(await resolveRequestPrincipal(forged, { bindings: {}, repository }), { kind: 'anonymous' });
  assert.equal(loads, 0);
  assert.deepEqual(await resolveRequestPrincipal(forged, {
    bindings: { NORTHSTAR_ENVIRONMENT: 'local', NORTHSTAR_AUTH_MODE: 'local_bootstrap' }, repository,
  }), owner);
  assert.equal(loads, 1);
});

test('deny-all maps to a generic no-store 401 without leaking forged identity values', async () => {
  const forged = new Request('https://northstar.example/api/forecasts/982', {
    headers: { 'X-User-ID': 'secret-user', 'X-Profile-ID': '982', 'X-Role': 'owner' },
  });
  const principal = await resolveRequestPrincipal(forged, {
    bindings: {},
    repository: { async loadLocalBootstrapPrincipal() { throw new Error('must not load'); } },
  });
  const decision = authorize(principal, 'forecast_read', { profileId: 982, resourceId: 982 });
  assert.equal(decision.reason, 'unauthenticated');
  const response = authorizationErrorResponse(new AuthorizationBoundaryError(decision.reason));
  assert.ok(response);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.text();
  assert.doesNotMatch(body, /secret-user|982|owner/u);
});

function migrationsThrough(number: number) {
  return Array.from({ length: number + 1 }, (_, index) => {
    const names = [
      '0000_spotty_sugar_man.sql', '0001_kind_warbound.sql', '0002_quiet_gamora.sql',
      '0003_great_xavin.sql', '0004_clean_next_avengers.sql', '0005_thin_ikaris.sql',
      '0006_late_wasp.sql', '0007_late_amphibian.sql', '0008_vengeful_the_watchers.sql',
      '0009_mysterious_maginty.sql',
    ];
    return readFileSync(new URL(`../../drizzle/${names[index]}`, import.meta.url), 'utf8');
  });
}

function applyMigration(db: DatabaseSync, sql: string) {
  for (const statement of sql.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean)) {
    db.exec(statement);
  }
}

function legacyDataSnapshot(db: DatabaseSync) {
  const tables = db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>;
  return Object.fromEntries(tables.map(({ name }) => [
    name,
    db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map((row) => ({ ...row })),
  ]));
}

test('0009 preserves a populated single tenant and creates an email-free pending bootstrap owner', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = OFF');
  const migrations = migrationsThrough(9);
  for (const migration of migrations.slice(0, 9)) applyMigration(db, migration);
  db.exec(`INSERT INTO investment_profiles VALUES (41, 'Existing', 'USD', 20, '2026-01-01T00:00:00.000Z');
    INSERT INTO positions (profile_id, symbol, company_name, shares, average_cost, created_at)
      VALUES (41, 'SAME', 'Tenant A', 1, 10, '2026-01-01T00:00:00.000Z');
    INSERT INTO forecasts
      (id,profile_id,symbol,direction,confidence,thesis,supporting_evidence,counter_evidence,
       setup_tag,evaluation_date,target_kind,target_price,status,activated_at,market_data_as_of,
       activation_price,activation_currency,market_provider,created_at,updated_at)
    VALUES (1,41,'SAME','bullish',80,'thesis','support','counter','manual','2026-09-30',
      'price',150,'active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',100,
      'USD','test','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO evaluation_runs
      (id,profile_id,forecast_id,result_kind,reason_code,explanation,evaluator_version,ruleset_version,
       evaluated_through,evaluation_cutoff,evidence_json,warnings_json,input_fingerprint,created_at)
    VALUES (1,41,1,'needs_review','currency_unverified','safe','evaluator-v1','ruleset-v1',
      '2026-08-26','2026-08-26T12:00:00.000Z','{}','[]','${'1'.repeat(64)}',
      '2026-01-01T00:00:00.000Z');
    INSERT INTO forecast_review_items
      (id,profile_id,forecast_id,evaluation_run_id,review_kind,acknowledged_at,created_at)
    VALUES (1,41,1,1,'needs_review',NULL,'2026-01-01T00:00:00.000Z');
    INSERT INTO forecast_notification_preference_revisions
      (profile_id,revision,preference_version,master_consent,target_hit_enabled,invalidated_enabled,
       expired_enabled,needs_review_enabled,timezone,quiet_hours_start,quiet_hours_end,change_source,
       change_reason,created_at)
    VALUES (41,1,'preferences-v1',1,1,1,1,1,'UTC',NULL,NULL,'operator','migration',
      '2026-01-01T00:00:00.000Z');
    INSERT INTO forecast_notification_preferences
      VALUES (41,1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO forecast_notification_intents
      (id,profile_id,forecast_id,evaluation_run_id,review_item_id,analysis_snapshot_id,category,
       dedup_contract_version,projector_version,payload_schema_version,dedup_key,payload_json,
       payload_fingerprint,event_occurred_at,created_at)
    VALUES ('intent-preserved',41,1,1,1,NULL,'needs_review','dedup-v1','projector-v1','payload-v1',
      '${'2'.repeat(64)}','{}','${'3'.repeat(64)}','2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z');
    INSERT INTO forecast_notification_policy_decisions
      (id,intent_id,profile_id,policy_version,preference_revision,decision,reason_code,decided_at,
       earliest_eligible_at,warnings_json,created_at)
    VALUES ('policy-preserved','intent-preserved',41,'policy-v1',1,'eligible','eligible',
      '2026-01-01T00:00:00.000Z',NULL,'[]','2026-01-01T00:00:00.000Z');
    INSERT INTO forecast_notification_outbox
      (id,intent_id,policy_decision_id,profile_id,retry_policy_version,quiet_hours_policy_version,state,
       available_at,attempt_count,lease_token,lease_expires_at,last_attempt_at,succeeded_at,
       dead_lettered_at,suppressed_at,suppression_reason,last_failure_category,created_at,updated_at)
    VALUES ('outbox-preserved','intent-preserved','policy-preserved',41,'retry-v1','quiet-v1','succeeded',
      NULL,1,NULL,NULL,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL,NULL,NULL,NULL,
      '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO forecast_notification_delivery_attempts
      (id,outbox_id,profile_id,attempt_number,owner_token,state,retry_policy_version,adapter_kind,
       adapter_version,started_at,finished_at,failure_classification,redacted_error_category,
       next_attempt_at,created_at)
    VALUES ('attempt-preserved','outbox-preserved',41,1,'owner-preserved','succeeded','retry-v1',
      'resend','resend-v1','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL,NULL,NULL,
      '2026-01-01T00:00:00.000Z');
    INSERT INTO forecast_email_recipients VALUES
      ('recipient',41,1,'person@example.test','p***@example.test','verified',
       '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL,'none',NULL,NULL,
       '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO forecast_email_consent_revisions VALUES
      (41,1,'recipient',1,1,1,1,1,'operator','2026-01-01T00:00:00.000Z',NULL,
       '2026-01-01T00:00:00.000Z');
    INSERT INTO forecast_email_consents VALUES
      (41,1,'recipient','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO forecast_email_provider_events VALUES
      ('provider-event','resend','evt-1','email-1',NULL,NULL,'email.delivered',1,
       '${'a'.repeat(64)}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
       'unknown_delivery','2026-01-01T00:00:00.000Z');
    INSERT INTO forecast_in_app_notification_projection_checkpoints VALUES
      (41,'forecast-in-app-projector-1.0.0',1,'intent-preserved',1,'intent-preserved',
       '2026-01-01T00:00:00.000Z',NULL,NULL,0,'2026-01-01T00:00:00.000Z',
       '2026-01-01T00:00:00.000Z');
    INSERT INTO forecast_in_app_notification_entries
      (sequence,id,profile_id,source_intent_id,forecast_id,evaluation_run_id,review_item_id,
       analysis_snapshot_id,category,symbol,occurred_at,presentation_version,presentation_json,
       presentation_fingerprint,deep_link_kind,state,first_read_at,state_updated_at,created_at,updated_at)
    VALUES (1,'entry-preserved',41,'intent-preserved',1,1,1,NULL,'needs_review','SAME',
      '2026-01-01T00:00:00.000Z','presentation-v1','{}','${'4'.repeat(64)}',
      'notification_evidence','unread',NULL,'2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO forecast_in_app_notification_projection_items VALUES
      ('projection-preserved',41,'forecast-in-app-projector-1.0.0','intent-preserved',1,
       'entry-preserved','materialized','materialized','2026-01-01T00:00:00.000Z',
       '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');`);
  const before = legacyDataSnapshot(db);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('BEGIN');
  applyMigration(db, migrations[9]);
  db.exec('COMMIT');
  for (const [table, rows] of Object.entries(before)) {
    assert.deepEqual(
      db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all().map((row) => ({ ...row })),
      rows,
      `${table} rows changed during 0008 to 0009 migration`,
    );
  }
  assert.deepEqual({ ...db.prepare(`SELECT status, external_identity_state AS externalState
    FROM identity_users`).get() }, { status: 'active', externalState: 'bootstrap_pending' });
  assert.deepEqual({ ...db.prepare(`SELECT profile_id AS profileId, role, status
    FROM profile_memberships`).get() }, { profileId: 41, role: 'owner', status: 'active' });
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('identity_users') WHERE name LIKE '%email%'`).get() as { count: number }).count, 0);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.throws(() => db.exec("UPDATE profile_membership_events SET role = 'viewer'"), /MembershipEventAppendOnly/u);
  assert.throws(() => db.exec(`UPDATE profile_memberships
    SET role = 'viewer', revision = 2, updated_at = '2026-08-26T01:00:00.000Z'`),
  /MembershipEventRequired/u);
  db.close();
});

test('0009 handles empty installation explicitly and blocks ambiguous legacy profiles transactionally', () => {
  const migrations = migrationsThrough(9);
  const empty = new DatabaseSync(':memory:');
  for (const migration of migrations.slice(0, 9)) applyMigration(empty, migration);
  applyMigration(empty, migrations[9]);
  assert.equal((empty.prepare('SELECT COUNT(*) AS count FROM identity_users').get() as { count: number }).count, 0);
  empty.close();

  const multiple = new DatabaseSync(':memory:');
  for (const migration of migrations.slice(0, 9)) applyMigration(multiple, migration);
  multiple.exec(`INSERT INTO investment_profiles VALUES
    (1, 'A', 'USD', 0, '2026-01-01T00:00:00.000Z'),
    (2, 'B', 'USD', 0, '2026-01-01T00:00:00.000Z')`);
  multiple.exec('BEGIN');
  assert.throws(() => applyMigration(multiple, migrations[9]), /CHECK constraint failed/u);
  multiple.exec('ROLLBACK');
  assert.equal((multiple.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'identity_users'`).get() as { count: number }).count, 0);
  multiple.close();
});

test('runtime authorization DDL matches migration tables, indexes, and integrity triggers', () => {
  const migrations = migrationsThrough(9);
  const migrated = new DatabaseSync(':memory:');
  const runtime = new DatabaseSync(':memory:');
  for (const migration of migrations.slice(0, 9)) {
    applyMigration(migrated, migration);
    applyMigration(runtime, migration);
  }
  applyMigration(migrated, migrations[9]);
  for (const statement of authorizationInitializationStatements()) runtime.exec(statement);
  for (const statement of authorizationIntegrityStatements()) runtime.exec(statement);
  for (const table of ['identity_users', 'profile_memberships', 'profile_membership_events']) {
    assert.deepEqual(runtime.prepare(`PRAGMA table_info(${table})`).all(),
      migrated.prepare(`PRAGMA table_info(${table})`).all(), `${table} columns`);
    assert.deepEqual(runtime.prepare(`PRAGMA foreign_key_list(${table})`).all(),
      migrated.prepare(`PRAGMA foreign_key_list(${table})`).all(), `${table} foreign keys`);
    assert.deepEqual(runtime.prepare(`PRAGMA index_list(${table})`).all(),
      migrated.prepare(`PRAGMA index_list(${table})`).all(), `${table} indexes`);
  }
  const triggerNames = authorizationIntegrityStatements().map((statement) =>
    statement.match(/TRIGGER IF NOT EXISTS ([a-z0-9_]+)/u)?.[1]);
  for (const name of triggerNames) {
    assert.ok(name);
    assert.equal((runtime.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'trigger' AND name = ?`).get(name) as { count: number }).count, 1);
    assert.equal((migrated.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'trigger' AND name = ?`).get(name) as { count: number }).count, 1);
  }
  runtime.close();
  migrated.close();
});

test('runtime authorization preflight blocks ambiguous legacy state and trigger-name collisions', async () => {
  const db = new DatabaseSync(':memory:');
  for (const migration of migrationsThrough(8)) applyMigration(db, migration);
  db.exec(`INSERT INTO investment_profiles VALUES
    (1, 'A', 'USD', 0, '2026-01-01T00:00:00.000Z'),
    (2, 'B', 'USD', 0, '2026-01-01T00:00:00.000Z')`);
  await assert.rejects(
    assertAuthorizationInitializationReady(new SQLiteD1(db) as unknown as D1Database),
    /AuthorizationInitializationIntegrityBlocked/u,
  );
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name = 'identity_users'`).get() as { count: number }).count, 0);
  db.close();

  const collision = new DatabaseSync(':memory:');
  for (const migration of migrationsThrough(8)) applyMigration(collision, migration);
  collision.exec(`CREATE TRIGGER forecast_events_tenant_guard_insert
    BEFORE INSERT ON forecast_events BEGIN SELECT 1; END`);
  const collisionD1 = new SQLiteD1(collision) as unknown as D1Database;
  await assert.rejects(
    assertAuthorizationInitializationReady(collisionD1),
    /AuthorizationTriggerConflict/u,
  );
  const collisionAudit = await auditTenant(collisionD1, 'auth:bootstrap:status');
  assert.equal(collisionAudit.summary.migrationReady, false);
  assert.ok(collisionAudit.blockers.includes('authorization_trigger_invalid'));
  collision.close();
});

test('fresh runtime bootstrap creates one empty tenant and is idempotent without reactivating revocation', async () => {
  const db = new DatabaseSync(':memory:');
  for (const migration of migrationsThrough(9)) applyMigration(db, migration);
  const d1 = new SQLiteD1(db) as unknown as D1Database;
  await ensureAuthorizationBootstrap(d1);
  await ensureAuthorizationBootstrap(d1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM investment_profiles').get() as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM identity_users').get() as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM profile_memberships').get() as { count: number }).count, 1);
  db.exec(`INSERT INTO profile_membership_events VALUES
      ('northstar-bootstrap-owner-revoked-v2', 'northstar-bootstrap-owner-v1',
       'northstar-bootstrap-user-v1', 1, 2, 'revoked', 'owner', 'revoked',
       'system_operator', '2026-08-26T01:00:00.000Z');
    UPDATE identity_users SET status = 'disabled', disabled_at = '2026-08-26T01:00:00.000Z';
    UPDATE profile_memberships SET status = 'revoked', revoked_at = '2026-08-26T01:00:00.000Z',
      revision = 2, updated_at = '2026-08-26T01:00:00.000Z'`);
  await ensureAuthorizationBootstrap(d1);
  assert.equal((db.prepare(`SELECT status FROM identity_users`).get() as { status: string }).status, 'disabled');
  assert.equal((db.prepare(`SELECT status FROM profile_memberships`).get() as { status: string }).status, 'revoked');
  db.exec('DROP TRIGGER profile_membership_events_append_only_update');
  db.exec(`UPDATE profile_membership_events SET actor_kind = 'system_operator'
    WHERE id = 'northstar-bootstrap-owner-created-v1'`);
  db.exec(authorizationIntegrityStatements().find((statement) =>
    statement.includes('profile_membership_events_append_only_update')) ?? '');
  await assert.rejects(ensureAuthorizationBootstrap(d1), /AuthorizationBootstrapIntegrityInvalid/u);
  db.close();
});

test('tenant audit is aggregate-only, read-only, and blocks orphaned and cross-profile data', async () => {
  const migrations = migrationsThrough(9);
  const clean = new DatabaseSync(':memory:');
  for (const migration of migrations) applyMigration(clean, migration);
  clean.exec(`INSERT INTO investment_profiles VALUES (9, 'Private tenant name', 'USD', 0,
    '2026-01-01T00:00:00.000Z')`);
  // Migration-on-populated is tested above; these rows model its deterministic output for the audit.
  clean.exec(`INSERT INTO identity_users VALUES
    ('northstar-bootstrap-user-v1', 'active', 'bootstrap_pending', '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z', NULL);
    INSERT INTO profile_memberships VALUES
    ('northstar-bootstrap-owner-v1', 'northstar-bootstrap-user-v1', 9, 'owner', 'active', 1,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL);
    INSERT INTO profile_membership_events VALUES
    ('northstar-bootstrap-owner-created-v1', 'northstar-bootstrap-owner-v1',
      'northstar-bootstrap-user-v1', 9, 1, 'created', 'owner', 'active',
      'bootstrap_migration', '2026-01-01T00:00:00.000Z')`);
  const before = (clean.prepare('SELECT total_changes() AS count').get() as { count: number }).count;
  const report = await auditTenant(new SQLiteD1(clean) as unknown as D1Database);
  const after = (clean.prepare('SELECT total_changes() AS count').get() as { count: number }).count;
  assert.equal(report.status, 'ready', renderAudit(report, true));
  assert.equal(after, before);
  assert.doesNotMatch(renderAudit(report, true), /Private tenant name|northstar-bootstrap-user-v1/u);
  clean.exec('DROP TRIGGER forecast_events_tenant_guard_insert');
  const missingTrigger = await auditTenant(new SQLiteD1(clean) as unknown as D1Database);
  assert.equal(missingTrigger.releaseBlocking, true);
  assert.ok(missingTrigger.blockers.includes('authorization_trigger_missing'));
  clean.exec(`CREATE TRIGGER forecast_events_tenant_guard_insert
    BEFORE INSERT ON forecast_events BEGIN SELECT 1; END`);
  const invalidTrigger = await auditTenant(new SQLiteD1(clean) as unknown as D1Database);
  assert.equal(invalidTrigger.summary.missingAuthorizationTriggerCount, 0);
  assert.ok(invalidTrigger.blockers.includes('authorization_trigger_invalid'));
  await assert.rejects(
    assertAuthorizationIntegrityReady(new SQLiteD1(clean) as unknown as D1Database),
    /AuthorizationIntegrityTriggerInvalid/u,
  );
  clean.exec('DROP TRIGGER forecast_events_tenant_guard_insert');
  clean.exec(authorizationIntegrityStatements().find((statement) =>
    statement.includes('forecast_events_tenant_guard_insert')) ?? '');
  clean.exec('DROP TRIGGER profile_memberships_change_requires_event');
  clean.exec(`INSERT INTO profile_membership_events VALUES
      ('invalid-noop-v2', 'northstar-bootstrap-owner-v1', 'northstar-bootstrap-user-v1', 9,
       2, 'role_changed', 'owner', 'active', 'system_operator', '2026-01-02T00:00:00.000Z');
    UPDATE profile_memberships SET revision = 2, updated_at = '2026-01-02T00:00:00.000Z'
      WHERE id = 'northstar-bootstrap-owner-v1'`);
  clean.exec(authorizationIntegrityStatements().find((statement) =>
    statement.includes('profile_memberships_change_requires_event')) ?? '');
  const invalidHistory = await auditTenant(new SQLiteD1(clean) as unknown as D1Database);
  assert.ok(invalidHistory.summary.membershipIntegrityViolationCount > 0);
  assert.ok(invalidHistory.blockers.includes('membership_history_mismatch'));
  clean.close();

  const corrupt = new DatabaseSync(':memory:');
  for (const migration of migrations.slice(0, 9)) applyMigration(corrupt, migration);
  corrupt.exec(`INSERT INTO investment_profiles VALUES
    (1, 'A', 'USD', 0, '2026-01-01T00:00:00.000Z'),
    (2, 'B', 'USD', 0, '2026-01-01T00:00:00.000Z');
    INSERT INTO forecasts
      (id, profile_id, symbol, direction, confidence, thesis, supporting_evidence,
       counter_evidence, setup_tag, evaluation_date, target_kind, target_price,
       invalidation_price, status, created_at, updated_at)
    VALUES (1, 1, 'SAME', 'bullish', 50, 'a', 'b', 'c', 'd', '2026-12-01',
      'price', 10, 5, 'draft', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO forecast_events
      (forecast_id, profile_id, revision, event_type, note, payload_json, created_at)
    VALUES (1, 2, 1, 'draft_created', '', '{}', '2026-01-01T00:00:00.000Z')`);
  const blocked = await auditTenant(new SQLiteD1(corrupt) as unknown as D1Database);
  assert.equal(blocked.releaseBlocking, true);
  assert.ok(blocked.summary.crossProfileViolationCount > 0);
  assert.ok(blocked.blockers.includes('cross_profile_relationship'));
  corrupt.close();
});

test('tenant audit blocks partial authorization schemas and missing expected legacy tables', async () => {
  const partial = new DatabaseSync(':memory:');
  for (const migration of migrationsThrough(8)) applyMigration(partial, migration);
  partial.exec(authorizationInitializationStatements()[0]);
  const partialReport = await auditTenant(new SQLiteD1(partial) as unknown as D1Database);
  assert.ok(partialReport.blockers.includes('authorization_schema_partial'));
  partial.close();

  const missing = new DatabaseSync(':memory:');
  for (const migration of migrationsThrough(7)) applyMigration(missing, migration);
  const missingReport = await auditTenant(new SQLiteD1(missing) as unknown as D1Database);
  assert.ok(missingReport.blockers.includes('expected_table_missing'));
  missing.close();
});

test('route and ownership inventories cover every current route and generated table', () => {
  assert.equal(ROUTE_AUTHORIZATION_MANIFEST.length, 31);
  assert.equal(new Set(ROUTE_AUTHORIZATION_MANIFEST.map((entry) => `${entry.source}#${entry.method}`)).size, 31);
  const snapshot = JSON.parse(readFileSync(new URL('../../drizzle/meta/0009_snapshot.json', import.meta.url), 'utf8')) as {
    tables: Record<string, unknown>;
  };
  const generated = Object.keys(snapshot.tables).map((name) => name.replace(/^main\./u, '')).sort();
  const classified = TABLE_OWNERSHIP_MANIFEST.map((entry) => entry.table).sort();
  assert.deepEqual(classified, generated);
  const pageBoundary = readFileSync(new URL('../components/ProtectedPage.tsx', import.meta.url), 'utf8');
  assert.match(pageBoundary, /Authentication is not configured/u);
  assert.match(pageBoundary, /local bootstrap owner/u);
  assert.match(pageBoundary, /Do not deploy this mode/u);
  assert.doesNotMatch(pageBoundary, /<form|password|email address/u);
  const viteConfiguration = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(viteConfiguration, /localAnalysisBridge|\/api\/workspace/u,
    'development must not shadow the exact analysis_run route with workspace_read authority');
  const routeAudit = auditRoutes();
  assert.equal(routeAudit.releaseBlocking, false);
  assert.equal(NON_ROUTE_EXECUTION_BOUNDARIES.length, 3);
  assert.equal(routeAudit.summary.nonRouteBoundaryCount, 3);
  assert.equal(routeAudit.summary.nonRouteMissingCount, 0);
  assert.equal(routeAudit.summary.nonRouteDuplicateCount, 0);
  assert.equal(routeAudit.summary.nonRouteEvidenceMismatchCount, 0);
  assert.equal(routeAudit.summary.unexpectedGlobalIdRepositoryReferenceCount, 0);
  assert.equal(routeAudit.summary.routeActionMismatchCount, 0);
});
