import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createDirectSqlHumanRouteHandlers } from './server/direct-sql-human-routes.ts';
import { authorizeProfileScope } from './server/auth/enforcement.ts';
import type { AuthorizationAction, HumanPrincipal, ResourceScope } from './server/auth/types.ts';

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
    return { success: true, results: this.database.prepare(this.sql).all(...this.bindings) as T[], meta: {} };
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
}

function human(
  userId: string,
  membershipId: string,
  profileId: number,
  role: HumanPrincipal['role'] = 'owner',
): HumanPrincipal {
  return {
    kind: 'human',
    userId,
    userStatus: 'active',
    membershipId,
    membershipStatus: 'active',
    profileId,
    role,
    assurance: { mechanism: 'local_bootstrap', externalIdentityLinked: false },
  };
}

function assertNoStore(response: Response) {
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
}

function jsonRequest(url: string, principal: 'a' | 'b', payload: Record<string, unknown>) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Test-Principal': principal },
    body: JSON.stringify(payload),
  });
}

test('direct-SQL human routes isolate two profiles with overlapping symbols and foreign IDs', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE investment_profiles (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, base_currency TEXT NOT NULL,
      cash_balance REAL NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE positions (
      id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL, symbol TEXT NOT NULL,
      company_name TEXT NOT NULL, shares REAL NOT NULL, average_cost REAL NOT NULL, created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_positions_profile_symbol ON positions(profile_id, symbol);
    CREATE TABLE watchlist_items (
      id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL, symbol TEXT NOT NULL,
      company_name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_watchlist_profile_symbol ON watchlist_items(profile_id, symbol);
    CREATE TABLE journal_entries (
      id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL, entry_date TEXT NOT NULL, symbol TEXT NOT NULL,
      direction TEXT NOT NULL, confidence INTEGER NOT NULL, thesis TEXT NOT NULL,
      target TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE review_alerts (
      id INTEGER PRIMARY KEY, profile_id INTEGER NOT NULL, symbol TEXT NOT NULL,
      condition_type TEXT NOT NULL, threshold REAL NOT NULL, note TEXT NOT NULL,
      active INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO investment_profiles VALUES
      (1, 'Portfolio A', 'USD', 1000, '2026-08-26T00:00:00.000Z'),
      (2, 'Portfolio B', 'USD', 2000, '2026-08-26T00:00:00.000Z');
    INSERT INTO positions VALUES
      (101, 1, 'SAME', 'Same A', 1, 10, '2026-08-26T00:00:00.000Z'),
      (201, 2, 'SAME', 'Same B', 2, 20, '2026-08-26T00:00:00.000Z');
    INSERT INTO watchlist_items VALUES
      (102, 1, 'AONLY', 'Only A', '2026-08-26T00:00:00.000Z'),
      (202, 2, 'BONLY', 'Only B', '2026-08-26T00:00:00.000Z');
    INSERT INTO journal_entries VALUES
      (103, 1, '2026-08-26', 'SAME', 'Watching', 60, 'A thesis', '', '2026-08-26T00:00:00.000Z'),
      (203, 2, '2026-08-26', 'SAME', 'Watching', 70, 'B thesis', '', '2026-08-26T00:00:00.000Z');
    INSERT INTO review_alerts VALUES
      (104, 1, 'SAME', 'Price above', 12, 'A alert', 1, '2026-08-26T00:00:00.000Z'),
      (204, 2, 'BONLY', 'Price above', 22, 'B alert', 1, '2026-08-26T00:00:00.000Z');
  `);

  const principals = {
    a: human('user-a', 'membership-a', 1),
    b: human('user-b', 'membership-b', 2),
    viewer: human('viewer-a', 'viewer-membership-a', 1, 'viewer'),
  };
  const d1 = new SQLiteD1(database) as unknown as D1Database;
  const quoteRequests: string[] = [];
  let analysisRequests = 0;
  const handlers = createDirectSqlHumanRouteHandlers({
    async authorizeHumanRequest<A extends AuthorizationAction>(
      request: Request,
      action: A,
      resource: Omit<ResourceScope, 'profileId'> = {},
    ) {
      const key = request.headers.get('X-Test-Principal');
      const principal = key === 'a' || key === 'b' || key === 'viewer' ? principals[key] : principals.a;
      return authorizeProfileScope(principal, action, { ...resource, profileId: principal.profileId });
    },
    async ensureDatabase() {},
    getD1: () => d1,
    async fetchYahooQuote(symbol) {
      quoteRequests.push(symbol);
      return {
        symbol, provider: 'test', currency: 'USD', price: 10, previousClose: 9,
        change: 1, changePct: 11.1, history: [9, 10], updatedAt: '2026-08-26T00:00:00.000Z',
      };
    },
    async resolveYahooTicker(symbol) {
      return { symbol, companyName: symbol, exchange: 'Test', quoteType: 'Equity' };
    },
    async fetch() {
      analysisRequests += 1;
      return Response.json({ error: 'not needed for the cross-tenant denial test' }, { status: 503 });
    },
    now: () => new Date('2026-08-26T12:00:00.000Z'),
    analysisApiUrl: () => 'https://analysis.example.test/v1/analyze',
  });

  const workspaceResponse = await handlers.workspaceGet(new Request(
    'https://northstar.example/api/workspace', { headers: { 'X-Test-Principal': 'a' } },
  ));
  assert.equal(workspaceResponse.status, 200);
  assertNoStore(workspaceResponse);
  const workspace = await workspaceResponse.json() as {
    profile: { id: number };
    positions: Array<{ id: number; companyName: string }>;
    watchlist: Array<{ id: number }>;
    journalEntries: Array<{ id: number; thesis: string }>;
    alerts: Array<{ id: number }>;
  };
  assert.equal(workspace.profile.id, 1);
  assert.deepEqual(workspace.positions, [{
    id: 101, symbol: 'SAME', companyName: 'Same A', shares: 1, averageCost: 10,
    createdAt: '2026-08-26T00:00:00.000Z',
  }]);
  assert.deepEqual(workspace.watchlist.map(({ id }) => id), [102]);
  assert.deepEqual(workspace.journalEntries.map(({ id, thesis }) => ({ id, thesis })), [{ id: 103, thesis: 'A thesis' }]);
  assert.deepEqual(workspace.alerts.map(({ id }) => id), [104]);

  for (const payload of [
    { action: 'deletePosition', id: 201 },
    { action: 'deleteWatchlist', id: 202 },
    { action: 'deleteJournal', id: 203 },
    { action: 'toggleAlert', id: 204, active: false },
    { action: 'deleteAlert', id: 204 },
  ]) {
    const response = await handlers.workspacePost(jsonRequest(
      'https://northstar.example/api/workspace', 'a', payload,
    ));
    assert.equal(response.status, 200, payload.action);
    assertNoStore(response);
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM positions WHERE id = 201 AND profile_id = 2').get()?.count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM watchlist_items WHERE id = 202 AND profile_id = 2').get()?.count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM journal_entries WHERE id = 203 AND profile_id = 2').get()?.count, 1);
  assert.deepEqual({ ...database.prepare('SELECT active FROM review_alerts WHERE id = 204 AND profile_id = 2').get() }, { active: 1 });

  const marketResponse = await handlers.marketGet(new Request(
    'https://northstar.example/api/market?symbols=SAME,BONLY',
    { headers: { 'X-Test-Principal': 'a' } },
  ));
  assert.equal(marketResponse.status, 200);
  assertNoStore(marketResponse);
  const market = await marketResponse.json() as { quotes: Record<string, unknown>; unavailable: string[] };
  assert.deepEqual(Object.keys(market.quotes), ['SAME']);
  assert.deepEqual(market.unavailable, ['BONLY']);
  assert.deepEqual(quoteRequests, ['SAME']);

  const analysisResponse = await handlers.analysisPost(jsonRequest(
    'https://northstar.example/api/analysis', 'a', { symbol: 'BONLY' },
  ));
  assert.equal(analysisResponse.status, 400);
  assertNoStore(analysisResponse);
  assert.deepEqual(await analysisResponse.json(), {
    error: 'Save this symbol as a position or watchlist item first.',
  });
  assert.equal(analysisRequests, 0, 'foreign symbol must be rejected before the analysis provider');

  const viewerWorkspace = await handlers.workspaceGet(new Request(
    'https://northstar.example/api/workspace', { headers: { 'X-Test-Principal': 'viewer' } },
  ));
  assert.equal(viewerWorkspace.status, 200, 'viewer retains read-only workspace access');
  assertNoStore(viewerWorkspace);
  const viewerAnalysis = await handlers.analysisPost(new Request('https://northstar.example/api/analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Test-Principal': 'viewer' },
    body: JSON.stringify({ symbol: 'SAME' }),
  }));
  assert.equal(viewerAnalysis.status, 403, 'workspace read authority must not imply analysis authority');
  assertNoStore(viewerAnalysis);
  assert.equal(analysisRequests, 0, 'a denied viewer must not reach the analysis provider');

  database.close();
});
