import {
  ResendWebhookVerificationError,
  verifyResendWebhookRequest,
  type ResendWebhookHeaders,
} from './webhook-verifier.ts';
import { ResendWebhookContractError } from './webhook-contract.ts';
import type { ResendWebhookService } from './webhook-service.ts';

const WEBHOOK_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'text/plain; charset=utf-8',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

export class WebhookBodyReadError extends Error {
  readonly code: 'body_too_large' | 'invalid_body';

  constructor(code: WebhookBodyReadError['code']) {
    super('Invalid webhook request body.');
    this.name = 'WebhookBodyReadError';
    this.code = code;
  }
}

function response(status: number, body: string | null): Response {
  return new Response(body, { status, headers: WEBHOOK_HEADERS });
}

function contentTypeIsJson(value: string | null): boolean {
  if (!value) return false;
  return value.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

function declaredLength(request: Request, maximum: number): number | null {
  const value = request.headers.get('content-length');
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/u.test(value) || value.length > 12) {
    throw new WebhookBodyReadError('invalid_body');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new WebhookBodyReadError('invalid_body');
  if (parsed > maximum) throw new WebhookBodyReadError('body_too_large');
  return parsed;
}

/** Reads and preserves the signed UTF-8 body while stopping at the byte cap. */
export async function readBoundedRawWebhookBody(request: Request, maximum: number): Promise<string> {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 262_144) {
    throw new WebhookBodyReadError('invalid_body');
  }
  declaredLength(request, maximum);
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new WebhookBodyReadError('body_too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WebhookBodyReadError) throw error;
    throw new WebhookBodyReadError('invalid_body');
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new WebhookBodyReadError('invalid_body');
  }
}

function headers(request: Request): ResendWebhookHeaders {
  return {
    'svix-id': request.headers.get('svix-id'),
    'svix-timestamp': request.headers.get('svix-timestamp'),
    'svix-signature': request.headers.get('svix-signature'),
  };
}

export type ResendWebhookHandlerDependencies = {
  webhookSecret: string | null;
  maxBodyBytes: number;
  service(): Promise<Pick<ResendWebhookService, 'process'>>;
  now(): string;
  nowEpochSeconds(): number;
};

export function createResendWebhookHandler(dependencies: ResendWebhookHandlerDependencies) {
  return async function handleResendWebhook(request: Request): Promise<Response> {
    if (!dependencies.webhookSecret) return response(503, 'Webhook unavailable.');
    if (!contentTypeIsJson(request.headers.get('content-type'))) {
      return response(415, 'Invalid webhook request.');
    }
    let rawBody: string;
    try {
      rawBody = await readBoundedRawWebhookBody(request, dependencies.maxBodyBytes);
    } catch (error) {
      return error instanceof WebhookBodyReadError && error.code === 'body_too_large'
        ? response(413, 'Invalid webhook request.')
        : response(400, 'Invalid webhook request.');
    }
    try {
      const verified = verifyResendWebhookRequest({
        rawBody,
        headers: headers(request),
        webhookSecret: dependencies.webhookSecret,
        maxBodyBytes: dependencies.maxBodyBytes,
        nowEpochSeconds: dependencies.nowEpochSeconds(),
      });
      const service = await dependencies.service();
      await service.process({
        webhookId: verified.webhookId,
        verifiedPayload: verified.payload,
        rawBody,
        receivedAt: dependencies.now(),
      });
      return response(200, null);
    } catch (error) {
      if (error instanceof ResendWebhookVerificationError
        || error instanceof ResendWebhookContractError) {
        return response(400, 'Invalid webhook request.');
      }
      return response(503, 'Webhook unavailable.');
    }
  };
}
