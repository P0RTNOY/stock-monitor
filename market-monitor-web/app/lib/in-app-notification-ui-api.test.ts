import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(relative: string) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

test('notification HTTP boundary is explicitly authorized, no-store, and performs no schema or provider work', () => {
  const http = source('./server/in-app-notifications/http.ts');
  assert.match(http, /authorizeHumanRequest\(request, action\)/u);
  assert.doesNotMatch(http, /resolveCurrentProfile/u);
  assert.match(http, /getD1\(\)/u);
  assert.match(http, /Cache-Control', 'no-store/u);
  assert.doesNotMatch(http, /ensureDatabase|forecastRequestContext|evaluationRequestContext|fetchYahoo|evaluateWithPython/u);
  const listRoute = source('../api/notifications/route.ts');
  const countRoute = source('../api/notifications/unread-count/route.ts');
  assert.doesNotMatch(`${listRoute}\n${countRoute}`, /POST|project|initialize|provider/u);
});

test('notification center exposes semantic controls and does not mark read while fetching or opening evidence', () => {
  const center = source('../components/NotificationCenter.tsx');
  const detail = source('../components/NotificationEvidenceDetail.tsx');
  assert.match(center, /aria-label="Notification filters"/u);
  assert.match(center, /aria-live="polite"/u);
  assert.match(center, /role="alert"/u);
  assert.match(center, /<article/u);
  assert.match(center, /<time dateTime=/u);
  assert.match(center, /Mark as read/u);
  assert.match(center, /Load more/u);
  assert.match(center, /AccessibleDialog/u);
  assert.doesNotMatch(detail, /method:\s*'POST'|\/read['`]/u);
  assert.match(detail, /Opening evidence does not change notification read state/u);
});

test('bell remains a real accessible link on mobile and caps only the visible badge', () => {
  const bell = source('../components/NotificationBell.tsx');
  const css = source('../globals.css');
  assert.match(bell, /<Link className="notification-bell" href="\/notifications"/u);
  assert.match(bell, /notificationCountLabel\(count, loading\)/u);
  assert.match(css, /a:focus-visible/u);
  assert.match(css, /\.notification-bell/u);
  assert.doesNotMatch(bell, /className="icon-button"/u);
});

test('notification route is isolated from the market workspace and external quote loading', () => {
  const page = source('../notifications/page.tsx');
  const shell = source('../components/NotificationShell.tsx');
  assert.match(page, /NotificationCenter/u);
  assert.match(page, /NotificationShell/u);
  assert.doesNotMatch(`${page}\n${shell}`, /MarketWorkspace|\/api\/workspace|\/api\/market/u);
});
