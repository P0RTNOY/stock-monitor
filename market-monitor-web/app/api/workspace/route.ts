import { ensureDatabase, getD1 } from '@/db';
import { fetchYahooQuote, resolveYahooTicker } from '@/app/lib/server/yahoo';
import { authorizeHumanRequest } from '@/app/lib/server/auth/runtime-resolver';
import { createDirectSqlHumanRouteHandlers } from '@/app/lib/server/direct-sql-human-routes';

function analysisServiceUrl() {
  const configured = process.env.ANALYSIS_API_URL || 'http://127.0.0.1:8502';
  const url = new URL(configured);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid analysis service URL.');
  }
  return `${url.toString().replace(/\/$/, '')}/v1/analyze`;
}

const handlers = createDirectSqlHumanRouteHandlers({
  authorizeHumanRequest,
  ensureDatabase,
  getD1,
  fetchYahooQuote,
  resolveYahooTicker,
  fetch: globalThis.fetch,
  now: () => new Date(),
  analysisApiUrl: analysisServiceUrl,
});

export const GET = handlers.workspaceGet;
export const POST = handlers.workspacePost;
