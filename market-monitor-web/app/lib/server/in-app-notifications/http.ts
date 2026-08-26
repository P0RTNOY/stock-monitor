import { getD1 } from '@/db';
import { authorizeHumanRequest } from '../auth/runtime-resolver.ts';
import { authorizationErrorResponse } from '../auth/http.ts';
import type { AuthorizationAction } from '../auth/types.ts';
import { profileIdFromScope, type AuthorizedProfileScope } from '../auth/enforcement.ts';
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

class AuthorizedInAppNotificationService {
  constructor(
    private readonly scope: AuthorizedProfileScope,
    private readonly service: InAppNotificationService,
  ) {}

  list(input: ReturnType<typeof parseListQuery>) {
    return this.service.list(profileIdFromScope(this.scope, 'in_app_notification_list'), input);
  }
  unreadCount() {
    return this.service.unreadCount(profileIdFromScope(this.scope, 'in_app_notification_list'));
  }
  detail(id: string) {
    return this.service.detail(profileIdFromScope(this.scope, 'in_app_notification_read'), id);
  }
  setState(id: string, state: 'read' | 'unread') {
    return this.service.setState(profileIdFromScope(this.scope, 'in_app_notification_state_update'), id, state);
  }
  markAllRead(token: string) {
    return this.service.markAllRead(profileIdFromScope(this.scope, 'in_app_notification_state_update'), token);
  }
}

function runtime() {
  return {
    now: () => new Date().toISOString(),
    token: () => crypto.randomUUID(),
  };
}

export async function inAppRequestContext(request: Request, action: AuthorizationAction) {
  const scope = await authorizeHumanRequest(request, action);
  return {
    scope,
    service: new AuthorizedInAppNotificationService(
      scope,
      new InAppNotificationService(new D1InAppNotificationRepository(getD1()), runtime()),
    ),
  };
}

export function inAppJson(value: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return Response.json(value, { ...init, headers });
}

export function inAppErrorResponse(error: unknown, operation: string) {
  const authorizationResponse = authorizationErrorResponse(error);
  if (authorizationResponse) return authorizationResponse;
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
  const { service } = await inAppRequestContext(request, 'in_app_notification_list');
  const input = parseListQuery(new URL(request.url));
  return inAppJson(await service.list(input));
}

export async function handleCount(request: Request) {
  const { service } = await inAppRequestContext(request, 'in_app_notification_list');
  assertNoQuery(request);
  return inAppJson(await service.unreadCount());
}

export async function handleGet(request: Request, rawId: string) {
  const { service } = await inAppRequestContext(request, 'in_app_notification_read');
  assertNoQuery(request);
  const id = parseEntryId(rawId);
  return inAppJson(await service.detail(id));
}

export async function handleState(request: Request, rawId: string, state: 'read' | 'unread') {
  const { service } = await inAppRequestContext(request, 'in_app_notification_state_update');
  assertNoQuery(request);
  const id = parseEntryId(rawId);
  parseEmptyBody(await smallJson(request));
  return inAppJson(await service.setState(id, state));
}

export async function handleMarkAll(request: Request) {
  const { service } = await inAppRequestContext(request, 'in_app_notification_state_update');
  assertNoQuery(request);
  const token = parseMarkAllBody(await smallJson(request));
  return inAppJson(await service.markAllRead(token));
}
