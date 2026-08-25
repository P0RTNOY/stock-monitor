import type { EmailEnvironment } from './types.ts';

export const EMAIL_PUBLIC_URL_MAX_LENGTH = 2_048;
export const EMAIL_CAPABILITY_TOKEN_MAX_LENGTH = 256;

export type EmailRuntimeEnvironment = EmailEnvironment | 'development' | 'test';
export type PublicAppBaseUrl = string & { readonly __publicAppBaseUrl: unique symbol };

export class EmailLinkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailLinkValidationError';
  }
}

function isLocalHostname(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function parsePublicAppBaseUrl(
  value: unknown,
  environment: EmailRuntimeEnvironment,
): PublicAppBaseUrl {
  if (typeof value !== 'string' || !value || value.length > EMAIL_PUBLIC_URL_MAX_LENGTH
    || value.trim() !== value || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new EmailLinkValidationError('Public application URL is invalid.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EmailLinkValidationError('Public application URL is malformed.');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password
    || url.search || url.hash || url.pathname !== '/') {
    throw new EmailLinkValidationError('Public application URL must be an origin without credentials or suffixes.');
  }
  const local = isLocalHostname(url.hostname);
  if (environment === 'production' || environment === 'staging' || environment === 'preview') {
    if (url.protocol !== 'https:' || url.port || local || !url.hostname.includes('.')
      || url.hostname.endsWith('.')) {
      throw new EmailLinkValidationError('Production-shaped public application URLs require an HTTPS domain origin.');
    }
  } else if (url.protocol === 'http:' && !local) {
    throw new EmailLinkValidationError('Development HTTP application URLs are restricted to loopback hosts.');
  }
  return url.origin as PublicAppBaseUrl;
}

function boundedCapabilityToken(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > EMAIL_CAPABILITY_TOKEN_MAX_LENGTH
    || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value)) {
    throw new EmailLinkValidationError('Email capability token is malformed.');
  }
  return value;
}

function fixedUrl(base: PublicAppBaseUrl, pathname: string, token?: string) {
  const url = new URL(pathname, `${base}/`);
  if (token !== undefined) url.searchParams.set('token', boundedCapabilityToken(token));
  const rendered = url.toString();
  if (rendered.length > EMAIL_PUBLIC_URL_MAX_LENGTH) {
    throw new EmailLinkValidationError('Rendered application link is too large.');
  }
  return rendered;
}

export function buildJournalUrl(base: PublicAppBaseUrl) {
  return fixedUrl(base, '/');
}

export function buildVerificationUrl(base: PublicAppBaseUrl, token: string) {
  return fixedUrl(base, '/email/verify', token);
}

export function buildUnsubscribeUrl(base: PublicAppBaseUrl, token: string) {
  return fixedUrl(base, '/email/unsubscribe', token);
}
