import { emailCapabilityLocator } from './capability.ts';

export const EMAIL_PUBLIC_FORM_MAX_BYTES = 2_048;

export interface EmailPublicActionService {
  confirmVerification(token: string): Promise<boolean>;
  unsubscribe(token: string): Promise<boolean>;
}

export type EmailPublicActionServiceSource = EmailPublicActionService
  | (() => Promise<EmailPublicActionService>);

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store, private',
  'Content-Security-Policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Content-Type': 'text/html; charset=utf-8',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
} as const;

function htmlResponse(body: string, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Northstar email preferences</title></head><body><main>${body}</main></body></html>`, {
    status,
    headers: SECURITY_HEADERS,
  });
}

function queryToken(request: Request) {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== 'token')) return '';
    const values = url.searchParams.getAll('token');
    const token = values.length === 1 ? values[0] : '';
    return emailCapabilityLocator(token) ? token : '';
  } catch {
    return '';
  }
}

async function readBoundedForm(request: Request) {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') return { error: 'unsupported' as const };
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > EMAIL_PUBLIC_FORM_MAX_BYTES)) {
    return { error: 'oversized' as const };
  }
  if (!request.body) return { form: new URLSearchParams() };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > EMAIL_PUBLIC_FORM_MAX_BYTES) {
        await reader.cancel();
        return { error: 'oversized' as const };
      }
      chunks.push(value);
    }
  } catch {
    return { error: 'malformed' as const };
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
    return { form: new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(body)) };
  } catch {
    return { error: 'malformed' as const };
  }
}

function exactForm(form: URLSearchParams, expected: Readonly<Record<string, string>>) {
  const keys = [...form.keys()];
  const expectedKeys = Object.keys(expected);
  return keys.length === expectedKeys.length
    && new Set(keys).size === expectedKeys.length
    && expectedKeys.every((key) => form.getAll(key).length === 1 && form.get(key) === expected[key]);
}

function genericVerificationResult() {
  return htmlResponse('<h1>Email verification request processed</h1><p>If the verification link was active and valid, the registered address is now verified. Verification does not enable forecast emails.</p>');
}

function genericUnsubscribeResult() {
  return htmlResponse('<h1>Forecast email preference processed</h1><p>If forecast email was enabled for this link, it has been disabled. Your journal and historical records were not changed.</p>');
}

async function resolveService(source: EmailPublicActionServiceSource) {
  return typeof source === 'function' ? source() : source;
}

/** Scanner-safe: this function performs no lookup and accepts no service dependency. */
export function verificationConfirmationGet(request: Request) {
  void request;
  return htmlResponse('<h1>Confirm your Northstar email</h1><p>Verification confirms this recipient only. It does not enable forecast emails.</p><form method="post" autocomplete="off"><input type="hidden" name="confirm" value="verify"><button type="submit">Confirm email</button></form>');
}

export async function verificationConfirmationPost(
  request: Request,
  serviceSource: EmailPublicActionServiceSource,
) {
  const parsed = await readBoundedForm(request);
  if ('error' in parsed) {
    return parsed.error === 'oversized'
      ? htmlResponse('<h1>Request could not be processed</h1>', 413)
      : parsed.error === 'unsupported'
        ? htmlResponse('<h1>Request could not be processed</h1>', 415)
        : genericVerificationResult();
  }
  const token = queryToken(request);
  if (exactForm(parsed.form, { confirm: 'verify' }) && emailCapabilityLocator(token)) {
    try {
      const service = await resolveService(serviceSource);
      await service.confirmVerification(token);
    } catch {
      // Public responses are intentionally generic and contain no diagnostics.
    }
  }
  return genericVerificationResult();
}

/** Scanner-safe: GET confirms intent but never changes consent or reads storage. */
export function unsubscribeConfirmationGet(request: Request) {
  void request;
  return htmlResponse('<h1>Unsubscribe from Northstar forecast email?</h1><p>This affects forecast email only. Your journal and historical evidence remain available.</p><form method="post" autocomplete="off"><input type="hidden" name="confirm" value="unsubscribe"><button type="submit">Unsubscribe</button></form>');
}

export async function unsubscribeConfirmationPost(
  request: Request,
  serviceSource: EmailPublicActionServiceSource,
) {
  const parsed = await readBoundedForm(request);
  if ('error' in parsed) {
    return parsed.error === 'oversized'
      ? htmlResponse('<h1>Request could not be processed</h1>', 413)
      : parsed.error === 'unsupported'
        ? htmlResponse('<h1>Request could not be processed</h1>', 415)
        : genericUnsubscribeResult();
  }
  const oneClick = exactForm(parsed.form, { 'List-Unsubscribe': 'One-Click' });
  const human = exactForm(parsed.form, { confirm: 'unsubscribe' });
  const token = oneClick || human ? queryToken(request) : '';
  if (emailCapabilityLocator(token)) {
    try {
      const service = await resolveService(serviceSource);
      await service.unsubscribe(token);
    } catch {
      // Public responses are intentionally generic and contain no diagnostics.
    }
  }
  return genericUnsubscribeResult();
}
