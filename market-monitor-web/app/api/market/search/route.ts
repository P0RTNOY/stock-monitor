import { normalizeTickerQuery } from '@/app/lib/tickers';
import { searchYahooTickers } from '@/app/lib/server/yahoo';

export async function GET(request: Request) {
  const query = normalizeTickerQuery(new URL(request.url).searchParams.get('q'));
  if (query.length < 2) {
    return Response.json({ query, results: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const results = await searchYahooTickers(query);
    return Response.json(
      { query, results },
      { headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=240' } },
    );
  } catch (error) {
    console.error('ticker search failed', error instanceof Error ? `${error.name}: ${error.message}` : 'UnknownError');
    return Response.json({ error: 'Ticker search is temporarily unavailable.' }, { status: 503 });
  }
}
