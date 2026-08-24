import {
  COORDINATOR_CURSOR_VERSION,
  COORDINATOR_MAX_CURSOR_LENGTH,
  COORDINATOR_VERSION,
  CoordinatorContractError,
  isCanonicalUtcInstant,
  isDateOnly,
  isPositiveSafeInteger,
} from './contract.ts';

export type CoordinatorCursorPosition = {
  evaluationDate: string;
  forecastId: number;
};

export type CoordinatorCursorPayload = {
  v: typeof COORDINATOR_CURSOR_VERSION;
  coordinator: typeof COORDINATOR_VERSION;
  profileId: number;
  cutoff: string;
  scanStartedAt: string;
  snapshotMaxForecastId: number;
  after: CoordinatorCursorPosition | null;
};

export type CoordinatorCursorContext = {
  profileId: number;
  cutoff: string;
};

const PAYLOAD_KEYS = ['v', 'coordinator', 'profileId', 'cutoff', 'scanStartedAt', 'snapshotMaxForecastId', 'after'];
const POSITION_KEYS = ['evaluationDate', 'forecastId'];
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function cursorError(message: string): never {
  throw new CoordinatorContractError(message, 'invalid_cursor');
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}

function base64url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64url(value: string) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    cursorError('Malformed coordinator cursor encoding.');
  }
  const standard = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = standard + '='.repeat((4 - standard.length % 4) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (base64url(bytes) !== value) cursorError('Non-canonical coordinator cursor encoding.');
    return bytes;
  } catch {
    return cursorError('Malformed coordinator cursor encoding.');
  }
}

async function checksum(bytes: Uint8Array) {
  // Copy onto a concrete ArrayBuffer so this remains compatible with both the
  // DOM and Cloudflare Worker BufferSource declarations.
  const input = new Uint8Array(bytes);
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input.buffer));
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function canonicalJson(payload: CoordinatorCursorPayload) {
  return JSON.stringify({
    v: payload.v,
    coordinator: payload.coordinator,
    profileId: payload.profileId,
    cutoff: payload.cutoff,
    scanStartedAt: payload.scanStartedAt,
    snapshotMaxForecastId: payload.snapshotMaxForecastId,
    after: payload.after === null ? null : {
      evaluationDate: payload.after.evaluationDate,
      forecastId: payload.after.forecastId,
    },
  });
}

export function parseCoordinatorCursorPayload(value: unknown): CoordinatorCursorPayload {
  const row = record(value);
  if (!row || !exactKeys(row, PAYLOAD_KEYS)) cursorError('Invalid coordinator cursor fields.');
  if (row.v !== COORDINATOR_CURSOR_VERSION) cursorError('Unsupported coordinator cursor version.');
  if (row.coordinator !== COORDINATOR_VERSION) cursorError('Unsupported coordinator version in cursor.');
  if (!isPositiveSafeInteger(row.profileId)) cursorError('Invalid coordinator cursor profile.');
  if (!isCanonicalUtcInstant(row.cutoff)) cursorError('Invalid coordinator cursor cutoff.');
  if (!isCanonicalUtcInstant(row.scanStartedAt)) cursorError('Invalid coordinator cursor scan start.');
  if (typeof row.snapshotMaxForecastId !== 'number' || !Number.isSafeInteger(row.snapshotMaxForecastId)
    || row.snapshotMaxForecastId < 0) {
    cursorError('Invalid coordinator cursor snapshot maximum.');
  }

  let after: CoordinatorCursorPosition | null = null;
  if (row.after !== null) {
    const position = record(row.after);
    if (!position || !exactKeys(position, POSITION_KEYS)
      || !isDateOnly(position.evaluationDate) || !isPositiveSafeInteger(position.forecastId)) {
      cursorError('Invalid coordinator cursor position.');
    }
    if (position.forecastId > row.snapshotMaxForecastId) {
      cursorError('Coordinator cursor position exceeds its frozen snapshot.');
    }
    after = { evaluationDate: position.evaluationDate, forecastId: position.forecastId };
  }

  return {
    v: COORDINATOR_CURSOR_VERSION,
    coordinator: COORDINATOR_VERSION,
    profileId: row.profileId,
    cutoff: row.cutoff,
    scanStartedAt: row.scanStartedAt,
    snapshotMaxForecastId: row.snapshotMaxForecastId,
    after,
  };
}

export function createCoordinatorCursorPayload(input: Omit<CoordinatorCursorPayload, 'v' | 'coordinator'>) {
  return parseCoordinatorCursorPayload({
    v: COORDINATOR_CURSOR_VERSION,
    coordinator: COORDINATOR_VERSION,
    ...input,
  });
}

export function advanceCoordinatorCursor(
  payload: CoordinatorCursorPayload,
  after: CoordinatorCursorPosition,
) {
  return parseCoordinatorCursorPayload({ ...payload, after });
}

export async function encodeCoordinatorCursor(value: unknown) {
  const payload = parseCoordinatorCursorPayload(value);
  const jsonBytes = encoder.encode(canonicalJson(payload));
  const token = `${base64url(jsonBytes)}.${base64url(await checksum(jsonBytes))}`;
  if (token.length > COORDINATOR_MAX_CURSOR_LENGTH) cursorError('Coordinator cursor is too long.');
  return token;
}

export async function decodeCoordinatorCursor(token: unknown, context: CoordinatorCursorContext) {
  if (typeof token !== 'string' || token.length === 0 || token.length > COORDINATOR_MAX_CURSOR_LENGTH
    || token.trim() !== token) {
    cursorError('Invalid coordinator cursor token.');
  }
  if (!isPositiveSafeInteger(context.profileId) || !isCanonicalUtcInstant(context.cutoff)) {
    cursorError('Invalid coordinator cursor context.');
  }
  const parts = token.split('.');
  if (parts.length !== 2) cursorError('Malformed coordinator cursor token.');
  const payloadBytes = decodeBase64url(parts[0]);
  const suppliedChecksum = decodeBase64url(parts[1]);
  if (suppliedChecksum.length !== 32 || !sameBytes(suppliedChecksum, await checksum(payloadBytes))) {
    cursorError('Coordinator cursor checksum does not match.');
  }

  let json: string;
  let decoded: unknown;
  try {
    json = decoder.decode(payloadBytes);
    decoded = JSON.parse(json) as unknown;
  } catch {
    return cursorError('Coordinator cursor payload is not valid UTF-8 JSON.');
  }
  const payload = parseCoordinatorCursorPayload(decoded);
  if (canonicalJson(payload) !== json) cursorError('Coordinator cursor payload is not canonical.');
  if (payload.profileId !== context.profileId) cursorError('Coordinator cursor belongs to another profile.');
  if (payload.cutoff !== context.cutoff) cursorError('Coordinator cursor belongs to another cutoff.');
  return payload;
}
