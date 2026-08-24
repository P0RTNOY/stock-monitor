import { ensureDatabase, getD1 } from '@/db';
import { fetchYahooQuote, resolveYahooTicker } from '@/app/lib/server/yahoo';
import { TICKER_PATTERN, type TickerSuggestion } from '@/app/lib/tickers';

const PROFILE_ID = 1;
const DIRECTIONS = new Set(['Bullish', 'Bearish', 'Neutral', 'Watching']);
const CONDITIONS = new Set(['Price above', 'Price below', 'Daily move above %', 'Daily move below %']);

type Payload = Record<string, unknown>;

function cleanText(value: unknown, field: string, maxLength = 240) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${field} is required.`);
  return text.slice(0, maxLength);
}

function cleanSymbol(value: unknown) {
  const symbol = cleanText(value, 'Symbol', 10).toUpperCase();
  if (!TICKER_PATTERN.test(symbol)) throw new Error('Enter a valid ticker symbol.');
  return symbol;
}

function cleanNumber(value: unknown, field: string, min: number, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${field} must be between ${min} and ${max}.`);
  }
  return number;
}

function cleanId(value: unknown) {
  return Math.trunc(cleanNumber(value, 'ID', 1));
}

async function cleanTrackedSymbol(d1: D1Database, value: unknown) {
  const symbol = cleanSymbol(value);
  const tracked = await d1.prepare(`SELECT symbol FROM positions WHERE profile_id = ? AND symbol = ?
    UNION SELECT symbol FROM watchlist_items WHERE profile_id = ? AND symbol = ? LIMIT 1`)
    .bind(PROFILE_ID, symbol, PROFILE_ID, symbol).first();
  if (!tracked) throw new Error('Save this symbol as a position or watchlist item first.');
  return symbol;
}

async function resolveCanonicalTicker(d1: D1Database, value: unknown): Promise<TickerSuggestion> {
  const symbol = cleanSymbol(value);
  const [ticker, profile] = await Promise.all([
    resolveYahooTicker(symbol),
    d1.prepare('SELECT base_currency AS baseCurrency FROM investment_profiles WHERE id = ?')
      .bind(PROFILE_ID).first<{ baseCurrency: string }>(),
  ]);
  if (!ticker) throw new Error('Choose a valid stock or ETF from ticker search.');
  if (!profile) throw new Error('Investment profile unavailable.');

  const quote = await fetchYahooQuote(ticker.symbol);
  if (!quote.currency || quote.currency !== profile.baseCurrency.toUpperCase()) {
    throw new Error(`Choose a ticker quoted in ${profile.baseCurrency.toUpperCase()}.`);
  }
  return ticker;
}

async function readWorkspace() {
  const d1 = getD1();
  const [profile, positions, watchlist, journalEntries, alerts] = await Promise.all([
    d1.prepare('SELECT id, name, base_currency AS baseCurrency, cash_balance AS cashBalance FROM investment_profiles WHERE id = ?')
      .bind(PROFILE_ID).first(),
    d1.prepare('SELECT id, symbol, company_name AS companyName, shares, average_cost AS averageCost, created_at AS createdAt FROM positions WHERE profile_id = ? ORDER BY shares * average_cost DESC')
      .bind(PROFILE_ID).all(),
    d1.prepare('SELECT id, symbol, company_name AS companyName, created_at AS createdAt FROM watchlist_items WHERE profile_id = ? ORDER BY symbol')
      .bind(PROFILE_ID).all(),
    d1.prepare('SELECT id, entry_date AS entryDate, symbol, direction, confidence, thesis, target, created_at AS createdAt FROM journal_entries WHERE profile_id = ? ORDER BY entry_date DESC, id DESC LIMIT 100')
      .bind(PROFILE_ID).all(),
    d1.prepare('SELECT id, symbol, condition_type AS conditionType, threshold, note, active, created_at AS createdAt FROM review_alerts WHERE profile_id = ? ORDER BY active DESC, symbol LIMIT 100')
      .bind(PROFILE_ID).all(),
  ]);

  return {
    profile,
    positions: positions.results,
    watchlist: watchlist.results,
    journalEntries: journalEntries.results,
    alerts: alerts.results.map((alert) => ({ ...alert, active: Boolean(alert.active) })),
  };
}

export async function GET() {
  try {
    await ensureDatabase();
    return Response.json(await readWorkspace());
  } catch (error) {
    console.error('workspace GET failed', error);
    return Response.json({ error: 'Your saved workspace could not be loaded.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const payload = await request.json() as Payload;
    const action = cleanText(payload.action, 'Action', 40);
    const d1 = getD1();
    const createdAt = new Date().toISOString();

    if (action === 'addPosition') {
      const { symbol, companyName } = await resolveCanonicalTicker(d1, payload.symbol);
      const shares = cleanNumber(payload.shares, 'Shares', 0.000001, 1_000_000_000);
      const averageCost = cleanNumber(payload.averageCost, 'Average cost', 0, 10_000_000);
      await d1.prepare(`INSERT INTO positions (profile_id, symbol, company_name, shares, average_cost, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, symbol) DO UPDATE SET
          company_name = excluded.company_name,
          average_cost = ((positions.shares * positions.average_cost) + (excluded.shares * excluded.average_cost)) / (positions.shares + excluded.shares),
          shares = positions.shares + excluded.shares`)
        .bind(PROFILE_ID, symbol, companyName, shares, averageCost, createdAt).run();
    } else if (action === 'deletePosition') {
      await d1.prepare('DELETE FROM positions WHERE id = ? AND profile_id = ?')
        .bind(cleanId(payload.id), PROFILE_ID).run();
    } else if (action === 'addWatchlist') {
      const { symbol, companyName } = await resolveCanonicalTicker(d1, payload.symbol);
      await d1.prepare(`INSERT INTO watchlist_items (profile_id, symbol, company_name, created_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(profile_id, symbol) DO UPDATE SET company_name = excluded.company_name`)
        .bind(PROFILE_ID, symbol, companyName, createdAt).run();
    } else if (action === 'deleteWatchlist') {
      await d1.prepare('DELETE FROM watchlist_items WHERE id = ? AND profile_id = ?')
        .bind(cleanId(payload.id), PROFILE_ID).run();
    } else if (action === 'addJournal') {
      const entryDate = cleanText(payload.entryDate, 'Entry date', 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) throw new Error('Enter a valid journal date.');
      const direction = cleanText(payload.direction, 'Direction', 24);
      if (!DIRECTIONS.has(direction)) throw new Error('Choose a supported direction.');
      await d1.prepare(`INSERT INTO journal_entries
        (profile_id, entry_date, symbol, direction, confidence, thesis, target, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          PROFILE_ID,
          entryDate,
          await cleanTrackedSymbol(d1, payload.symbol),
          direction,
          Math.trunc(cleanNumber(payload.confidence, 'Confidence', 0, 100)),
          cleanText(payload.thesis, 'Thesis', 2000),
          typeof payload.target === 'string' ? payload.target.trim().slice(0, 120) : '',
          createdAt,
        ).run();
    } else if (action === 'deleteJournal') {
      await d1.prepare('DELETE FROM journal_entries WHERE id = ? AND profile_id = ?')
        .bind(cleanId(payload.id), PROFILE_ID).run();
    } else if (action === 'addAlert') {
      const conditionType = cleanText(payload.conditionType, 'Condition', 40);
      if (!CONDITIONS.has(conditionType)) throw new Error('Choose a supported alert condition.');
      await d1.prepare(`INSERT INTO review_alerts
        (profile_id, symbol, condition_type, threshold, note, active, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)`)
        .bind(
          PROFILE_ID,
          await cleanTrackedSymbol(d1, payload.symbol),
          conditionType,
          cleanNumber(payload.threshold, 'Threshold', -10_000_000, 10_000_000),
          typeof payload.note === 'string' ? payload.note.trim().slice(0, 240) : '',
          createdAt,
        ).run();
    } else if (action === 'toggleAlert') {
      await d1.prepare('UPDATE review_alerts SET active = ? WHERE id = ? AND profile_id = ?')
        .bind(payload.active ? 1 : 0, cleanId(payload.id), PROFILE_ID).run();
    } else if (action === 'deleteAlert') {
      await d1.prepare('DELETE FROM review_alerts WHERE id = ? AND profile_id = ?')
        .bind(cleanId(payload.id), PROFILE_ID).run();
    } else if (action === 'updateProfile') {
      const name = cleanText(payload.name, 'Portfolio name', 80);
      const cashBalance = cleanNumber(payload.cashBalance, 'Cash balance', 0, 1_000_000_000_000);
      await d1.prepare('UPDATE investment_profiles SET name = ?, cash_balance = ? WHERE id = ?')
        .bind(name, cashBalance, PROFILE_ID).run();
    } else {
      return Response.json({ error: 'Unsupported workspace action.' }, { status: 400 });
    }

    return Response.json(await readWorkspace());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The workspace could not be updated.';
    console.error('workspace POST failed', error);
    return Response.json({ error: message }, { status: 400 });
  }
}
