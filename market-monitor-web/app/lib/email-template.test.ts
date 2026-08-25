import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EmailAddressValidationError,
  maskEmailAddress,
  normalizeEmailAddress,
  normalizeEmailMailboxHeader,
} from './server/email/address.ts';
import {
  EmailCapabilityError,
  issueEmailCapability,
  materializeEmailCapability,
  verifyEmailCapability,
  webCryptoEmailCapabilityPrimitives,
} from './server/email/capability.ts';
import {
  EmailLinkValidationError,
  buildUnsubscribeUrl,
  parsePublicAppBaseUrl,
} from './server/email/links.ts';
import {
  EmailSafetyError,
  assertSafeEmailHeaderValue,
  escapeHtml,
} from './server/email/safety.ts';
import {
  FORECAST_EMAIL_CAPABILITY_VERSION,
} from './server/email/types.ts';
import {
  EMAIL_DISCLAIMER,
  EMAIL_TEMPLATE_LOCALE,
  EMAIL_TEMPLATE_VERSIONS,
  renderForecastEmail,
  renderVerificationEmail,
} from './server/email/templates.ts';
import { NOTIFICATION_PAYLOAD_SCHEMA_VERSION } from './server/notifications/contract.ts';
import type { NotificationCategory, NotificationPayload } from './server/notifications/types.ts';

const publicAppBaseUrl = parsePublicAppBaseUrl('https://northstar.example', 'production');
const token = `v1.${'a'.repeat(24)}.${'b'.repeat(43)}`;
const now = '2026-08-25T06:30:00.000Z';

function payload(category: NotificationCategory): NotificationPayload {
  return {
    payloadVersion: NOTIFICATION_PAYLOAD_SCHEMA_VERSION,
    profileId: 1,
    forecastId: 11,
    evaluationRunId: 21,
    reviewItemId: 31,
    category,
    previousStatus: 'active',
    resultingStatus: category === 'needs_review' ? 'active' : category,
    symbol: 'NVDA',
    reasonCode: `${category}_reason`,
    evaluatedThrough: '2026-08-24',
    triggeringMarketDate: category === 'expired' ? null : '2026-08-24',
    occurredAt: '2026-08-25T06:29:00.000Z',
    evaluationCutoff: now,
    targetBoundary: category === 'target_hit' ? 190 : null,
    targetRange: category === 'target_hit' ? [185, 190] : null,
    invalidationBoundary: category === 'invalidated' ? 150 : null,
    detectedAt: category === 'expired' ? null : 'within_bar',
    crossedBoundary: category === 'target_hit' ? 190 : category === 'invalidated' ? 150 : null,
    activationCurrency: 'USD',
    observedCurrency: 'USD',
    analysisSnapshotId: 41,
    evaluatorVersion: 'forecast-evaluator-1.0.0',
    rulesetVersion: 'forecast-evaluation-ruleset-v1',
  };
}

test('address normalization is deliberately minimal and masking is stable', () => {
  assert.equal(normalizeEmailAddress('  First.Last+alerts@EXAMPLE.COM  '), 'First.Last+alerts@example.com');
  assert.equal(normalizeEmailMailboxHeader('Northstar Alerts <Ops@EXAMPLE.COM>'),
    'Northstar Alerts <Ops@example.com>');
  assert.equal(maskEmailAddress('First.Last+alerts@example.com'), 'F***@e***.com');
  for (const invalid of [
    'missing-at.example.com', '.first@example.com', 'first..last@example.com',
    'first@localhost', 'first@-example.com', 'first@example.com\r\nBcc:x@example.com',
    'føø@example.com',
  ]) assert.throws(() => normalizeEmailAddress(invalid), EmailAddressValidationError);
});

test('HTML and header safety escape metacharacters and reject injection', () => {
  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(assertSafeEmailHeaderValue('Safe subject', 'subject', 20), 'Safe subject');
  for (const value of [' subject', 'subject ', 'subject\r\nBcc: x@example.com', 'bad\tvalue']) {
    assert.throws(() => assertSafeEmailHeaderValue(value), EmailSafetyError);
  }
});

test('public application links are origin-only and production HTTPS', () => {
  assert.equal(publicAppBaseUrl, 'https://northstar.example');
  assert.equal(buildUnsubscribeUrl(publicAppBaseUrl, token),
    `https://northstar.example/email/unsubscribe?token=${token}`);
  assert.equal(parsePublicAppBaseUrl('http://localhost:3000', 'development'), 'http://localhost:3000');
  assert.equal(parsePublicAppBaseUrl('http://127.0.0.1:3000', 'local'), 'http://127.0.0.1:3000');
  for (const value of [
    'http://northstar.example', 'https://user:pass@northstar.example',
    'https://northstar.example/path', 'https://northstar.example?next=https://evil.example',
    'javascript:alert(1)', 'https://localhost', 'https://northstar.example:8443',
  ]) assert.throws(() => parsePublicAppBaseUrl(value, 'production'), EmailLinkValidationError);
  assert.throws(
    () => parsePublicAppBaseUrl('http://localhost:3000', 'preview'),
    EmailLinkValidationError,
  );
});

test('all four forecast templates are frozen, informational, bounded, and unsubscribable', async () => {
  const expected = {
    target_hit: ['northstar-forecast-target-hit-1.0.0', 'reached its recorded target'],
    invalidated: ['northstar-forecast-invalidated-1.0.0', 'recorded invalidation boundary'],
    expired: ['northstar-forecast-expired-1.0.0', 'completed its recorded horizon'],
    needs_review: ['northstar-forecast-needs-review-1.0.0', 'needs review'],
  } as const;
  for (const category of Object.keys(expected) as NotificationCategory[]) {
    const rendered = await renderForecastEmail({
      payload: payload(category), publicAppBaseUrl, unsubscribeToken: token,
    });
    assert.equal(rendered.templateId, category);
    assert.equal(rendered.templateVersion, expected[category][0]);
    assert.equal(rendered.locale, EMAIL_TEMPLATE_LOCALE);
    assert.match(rendered.text, new RegExp(expected[category][1], 'u'));
    assert.match(rendered.text, new RegExp(EMAIL_DISCLAIMER, 'u'));
    assert.match(rendered.html, /Unsubscribe from forecast email/u);
    assert.equal(rendered.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.match(rendered.headers['List-Unsubscribe'], /^<https:\/\/northstar\.example\/email\/unsubscribe\?token=/u);
    assert.match(rendered.contentHash, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(`${rendered.subject}\n${rendered.text}\n${rendered.html}`, /\b(?:buy|sell)\b/iu);
    const replay = await renderForecastEmail({
      payload: { ...payload(category) }, publicAppBaseUrl, unsubscribeToken: token,
    });
    assert.equal(replay.contentHash, rendered.contentHash);
  }
});

test('verification template is bounded and explicitly separates verification from consent', async () => {
  const rendered = await renderVerificationEmail({
    publicAppBaseUrl,
    verificationToken: token,
    expiresAt: '2026-08-26T06:30:00.000Z',
  });
  assert.equal(rendered.templateVersion, EMAIL_TEMPLATE_VERSIONS.verification);
  assert.equal(rendered.subject, 'Verify your Northstar email');
  assert.match(rendered.text, /does not enable forecast emails/u);
  assert.match(rendered.html, /https:\/\/northstar\.example\/email\/verify\?token=/u);
  assert.deepEqual(rendered.headers, {});
  assert.match(rendered.contentHash, /^[a-f0-9]{64}$/u);
});

test('forecast renderer rejects unsupported payload versions and header-injection payloads', async () => {
  await assert.rejects(() => renderForecastEmail({
    payload: { ...payload('target_hit'), payloadVersion: 'future' },
    publicAppBaseUrl,
    unsubscribeToken: token,
  }));
  await assert.rejects(() => renderForecastEmail({
    payload: { ...payload('target_hit'), symbol: 'NVDA\r\nBcc:x@example.com' },
    publicAppBaseUrl,
    unsubscribeToken: token,
  }));
});

test('capabilities are random, purpose-bound, hash-only at rest, reconstructable, and expiring', async () => {
  const secret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const primitives = {
    ...webCryptoEmailCapabilityPrimitives,
    randomBytes(length: number) {
      return Uint8Array.from({ length }, (_, index) => index + 10);
    },
  };
  const issued = await issueEmailCapability({
    purpose: 'verification',
    recipientId: 'recipient_7',
    consentRevision: null,
    createdAt: now,
    expiresAt: '2026-08-26T06:30:00.000Z',
  }, secret, primitives);
  assert.match(issued.token, /^v1\.[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/u);
  assert.doesNotMatch(issued.token, /recipient|profile|@/u);
  assert.match(issued.record.tokenHash, /^[a-f0-9]{64}$/u);
  assert.equal(issued.record.tokenVersion, FORECAST_EMAIL_CAPABILITY_VERSION);
  assert.doesNotMatch(JSON.stringify(issued.record), new RegExp(issued.token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.equal(await materializeEmailCapability(issued.record, secret, primitives), issued.token);
  assert.deepEqual(await verifyEmailCapability({
    token: issued.token,
    expectedPurpose: 'verification',
    record: issued.record,
    now: '2026-08-25T07:00:00.000Z',
  }, secret, primitives), {
    valid: true,
    purpose: 'verification',
    recipientId: 'recipient_7',
  });
  assert.equal((await verifyEmailCapability({
    token: issued.token,
    expectedPurpose: 'unsubscribe',
    record: issued.record,
    now: '2026-08-25T07:00:00.000Z',
  }, secret, primitives)).valid, false);
  assert.deepEqual(await verifyEmailCapability({
    token: issued.token,
    expectedPurpose: 'verification',
    record: issued.record,
    now: issued.record.expiresAt as string,
  }, secret, primitives), { valid: false, reason: 'expired' });
  assert.deepEqual(await verifyEmailCapability({
    token: `${issued.token.slice(0, -1)}${issued.token.endsWith('A') ? 'B' : 'A'}`,
    expectedPurpose: 'verification',
    record: issued.record,
    now: '2026-08-25T07:00:00.000Z',
  }, secret, primitives), { valid: false, reason: 'integrity_failure' });
  assert.deepEqual(await verifyEmailCapability({
    token: issued.token,
    expectedPurpose: 'verification',
    record: { ...issued.record, consumedAt: '2026-08-25T06:45:00.000Z' },
    now: '2026-08-25T07:00:00.000Z',
  }, secret, primitives), { valid: false, reason: 'used' });
  await assert.rejects(
    () => materializeEmailCapability({
      ...issued.record, consumedAt: '2026-08-25T06:45:00.000Z',
    }, secret, primitives),
    EmailCapabilityError,
  );

  const unsubscribe = await issueEmailCapability({
    purpose: 'unsubscribe',
    recipientId: 'recipient_7',
    consentRevision: 3,
    createdAt: now,
    expiresAt: null,
  }, secret, primitives);
  assert.equal((await verifyEmailCapability({
    token: unsubscribe.token,
    expectedPurpose: 'unsubscribe',
    record: unsubscribe.record,
    now: '2036-08-25T07:00:00.000Z',
  }, secret, primitives)).valid, true);
  assert.deepEqual(await verifyEmailCapability({
    token: unsubscribe.token,
    expectedPurpose: 'unsubscribe',
    record: { ...unsubscribe.record, consentRevision: 4 },
    now: '2036-08-25T07:00:00.000Z',
  }, secret, primitives), { valid: false, reason: 'integrity_failure' });
});
