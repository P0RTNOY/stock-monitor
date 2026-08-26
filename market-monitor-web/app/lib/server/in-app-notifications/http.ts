import { getD1 } from '@/db';
import { resolveCurrentProfile } from '../profile.ts';
import {
  InAppNotificationError,
  parseEmptyBody,
  parseEntryId,
  parseListQuery,
  parseMarkAllBody,
} from './contract.ts';
import { D1InAppNotificationRepository } from './repository.ts';
import { InAppNotificationService } from './service.ts';

const MAX_MUTATION_BYTES = 1_024;

function runtime() {
  return {
    now: () => new Date().toISOString(),
    token: () => crypto.randomUUID(),
  };
}

export async function inAppRequestContext(request: Request) {
  const { profileId } = await resolveCurrentProfile(request);
  return {
    profileId,
    service: new InAppNotificationService(new D1InAppNotificationRepository(getD1()), runtime()),
  };
}

export function inAppJson(value: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return Response.json(value, { ...init, headers });
}

export function inAppErrorResponse(error: unknown, operation: string) {
  if (error instanceof InAppNotificationError) {
    return inAppJson({ error: error.message, code: error.code }, { status: error.status });
  }
  console.error(`In-app notification ${operation} failed.`, {
    category: error instanceof Error ? error.name : 'UnknownError',
  });
  return inAppJson({
    error: 'In-app notifications are temporarily unavailable.',
    code: 'service_unavailable',
  }, { status: 503 });
}

export function assertNoQuery(request: Request) {
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    throw new InAppNotificationError('This notification endpoint does not accept query fields.');
  }
}

export async function smallJson(request: Request) {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    throw new InAppNotificationError('Notification mutations must use JSON.');
  }
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_MUTATION_BYTES) throw new InAppNotificationError('Request body is too large.');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_MUTATION_BYTES) {
    throw new InAppNotificationError('Request body is too large.');
  }
  try { return JSON.parse(text) as unknown; }
  catch { throw new InAppNotificationError('Request body must be valid JSON.'); }
}

export async function handleList(request: Request) {
  const input = parseListQuery(new URL(request.url));
  const { profileId, service } = await inAppRequestContext(request);
  return inAppJson(await service.list(profileId, input));
}

export async function handleCount(request: Request) {
  assertNoQuery(request);
  const { profileId, service } = await inAppRequestContext(request);
  return inAppJson(await service.unreadCount(profileId));
}

export async function handleGet(request: Request, rawId: string) {
  assertNoQuery(request);
  const id = parseEntryId(rawId);
  const { profileId, service } = await inAppRequestContext(request);
  return inAppJson(await service.detail(profileId, id));
}

export async function handleState(request: Request, rawId: string, state: 'read' | 'unread') {
  assertNoQuery(request);
  const id = parseEntryId(rawId);
  parseEmptyBody(await smallJson(request));
  const { profileId, service } = await inAppRequestContext(request);
  return inAppJson(await service.setState(profileId, id, state));
}

export async function handleMarkAll(request: Request) {
  assertNoQuery(request);
  const token = parseMarkAllBody(await smallJson(request));
  const { profileId, service } = await inAppRequestContext(request);
  return inAppJson(await service.markAllRead(profileId, token));
}
