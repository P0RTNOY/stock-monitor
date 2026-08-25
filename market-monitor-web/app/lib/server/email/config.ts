import { EMAIL_ENVIRONMENTS, type EmailEnvironment } from './types.ts';
import { parsePublicAppBaseUrl } from './links.ts';

export { EMAIL_ENVIRONMENTS } from './types.ts';
export type { EmailEnvironment } from './types.ts';

export const DEFAULT_RESEND_TIMEOUT_MS = 10_000;
export const DEFAULT_RESEND_RESPONSE_MAX_BYTES = 16_384;
export const DEFAULT_EMAIL_DISPATCH_LIMIT = 10;
export const DEFAULT_RESEND_WEBHOOK_MAX_BYTES = 65_536;

export type EmailConfiguration = {
  environment: EmailEnvironment;
  dispatchEnabled: boolean;
  resendApiKey: string | null;
  resendWebhookSecret: string | null;
  capabilitySecret: string | null;
  from: string | null;
  replyTo: string | null;
  publicAppUrl: string | null;
  providerTimeoutMs: number;
  providerResponseMaxBytes: number;
  dispatcherLimit: number;
  webhookMaxBytes: number;
};

export type LiveEmailConfiguration = EmailConfiguration & {
  dispatchEnabled: true;
  resendApiKey: string;
  from: string;
  publicAppUrl: string;
  capabilitySecret: string;
};

export type EmailEnvironmentBindings = Readonly<{
  FORECAST_EMAIL_ENVIRONMENT?: string;
  FORECAST_EMAIL_DISPATCH_ENABLED?: string;
  RESEND_API_KEY?: string;
  RESEND_WEBHOOK_SECRET?: string;
  FORECAST_EMAIL_CAPABILITY_SECRET?: string;
  FORECAST_EMAIL_FROM?: string;
  FORECAST_EMAIL_REPLY_TO?: string;
  PUBLIC_APP_URL?: string;
  FORECAST_EMAIL_PROVIDER_TIMEOUT_MS?: string;
  FORECAST_EMAIL_RESPONSE_MAX_BYTES?: string;
  FORECAST_EMAIL_DISPATCH_LIMIT?: string;
  FORECAST_EMAIL_WEBHOOK_MAX_BYTES?: string;
}>;

export class EmailConfigurationError extends Error {
  readonly code: 'invalid_configuration' | 'dispatch_disabled';
  readonly field: string;

  constructor(
    code: EmailConfigurationError['code'],
    field: string,
    message = 'Email configuration is invalid.',
  ) {
    super(message);
    this.name = 'EmailConfigurationError';
    this.code = code;
    this.field = field;
  }
}

type EmailConfigurationInput = {
  environment?: unknown;
  dispatchEnabled?: unknown;
  resendApiKey?: unknown;
  resendWebhookSecret?: unknown;
  capabilitySecret?: unknown;
  from?: unknown;
  replyTo?: unknown;
  publicAppUrl?: unknown;
  providerTimeoutMs?: unknown;
  providerResponseMaxBytes?: unknown;
  dispatcherLimit?: unknown;
  webhookMaxBytes?: unknown;
};

const INPUT_KEYS = new Set<keyof EmailConfigurationInput>([
  'environment',
  'dispatchEnabled',
  'resendApiKey',
  'resendWebhookSecret',
  'capabilitySecret',
  'from',
  'replyTo',
  'publicAppUrl',
  'providerTimeoutMs',
  'providerResponseMaxBytes',
  'dispatcherLimit',
  'webhookMaxBytes',
]);

const MAILBOX_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u;

function invalid(field: string): never {
  throw new EmailConfigurationError('invalid_configuration', field);
}

function optionalSecret(
  value: unknown,
  field: string,
  prefix: 're_' | 'whsec_',
): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value !== value.trim()
    || value.length < prefix.length + 4 || value.length > 512
    || !value.startsWith(prefix)
    || !(prefix === 're_'
      ? /^[A-Za-z0-9_-]+$/u
      : /^[A-Za-z0-9_+/=-]+$/u).test(value.slice(prefix.length))) invalid(field);
  return value;
}

function optionalCapabilitySecret(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value !== value.trim()
    || value.length < 43 || value.length > 1_366
    || !/^[A-Za-z0-9_-]+$/u.test(value)) invalid('capabilitySecret');
  try {
    const standard = value.replaceAll('-', '+').replaceAll('_', '/');
    const decoded = atob(standard + '='.repeat((4 - standard.length % 4) % 4));
    if (decoded.length < 32 || decoded.length > 1_024) invalid('capabilitySecret');
  } catch {
    invalid('capabilitySecret');
  }
  return value;
}

export function decodeEmailCapabilitySecret(value: string): Uint8Array {
  const normalized = optionalCapabilitySecret(value);
  if (!normalized) invalid('capabilitySecret');
  const standard = normalized.replaceAll('-', '+').replaceAll('_', '/');
  const decoded = atob(standard + '='.repeat((4 - standard.length % 4) % 4));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export function validEmailMailbox(value: string): boolean {
  return value.length >= 3 && value.length <= 254
    && value === value.trim()
    && !/[\u0000-\u001f\u007f\r\n]/u.test(value)
    && MAILBOX_PATTERN.test(value)
    && !value.includes('..');
}

export function validEmailSender(value: string): boolean {
  if (value.length < 3 || value.length > 320 || value !== value.trim()
    || /[\u0000-\u001f\u007f\r\n]/u.test(value)) return false;
  if (validEmailMailbox(value)) return true;
  const match = /^([^<>]{1,64}) <([^<>]+)>$/u.exec(value);
  return Boolean(match && match[1] === match[1].trim() && validEmailMailbox(match[2]));
}

function optionalString(
  value: unknown,
  field: string,
  validator: (candidate: string) => boolean,
): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !validator(value)) invalid(field);
  return value;
}

function parseBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return invalid(field);
}

function parseInteger(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const candidate = typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < minimum
    || (candidate as number) > maximum) invalid(field);
  return candidate as number;
}

function parsePublicAppUrl(value: unknown, environment: EmailEnvironment): string | null {
  if (value === undefined || value === null || value === '') return null;
  try {
    return parsePublicAppBaseUrl(value, environment);
  } catch {
    return invalid('publicAppUrl');
  }
}

export function parseEmailConfiguration(value: unknown): EmailConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('configuration');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !INPUT_KEYS.has(key as keyof EmailConfigurationInput))) {
    invalid('configuration');
  }
  const raw = row as EmailConfigurationInput;
  const environment = raw.environment ?? 'local';
  if (typeof environment !== 'string'
    || !EMAIL_ENVIRONMENTS.includes(environment as EmailEnvironment)) invalid('environment');
  const parsedEnvironment = environment as EmailEnvironment;
  return {
    environment: parsedEnvironment,
    dispatchEnabled: parseBoolean(raw.dispatchEnabled, 'dispatchEnabled', false),
    resendApiKey: optionalSecret(raw.resendApiKey, 'resendApiKey', 're_'),
    resendWebhookSecret: optionalSecret(raw.resendWebhookSecret, 'resendWebhookSecret', 'whsec_'),
    capabilitySecret: optionalCapabilitySecret(raw.capabilitySecret),
    from: optionalString(raw.from, 'from', validEmailSender),
    replyTo: optionalString(raw.replyTo, 'replyTo', validEmailMailbox),
    publicAppUrl: parsePublicAppUrl(raw.publicAppUrl, parsedEnvironment),
    providerTimeoutMs: parseInteger(
      raw.providerTimeoutMs, 'providerTimeoutMs', DEFAULT_RESEND_TIMEOUT_MS, 1_000, 30_000,
    ),
    providerResponseMaxBytes: parseInteger(
      raw.providerResponseMaxBytes,
      'providerResponseMaxBytes',
      DEFAULT_RESEND_RESPONSE_MAX_BYTES,
      1_024,
      65_536,
    ),
    dispatcherLimit: parseInteger(
      raw.dispatcherLimit, 'dispatcherLimit', DEFAULT_EMAIL_DISPATCH_LIMIT, 1, 50,
    ),
    webhookMaxBytes: parseInteger(
      raw.webhookMaxBytes,
      'webhookMaxBytes',
      DEFAULT_RESEND_WEBHOOK_MAX_BYTES,
      1_024,
      262_144,
    ),
  };
}

export function emailConfigurationFromEnv(
  env: EmailEnvironmentBindings,
): EmailConfiguration {
  return parseEmailConfiguration({
    environment: env.FORECAST_EMAIL_ENVIRONMENT,
    dispatchEnabled: env.FORECAST_EMAIL_DISPATCH_ENABLED,
    resendApiKey: env.RESEND_API_KEY,
    resendWebhookSecret: env.RESEND_WEBHOOK_SECRET,
    capabilitySecret: env.FORECAST_EMAIL_CAPABILITY_SECRET,
    from: env.FORECAST_EMAIL_FROM,
    replyTo: env.FORECAST_EMAIL_REPLY_TO,
    publicAppUrl: env.PUBLIC_APP_URL,
    providerTimeoutMs: env.FORECAST_EMAIL_PROVIDER_TIMEOUT_MS,
    providerResponseMaxBytes: env.FORECAST_EMAIL_RESPONSE_MAX_BYTES,
    dispatcherLimit: env.FORECAST_EMAIL_DISPATCH_LIMIT,
    webhookMaxBytes: env.FORECAST_EMAIL_WEBHOOK_MAX_BYTES,
  });
}

export function requireLiveEmailConfiguration(
  configuration: EmailConfiguration,
): LiveEmailConfiguration {
  if (!configuration.dispatchEnabled) {
    throw new EmailConfigurationError('dispatch_disabled', 'dispatchEnabled');
  }
  if (!configuration.resendApiKey) invalid('resendApiKey');
  if (!configuration.from) invalid('from');
  if (!configuration.publicAppUrl) invalid('publicAppUrl');
  if (!configuration.capabilitySecret) invalid('capabilitySecret');
  return configuration as LiveEmailConfiguration;
}
