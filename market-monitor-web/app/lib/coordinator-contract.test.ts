import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COORDINATOR_DEFAULT_LIMIT,
  COORDINATOR_MAX_LIMIT,
  COORDINATOR_MIN_LIMIT,
  CoordinatorContractError,
  isCanonicalUtcInstant,
  isDateOnly,
  parseCoordinatorInput,
} from './server/coordinator/contract.ts';
import {
  advanceCoordinatorCursor,
  createCoordinatorCursorPayload,
  decodeCoordinatorCursor,
  encodeCoordinatorCursor,
} from './server/coordinator/cursor.ts';

const cutoff = '2026-08-24T12:00:00.000Z';
const scanStartedAt = '2026-08-24T12:00:01.000Z';

function expectCode(action: () => unknown, code: CoordinatorContractError['code']) {
  assert.throws(action, (error) => error instanceof CoordinatorContractError && error.code === code);
}

async function expectCursorError(action: () => Promise<unknown>, message?: RegExp) {
  await assert.rejects(action, (error) => error instanceof CoordinatorContractError
    && error.code === 'invalid_cursor' && (!message || message.test(error.message)));
}

function base64url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function signedRawCursor(json: string) {
  const bytes = new TextEncoder().encode(json);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `${base64url(bytes)}.${base64url(digest)}`;
}

test('coordinator input normalizes defaults only after trusted profile validation', () => {
  assert.deepEqual(parseCoordinatorInput({ profileId: 7, cutoff, mode: 'execute' }, 7), {
    profileId: 7,
    cutoff,
    limit: COORDINATOR_DEFAULT_LIMIT,
    mode: 'execute',
  });
  assert.deepEqual(parseCoordinatorInput({
    profileId: 7,
    cutoff,
    limit: COORDINATOR_MAX_LIMIT,
    cursor: 'opaque',
    mode: 'dry_run',
    operatorRunKey: 'nightly:2026-08-24',
  }, 7), {
    profileId: 7,
    cutoff,
    limit: 100,
    cursor: 'opaque',
    mode: 'dry_run',
    operatorRunKey: 'nightly:2026-08-24',
  });
});

test('coordinator input rejects untrusted profiles, unknown fields, and malformed values', () => {
  expectCode(() => parseCoordinatorInput({ profileId: 8, cutoff, mode: 'execute' }, 7), 'invalid_profile');
  expectCode(() => parseCoordinatorInput({ profileId: 7, cutoff, mode: 'execute', symbol: 'NVDA' }, 7), 'invalid_input');
  expectCode(() => parseCoordinatorInput({ profileId: 7, cutoff: '2026-08-24T12:00:00Z', mode: 'execute' }, 7), 'invalid_cutoff');
  expectCode(() => parseCoordinatorInput({ profileId: 7, cutoff, mode: 'preview' }, 7), 'invalid_mode');
  for (const limit of [COORDINATOR_MIN_LIMIT - 1, COORDINATOR_MAX_LIMIT + 1, 1.5, '25']) {
    expectCode(() => parseCoordinatorInput({ profileId: 7, cutoff, mode: 'execute', limit }, 7), 'invalid_limit');
  }
  expectCode(() => parseCoordinatorInput({ profileId: 7, cutoff, mode: 'execute', cursor: '' }, 7), 'invalid_cursor');
  expectCode(() => parseCoordinatorInput({ profileId: 7, cutoff, mode: 'execute', operatorRunKey: ' bad ' }, 7), 'invalid_operator_run_key');
  expectCode(() => parseCoordinatorInput({ profileId: 7, cutoff, mode: 'execute', operatorRunKey: 'bad\nkey' }, 7), 'invalid_operator_run_key');
});

test('UTC instant and date-only guards reject normalized-looking impossible dates', () => {
  assert.equal(isCanonicalUtcInstant(cutoff), true);
  assert.equal(isCanonicalUtcInstant('2026-08-24T15:00:00.000+03:00'), false);
  assert.equal(isCanonicalUtcInstant('2026-02-30T12:00:00.000Z'), false);
  assert.equal(isDateOnly('2028-02-29'), true);
  assert.equal(isDateOnly('2027-02-29'), false);
});

test('cursor encoding is deterministic, opaque, unpadded, and context bound', async () => {
  const payload = createCoordinatorCursorPayload({
    profileId: 7,
    cutoff,
    scanStartedAt,
    snapshotMaxForecastId: 42,
    after: { evaluationDate: '2026-09-30', forecastId: 12 },
  });
  const first = await encodeCoordinatorCursor(payload);
  const second = await encodeCoordinatorCursor({ ...payload });
  assert.equal(first, second);
  assert.match(first, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(first, /=/);
  assert.deepEqual(await decodeCoordinatorCursor(first, { profileId: 7, cutoff }), payload);
  await expectCursorError(() => decodeCoordinatorCursor(first, { profileId: 8, cutoff }), /another profile/);
  await expectCursorError(() => decodeCoordinatorCursor(first, {
    profileId: 7,
    cutoff: '2026-08-25T12:00:00.000Z',
  }), /another cutoff/);
});

test('cursor supports a frozen empty scan and immutable key advancement', async () => {
  const start = createCoordinatorCursorPayload({
    profileId: 1,
    cutoff,
    scanStartedAt,
    snapshotMaxForecastId: 0,
    after: null,
  });
  assert.equal((await decodeCoordinatorCursor(await encodeCoordinatorCursor(start), { profileId: 1, cutoff })).after, null);

  const populated = createCoordinatorCursorPayload({ ...start, snapshotMaxForecastId: 9 });
  const advanced = advanceCoordinatorCursor(populated, { evaluationDate: '2026-08-31', forecastId: 9 });
  assert.deepEqual(advanced.after, { evaluationDate: '2026-08-31', forecastId: 9 });
  assert.equal(populated.after, null);
  expectCode(() => advanceCoordinatorCursor(populated, { evaluationDate: '2026-08-31', forecastId: 10 }), 'invalid_cursor');
});

test('cursor rejects malformed, truncated, padded, and checksum-tampered tokens', async () => {
  const payload = createCoordinatorCursorPayload({
    profileId: 7, cutoff, scanStartedAt, snapshotMaxForecastId: 42, after: null,
  });
  const token = await encodeCoordinatorCursor(payload);
  await expectCursorError(() => decodeCoordinatorCursor('', { profileId: 7, cutoff }));
  await expectCursorError(() => decodeCoordinatorCursor('abc', { profileId: 7, cutoff }));
  await expectCursorError(() => decodeCoordinatorCursor(`${token}=`, { profileId: 7, cutoff }));
  await expectCursorError(() => decodeCoordinatorCursor(token.slice(0, -1), { profileId: 7, cutoff }));
  const replacement = token.endsWith('A') ? 'B' : 'A';
  await expectCursorError(() => decodeCoordinatorCursor(`${token.slice(0, -1)}${replacement}`, { profileId: 7, cutoff }), /checksum/);
});

test('cursor rejects correctly checksummed unknown versions, fields, and non-canonical JSON', async () => {
  const base = {
    v: 1,
    coordinator: 'forecast-coordinator-1.0.0',
    profileId: 7,
    cutoff,
    scanStartedAt,
    snapshotMaxForecastId: 42,
    after: null,
  };
  const unknownVersion = await signedRawCursor(JSON.stringify({ ...base, v: 2 }));
  const unknownField = await signedRawCursor(JSON.stringify({ ...base, sql: 'OFFSET 1' }));
  const nonCanonical = await signedRawCursor(JSON.stringify({ ...base, profileId: 7 }, null, 2));
  await expectCursorError(
    () => decodeCoordinatorCursor(unknownVersion, { profileId: 7, cutoff }), /version/,
  );
  await expectCursorError(
    () => decodeCoordinatorCursor(unknownField, { profileId: 7, cutoff }), /fields/,
  );
  await expectCursorError(
    () => decodeCoordinatorCursor(nonCanonical, { profileId: 7, cutoff }), /canonical/,
  );
});
