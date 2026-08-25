import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NOTIFICATION_CURSOR_VERSION,
  NOTIFICATION_DEDUP_VERSION,
  NOTIFICATION_MAX_CURSOR_LENGTH,
  NOTIFICATION_PAYLOAD_SCHEMA_VERSION,
  NOTIFICATION_POLICY_VERSION,
  NOTIFICATION_PROJECTOR_VERSION,
  NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
  NOTIFICATION_RETRY_POLICY_VERSION,
  NotificationContractError,
  advanceNotificationCursor,
  createNotificationCursorPayload,
  decodeNotificationCursor,
  encodeNotificationCursor,
  parseNotificationProjectionInput,
} from './server/notifications/contract.ts';
import {
  canonicalNotificationPayloadJson,
  materializeNotificationPayload,
  notificationIntentId,
  notificationSourceDedupKey,
  parseNotificationPayload,
} from './server/notifications/payload.ts';
import {
  NOTIFICATION_PROJECTION_CLASSIFICATIONS,
  type TrustedNotificationSourceRow,
} from './server/notifications/types.ts';

const cutoff = '2026-08-25T06:30:00.000Z';

function expectContractCode(action: () => unknown, code: NotificationContractError['code']) {
  assert.throws(action, (error: unknown) => (
    error instanceof NotificationContractError && error.code === code
  ));
}

function source(overrides: Partial<TrustedNotificationSourceRow> = {}): TrustedNotificationSourceRow {
  return {
    profileId: 1,
    forecastId: 11,
    evaluationRunId: 21,
    reviewItemId: 31,
    reviewKind: 'resolved',
    resultKind: 'target_hit',
    reasonCode: 'target_boundary_touched',
    evaluatorVersion: 'forecast-evaluator-1.0.0',
    rulesetVersion: 'forecast-evaluation-ruleset-v1',
    evaluatedThrough: '2026-08-24',
    evaluationCutoff: cutoff,
    createdAt: '2026-08-25T06:29:00.000Z',
    symbol: 'NVDA',
    analysisSnapshotId: 41,
    evidenceJson: JSON.stringify({
      activation_currency: 'USD',
      observed_currency: 'USD',
      triggering_observation: { market_date: '2026-08-24' },
      target_boundary: 190,
      target_range: null,
      invalidation_boundary: 150,
      detected_at: 'within_bar',
      crossed_boundary: 190,
    }),
    ...overrides,
  };
}

test('notification contract versions are explicit and frozen', () => {
  assert.deepEqual({
    projector: NOTIFICATION_PROJECTOR_VERSION,
    policy: NOTIFICATION_POLICY_VERSION,
    payload: NOTIFICATION_PAYLOAD_SCHEMA_VERSION,
    dedup: NOTIFICATION_DEDUP_VERSION,
    retry: NOTIFICATION_RETRY_POLICY_VERSION,
    quietHours: NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
    cursor: NOTIFICATION_CURSOR_VERSION,
  }, {
    projector: 'forecast-notification-projector-1.0.0',
    policy: 'forecast-notification-policy-1.0.0',
    payload: 'forecast-notification-payload-1.0.0',
    dedup: 'forecast-notification-dedup-1.0.0',
    retry: 'forecast-notification-retry-1.0.0',
    quietHours: 'forecast-notification-quiet-hours-1.0.0',
    cursor: 1,
  });
});

test('projection input is strict, profile-bound, bounded, and dry-run by default', () => {
  assert.deepEqual(parseNotificationProjectionInput({ profileId: 1, cutoff }, 1), {
    profileId: 1,
    cutoff,
    limit: 25,
    mode: 'dry_run',
  });
  assert.deepEqual(parseNotificationProjectionInput({
    profileId: 1, cutoff, limit: 100, mode: 'commit', cursor: 'opaque',
  }, 1), {
    profileId: 1, cutoff, limit: 100, mode: 'commit', cursor: 'opaque',
  });

  for (const [value, code] of [
    [null, 'invalid_input'],
    [{ profileId: 1, cutoff, outcome: 'target_hit' }, 'invalid_input'],
    [{ profileId: 2, cutoff }, 'invalid_profile'],
    [{ profileId: 1, cutoff: '2026-08-25T06:30:00Z' }, 'invalid_cutoff'],
    [{ profileId: 1, cutoff, limit: 0 }, 'invalid_limit'],
    [{ profileId: 1, cutoff, limit: 1.5 }, 'invalid_limit'],
    [{ profileId: 1, cutoff, limit: 101 }, 'invalid_limit'],
    [{ profileId: 1, cutoff, mode: 'execute' }, 'invalid_mode'],
    [{ profileId: 1, cutoff, cursor: `x${'a'.repeat(NOTIFICATION_MAX_CURSOR_LENGTH)}` }, 'invalid_cursor'],
  ] as const) expectContractCode(() => parseNotificationProjectionInput(value, 1), code);
  expectContractCode(() => parseNotificationProjectionInput({ profileId: 1, cutoff }, 0), 'invalid_profile');
});

test('projection cursor is deterministic, opaque, context-bound, and advances only by evaluation-run id', async () => {
  const payload = createNotificationCursorPayload({
    profileId: 1,
    cutoff,
    after: { createdAt: '2026-08-25T06:29:00.000Z', evaluationRunId: 21 },
  });
  const token = await encodeNotificationCursor(payload);
  assert.equal(token, await encodeNotificationCursor(payload));
  assert.doesNotMatch(token, /2026|evaluationRunId|forecast-notification/u);
  assert.deepEqual(await decodeNotificationCursor(token, { profileId: 1, cutoff }), payload);

  await assert.rejects(
    () => decodeNotificationCursor(token, { profileId: 2, cutoff }),
    (error: unknown) => error instanceof NotificationContractError && error.code === 'invalid_cursor',
  );
  const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  await assert.rejects(
    () => decodeNotificationCursor(tampered, { profileId: 1, cutoff }),
    (error: unknown) => error instanceof NotificationContractError && error.code === 'invalid_cursor',
  );
  expectContractCode(() => advanceNotificationCursor(payload, {
    createdAt: '2026-08-25T06:29:30.000Z', evaluationRunId: 21,
  }), 'invalid_cursor');
  assert.equal(advanceNotificationCursor(payload, {
    createdAt: '2026-08-25T06:29:30.000Z', evaluationRunId: 22,
  }).after?.evaluationRunId, 22);
});

test('trusted Phase 2A source materializes a minimal canonical payload', () => {
  const payload = materializeNotificationPayload(source());
  assert.deepEqual(payload, {
    payloadVersion: NOTIFICATION_PAYLOAD_SCHEMA_VERSION,
    profileId: 1,
    forecastId: 11,
    evaluationRunId: 21,
    reviewItemId: 31,
    category: 'target_hit',
    previousStatus: 'active',
    resultingStatus: 'target_hit',
    symbol: 'NVDA',
    reasonCode: 'target_boundary_touched',
    evaluatedThrough: '2026-08-24',
    triggeringMarketDate: '2026-08-24',
    occurredAt: '2026-08-25T06:29:00.000Z',
    evaluationCutoff: cutoff,
    targetBoundary: 190,
    targetRange: null,
    invalidationBoundary: 150,
    detectedAt: 'within_bar',
    crossedBoundary: 190,
    activationCurrency: 'USD',
    observedCurrency: 'USD',
    analysisSnapshotId: 41,
    evaluatorVersion: 'forecast-evaluator-1.0.0',
    rulesetVersion: 'forecast-evaluation-ruleset-v1',
  });
  assert.deepEqual(parseNotificationPayload(JSON.parse(canonicalNotificationPayloadJson(payload))), payload);
});

test('deduplication and intent identities are deterministic and bound to trusted dimensions', async () => {
  const payload = materializeNotificationPayload(source());
  const dedup = await notificationSourceDedupKey(payload);
  const intent = await notificationIntentId(payload);
  assert.match(dedup, /^[a-f0-9]{64}$/u);
  assert.match(intent, /^[a-f0-9]{64}$/u);
  assert.equal(dedup, await notificationSourceDedupKey({ ...payload }));
  assert.equal(intent, await notificationIntentId({ ...payload }));

  for (const changed of [
    materializeNotificationPayload(source({ profileId: 2 })),
    materializeNotificationPayload(source({ evaluationRunId: 22 })),
    materializeNotificationPayload(source({
      resultKind: 'needs_review', reviewKind: 'needs_review', reasonCode: 'same_bar_collision',
      evidenceJson: JSON.stringify({
        activation_currency: 'USD', observed_currency: 'USD',
        triggering_observation: { market_date: '2026-08-24' },
        target_boundary: 190, target_range: null, invalidation_boundary: 150,
        detected_at: 'within_bar', crossed_boundary: null,
      }),
    })),
  ]) assert.notEqual(await notificationSourceDedupKey(changed), dedup);
});

test('no-change and malformed trusted sources fail closed as invalid_source', () => {
  assert.ok(NOTIFICATION_PROJECTION_CLASSIFICATIONS.includes('excluded_no_change'));
  for (const invalid of [
    source({ resultKind: 'no_change' }),
    source({ evidenceJson: '{not-json' }),
    source({ reviewKind: 'needs_review' }),
    source({ symbol: 'NVDA\nBUY' }),
    source({ evidenceJson: JSON.stringify({
      activation_currency: 'USD', observed_currency: 'USD',
      triggering_observation: { market_date: '2026-08-24' },
      target_boundary: 190, target_range: null, invalidation_boundary: 150,
      detected_at: 'within_bar', crossed_boundary: 189,
    }) }),
  ]) expectContractCode(() => materializeNotificationPayload(invalid), 'invalid_source');
});

test('persisted payload parser rejects unknown fields, forged transitions, and unsafe evidence', () => {
  const payload = materializeNotificationPayload(source());
  for (const invalid of [
    { ...payload, arbitraryMetadata: 'secret' },
    { ...payload, payloadVersion: 'future' },
    { ...payload, previousStatus: 'draft' },
    { ...payload, resultingStatus: 'invalidated' },
    { ...payload, reasonCode: 'Buy now' },
    { ...payload, crossedBoundary: 189 },
    { ...payload, activationCurrency: 'usd' },
  ]) expectContractCode(() => parseNotificationPayload(invalid), 'invalid_payload');
});
