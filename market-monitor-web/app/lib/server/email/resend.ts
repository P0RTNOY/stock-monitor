import { validEmailMailbox, validEmailSender } from './config.ts';
import {
  EMAIL_ENVIRONMENTS,
  RESEND_ADAPTER_VERSION as FROZEN_RESEND_ADAPTER_VERSION,
  type EmailEnvironment,
} from './types.ts';

export const RESEND_EMAIL_API_URL = 'https://api.resend.com/emails';
export const RESEND_ADAPTER_KIND = 'resend-email';
export const RESEND_ADAPTER_VERSION = FROZEN_RESEND_ADAPTER_VERSION;
export const RESEND_IDEMPOTENCY_VERSION = 'northstar-email-v1';

const MAX_SUBJECT_LENGTH = 200;
const MAX_TEXT_LENGTH = 20_000;
const MAX_HTML_LENGTH = 50_000;
const MAX_REQUEST_BYTES = 100_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

export type ResendEmailRequest = {
  from: string;
  to: readonly [string];
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  headers?: Readonly<{
    'List-Unsubscribe': string;
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click';
  }>;
};

export type ResendProviderIdentity = {
  idempotencyKey: string;
  canonicalRequestHash: string;
};

export type ResendSendInput = ResendProviderIdentity & {
  request: ResendEmailRequest;
};

export type ResendSendResult =
  | { disposition: 'accepted'; providerEmailId: string }
  | {
    disposition: 'retryable';
    classification: 'provider_rate_limited' | 'concurrent_idempotent_request';
    retryAfterSeconds: number | null;
  }
  | {
    disposition: 'terminal';
    classification: 'provider_rejected' | 'provider_quota_exceeded'
      | 'idempotency_integrity_failure' | 'invalid_request';
  }
  | {
    disposition: 'ambiguous';
    classification: 'provider_timeout' | 'provider_network_error'
      | 'provider_unavailable' | 'provider_response_invalid' | 'provider_response_too_large';
  };

export type ResendEmailAdapterOptions = {
  apiKey: string;
  timeoutMs: number;
  responseMaxBytes: number;
  userAgent?: string;
  fetch?: typeof fetch;
};

type CanonicalProviderRequest = {
  from: string;
  to: [string];
  subject: string;
  text: string;
  html: string;
  reply_to?: string;
  headers?: {
    'List-Unsubscribe': string;
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click';
  };
};

class RequestValidationError extends Error {}
class ResponseTooLargeError extends Error {}
class ResponseInvalidError extends Error {}
class ProviderTimeoutError extends Error {}

function boundedSingleLine(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && value === value.trim()
    && !/[\u0000-\u001f\u007f\r\n]/u.test(value);
}

function validUnsubscribeHeader(value: string): boolean {
  if (!boundedSingleLine(value, 2_050) || !value.startsWith('<') || !value.endsWith('>')) {
    return false;
  }
  try {
    const url = new URL(value.slice(1, -1));
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function canonicalProviderRequest(request: ResendEmailRequest): CanonicalProviderRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || !validEmailSender(request.from)
    || !Array.isArray(request.to) || request.to.length !== 1
    || !validEmailMailbox(request.to[0])
    || !boundedSingleLine(request.subject, MAX_SUBJECT_LENGTH)
    || typeof request.text !== 'string' || request.text.length === 0
    || request.text.length > MAX_TEXT_LENGTH || /\u0000/u.test(request.text)
    || typeof request.html !== 'string' || request.html.length === 0
    || request.html.length > MAX_HTML_LENGTH || /\u0000/u.test(request.html)
    || (request.replyTo !== undefined && !validEmailMailbox(request.replyTo))) {
    throw new RequestValidationError();
  }
  const keys = Object.keys(request);
  if (keys.some((key) => !['from', 'to', 'subject', 'text', 'html', 'replyTo', 'headers'].includes(key))) {
    throw new RequestValidationError();
  }
  let headers: CanonicalProviderRequest['headers'];
  if (request.headers !== undefined) {
    if (!request.headers || typeof request.headers !== 'object'
      || Array.isArray(request.headers)
      || Object.keys(request.headers).length !== 2
      || !validUnsubscribeHeader(request.headers['List-Unsubscribe'])
      || request.headers['List-Unsubscribe-Post'] !== 'List-Unsubscribe=One-Click') {
      throw new RequestValidationError();
    }
    headers = {
      'List-Unsubscribe': request.headers['List-Unsubscribe'],
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
  }
  return {
    from: request.from,
    to: [request.to[0]],
    subject: request.subject,
    text: request.text,
    html: request.html,
    ...(request.replyTo === undefined ? {} : { reply_to: request.replyTo }),
    ...(headers === undefined ? {} : { headers }),
  };
}

function encodeHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<string> {
  return encodeHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export function canonicalResendRequestJson(request: ResendEmailRequest): string {
  const json = JSON.stringify(canonicalProviderRequest(request));
  if (new TextEncoder().encode(json).byteLength > MAX_REQUEST_BYTES) {
    throw new RequestValidationError();
  }
  return json;
}

export async function createResendProviderIdentity(input: {
  deliveryId: string;
  templateVersion: string;
  environment: EmailEnvironment;
  request: ResendEmailRequest;
}): Promise<ResendProviderIdentity> {
  if (!boundedSingleLine(input.deliveryId, 200)
    || !/^[A-Za-z0-9._:-]+$/u.test(input.deliveryId)
    || !boundedSingleLine(input.templateVersion, 100)
    || !EMAIL_ENVIRONMENTS.includes(input.environment)
    || !/^[A-Za-z0-9._-]+$/u.test(input.templateVersion)) throw new RequestValidationError();
  const canonicalRequest = canonicalResendRequestJson(input.request);
  const identityDigest = await sha256(JSON.stringify([
    RESEND_IDEMPOTENCY_VERSION,
    input.environment,
    input.deliveryId,
    input.templateVersion,
  ]));
  const idempotencyKey = `${RESEND_IDEMPOTENCY_VERSION}-${identityDigest}`;
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) throw new RequestValidationError();
  return {
    idempotencyKey,
    canonicalRequestHash: await sha256(canonicalRequest),
  };
}

function validApiKey(value: string): boolean {
  return value.length >= 7 && value.length <= 512 && value.startsWith('re_')
    && /^[A-Za-z0-9_-]+$/u.test(value.slice(3));
}

function validIdempotencyKey(value: string): boolean {
  return value.length <= MAX_IDEMPOTENCY_KEY_LENGTH
    && new RegExp(`^${RESEND_IDEMPOTENCY_VERSION}-[a-f0-9]{64}$`, 'u').test(value);
}

function validHash(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

async function readBoundedBody(response: Response, maximum: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximum)) {
    throw new ResponseTooLargeError();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new ResponseTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new ResponseInvalidError();
  }
}

function parseProviderShape(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function retryAfter(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (!value || !/^(0|[1-9][0-9]*)$/u.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 86_400 ? seconds : null;
}

async function withTimeout<T>(
  action: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new ProviderTimeoutError());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export class ResendEmailAdapter {
  readonly kind = RESEND_ADAPTER_KIND;
  readonly version = RESEND_ADAPTER_VERSION;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly responseMaxBytes: number;
  private readonly userAgent: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: ResendEmailAdapterOptions) {
    if (!validApiKey(options.apiKey)
      || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000
      || options.timeoutMs > 30_000
      || !Number.isSafeInteger(options.responseMaxBytes) || options.responseMaxBytes < 1_024
      || options.responseMaxBytes > 65_536
      || (options.userAgent !== undefined && !boundedSingleLine(options.userAgent, 200))) {
      throw new RequestValidationError();
    }
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.responseMaxBytes = options.responseMaxBytes;
    this.userAgent = options.userAgent ?? 'northstar-forecast-journal/1.0';
    this.fetchImplementation = options.fetch ?? fetch;
  }

  async send(input: ResendSendInput): Promise<ResendSendResult> {
    let body: string;
    try {
      if (!validIdempotencyKey(input.idempotencyKey) || !validHash(input.canonicalRequestHash)) {
        return { disposition: 'terminal', classification: 'invalid_request' };
      }
      body = canonicalResendRequestJson(input.request);
      if (await sha256(body) !== input.canonicalRequestHash) {
        return { disposition: 'terminal', classification: 'idempotency_integrity_failure' };
      }
    } catch {
      return { disposition: 'terminal', classification: 'invalid_request' };
    }

    let response: Response;
    let responseBody: string;
    try {
      ({ response, responseBody } = await withTimeout(async (signal) => {
        const providerResponse = await this.fetchImplementation(RESEND_EMAIL_API_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'User-Agent': this.userAgent,
            'Idempotency-Key': input.idempotencyKey,
          },
          body,
          signal,
        });
        return {
          response: providerResponse,
          responseBody: await readBoundedBody(providerResponse, this.responseMaxBytes),
        };
      }, this.timeoutMs));
    } catch (error) {
      if (error instanceof ProviderTimeoutError) {
        return { disposition: 'ambiguous', classification: 'provider_timeout' };
      }
      if (error instanceof ResponseTooLargeError) {
        return { disposition: 'ambiguous', classification: 'provider_response_too_large' };
      }
      if (error instanceof ResponseInvalidError) {
        return { disposition: 'ambiguous', classification: 'provider_response_invalid' };
      }
      return { disposition: 'ambiguous', classification: 'provider_network_error' };
    }

    const parsed = parseProviderShape(responseBody);
    if (response.status === 200) {
      if (!parsed || Object.keys(parsed).length !== 1 || typeof parsed.id !== 'string'
        || parsed.id.length < 1 || parsed.id.length > 128
        || !/^[A-Za-z0-9_-]+$/u.test(parsed.id)) {
        return { disposition: 'ambiguous', classification: 'provider_response_invalid' };
      }
      return { disposition: 'accepted', providerEmailId: parsed.id };
    }
    const errorName = parsed && typeof parsed.name === 'string' && parsed.name.length <= 100
      ? parsed.name
      : null;
    if (response.status === 409 && errorName === 'invalid_idempotent_request') {
      return { disposition: 'terminal', classification: 'idempotency_integrity_failure' };
    }
    if (response.status === 409 && errorName === 'concurrent_idempotent_requests') {
      return {
        disposition: 'retryable',
        classification: 'concurrent_idempotent_request',
        retryAfterSeconds: retryAfter(response),
      };
    }
    if (response.status === 429
      && (errorName === 'daily_quota_exceeded' || errorName === 'monthly_quota_exceeded')) {
      return { disposition: 'terminal', classification: 'provider_quota_exceeded' };
    }
    if (response.status === 429) {
      return {
        disposition: 'retryable',
        classification: 'provider_rate_limited',
        retryAfterSeconds: retryAfter(response),
      };
    }
    if (response.status >= 500) {
      return { disposition: 'ambiguous', classification: 'provider_unavailable' };
    }
    if (response.status >= 400 && response.status < 500) {
      return { disposition: 'terminal', classification: 'provider_rejected' };
    }
    return { disposition: 'ambiguous', classification: 'provider_response_invalid' };
  }
}
