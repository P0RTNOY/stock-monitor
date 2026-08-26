export const BOOTSTRAP_USER_ID = 'northstar-bootstrap-user-v1';
export const BOOTSTRAP_MEMBERSHIP_ID = 'northstar-bootstrap-owner-v1';
export const BOOTSTRAP_MEMBERSHIP_EVENT_ID = 'northstar-bootstrap-owner-created-v1';

export function authorizationInitializationStatements() {
  return [
    `CREATE TABLE IF NOT EXISTS identity_users (
      id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      external_identity_state TEXT NOT NULL DEFAULT 'bootstrap_pending' CHECK (external_identity_state IN ('bootstrap_pending', 'unlinked', 'linked')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disabled_at TEXT,
      CHECK ((status = 'active' AND disabled_at IS NULL) OR (status = 'disabled' AND disabled_at IS NOT NULL))
    )`,
    `CREATE TABLE IF NOT EXISTS profile_memberships (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      profile_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY (user_id) REFERENCES identity_users(id),
      FOREIGN KEY (profile_id) REFERENCES investment_profiles(id) ON DELETE CASCADE,
      CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL))
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_memberships_user_profile ON profile_memberships(user_id, profile_id)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_memberships_id_user_profile ON profile_memberships(id, user_id, profile_id)',
    'CREATE INDEX IF NOT EXISTS idx_profile_memberships_profile_status ON profile_memberships(profile_id, status, role)',
    `CREATE TABLE IF NOT EXISTS profile_membership_events (
      id TEXT PRIMARY KEY NOT NULL,
      membership_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      profile_id INTEGER NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      event_type TEXT NOT NULL CHECK (event_type IN ('created', 'role_changed', 'revoked', 'restored')),
      role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('bootstrap_migration', 'system_operator', 'future_identity_provider')),
      created_at TEXT NOT NULL,
      FOREIGN KEY (membership_id, user_id, profile_id)
        REFERENCES profile_memberships(id, user_id, profile_id) ON DELETE CASCADE
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_membership_events_membership_revision ON profile_membership_events(membership_id, revision)',
    'CREATE INDEX IF NOT EXISTS idx_profile_membership_events_profile_created ON profile_membership_events(profile_id, created_at, id)',
  ];
}

export function authorizationIntegrityStatements() {
  return [
    `CREATE TRIGGER IF NOT EXISTS profile_membership_events_append_only_update
      BEFORE UPDATE ON profile_membership_events
      BEGIN SELECT RAISE(ABORT, 'MembershipEventAppendOnly'); END`,
    `CREATE TRIGGER IF NOT EXISTS profile_membership_events_append_only_delete
      BEFORE DELETE ON profile_membership_events
      BEGIN SELECT RAISE(ABORT, 'MembershipEventAppendOnly'); END`,
    `CREATE TRIGGER IF NOT EXISTS profile_memberships_identity_immutable
      BEFORE UPDATE OF id, user_id, profile_id, created_at ON profile_memberships
      BEGIN SELECT RAISE(ABORT, 'MembershipIdentityImmutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS profile_memberships_change_requires_event
      BEFORE UPDATE OF role, status, revision, revoked_at ON profile_memberships
      WHEN NEW.revision <> OLD.revision + 1
        OR (NEW.status = OLD.status AND NEW.role = OLD.role)
        OR (NEW.status <> OLD.status AND NEW.role <> OLD.role)
        OR NOT EXISTS (
          SELECT 1 FROM profile_membership_events e
          WHERE e.membership_id = OLD.id AND e.user_id = OLD.user_id
            AND e.profile_id = OLD.profile_id AND e.revision = NEW.revision
            AND e.role = NEW.role AND e.status = NEW.status
            AND e.event_type = CASE
              WHEN OLD.status = 'active' AND NEW.status = 'revoked' THEN 'revoked'
              WHEN OLD.status = 'revoked' AND NEW.status = 'active' THEN 'restored'
              ELSE 'role_changed'
            END)
      BEGIN SELECT RAISE(ABORT, 'MembershipEventRequired'); END`,
    `CREATE TRIGGER IF NOT EXISTS profile_memberships_delete_requires_history_preservation
      BEFORE DELETE ON profile_memberships
      BEGIN SELECT RAISE(ABORT, 'MembershipDeleteForbidden'); END`,
    `CREATE TRIGGER IF NOT EXISTS forecasts_profile_immutable
      BEFORE UPDATE OF profile_id ON forecasts
      BEGIN SELECT RAISE(ABORT, 'ForecastProfileImmutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS forecast_events_tenant_guard_insert
      BEFORE INSERT ON forecast_events
      WHEN NOT EXISTS (SELECT 1 FROM forecasts p WHERE p.id = NEW.forecast_id AND p.profile_id = NEW.profile_id)
      BEGIN SELECT RAISE(ABORT, 'CrossProfileForecastEvent'); END`,
    `CREATE TRIGGER IF NOT EXISTS forecast_events_tenant_guard_update
      BEFORE UPDATE OF forecast_id, profile_id ON forecast_events
      WHEN NOT EXISTS (SELECT 1 FROM forecasts p WHERE p.id = NEW.forecast_id AND p.profile_id = NEW.profile_id)
      BEGIN SELECT RAISE(ABORT, 'CrossProfileForecastEvent'); END`,
    `CREATE TRIGGER IF NOT EXISTS evaluation_runs_tenant_guard_insert
      BEFORE INSERT ON evaluation_runs
      WHEN NOT EXISTS (SELECT 1 FROM forecasts p WHERE p.id = NEW.forecast_id AND p.profile_id = NEW.profile_id)
      BEGIN SELECT RAISE(ABORT, 'CrossProfileEvaluationRun'); END`,
    `CREATE TRIGGER IF NOT EXISTS evaluation_runs_tenant_guard_update
      BEFORE UPDATE OF forecast_id, profile_id ON evaluation_runs
      WHEN NOT EXISTS (SELECT 1 FROM forecasts p WHERE p.id = NEW.forecast_id AND p.profile_id = NEW.profile_id)
      BEGIN SELECT RAISE(ABORT, 'CrossProfileEvaluationRun'); END`,
    `CREATE TRIGGER IF NOT EXISTS analysis_snapshots_tenant_guard_insert
      BEFORE INSERT ON analysis_snapshots
      WHEN NOT EXISTS (SELECT 1 FROM forecasts p WHERE p.id = NEW.forecast_id AND p.profile_id = NEW.profile_id)
      BEGIN SELECT RAISE(ABORT, 'CrossProfileAnalysisSnapshot'); END`,
    `CREATE TRIGGER IF NOT EXISTS analysis_snapshots_tenant_guard_update
      BEFORE UPDATE OF forecast_id, profile_id ON analysis_snapshots
      WHEN NOT EXISTS (SELECT 1 FROM forecasts p WHERE p.id = NEW.forecast_id AND p.profile_id = NEW.profile_id)
      BEGIN SELECT RAISE(ABORT, 'CrossProfileAnalysisSnapshot'); END`,
    `CREATE TRIGGER IF NOT EXISTS forecast_review_items_tenant_guard_insert
      BEFORE INSERT ON forecast_review_items
      WHEN NOT EXISTS (
        SELECT 1 FROM forecasts p JOIN evaluation_runs r
          ON r.id = NEW.evaluation_run_id AND r.profile_id = NEW.profile_id AND r.forecast_id = NEW.forecast_id
        WHERE p.id = NEW.forecast_id AND p.profile_id = NEW.profile_id)
      BEGIN SELECT RAISE(ABORT, 'CrossProfileForecastReview'); END`,
    `CREATE TRIGGER IF NOT EXISTS forecast_review_items_tenant_guard_update
      BEFORE UPDATE OF forecast_id, evaluation_run_id, profile_id ON forecast_review_items
      WHEN NOT EXISTS (
        SELECT 1 FROM forecasts p JOIN evaluation_runs r
          ON r.id = NEW.evaluation_run_id AND r.profile_id = NEW.profile_id AND r.forecast_id = NEW.forecast_id
        WHERE p.id = NEW.forecast_id AND p.profile_id = NEW.profile_id)
      BEGIN SELECT RAISE(ABORT, 'CrossProfileForecastReview'); END`,
  ];
}

export function normalizedAuthorizationTriggerSql(value: string) {
  return value.toLowerCase()
    .replace(/\bif\s+not\s+exists\b/gu, '')
    .replace(/[`";]/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/\s*([(),])\s*/gu, '$1')
    .trim();
}

export function authorizationIntegrityTriggerManifest() {
  return authorizationIntegrityStatements().map((sql) => {
    const name = sql.match(/TRIGGER IF NOT EXISTS ([a-z0-9_]+)/u)?.[1];
    if (!name) throw new Error('AuthorizationTriggerManifestInvalid');
    return { name, sql } as const;
  });
}

export async function assertAuthorizationIntegrityReady(d1: D1Database) {
  const manifest = authorizationIntegrityTriggerManifest();
  const triggers = await d1.prepare(`SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND name IN (${manifest.map(() => '?').join(', ')})`)
    .bind(...manifest.map(({ name }) => name)).all<{ name: string; sql: string }>();
  const expected = new Map(manifest.map(({ name, sql }) => [name, normalizedAuthorizationTriggerSql(sql)]));
  if (triggers.results.length !== manifest.length || triggers.results.some(({ name, sql }) =>
    normalizedAuthorizationTriggerSql(sql) !== expected.get(name))) {
    throw new Error('AuthorizationIntegrityTriggerInvalid');
  }
}

export async function assertAuthorizationInitializationReady(d1: D1Database) {
  const schema = await d1.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name IN ('identity_users', 'profile_memberships', 'profile_membership_events')`)
    .first<{ count: number }>();
  const authorizationTableCount = Number(schema?.count ?? 0);
  if (authorizationTableCount !== 0 && authorizationTableCount !== 3) {
    throw new Error('AuthorizationSchemaPartial');
  }
  if (authorizationTableCount === 3) return;

  const triggerManifest = authorizationIntegrityTriggerManifest();
  const triggerCollision = await d1.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'trigger' AND name IN (${triggerManifest.map(() => '?').join(', ')})`)
    .bind(...triggerManifest.map(({ name }) => name)).first<{ count: number }>();
  if (Number(triggerCollision?.count ?? 0) > 0) throw new Error('AuthorizationTriggerConflict');

  const readiness = await d1.prepare(`SELECT
      (SELECT COUNT(*) FROM investment_profiles) AS profileCount,
      (SELECT COUNT(*) FROM pragma_foreign_key_check) AS foreignKeyViolationCount,
      (SELECT COUNT(*) FROM forecast_events c LEFT JOIN forecasts p ON p.id = c.forecast_id
        WHERE p.id IS NULL OR p.profile_id <> c.profile_id)
      + (SELECT COUNT(*) FROM evaluation_runs c LEFT JOIN forecasts p ON p.id = c.forecast_id
        WHERE p.id IS NULL OR p.profile_id <> c.profile_id)
      + (SELECT COUNT(*) FROM analysis_snapshots c LEFT JOIN forecasts p ON p.id = c.forecast_id
        WHERE p.id IS NULL OR p.profile_id <> c.profile_id)
      + (SELECT COUNT(*) FROM forecast_review_items c
        LEFT JOIN forecasts p ON p.id = c.forecast_id
        LEFT JOIN evaluation_runs r ON r.id = c.evaluation_run_id
        WHERE p.id IS NULL OR p.profile_id <> c.profile_id OR r.id IS NULL
          OR r.profile_id <> c.profile_id OR r.forecast_id <> c.forecast_id)
        AS crossProfileViolationCount`)
    .first<{ profileCount: number; foreignKeyViolationCount: number; crossProfileViolationCount: number }>();
  if (!readiness || readiness.profileCount > 1 || readiness.foreignKeyViolationCount > 0
    || readiness.crossProfileViolationCount > 0) {
    throw new Error('AuthorizationInitializationIntegrityBlocked');
  }
}

export async function ensureAuthorizationBootstrap(d1: D1Database) {
  const existingBootstrap = await d1.prepare(`SELECT
      u.id AS userId,
      m.id AS membershipId,
      m.profile_id AS profileId,
      e.id AS eventId,
      e.event_type AS eventType,
      e.role AS eventRole,
      e.status AS eventStatus,
      e.actor_kind AS eventActorKind
    FROM identity_users u
    JOIN profile_memberships m ON m.user_id = u.id
    JOIN profile_membership_events e
      ON e.membership_id = m.id AND e.user_id = m.user_id AND e.profile_id = m.profile_id AND e.revision = 1
    WHERE u.id = ? AND m.id = ? AND e.id = ?`)
    .bind(BOOTSTRAP_USER_ID, BOOTSTRAP_MEMBERSHIP_ID, BOOTSTRAP_MEMBERSHIP_EVENT_ID)
    .first<{
      userId: string;
      membershipId: string;
      profileId: number;
      eventId: string;
      eventType: string;
      eventRole: string;
      eventStatus: string;
      eventActorKind: string;
    }>();
  if (existingBootstrap) {
    if (existingBootstrap.eventType !== 'created'
      || existingBootstrap.eventRole !== 'owner'
      || existingBootstrap.eventStatus !== 'active'
      || existingBootstrap.eventActorKind !== 'bootstrap_migration') {
      throw new Error('AuthorizationBootstrapIntegrityInvalid');
    }
    return;
  }

  const partial = await d1.prepare(`SELECT
      (SELECT COUNT(*) FROM identity_users WHERE id = ?) AS userCount,
      (SELECT COUNT(*) FROM profile_memberships WHERE id = ?) AS membershipCount,
      (SELECT COUNT(*) FROM profile_membership_events WHERE id = ?) AS eventCount`)
    .bind(BOOTSTRAP_USER_ID, BOOTSTRAP_MEMBERSHIP_ID, BOOTSTRAP_MEMBERSHIP_EVENT_ID)
    .first<{ userCount: number; membershipCount: number; eventCount: number }>();
  if (!partial || partial.userCount + partial.membershipCount + partial.eventCount !== 0) {
    throw new Error('AuthorizationBootstrapIntegrityInvalid');
  }

  const profileCount = await d1.prepare('SELECT COUNT(*) AS count FROM investment_profiles')
    .first<{ count: number }>();
  if (!profileCount || profileCount.count > 1) throw new Error('AuthorizationBootstrapProfileCountInvalid');

  const now = new Date().toISOString();
  if (profileCount.count === 0) {
    await d1.prepare(`INSERT INTO investment_profiles
      (id, name, base_currency, cash_balance, created_at) VALUES (1, 'My portfolio', 'USD', 0, ?)`)
      .bind(now).run();
  }
  const profile = await d1.prepare('SELECT id FROM investment_profiles').first<{ id: number }>();
  if (!profile) throw new Error('AuthorizationBootstrapProfileUnavailable');

  await d1.batch([
    d1.prepare(`INSERT OR IGNORE INTO identity_users
      (id, status, external_identity_state, created_at, updated_at, disabled_at)
      VALUES (?, 'active', 'bootstrap_pending', ?, ?, NULL)`)
      .bind(BOOTSTRAP_USER_ID, now, now),
    d1.prepare(`INSERT OR IGNORE INTO profile_memberships
      (id, user_id, profile_id, role, status, revision, created_at, updated_at, revoked_at)
      VALUES (?, ?, ?, 'owner', 'active', 1, ?, ?, NULL)`)
      .bind(BOOTSTRAP_MEMBERSHIP_ID, BOOTSTRAP_USER_ID, profile.id, now, now),
    d1.prepare(`INSERT OR IGNORE INTO profile_membership_events
      (id, membership_id, user_id, profile_id, revision, event_type, role, status, actor_kind, created_at)
      VALUES (?, ?, ?, ?, 1, 'created', 'owner', 'active', 'bootstrap_migration', ?)`)
      .bind(
        BOOTSTRAP_MEMBERSHIP_EVENT_ID,
        BOOTSTRAP_MEMBERSHIP_ID,
        BOOTSTRAP_USER_ID,
        profile.id,
        now,
      ),
  ]);

  const bootstrap = await d1.prepare(`SELECT
      m.profile_id AS profileId,
      e.event_type AS eventType
    FROM identity_users u
    JOIN profile_memberships m ON m.user_id = u.id
    JOIN profile_membership_events e
      ON e.membership_id = m.id AND e.user_id = m.user_id AND e.profile_id = m.profile_id AND e.revision = 1
    WHERE u.id = ? AND m.id = ? AND e.id = ?`)
    .bind(BOOTSTRAP_USER_ID, BOOTSTRAP_MEMBERSHIP_ID, BOOTSTRAP_MEMBERSHIP_EVENT_ID)
    .first<{
      profileId: number;
      eventType: string;
    }>();
  if (!bootstrap
    || bootstrap.profileId !== profile.id
    || bootstrap.eventType !== 'created') {
    throw new Error('AuthorizationBootstrapIntegrityInvalid');
  }
}
