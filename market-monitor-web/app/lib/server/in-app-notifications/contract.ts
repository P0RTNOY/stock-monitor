import { isCanonicalUtcInstant, isPositiveSafeInteger } from '../coordinator/contract.ts';
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from '../notifications/types.ts';
import { IN_APP_STATES, type InAppState } from './types.ts';

export const IN_APP_PROJECTOR_VERSION = 'forecast-in-app-projector-1.0.0' as const;
export const IN_APP_PRESENTATION_VERSION = 'forecast-in-app-presentation-1.0.0' as const;
export const IN_APP_CURSOR_VERSION = 1 as const;
export const IN_APP_DEFAULT_LIMIT = 20;
export const IN_APP_MAX_LIMIT = 50;
export const IN_APP_MAX_PROJECTION_LIMIT = 100;
export const IN_APP_MAX_TOKEN_LENGTH = 4_096;

export type InAppFilterState = InAppState | 'all';
export type InAppFilterCategory = NotificationCategory | 'all';

export type InAppListInput = {
  state: InAppFilterState;
  category: InAppFilterCategory;
  limit: number;
  cursor?: string;
};

type CursorPayload = {
  v: typeof IN_APP_CURSOR_VERSION;
  purpose: 'notification_list';
  profileId: number;
  state: InAppFilterState;
  category: InAppFilterCategory;
  after: { occurredAt: string; id: string };
};

type HighWaterPayload = {
  v: typeof IN_APP_CURSOR_VERSION;
  purpose: 'mark_all_read';
  profileId: number;
  sequence: number;
};

export class InAppNotificationError extends Error {
  readonly code: 'validation_error' | 'not_found' | 'conflict' | 'schema_unavailable';
  readonly status: number;

  constructor(
    message: string,
    code: InAppNotificationError['code'] = 'validation_error',
    status = 400,
  ) {
    super(message);
    this.name = 'InAppNotificationError';
    this.code = code;
    this.status = status;
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
    throw new InAppNotificationError('Malformed notification token.');
  }
  try {
    const standard = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(standard + '='.repeat((4 - standard.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (base64url(bytes) !== value) throw new Error('noncanonical');
    return bytes;
  } catch {
    throw new InAppNotificationError('Malformed notification token.');
  }
}

async function digest(bytes: Uint8Array) {
  const copied = new Uint8Array(bytes);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', copied.buffer));
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function encode(payload: CursorPayload | HighWaterPayload) {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  return `${base64url(bytes)}.${base64url(await digest(bytes))}`;
}

async function decode(token: unknown) {
  if (typeof token !== 'string' || !token || token.trim() !== token
    || token.length > IN_APP_MAX_TOKEN_LENGTH) {
    throw new InAppNotificationError('Invalid notification token.');
  }
  const parts = token.split('.');
  if (parts.length !== 2) throw new InAppNotificationError('Malformed notification token.');
  const bytes = decodeBase64url(parts[0]);
  const checksum = decodeBase64url(parts[1]);
  if (checksum.length !== 32 || !sameBytes(checksum, await digest(bytes))) {
    throw new InAppNotificationError('Notification token checksum does not match.');
  }
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(json) as unknown;
    if (JSON.stringify(value) !== json) throw new Error('noncanonical');
    return value;
  } catch {
    throw new InAppNotificationError('Notification token is not canonical JSON.');
  }
}

function parseState(value: unknown): InAppFilterState {
  return value === undefined || value === 'all'
    ? 'all'
    : IN_APP_STATES.includes(value as InAppState)
      ? value as InAppState
      : (() => { throw new InAppNotificationError('state must be all, unread, or read.'); })();
}

function parseCategory(value: unknown): InAppFilterCategory {
  return value === undefined || value === 'all'
    ? 'all'
    : NOTIFICATION_CATEGORIES.includes(value as NotificationCategory)
      ? value as NotificationCategory
      : (() => { throw new InAppNotificationError('category is unsupported.'); })();
}

export function parseListQuery(url: URL): InAppListInput {
  const allowed = new Set(['state', 'category', 'limit', 'cursor']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new InAppNotificationError('Unsupported or duplicate notification query field.');
    }
  }
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? IN_APP_DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > IN_APP_MAX_LIMIT
    || (rawLimit !== null && (!/^\d+$/u.test(rawLimit) || String(limit) !== rawLimit))) {
    throw new InAppNotificationError(`limit must be an integer from 1 through ${IN_APP_MAX_LIMIT}.`);
  }
  const rawCursor = url.searchParams.get('cursor');
  const cursor = rawCursor ?? undefined;
  if (rawCursor !== null && (!rawCursor || rawCursor.trim() !== rawCursor
    || rawCursor.length > IN_APP_MAX_TOKEN_LENGTH)) {
    throw new InAppNotificationError('Invalid notification cursor.');
  }
  return {
    state: parseState(url.searchParams.get('state') ?? undefined),
    category: parseCategory(url.searchParams.get('category') ?? undefined),
    limit,
    ...(cursor ? { cursor } : {}),
  };
}

export async function encodeListCursor(input: Omit<CursorPayload, 'v' | 'purpose'>) {
  return encode({ v: IN_APP_CURSOR_VERSION, purpose: 'notification_list', ...input });
}

export async function decodeListCursor(
  token: string,
  context: { profileId: number; state: InAppFilterState; category: InAppFilterCategory },
) {
  const value = record(await decode(token));
  if (!value || !exactKeys(value, ['v', 'purpose', 'profileId', 'state', 'category', 'after'])
    || value.v !== IN_APP_CURSOR_VERSION || value.purpose !== 'notification_list'
    || value.profileId !== context.profileId || value.state !== context.state
    || value.category !== context.category) {
    throw new InAppNotificationError('Notification cursor belongs to another list.');
  }
  const after = record(value.after);
  if (!after || !exactKeys(after, ['occurredAt', 'id']) || !isCanonicalUtcInstant(after.occurredAt)
    || typeof after.id !== 'string' || !/^[a-f0-9]{64}$/u.test(after.id)) {
    throw new InAppNotificationError('Notification cursor position is invalid.');
  }
  return { occurredAt: after.occurredAt as string, id: after.id };
}

export async function encodeHighWater(profileId: number, sequence: number) {
  if (!isPositiveSafeInteger(profileId) || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new InAppNotificationError('Invalid notification high-water mark.');
  }
  return encode({ v: IN_APP_CURSOR_VERSION, purpose: 'mark_all_read', profileId, sequence });
}

export async function decodeHighWater(token: unknown, profileId: number) {
  const value = record(await decode(token));
  if (!value || !exactKeys(value, ['v', 'purpose', 'profileId', 'sequence'])
    || value.v !== IN_APP_CURSOR_VERSION || value.purpose !== 'mark_all_read'
    || value.profileId !== profileId || !Number.isSafeInteger(value.sequence)
    || (value.sequence as number) < 0) {
    throw new InAppNotificationError('Notification high-water mark is invalid.');
  }
  return value.sequence as number;
}

export function parseEmptyBody(value: unknown) {
  const body = record(value);
  if (!body || !exactKeys(body, [])) throw new InAppNotificationError('Request body must be an empty object.');
}

export function parseMarkAllBody(value: unknown) {
  const body = record(value);
  if (!body || !exactKeys(body, ['highWaterToken']) || typeof body.highWaterToken !== 'string'
    || !body.highWaterToken || body.highWaterToken.length > IN_APP_MAX_TOKEN_LENGTH) {
    throw new InAppNotificationError('Request body requires only highWaterToken.');
  }
  return body.highWaterToken;
}

export function parseEntryId(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new InAppNotificationError('Notification entry ID is invalid.');
  }
  return value;
}
