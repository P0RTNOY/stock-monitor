import { normalizeTickerQuery } from '@/app/lib/tickers';
import { searchYahooTickers } from '@/app/lib/server/yahoo';
import { authorizeHumanRequest } from '@/app/lib/server/auth/runtime-resolver';
import { authorizationErrorResponse } from '@/app/lib/server/auth/http';

export async function GET(request: Request) {
  try {
    await authorizeHumanRequest(request, 'market_search');
  } catch (error) {
    return authorizationErrorResponse(error) ?? Response.json(
      { error: 'Ticker search is temporarily unavailable.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const query = normalizeTickerQuery(new URL(request.url).searchParams.get('q'));
  if (query.length < 2) {
    return Response.json({ query, results: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const results = await searchYahooTickers(query);
    return Response.json(
      { query, results },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('ticker search failed', error instanceof Error ? error.name : 'UnknownError');
    return Response.json({ error: 'Ticker search is temporarily unavailable.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
