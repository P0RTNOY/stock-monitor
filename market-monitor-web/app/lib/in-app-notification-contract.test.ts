import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IN_APP_DEFAULT_LIMIT,
  IN_APP_MAX_LIMIT,
  InAppNotificationError,
  decodeHighWater,
  decodeListCursor,
  encodeHighWater,
  encodeListCursor,
  parseEmptyBody,
  parseEntryId,
  parseListQuery,
  parseMarkAllBody,
} from './server/in-app-notifications/contract.ts';
import { mapEmailStatus } from './server/in-app-notifications/presentation.ts';
import {
  notificationBadge,
  notificationCountLabel,
  parseClientNotificationList,
} from './in-app-notifications.ts';

const ID = 'a'.repeat(64);
const POSITION = { occurredAt: '2026-08-26T10:00:00.000Z', id: ID };

function base64url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function checksummedToken(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const checksum = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `${base64url(bytes)}.${base64url(checksum)}`;
}

test('list query is strict, bounded, and defaults to all filters with 20 items', () => {
  assert.deepEqual(parseListQuery(new URL('https://northstar.test/api/notifications')), {
    state: 'all', category: 'all', limit: IN_APP_DEFAULT_LIMIT,
  });
  assert.equal(IN_APP_MAX_LIMIT, 50);
  assert.deepEqual(parseListQuery(new URL('https://northstar.test/api/notifications?state=unread&category=needs_review&limit=50')), {
    state: 'unread', category: 'needs_review', limit: 50,
  });
  for (const query of [
    '?profileId=1', '?state=unknown', '?category=no_change', '?limit=0', '?limit=51',
    '?limit=01', '?state=read&state=unread', '?cursor=',
  ]) assert.throws(() => parseListQuery(new URL(`https://northstar.test/api/notifications${query}`)), InAppNotificationError);
});

test('list cursor is canonical, checksummed, profile-bound, and filter-bound', async () => {
  const token = await encodeListCursor({ profileId: 1, state: 'unread', category: 'needs_review', after: POSITION });
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.deepEqual(await decodeListCursor(token, { profileId: 1, state: 'unread', category: 'needs_review' }), POSITION);
  await assert.rejects(() => decodeListCursor(`${token}x`, { profileId: 1, state: 'unread', category: 'needs_review' }), InAppNotificationError);
  await assert.rejects(() => decodeListCursor(token, { profileId: 2, state: 'unread', category: 'needs_review' }), InAppNotificationError);
  await assert.rejects(() => decodeListCursor(token, { profileId: 1, state: 'read', category: 'needs_review' }), InAppNotificationError);
  await assert.rejects(() => decodeListCursor(token, { profileId: 1, state: 'unread', category: 'expired' }), InAppNotificationError);
  await assert.rejects(() => decodeListCursor(`${token}=`, { profileId: 1, state: 'unread', category: 'needs_review' }), InAppNotificationError);
  await assert.rejects(() => decodeListCursor(token.slice(0, -5), { profileId: 1, state: 'unread', category: 'needs_review' }), InAppNotificationError);
  const future = await checksummedToken({
    v: 2, purpose: 'notification_list', profileId: 1, state: 'unread',
    category: 'needs_review', after: POSITION,
  });
  await assert.rejects(() => decodeListCursor(future, { profileId: 1, state: 'unread', category: 'needs_review' }), InAppNotificationError);
});

test('mark-all high water is server-context bound and tamper evident', async () => {
  const token = await encodeHighWater(1, 42);
  assert.equal(await decodeHighWater(token, 1), 42);
  await assert.rejects(() => decodeHighWater(token, 2), InAppNotificationError);
  await assert.rejects(() => decodeHighWater(token.replace(/.$/u, 'x'), 1), InAppNotificationError);
});

test('mutation bodies and public IDs reject browser-owned fields', () => {
  assert.doesNotThrow(() => parseEmptyBody({}));
  assert.throws(() => parseEmptyBody({ occurredAt: '2026-01-01T00:00:00.000Z' }), InAppNotificationError);
  assert.equal(parseMarkAllBody({ highWaterToken: 'opaque' }), 'opaque');
  assert.throws(() => parseMarkAllBody({ highWaterToken: 'opaque', profileId: 1 }), InAppNotificationError);
  assert.equal(parseEntryId(ID), ID);
  assert.throws(() => parseEntryId('../intent'), InAppNotificationError);
});

test('email delivery presentation stays distinct and truthful', () => {
  assert.deepEqual(mapEmailStatus(null), { state: 'not_configured', label: 'Email not configured', tone: 'neutral' });
  assert.equal(mapEmailStatus('provider_accepted').label, 'Email provider accepted');
  assert.equal(mapEmailStatus('delivered').label, 'Delivered to mail server');
  assert.equal(mapEmailStatus('ambiguous').label, 'Email outcome unconfirmed');
  assert.equal(mapEmailStatus('bounced').tone, 'negative');
  assert.equal(mapEmailStatus('complained').tone, 'negative');
  assert.equal(mapEmailStatus('suppressed').state, 'suppressed');
});

test('client badge caps visually but preserves exact accessible count', () => {
  assert.equal(notificationBadge(99), '99');
  assert.equal(notificationBadge(127), '99+');
  assert.equal(notificationCountLabel(127), 'Notifications, 127 unread items');
  assert.equal(notificationCountLabel(0), 'Notifications, no unread items');
  assert.equal(notificationCountLabel(null), 'Notifications, unread count unavailable');
});

test('client response validator rejects arbitrary links and leaked malformed models', () => {
  const entry = {
    id: ID, category: 'needs_review', symbol: 'AAPL', state: 'unread',
    occurredAt: '2026-08-26T10:00:00.000Z', firstReadAt: null,
    presentation: { version: 'v1', title: 'Needs review', summary: 'AAPL needs review.', details: [], evidence: { forecastId: 1, evaluationRunId: 2, reviewItemId: 3, analysisSnapshotId: null } },
    deepLink: `/notifications/${ID}`,
    email: { state: 'not_configured', label: 'Email not configured', tone: 'neutral' },
  };
  assert.ok(parseClientNotificationList({ items: [entry], nextCursor: null, unreadCount: 1, markAllReadToken: 'opaque' }));
  assert.equal(parseClientNotificationList({ items: [{ ...entry, deepLink: 'https://evil.test' }], nextCursor: null, unreadCount: 1, markAllReadToken: 'opaque' }), null);
});
