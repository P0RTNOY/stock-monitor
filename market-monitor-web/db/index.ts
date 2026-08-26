import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';
import { forecastEventUpgradeStatements, forecastInitializationStatements } from './forecast-initialization.ts';
import { inAppNotificationInitializationStatements } from './in-app-notification-initialization.ts';
import {
  authorizationInitializationStatements,
  authorizationIntegrityStatements,
  assertAuthorizationInitializationReady,
  ensureAuthorizationBootstrap,
} from './authorization-initialization.ts';
import { authConfigurationFromEnv, type AuthEnvironmentBindings } from '@/app/lib/server/auth/config.ts';

let readyPromise: Promise<void> | undefined;

const LEGACY_DEMO_CLEANUP_KEY = 'legacy-demo-cleanup-v1';

export function getD1(): D1Database {
  if (!env.DB) {
    throw new Error('The portfolio database is unavailable.');
  }
  return env.DB;
}

export function getDb() {
  return drizzle(getD1(), { schema });
}

async function initializeDatabase() {
  const d1 = getD1();
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS investment_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_currency TEXT NOT NULL DEFAULT 'USD',
      cash_balance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      company_name TEXT NOT NULL,
      shares REAL NOT NULL CHECK (shares > 0),
      average_cost REAL NOT NULL CHECK (average_cost >= 0),
      created_at TEXT NOT NULL,
      FOREIGN KEY (profile_id) REFERENCES investment_profiles(id) ON DELETE CASCADE
    )`),
    d1.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_profile_symbol ON positions(profile_id, symbol)'),
    d1.prepare(`CREATE TABLE IF NOT EXISTS watchlist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      company_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (profile_id) REFERENCES investment_profiles(id) ON DELETE CASCADE
    )`),
    d1.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_profile_symbol ON watchlist_items(profile_id, symbol)'),
    d1.prepare(`CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      entry_date TEXT NOT NULL,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
      thesis TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (profile_id) REFERENCES investment_profiles(id) ON DELETE CASCADE
    )`),
    d1.prepare('CREATE INDEX IF NOT EXISTS idx_journal_profile_date ON journal_entries(profile_id, entry_date DESC)'),
    d1.prepare(`CREATE TABLE IF NOT EXISTS review_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      condition_type TEXT NOT NULL,
      threshold REAL NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (profile_id) REFERENCES investment_profiles(id) ON DELETE CASCADE
    )`),
    d1.prepare('CREATE INDEX IF NOT EXISTS idx_alerts_profile_active ON review_alerts(profile_id, active)'),
    ...forecastInitializationStatements().map((statement) => d1.prepare(statement)),
    ...inAppNotificationInitializationStatements().map((statement) => d1.prepare(statement)),
  ]);

  await assertAuthorizationInitializationReady(d1);
  await d1.batch([
    ...authorizationInitializationStatements().map((statement) => d1.prepare(statement)),
    ...authorizationIntegrityStatements().map((statement) => d1.prepare(statement)),
  ]);

  const eventTable = await d1.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'forecast_events'")
    .first<{ sql: string }>();
  if (eventTable && !eventTable.sql.includes('evaluation_review_acknowledged')) {
    await d1.batch(forecastEventUpgradeStatements().map((statement) => d1.prepare(statement)));
  }

  const cleanupMarker = await d1.prepare('SELECT value FROM app_metadata WHERE key = ?')
    .bind(LEGACY_DEMO_CLEANUP_KEY).first();
  if (!cleanupMarker) {
    const legacyProfile = await d1.prepare(`SELECT id, created_at AS createdAt
      FROM investment_profiles
      WHERE id = 1 AND name = 'My portfolio' AND base_currency = 'USD' AND cash_balance = 16620.4`)
      .first<{ id: number; createdAt: string }>();
    const legacyFingerprint = legacyProfile
      ? await d1.prepare(`SELECT
          (SELECT COUNT(*) FROM positions WHERE profile_id = 1 AND created_at = ? AND (
            (symbol = 'NVDA' AND company_name = 'NVIDIA' AND shares = 180 AND average_cost = 146.2) OR
            (symbol = 'MSFT' AND company_name = 'Microsoft' AND shares = 48 AND average_cost = 456.25) OR
            (symbol = 'AAPL' AND company_name = 'Apple' AND shares = 79 AND average_cost = 205.4)
          )) AS positionCount,
          (SELECT COUNT(*) FROM watchlist_items WHERE profile_id = 1 AND created_at = ? AND (
            (symbol = 'AMZN' AND company_name = 'Amazon') OR
            (symbol = 'GOOGL' AND company_name = 'Alphabet') OR
            (symbol = 'META' AND company_name = 'Meta Platforms') OR
            (symbol = 'TSLA' AND company_name = 'Tesla')
          )) AS watchlistCount`)
        .bind(legacyProfile.createdAt, legacyProfile.createdAt)
        .first<{ positionCount: number; watchlistCount: number }>()
      : null;
    const legacyDemoDetected = legacyFingerprint?.positionCount === 3
      && legacyFingerprint.watchlistCount === 4;
    const cleanedAt = new Date().toISOString();
    const cleanupStatements: D1PreparedStatement[] = [];

    if (legacyProfile && legacyDemoDetected) {
      const seededAt = legacyProfile.createdAt;
      cleanupStatements.push(
        d1.prepare(`DELETE FROM positions
          WHERE profile_id = 1 AND symbol = 'NVDA' AND company_name = 'NVIDIA'
          AND shares = 180 AND average_cost = 146.2 AND created_at = ?`).bind(seededAt),
        d1.prepare(`DELETE FROM positions
          WHERE profile_id = 1 AND symbol = 'MSFT' AND company_name = 'Microsoft'
          AND shares = 48 AND average_cost = 456.25 AND created_at = ?`).bind(seededAt),
        d1.prepare(`DELETE FROM positions
          WHERE profile_id = 1 AND symbol = 'AAPL' AND company_name = 'Apple'
          AND shares = 79 AND average_cost = 205.4 AND created_at = ?`).bind(seededAt),
        d1.prepare(`DELETE FROM watchlist_items
          WHERE profile_id = 1 AND symbol = 'AMZN' AND company_name = 'Amazon' AND created_at = ?`).bind(seededAt),
        d1.prepare(`DELETE FROM watchlist_items
          WHERE profile_id = 1 AND symbol = 'GOOGL' AND company_name = 'Alphabet' AND created_at = ?`).bind(seededAt),
        d1.prepare(`DELETE FROM watchlist_items
          WHERE profile_id = 1 AND symbol = 'META' AND company_name = 'Meta Platforms' AND created_at = ?`).bind(seededAt),
        d1.prepare(`DELETE FROM watchlist_items
          WHERE profile_id = 1 AND symbol = 'TSLA' AND company_name = 'Tesla' AND created_at = ?`).bind(seededAt),
        d1.prepare('UPDATE investment_profiles SET cash_balance = 0 WHERE id = 1 AND cash_balance = 16620.4'),
      );
    }

    cleanupStatements.push(
      d1.prepare('INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)')
        .bind(LEGACY_DEMO_CLEANUP_KEY, legacyDemoDetected ? 'removed' : 'not-present', cleanedAt),
    );
    await d1.batch(cleanupStatements);
  }

  const authorization = authConfigurationFromEnv(env as unknown as AuthEnvironmentBindings);
  if (authorization.mode === 'local_bootstrap') await ensureAuthorizationBootstrap(d1);

  await d1.prepare('PRAGMA optimize').run();
}

export async function ensureDatabase() {
  if (!readyPromise) {
    readyPromise = initializeDatabase().catch((error) => {
      readyPromise = undefined;
      throw error;
    });
  }
  await readyPromise;
}
