import { isCanonicalUtcInstant, isPositiveSafeInteger } from '../coordinator/contract.ts';

export const NOTIFICATION_PROJECTOR_VERSION = 'forecast-notification-projector-1.0.0' as const;
export const NOTIFICATION_POLICY_VERSION = 'forecast-notification-policy-1.0.0' as const;
export const NOTIFICATION_PAYLOAD_SCHEMA_VERSION = 'forecast-notification-payload-1.0.0' as const;
export const NOTIFICATION_DEDUP_VERSION = 'forecast-notification-dedup-1.0.0' as const;
export const NOTIFICATION_RETRY_POLICY_VERSION = 'forecast-notification-retry-1.0.0' as const;
export const NOTIFICATION_QUIET_HOURS_POLICY_VERSION = 'forecast-notification-quiet-hours-1.0.0' as const;
export const NOTIFICATION_CURSOR_VERSION = 1 as const;

export const NOTIFICATION_DEFAULT_PROJECTION_LIMIT = 25;
export const NOTIFICATION_MIN_PROJECTION_LIMIT = 1;
export const NOTIFICATION_MAX_PROJECTION_LIMIT = 100;
export const NOTIFICATION_MAX_CURSOR_LENGTH = 4_096;
export const NOTIFICATION_PROJECTION_ORDER = 'evaluation_run_id_asc' as const;
export const NOTIFICATION_PROJECTION_MODES = ['dry_run', 'commit'] as const;

export type NotificationProjectionMode = typeof NOTIFICATION_PROJECTION_MODES[number];

export type NotificationProjectionCursorPosition = {
  createdAt: string | null;
  evaluationRunId: number;
};

export type NotificationProjectionCursorPayload = {
  v: typeof NOTIFICATION_CURSOR_VERSION;
  projector: typeof NOTIFICATION_PROJECTOR_VERSION;
  profileId: number;
  cutoff: string;
  after: NotificationProjectionCursorPosition | null;
};

export type NotificationProjectionInput = {
  profileId: number;
  cutoff: string;
  limit: number;
  mode: NotificationProjectionMode;
  cursor?: string;
};

export type NotificationContractErrorCode =
  | 'invalid_input'
  | 'invalid_profile'
  | 'invalid_cutoff'
  | 'invalid_limit'
  | 'invalid_mode'
  | 'invalid_cursor'
  | 'invalid_source'
  | 'invalid_payload';

export class NotificationContractError extends Error {
  readonly code: NotificationContractErrorCode;

  constructor(message: string, code: NotificationContractErrorCode) {
    super(message);
    this.name = 'NotificationContractError';
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function base64url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64url(value: string) {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new NotificationContractError('Malformed notification cursor encoding.', 'invalid_cursor');
  }
  const standard = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = standard + '='.repeat((4 - standard.length % 4) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (base64url(bytes) !== value) {
      throw new NotificationContractError('Non-canonical notification cursor encoding.', 'invalid_cursor');
    }
    return bytes;
  } catch (error) {
    if (error instanceof NotificationContractError) throw error;
    throw new NotificationContractError('Malformed notification cursor encoding.', 'invalid_cursor');
  }
}

async function sha256Bytes(bytes: Uint8Array) {
  const copied = new Uint8Array(bytes);
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', copied.buffer));
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function canonicalCursorJson(payload: NotificationProjectionCursorPayload) {
  return JSON.stringify({
    v: payload.v,
    projector: payload.projector,
    profileId: payload.profileId,
    cutoff: payload.cutoff,
    after: payload.after === null ? null : {
      createdAt: payload.after.createdAt,
      evaluationRunId: payload.after.evaluationRunId,
    },
  });
}

export function parseNotificationProjectionInput(
  value: unknown,
  trustedProfileId: number,
): NotificationProjectionInput {
  if (!isPositiveSafeInteger(trustedProfileId)) {
    throw new NotificationContractError('Invalid trusted notification profile.', 'invalid_profile');
  }
  const row = record(value);
  if (!row) throw new NotificationContractError('Notification projection input must be an object.', 'invalid_input');
  const allowed = new Set(['profileId', 'cutoff', 'limit', 'mode', 'cursor']);
  if (Object.keys(row).some((key) => !allowed.has(key))) {
    throw new NotificationContractError('Notification projection input contains unknown fields.', 'invalid_input');
  }
  if (!isPositiveSafeInteger(row.profileId) || row.profileId !== trustedProfileId) {
    throw new NotificationContractError('Notification profile does not match the trusted context.', 'invalid_profile');
  }
  if (!isCanonicalUtcInstant(row.cutoff)) {
    throw new NotificationContractError('Notification cutoff must be a canonical UTC instant.', 'invalid_cutoff');
  }
  const limit = Object.hasOwn(row, 'limit') ? row.limit : NOTIFICATION_DEFAULT_PROJECTION_LIMIT;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit)
    || limit < NOTIFICATION_MIN_PROJECTION_LIMIT || limit > NOTIFICATION_MAX_PROJECTION_LIMIT) {
    throw new NotificationContractError(
      `Notification limit must be an integer from ${NOTIFICATION_MIN_PROJECTION_LIMIT} through ${NOTIFICATION_MAX_PROJECTION_LIMIT}.`,
      'invalid_limit',
    );
  }
  const mode = Object.hasOwn(row, 'mode') ? row.mode : 'dry_run';
  if (!NOTIFICATION_PROJECTION_MODES.includes(mode as NotificationProjectionMode)) {
    throw new NotificationContractError('Notification mode must be dry_run or commit.', 'invalid_mode');
  }
  let cursor: string | undefined;
  if (Object.hasOwn(row, 'cursor')) {
    if (typeof row.cursor !== 'string' || !row.cursor || row.cursor.trim() !== row.cursor
      || row.cursor.length > NOTIFICATION_MAX_CURSOR_LENGTH) {
      throw new NotificationContractError('Invalid notification projection cursor.', 'invalid_cursor');
    }
    cursor = row.cursor;
  }
  return {
    profileId: row.profileId,
    cutoff: row.cutoff,
    limit,
    mode: mode as NotificationProjectionMode,
    ...(cursor ? { cursor } : {}),
  };
}

export function parseNotificationCursorPayload(value: unknown): NotificationProjectionCursorPayload {
  const row = record(value);
  if (!row || !exactKeys(row, ['v', 'projector', 'profileId', 'cutoff', 'after'])) {
    throw new NotificationContractError('Invalid notification cursor fields.', 'invalid_cursor');
  }
  if (row.v !== NOTIFICATION_CURSOR_VERSION || row.projector !== NOTIFICATION_PROJECTOR_VERSION) {
    throw new NotificationContractError('Unsupported notification cursor version.', 'invalid_cursor');
  }
  if (!isPositiveSafeInteger(row.profileId) || !isCanonicalUtcInstant(row.cutoff)) {
    throw new NotificationContractError('Invalid notification cursor context.', 'invalid_cursor');
  }
  let after: NotificationProjectionCursorPosition | null = null;
  if (row.after !== null) {
    const position = record(row.after);
    if (!position || !exactKeys(position, ['createdAt', 'evaluationRunId'])
      || (position.createdAt !== null && !isCanonicalUtcInstant(position.createdAt))
      || !isPositiveSafeInteger(position.evaluationRunId)
      || (position.createdAt !== null && position.createdAt > row.cutoff)) {
      throw new NotificationContractError('Invalid notification cursor position.', 'invalid_cursor');
    }
    after = {
      createdAt: position.createdAt as string | null,
      evaluationRunId: position.evaluationRunId,
    };
  }
  return {
    v: NOTIFICATION_CURSOR_VERSION,
    projector: NOTIFICATION_PROJECTOR_VERSION,
    profileId: row.profileId,
    cutoff: row.cutoff,
    after,
  };
}

export function createNotificationCursorPayload(
  input: Omit<NotificationProjectionCursorPayload, 'v' | 'projector'>,
) {
  return parseNotificationCursorPayload({
    v: NOTIFICATION_CURSOR_VERSION,
    projector: NOTIFICATION_PROJECTOR_VERSION,
    ...input,
  });
}

/**
 * Advances only in the authoritative evaluation-run insertion order. createdAt
 * is retained in the cursor for source audit and cutoff validation; it is not a
 * sort key. A projector encountering a valid source after its injected cutoff
 * must stop without advancing around that evaluation-run ID.
 */
export function advanceNotificationCursor(
  payload: NotificationProjectionCursorPayload,
  position: NotificationProjectionCursorPosition,
) {
  if (payload.after && position.evaluationRunId <= payload.after.evaluationRunId) {
    throw new NotificationContractError('Notification cursor cannot move backwards.', 'invalid_cursor');
  }
  return parseNotificationCursorPayload({ ...payload, after: position });
}

export async function encodeNotificationCursor(value: unknown) {
  const payload = parseNotificationCursorPayload(value);
  const bytes = new TextEncoder().encode(canonicalCursorJson(payload));
  const token = `${base64url(bytes)}.${base64url(await sha256Bytes(bytes))}`;
  if (token.length > NOTIFICATION_MAX_CURSOR_LENGTH) {
    throw new NotificationContractError('Notification cursor is too long.', 'invalid_cursor');
  }
  return token;
}

export async function decodeNotificationCursor(
  token: unknown,
  context: { profileId: number; cutoff: string },
) {
  if (typeof token !== 'string' || !token || token.trim() !== token
    || token.length > NOTIFICATION_MAX_CURSOR_LENGTH
    || !isPositiveSafeInteger(context.profileId) || !isCanonicalUtcInstant(context.cutoff)) {
    throw new NotificationContractError('Invalid notification cursor token or context.', 'invalid_cursor');
  }
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new NotificationContractError('Malformed notification cursor token.', 'invalid_cursor');
  }
  const payloadBytes = decodeBase64url(parts[0]);
  const suppliedChecksum = decodeBase64url(parts[1]);
  if (suppliedChecksum.length !== 32 || !sameBytes(suppliedChecksum, await sha256Bytes(payloadBytes))) {
    throw new NotificationContractError('Notification cursor checksum does not match.', 'invalid_cursor');
  }
  let json: string;
  let decoded: unknown;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
    decoded = JSON.parse(json) as unknown;
  } catch {
    throw new NotificationContractError('Notification cursor is not valid UTF-8 JSON.', 'invalid_cursor');
  }
  const payload = parseNotificationCursorPayload(decoded);
  if (canonicalCursorJson(payload) !== json) {
    throw new NotificationContractError('Notification cursor payload is not canonical.', 'invalid_cursor');
  }
  if (payload.profileId !== context.profileId || payload.cutoff !== context.cutoff) {
    throw new NotificationContractError('Notification cursor belongs to another projection.', 'invalid_cursor');
  }
  return payload;
}
