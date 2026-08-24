import { ensureDatabase, getD1 } from '@/db';
import { fetchYahooQuote } from '@/app/lib/server/yahoo';
import { TICKER_PATTERN } from '@/app/lib/tickers';
import { resolveCurrentProfile } from '@/app/lib/server/profile';

export async function GET(request: Request) {
  const allRequestedSymbols = [...new Set(new URL(request.url).searchParams.get('symbols')
    ?.split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => TICKER_PATTERN.test(symbol))
    ?? [])];
  const requestedSymbols = allRequestedSymbols.slice(0, 24);

  if (!requestedSymbols.length) return Response.json(
    { quotes: {}, fetchedAt: new Date().toISOString(), unavailable: [] },
    { headers: { 'Cache-Control': 'no-store' } },
  );

  try {
    await ensureDatabase();
    const { profileId } = await resolveCurrentProfile(request);
    const profile = await getD1().prepare('SELECT base_currency AS baseCurrency FROM investment_profiles WHERE id = ?')
      .bind(profileId)
      .first<{ baseCurrency: string }>();
    if (!profile) throw new Error('Investment profile unavailable');
    const trackedRows = await getD1().prepare(`SELECT symbol FROM positions WHERE profile_id = ?
      UNION SELECT symbol FROM watchlist_items WHERE profile_id = ?
      UNION SELECT symbol FROM review_alerts WHERE profile_id = ?`)
      .bind(profileId, profileId, profileId).all<{ symbol: string }>();
    const tracked = new Set(trackedRows.results.map((row) => row.symbol));
    const symbols = requestedSymbols.filter((symbol) => tracked.has(symbol));
    const results = await Promise.allSettled(symbols.map((symbol) => fetchYahooQuote(symbol)));
    const quotes: Record<string, Awaited<ReturnType<typeof fetchYahooQuote>>> = {};
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.currency === profile.baseCurrency.toUpperCase()) {
        quotes[result.value.symbol] = result.value;
      }
    }

    return Response.json(
      { quotes, fetchedAt: new Date().toISOString(), unavailable: allRequestedSymbols.filter((symbol) => !quotes[symbol]) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('market GET failed', error);
    return Response.json({ error: 'Real market data could not be loaded.' }, { status: 503 });
  }
}
