import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { forecastInitializationStatements } from '../db/forecast-initialization.ts';
import { isCanonicalUtcInstant } from '../app/lib/server/coordinator/contract.ts';
import {
  EmailAddressValidationError,
  normalizeEmailAddress,
} from '../app/lib/server/email/address.ts';
import {
  DEFAULT_EMAIL_DISPATCH_LIMIT,
  decodeEmailCapabilitySecret,
  emailConfigurationFromEnv,
  requireLiveEmailConfiguration,
  type EmailConfiguration,
} from '../app/lib/server/email/config.ts';
import {
  ForecastEmailDispatcherService,
  type EmailProviderAdapter,
  type ForecastEmailDispatchReport,
} from '../app/lib/server/email/dispatcher.ts';
import {
  EmailRecipientService,
  type EmailRecipientState,
} from '../app/lib/server/email/recipient-service.ts';
import {
  D1EmailRepository,
  D1VerificationEmailRepository,
} from '../app/lib/server/email/repository.ts';
import {
  RESEND_ADAPTER_KIND,
  RESEND_ADAPTER_VERSION,
  ResendEmailAdapter,
} from '../app/lib/server/email/resend.ts';
import { VerificationEmailDeliveryService } from '../app/lib/server/email/verification-delivery.ts';
import {
  EMAIL_DELIVERY_STATES,
  FORECAST_EMAIL_DISPATCHER_VERSION,
  type EmailConsentSnapshot,
  type EmailDeliveryState,
  type EmailPreSendDecision,
  type EmailRecipient,
  type EmailReconciliationState,
} from '../app/lib/server/email/types.ts';
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from '../app/lib/server/notifications/types.ts';
import { trustedOperatorScope } from '../app/lib/server/auth/system.ts';
import {
  AuthorizedEmailConsentService,
  AuthorizedEmailDispatcherService,
  AuthorizedEmailRecipientService,
  AuthorizedVerificationDeliveryService,
} from '../app/lib/server/auth/system-services.ts';
import {
  exactActionScope,
  profileIdFromScope,
  type AuthorizedProfileScope,
} from '../app/lib/server/auth/enforcement.ts';
import type { AuthorizationAction } from '../app/lib/server/auth/types.ts';

const CONFIG_PATH = fileURLToPath(new URL('./wrangler.operator.jsonc', import.meta.url));
const DEFAULT_PERSIST_PATH = '.wrangler/state/v3';
const DEFAULT_STATUS_LIMIT = 20;
const MAX_OPERATOR_LIMIT = 50;

export const RECIPIENT_USAGE = `Usage:
  npm run --silent forecast:email:recipient -- --status [--json]
  npm run --silent forecast:email:recipient -- --set <email> [--json]
  npm run --silent forecast:email:recipient -- --revoke [--json]
  npm run --silent forecast:email:recipient -- --request-verification [--json]

Exactly one action is required. Registration, replacement, revocation, and verification
requests are local operator mutations. Requesting verification prepares durable state but
does not call Resend. The fixed profile is resolved internally. Output never includes the
raw recipient address or a verification token.`;

export const CONSENT_USAGE = `Usage:
  npm run --silent forecast:email:consent -- --status [--json]
  npm run --silent forecast:email:consent -- --enable --categories <list> [--json]
  npm run --silent forecast:email:consent -- --disable [--json]

Categories are a comma-separated complete allowlist drawn from:
  ${NOTIFICATION_CATEGORIES.join(',')}

Exactly one action is required. Missing consent is disabled. Verification never grants
consent, and enabling consent never verifies a recipient. The fixed profile is resolved
internally.`;

export const VERIFICATION_SEND_USAGE = `Usage:
  npm run --silent forecast:email:verification:send -- --cutoff <UTC> [--dry-run] [--json]
  npm run --silent forecast:email:verification:send -- --cutoff <UTC> --send-live [--json]

Required:
  --cutoff <UTC>  Canonical UTC instant with milliseconds and Z

Dry-run is the default and performs no provider call. A real verification-email request
requires both --send-live and FORECAST_EMAIL_DISPATCH_ENABLED=true. Provider credentials
are accepted only through server-side environment configuration.`;

export const DISPATCH_USAGE = `Usage:
  npm run --silent forecast:email:dispatch -- --cutoff <UTC> [options]

Required:
  --cutoff <UTC>  Canonical UTC instant with milliseconds and Z

Options:
  --limit <1-${MAX_OPERATOR_LIMIT}>  Maximum outbox items (configured default; ${DEFAULT_EMAIL_DISPATCH_LIMIT} when unset)
  --dry-run       Preview only; this is the default
  --send-live     Permit real provider calls after every server-side gate passes
  --json          Print stable machine-readable JSON
  --help          Show this help without opening D1

Dry-run never claims an item or calls Resend. Live dispatch also requires
FORECAST_EMAIL_DISPATCH_ENABLED=true and valid server-side configuration. The fixed
profile is resolved internally.`;

export const EMAIL_STATUS_USAGE = `Usage:
  npm run --silent forecast:email:status -- [options]

Options:
  --limit <1-${MAX_OPERATOR_LIMIT}>  Recent deliveries to display (default: ${DEFAULT_STATUS_LIMIT})
  --category <category>  Filter by: ${NOTIFICATION_CATEGORIES.join(', ')}
  --delivery-state <state>  Filter by: ${EMAIL_DELIVERY_STATES.join(', ')}
  --json          Print stable machine-readable JSON
  --help          Show this help without opening D1

Status is local and read-only. It never initializes schema, claims work, or calls Resend.
Raw addresses, tokens, message bodies, claim tokens, provider responses, and secrets are
excluded from both human and JSON output.`;

export class ForecastEmailOperatorUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForecastEmailOperatorUsageError';
  }
}

type ParsedFlags = Map<string, string | true>;

function parseFlags(
  argv: string[],
  valueFlags: ReadonlySet<string>,
  booleanFlags: ReadonlySet<string>,
) {
  const parsed: ParsedFlags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!valueFlags.has(flag) && !booleanFlags.has(flag)) {
      throw new ForecastEmailOperatorUsageError(`Unknown argument: ${flag}`);
    }
    if (parsed.has(flag)) throw new ForecastEmailOperatorUsageError(`Duplicate argument: ${flag}`);
    if (booleanFlags.has(flag)) {
      parsed.set(flag, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ForecastEmailOperatorUsageError(`${flag} requires a value.`);
    }
    parsed.set(flag, value);
    index += 1;
  }
  return parsed;
}

function helpOnly(values: ParsedFlags) {
  if (!values.has('--help')) return false;
  if (values.size !== 1) {
    throw new ForecastEmailOperatorUsageError('--help cannot be combined with other arguments.');
  }
  return true;
}

function exactlyOneAction(values: ParsedFlags, actions: readonly string[]) {
  const selected = actions.filter((action) => values.has(action));
  if (selected.length !== 1) {
    throw new ForecastEmailOperatorUsageError(`Exactly one action is required: ${actions.join(', ')}.`);
  }
  return selected[0];
}

function wholeNumber(
  value: string | true | undefined,
  flag: string,
  fallback: number,
  maximum = MAX_OPERATOR_LIMIT,
) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new ForecastEmailOperatorUsageError(`${flag} must be a whole number.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ForecastEmailOperatorUsageError(`${flag} must be from 1 through ${maximum}.`);
  }
  return parsed;
}

function canonicalCutoff(value: string | true | undefined) {
  if (typeof value !== 'string' || !isCanonicalUtcInstant(value)) {
    throw new ForecastEmailOperatorUsageError(
      '--cutoff must be a canonical UTC instant with millisecond precision.',
    );
  }
  return value;
}

export type RecipientOperatorOptions = {
  help: boolean;
  json: boolean;
  action?: 'status' | 'set' | 'revoke' | 'request_verification';
  email?: string;
};

export function parseRecipientArgs(argv: string[]): RecipientOperatorOptions {
  const values = parseFlags(
    argv,
    new Set(['--set']),
    new Set(['--status', '--revoke', '--request-verification', '--json', '--help']),
  );
  if (helpOnly(values)) return { help: true, json: false };
  const action = exactlyOneAction(values, ['--status', '--set', '--revoke', '--request-verification']);
  const emailValue = values.get('--set');
  let email: string | undefined;
  try {
    email = typeof emailValue === 'string' ? normalizeEmailAddress(emailValue) : undefined;
  } catch (error) {
    if (error instanceof EmailAddressValidationError) {
      throw new ForecastEmailOperatorUsageError('--set requires a supported email address.');
    }
    throw error;
  }
  return {
    help: false,
    json: values.has('--json'),
    action: action === '--request-verification'
      ? 'request_verification'
      : action.slice(2) as 'status' | 'set' | 'revoke',
    ...(email ? { email } : {}),
  };
}

export type ConsentOperatorOptions = {
  help: boolean;
  json: boolean;
  action?: 'status' | 'enable' | 'disable';
  categories?: NotificationCategory[];
};

function parseCategoryList(value: string | true | undefined) {
  if (typeof value !== 'string' || !value || value.trim() !== value
    || /\s|[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ForecastEmailOperatorUsageError('--categories must be a comma-separated allowlist.');
  }
  const categories = value.split(',');
  if (categories.some((category) => !NOTIFICATION_CATEGORIES.includes(category as NotificationCategory))) {
    throw new ForecastEmailOperatorUsageError('--categories contains an unsupported category.');
  }
  if (new Set(categories).size !== categories.length) {
    throw new ForecastEmailOperatorUsageError('--categories cannot contain duplicates.');
  }
  const selected = new Set(categories);
  return NOTIFICATION_CATEGORIES.filter((category) => selected.has(category));
}

export function parseConsentArgs(argv: string[]): ConsentOperatorOptions {
  const values = parseFlags(
    argv,
    new Set(['--categories']),
    new Set(['--status', '--enable', '--disable', '--json', '--help']),
  );
  if (helpOnly(values)) return { help: true, json: false };
  const actionFlag = exactlyOneAction(values, ['--status', '--enable', '--disable']);
  if (actionFlag === '--enable' && !values.has('--categories')) {
    throw new ForecastEmailOperatorUsageError('--categories is required with --enable.');
  }
  if (actionFlag !== '--enable' && values.has('--categories')) {
    throw new ForecastEmailOperatorUsageError('--categories can be used only with --enable.');
  }
  const action = actionFlag.slice(2) as 'status' | 'enable' | 'disable';
  return {
    help: false,
    json: values.has('--json'),
    action,
    ...(action === 'enable' ? { categories: parseCategoryList(values.get('--categories')) } : {}),
  };
}

export type SendMode = 'dry_run' | 'send_live';

function parseSendMode(values: ParsedFlags) {
  if (values.has('--dry-run') && values.has('--send-live')) {
    throw new ForecastEmailOperatorUsageError('--dry-run and --send-live cannot be combined.');
  }
  return values.has('--send-live') ? 'send_live' as const : 'dry_run' as const;
}

export type VerificationSendOperatorOptions = {
  help: boolean;
  json: boolean;
  cutoff?: string;
  mode: SendMode;
};

export function parseVerificationSendArgs(argv: string[]): VerificationSendOperatorOptions {
  const values = parseFlags(
    argv,
    new Set(['--cutoff']),
    new Set(['--dry-run', '--send-live', '--json', '--help']),
  );
  if (helpOnly(values)) return { help: true, json: false, mode: 'dry_run' };
  return {
    help: false,
    json: values.has('--json'),
    cutoff: canonicalCutoff(values.get('--cutoff')),
    mode: parseSendMode(values),
  };
}

export type DispatchOperatorOptions = VerificationSendOperatorOptions & { limit?: number };

export function resolveDispatchLimit(
  options: Pick<DispatchOperatorOptions, 'limit'>,
  configuration: Pick<EmailConfiguration, 'dispatcherLimit'>,
) {
  return options.limit ?? configuration.dispatcherLimit;
}

export function parseDispatchArgs(argv: string[]): DispatchOperatorOptions {
  const values = parseFlags(
    argv,
    new Set(['--cutoff', '--limit']),
    new Set(['--dry-run', '--send-live', '--json', '--help']),
  );
  if (helpOnly(values)) {
    return { help: true, json: false, mode: 'dry_run' };
  }
  return {
    help: false,
    json: values.has('--json'),
    cutoff: canonicalCutoff(values.get('--cutoff')),
    ...(values.has('--limit')
      ? { limit: wholeNumber(values.get('--limit'), '--limit', DEFAULT_EMAIL_DISPATCH_LIMIT) }
      : {}),
    mode: parseSendMode(values),
  };
}

export type EmailStatusOperatorOptions = {
  help: boolean;
  json: boolean;
  limit: number;
  category?: NotificationCategory;
  deliveryState?: EmailDeliveryState;
};

export function parseEmailStatusArgs(argv: string[]): EmailStatusOperatorOptions {
  const values = parseFlags(
    argv,
    new Set(['--limit', '--category', '--delivery-state']),
    new Set(['--json', '--help']),
  );
  if (helpOnly(values)) return { help: true, json: false, limit: DEFAULT_STATUS_LIMIT };
  const category = values.get('--category');
  if (category !== undefined && (typeof category !== 'string'
    || !NOTIFICATION_CATEGORIES.includes(category as NotificationCategory))) {
    throw new ForecastEmailOperatorUsageError('--category must be supported.');
  }
  const deliveryState = values.get('--delivery-state');
  if (deliveryState !== undefined && (typeof deliveryState !== 'string'
    || !EMAIL_DELIVERY_STATES.includes(deliveryState as EmailDeliveryState))) {
    throw new ForecastEmailOperatorUsageError('--delivery-state must be supported.');
  }
  return {
    help: false,
    json: values.has('--json'),
    limit: wholeNumber(values.get('--limit'), '--limit', DEFAULT_STATUS_LIMIT),
    ...(typeof category === 'string' ? { category: category as NotificationCategory } : {}),
    ...(typeof deliveryState === 'string'
      ? { deliveryState: deliveryState as EmailDeliveryState }
      : {}),
  };
}

export type VisibleRecipient = {
  maskedAddress: string;
  revision: number;
  lifecycle: 'pending' | 'verified' | 'revoked' | 'replaced';
  verificationRequestedAt: string | null;
  verifiedAt: string | null;
  revokedAt: string | null;
  suppressionState: 'none' | 'suppressed';
  suppressionReason: string | null;
  suppressedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RecipientOperatorReport = {
  action: NonNullable<RecipientOperatorOptions['action']>;
  disposition: string;
  recipient: VisibleRecipient | null;
  verification: null | {
    state: 'not_requested' | 'prepared' | 'already_pending';
    expiresAt: string | null;
  };
};

export type ConsentOperatorReport = {
  action: NonNullable<ConsentOperatorOptions['action']>;
  disposition: string;
  recipient: null | { maskedAddress: string; lifecycle: VisibleRecipient['lifecycle'] };
  consent: null | {
    revision: number;
    masterConsent: boolean;
    categories: Record<NotificationCategory, boolean>;
    source: string;
    consentedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  };
};

export type VerificationSendOperatorReport = {
  mode: SendMode;
  cutoff: string;
  disposition: string;
  recipient: null | { maskedAddress: string; lifecycle: VisibleRecipient['lifecycle'] };
  providerCallAttempted: boolean;
  providerAccepted: boolean;
  retryAt: string | null;
  failureCategory: string | null;
};

export type DispatchItemReport = {
  correlationId: string;
  classification: string;
  preSendDecision: EmailPreSendDecision | null;
  retryAt: string | null;
  providerClassification: string | null;
};

export type DispatchOperatorReport = {
  dispatcherVersion: typeof FORECAST_EMAIL_DISPATCHER_VERSION;
  mode: SendMode;
  cutoff: string;
  limit: number;
  disposition: string;
  selectedCount: number;
  processedCount: number;
  acceptedCount: number;
  deferredCount: number;
  suppressedCount: number;
  retryScheduledCount: number;
  deadLetterCount: number;
  claimConflictCount: number;
  unexpectedErrorCount: number;
  durationMs: number;
  items: DispatchItemReport[];
};

export type EmailStatusReport = {
  state: 'inspection_ready' | 'configuration_error';
  localSchema: 'present' | 'missing';
  provider: 'resend';
  dispatcherVersion: typeof FORECAST_EMAIL_DISPATCHER_VERSION;
  configuration: {
    environment: EmailConfiguration['environment'];
    dispatchEnabled: boolean;
    liveConfigurationComplete: boolean;
  };
  filters: {
    limit: number;
    category: NotificationCategory | null;
    deliveryState: EmailDeliveryState | null;
  };
  recipient: VisibleRecipient | null;
  consent: ConsentOperatorReport['consent'];
  counts: Array<{
    state: EmailDeliveryState;
    reconciliationState: EmailReconciliationState;
    count: number;
  }>;
  deliveries: Array<{
    correlationId: string;
    sourceKind: 'forecast_notification' | 'recipient_verification';
    templateKind: string;
    state: EmailDeliveryState;
    reconciliationState: EmailReconciliationState;
    templateVersion: string;
    providerAcceptedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
};

function text(value: string | number | boolean | null) {
  return value === null ? 'none' : String(value);
}

export function renderRecipientHuman(report: RecipientOperatorReport) {
  const lines = [
    'Northstar email recipient operator',
    `Action: ${report.action} | disposition=${report.disposition}`,
  ];
  if (report.recipient) {
    lines.push(
      `Recipient: ${report.recipient.maskedAddress} | lifecycle=${report.recipient.lifecycle} | revision=${report.recipient.revision}`,
      `Verification: requested=${text(report.recipient.verificationRequestedAt)} verified=${text(report.recipient.verifiedAt)}`,
      `Suppression: ${report.recipient.suppressionState} | reason=${text(report.recipient.suppressionReason)}`,
    );
  } else {
    lines.push('Recipient: none');
  }
  if (report.verification) {
    lines.push(`Verification request: ${report.verification.state} | expires=${text(report.verification.expiresAt)}`);
  }
  lines.push('Raw address and verification token: redacted');
  return lines.join('\n');
}

export function renderConsentHuman(report: ConsentOperatorReport) {
  const lines = [
    'Northstar forecast email consent',
    `Action: ${report.action} | disposition=${report.disposition}`,
    `Recipient: ${report.recipient ? `${report.recipient.maskedAddress}/${report.recipient.lifecycle}` : 'none'}`,
  ];
  if (report.consent) {
    lines.push(
      `Consent: revision=${report.consent.revision} master=${report.consent.masterConsent} source=${report.consent.source}`,
      `Categories: ${NOTIFICATION_CATEGORIES.map((category) => `${category}=${report.consent?.categories[category]}`).join(', ')}`,
      `Times: consented=${text(report.consent.consentedAt)} revoked=${text(report.consent.revokedAt)}`,
    );
  } else {
    lines.push('Consent: none (disabled)');
  }
  return lines.join('\n');
}

export function renderVerificationSendHuman(report: VerificationSendOperatorReport) {
  return [
    'Northstar recipient verification delivery',
    `Disposition: ${report.disposition} | mode=${report.mode} | cutoff=${report.cutoff}`,
    `Recipient: ${report.recipient ? `${report.recipient.maskedAddress}/${report.recipient.lifecycle}` : 'none'}`,
    `Provider: attempted=${report.providerCallAttempted} accepted=${report.providerAccepted}`,
    `Retry: ${text(report.retryAt)} | failure=${text(report.failureCategory)}`,
    'Provider acceptance is not recipient delivery or verification.',
  ].join('\n');
}

export function renderDispatchHuman(report: DispatchOperatorReport) {
  const lines = [
    'Northstar forecast email dispatch',
    `Disposition: ${report.disposition} | mode=${report.mode} | cutoff=${report.cutoff} | limit=${report.limit}`,
    `Counts: selected=${report.selectedCount} processed=${report.processedCount} accepted=${report.acceptedCount} deferred=${report.deferredCount} suppressed=${report.suppressedCount} retryScheduled=${report.retryScheduledCount} deadLetter=${report.deadLetterCount}`,
    `Claim conflicts: ${report.claimConflictCount} | unexpected=${report.unexpectedErrorCount} | durationMs=${report.durationMs}`,
  ];
  if (report.items.length) {
    lines.push('Items:');
    for (const item of report.items) {
      lines.push(
        `  ${item.correlationId} ${item.classification} policy=${text(item.preSendDecision)}`,
        `    retry=${text(item.retryAt)} providerClassification=${text(item.providerClassification)}`,
      );
    }
  } else {
    lines.push('Items: none');
  }
  lines.push(report.mode === 'dry_run'
    ? 'External delivery: not attempted'
    : 'Provider acceptance is not final delivery.');
  return lines.join('\n');
}

export function renderEmailStatusHuman(report: EmailStatusReport) {
  const lines = [
    'Northstar forecast email status (local, read-only)',
    `Inspection: ${report.state} | schema=${report.localSchema} | provider=${report.provider}`,
    `Configuration: environment=${report.configuration.environment} dispatchEnabled=${report.configuration.dispatchEnabled} liveComplete=${report.configuration.liveConfigurationComplete}`,
    `Filters: category=${text(report.filters.category)} deliveryState=${text(report.filters.deliveryState)} limit=${report.filters.limit}`,
    `Recipient: ${report.recipient ? `${report.recipient.maskedAddress}/${report.recipient.lifecycle}` : 'none'}`,
    `Consent: ${report.consent ? `revision=${report.consent.revision} master=${report.consent.masterConsent}` : 'none (disabled)'}`,
    report.counts.length
      ? `Counts: ${report.counts.map((entry) => `${entry.state}/${entry.reconciliationState}=${entry.count}`).join(', ')}`
      : 'Counts: none',
  ];
  if (report.deliveries.length) {
    lines.push('Deliveries:');
    for (const delivery of report.deliveries) {
      lines.push(
        `  ${delivery.createdAt} ${delivery.sourceKind}/${delivery.templateKind} state=${delivery.state} reconciliation=${delivery.reconciliationState} correlation=${delivery.correlationId}`,
        `    providerAccepted=${text(delivery.providerAcceptedAt)} template=${delivery.templateVersion}`,
      );
    }
  } else {
    lines.push('Deliveries: none');
  }
  return lines.join('\n');
}

function platformOptions() {
  return {
    configPath: CONFIG_PATH,
    persist: { path: process.env.NORTHSTAR_COORDINATOR_PERSIST_PATH || DEFAULT_PERSIST_PATH },
    remoteBindings: false,
  } as const;
}

function operatorEmailConfiguration() {
  return emailConfigurationFromEnv({
    FORECAST_EMAIL_ENVIRONMENT: process.env.FORECAST_EMAIL_ENVIRONMENT,
    FORECAST_EMAIL_DISPATCH_ENABLED: process.env.FORECAST_EMAIL_DISPATCH_ENABLED,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
    FORECAST_EMAIL_CAPABILITY_SECRET: process.env.FORECAST_EMAIL_CAPABILITY_SECRET,
    FORECAST_EMAIL_FROM: process.env.FORECAST_EMAIL_FROM,
    FORECAST_EMAIL_REPLY_TO: process.env.FORECAST_EMAIL_REPLY_TO,
    PUBLIC_APP_URL: process.env.PUBLIC_APP_URL,
    FORECAST_EMAIL_PROVIDER_TIMEOUT_MS: process.env.FORECAST_EMAIL_PROVIDER_TIMEOUT_MS,
    FORECAST_EMAIL_RESPONSE_MAX_BYTES: process.env.FORECAST_EMAIL_RESPONSE_MAX_BYTES,
    FORECAST_EMAIL_DISPATCH_LIMIT: process.env.FORECAST_EMAIL_DISPATCH_LIMIT,
    FORECAST_EMAIL_WEBHOOK_MAX_BYTES: process.env.FORECAST_EMAIL_WEBHOOK_MAX_BYTES,
  });
}

async function initializeEmailDatabase(d1: D1Database, profileId: number) {
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS investment_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_currency TEXT NOT NULL DEFAULT 'USD',
      cash_balance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`),
    ...forecastInitializationStatements().map((statement) => d1.prepare(statement)),
  ]);
  const profile = await d1.prepare('SELECT id FROM investment_profiles WHERE id = ?')
    .bind(profileId).first<{ id: number }>();
  if (!profile) throw new Error('ConfiguredOperatorProfileUnavailable');
}

type Platform = Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;

async function withEmailPlatform<T, A extends AuthorizationAction>(
  initialize: boolean,
  authorizationAction: A,
  command: string,
  operation: (input: {
    d1: D1Database;
    profileId: number;
    scope: AuthorizedProfileScope<A>;
    configuration: EmailConfiguration;
    uuid: () => string;
  }) => Promise<T>,
) {
  const platform: Platform = await getPlatformProxy<{ DB: D1Database }>(platformOptions());
  try {
    const d1 = platform.env.DB;
    if (!d1) throw new Error('MissingLocalD1Binding');
    const scope = trustedOperatorScope(process.env, authorizationAction, command);
    const profileId = profileIdFromScope(scope, authorizationAction);
    if (initialize) await initializeEmailDatabase(d1, profileId);
    return await operation({
      d1,
      profileId,
      scope,
      configuration: operatorEmailConfiguration(),
      uuid: randomUUID,
    });
  } finally {
    await platform.dispose();
  }
}

function visibleRecipient(value: EmailRecipient | null): VisibleRecipient | null {
  if (!value) return null;
  return {
    maskedAddress: value.maskedEmail,
    revision: value.revision,
    lifecycle: value.lifecycle,
    verificationRequestedAt: value.verificationRequestedAt,
    verifiedAt: value.verifiedAt,
    revokedAt: value.revokedAt,
    suppressionState: value.suppressionState,
    suppressionReason: value.suppressionReason,
    suppressedAt: value.suppressedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function visibleConsent(value: EmailConsentSnapshot | null): ConsentOperatorReport['consent'] {
  if (!value) return null;
  return {
    revision: value.revision,
    masterConsent: value.masterConsent,
    categories: { ...value.categories },
    source: value.source,
    consentedAt: value.consentedAt,
    revokedAt: value.revokedAt,
    createdAt: value.createdAt,
  };
}

function visibleConsentRecipient(state: EmailRecipientState) {
  const recipient = visibleRecipient(state.currentRecipient);
  return recipient ? { maskedAddress: recipient.maskedAddress, lifecycle: recipient.lifecycle } : null;
}

function recipientService(
  repository: D1EmailRepository,
  configuration: EmailConfiguration,
  uuid: () => string,
) {
  if (!configuration.capabilitySecret) throw new Error('EmailCapabilitySecretMissing');
  return new EmailRecipientService({
    repository,
    capabilitySecret: decodeEmailCapabilitySecret(configuration.capabilitySecret),
    initialTimeZone: 'UTC',
    runtime: {
      now: () => new Date().toISOString(),
      recipientId: () => `email-recipient-${uuid()}`,
      verificationExpiresAt: (issuedAt) => new Date(
        Date.parse(issuedAt) + 24 * 60 * 60_000,
      ).toISOString(),
    },
  });
}

export async function invokeRecipientOperator(
  options: RecipientOperatorOptions,
): Promise<RecipientOperatorReport> {
  if (options.help || !options.action) {
    throw new ForecastEmailOperatorUsageError('A runnable recipient action is required.');
  }
  return withEmailPlatform(
    options.action !== 'status',
    options.action === 'status' ? 'operator_status_inspect' : 'email_recipient_administer',
    options.action === 'status'
      ? 'forecast:email:recipient:status'
      : 'forecast:email:recipient:administer',
    async ({
    d1, profileId, scope, configuration, uuid,
  }) => {
    const repository = new D1EmailRepository(d1);
    if (options.action === 'status') {
      if (!await repository.hasSchema()) {
        return { action: 'status', disposition: 'schema_missing', recipient: null, verification: null };
      }
      const state = await repository.readRecipientState(profileId);
      return {
        action: 'status',
        disposition: state.currentRecipient ? 'recipient_found' : 'recipient_missing',
        recipient: visibleRecipient(state.currentRecipient),
        verification: null,
      };
    }
    const service = new AuthorizedEmailRecipientService(
      exactActionScope(scope, 'email_recipient_administer'),
      recipientService(repository, configuration, uuid),
    );
    if (options.action === 'set') {
      if (!options.email) throw new ForecastEmailOperatorUsageError('--set requires an email address.');
      const recipient = await service.register(options.email);
      return {
        action: 'set', disposition: 'recipient_pending',
        recipient: visibleRecipient(recipient), verification: null,
      };
    }
    if (options.action === 'revoke') {
      const recipient = await service.revoke();
      return {
        action: 'revoke',
        disposition: recipient ? 'recipient_revoked' : 'recipient_missing',
        recipient: visibleRecipient(recipient),
        verification: null,
      };
    }
    const requested = await service.requestVerification();
    // The plaintext capability exists only inside this trusted process and is
    // deliberately discarded rather than logged or returned by the operator.
    void requested.verificationToken;
    return {
      action: 'request_verification',
      disposition: 'verification_prepared',
      recipient: visibleRecipient(requested.recipient),
      verification: { state: 'prepared', expiresAt: requested.expiresAt },
    };
    },
  );
}

export async function invokeConsentOperator(
  options: ConsentOperatorOptions,
): Promise<ConsentOperatorReport> {
  if (options.help || !options.action) {
    throw new ForecastEmailOperatorUsageError('A runnable email consent action is required.');
  }
  const action = options.action;
  return withEmailPlatform(
    action !== 'status',
    action === 'status' ? 'operator_status_inspect' : 'email_consent_administer',
    action === 'status'
      ? 'forecast:email:consent:status'
      : 'forecast:email:consent:administer',
    async ({
    d1, profileId, scope, configuration, uuid,
  }) => {
    const repository = new D1EmailRepository(d1);
    if (action === 'status') {
      if (!await repository.hasSchema()) {
        return {
          action: 'status', disposition: 'schema_missing', recipient: null, consent: null,
        };
      }
      const state = await repository.readRecipientState(profileId);
      return {
        action: 'status',
        disposition: state.currentConsent ? 'consent_found' : 'consent_missing_disabled',
        recipient: visibleConsentRecipient(state),
        consent: visibleConsent(state.currentConsent),
      };
    }
    const service = new AuthorizedEmailConsentService(
      exactActionScope(scope, 'email_consent_administer'),
      recipientService(repository, configuration, uuid),
    );
    const consent = action === 'enable'
      ? await service.enable(options.categories)
      : await service.disable();
    const state = await repository.readRecipientState(profileId);
    return {
      action,
      disposition: action === 'enable'
        ? 'consent_enabled'
        : consent ? 'consent_disabled' : 'consent_missing_disabled',
      recipient: visibleConsentRecipient(state),
      consent: visibleConsent(consent),
    };
    },
  );
}

export async function invokeVerificationSendOperator(
  options: VerificationSendOperatorOptions,
): Promise<VerificationSendOperatorReport> {
  if (options.help || !options.cutoff) {
    throw new ForecastEmailOperatorUsageError('A runnable verification delivery is required.');
  }
  return withEmailPlatform(options.mode === 'send_live', 'email_dispatch', 'forecast:email:verification:send', async ({
    d1, profileId, scope, configuration, uuid,
  }) => {
    const repository = new D1EmailRepository(d1);
    if (!await repository.hasSchema()) throw new Error('ForecastEmailSchemaMissing');
    let adapter: EmailProviderAdapter = {
      kind: RESEND_ADAPTER_KIND,
      version: RESEND_ADAPTER_VERSION,
      async send() { throw new Error('DryRunProviderBoundaryReached'); },
    };
    if (options.mode === 'send_live' && configuration.dispatchEnabled) {
      const live = requireLiveEmailConfiguration(configuration);
      adapter = new ResendEmailAdapter({
        apiKey: live.resendApiKey,
        timeoutMs: live.providerTimeoutMs,
        responseMaxBytes: live.providerResponseMaxBytes,
      });
    }
    const service = new VerificationEmailDeliveryService(
      new D1VerificationEmailRepository(d1),
      adapter,
      configuration,
      {
        now: () => options.cutoff as string,
        id: (kind) => `${kind}-${uuid()}`,
      },
    );
    const delivery = await new AuthorizedVerificationDeliveryService(scope, service).send({
      sendLive: options.mode === 'send_live',
    });
    const state = await repository.readRecipientState(profileId);
    return {
      mode: delivery.mode === 'live' ? 'send_live' : 'dry_run',
      cutoff: options.cutoff as string,
      disposition: delivery.disposition,
      recipient: visibleConsentRecipient(state),
      providerCallAttempted: delivery.providerCalled,
      providerAccepted: [
        'sent_request_accepted', 'accepted_recovery', 'duplicate_replayed',
      ].includes(delivery.disposition),
      retryAt: delivery.nextAttemptAt,
      failureCategory: delivery.providerClassification,
    };
  });
}

export async function invokeDispatchOperator(options: DispatchOperatorOptions): Promise<DispatchOperatorReport> {
  if (options.help || !options.cutoff) {
    throw new ForecastEmailOperatorUsageError('A runnable forecast email dispatch is required.');
  }
  return withEmailPlatform(options.mode === 'send_live', 'email_dispatch', 'forecast:email:dispatch', async ({ d1, scope, configuration, uuid }) => {
    const repository = new D1EmailRepository(d1);
    if (!await repository.hasSchema()) {
      throw new Error('ForecastEmailSchemaMissing');
    }
    let adapter: EmailProviderAdapter = {
      kind: RESEND_ADAPTER_KIND,
      version: RESEND_ADAPTER_VERSION,
      async send() { throw new Error('DryRunProviderBoundaryReached'); },
    };
    if (options.mode === 'send_live' && configuration.dispatchEnabled) {
      const live = requireLiveEmailConfiguration(configuration);
      adapter = new ResendEmailAdapter({
        apiKey: live.resendApiKey,
        timeoutMs: live.providerTimeoutMs,
        responseMaxBytes: live.providerResponseMaxBytes,
      });
    }
    const started = Date.now();
    const service = new ForecastEmailDispatcherService(repository, adapter, configuration, {
      now: () => new Date().toISOString(),
      elapsedMs: () => Math.max(0, Date.now() - started),
      leaseExpiresAt: (acquiredAt) => new Date(Date.parse(acquiredAt) + 60_000).toISOString(),
      id: (kind) => `${kind}-${uuid()}`,
    });
    const effectiveLimit = resolveDispatchLimit(options, configuration);
    const report = await new AuthorizedEmailDispatcherService(scope, service).dispatch({
      cutoff: options.cutoff as string,
      limit: effectiveLimit,
      sendLive: options.mode === 'send_live',
    });
    return visibleDispatchReport(report, effectiveLimit);
  });
}

function visibleDispatchReport(
  report: ForecastEmailDispatchReport,
  limit: number,
): DispatchOperatorReport {
  return {
    dispatcherVersion: report.dispatcherVersion,
    mode: report.mode === 'live' ? 'send_live' : 'dry_run',
    cutoff: report.cutoff,
    limit,
    disposition: report.disposition,
    selectedCount: report.selectedCount,
    processedCount: report.items.length,
    acceptedCount: report.acceptedCount,
    deferredCount: report.deferredCount,
    suppressedCount: report.suppressedCount,
    retryScheduledCount: report.retryScheduledCount,
    deadLetterCount: report.deadLetterCount,
    claimConflictCount: report.claimConflictCount,
    unexpectedErrorCount: report.unexpectedErrorCount,
    durationMs: report.durationMs,
    items: report.items.map((item) => ({
      correlationId: item.outboxId,
      classification: item.disposition,
      preSendDecision: item.policyDecision,
      retryAt: item.nextAttemptAt,
      providerClassification: item.providerClassification,
    })),
  };
}

function liveConfigurationComplete(configuration: EmailConfiguration) {
  try {
    requireLiveEmailConfiguration(configuration);
    return true;
  } catch {
    return false;
  }
}

export async function inspectEmailStatus(options: EmailStatusOperatorOptions): Promise<EmailStatusReport> {
  if (options.help) {
    throw new ForecastEmailOperatorUsageError('A runnable email status inspection is required.');
  }
  return withEmailPlatform(false, 'operator_status_inspect', 'forecast:email:status', async ({ d1, profileId, configuration }) => {
    const repository = new D1EmailRepository(d1);
    const filters = {
      limit: options.limit,
      category: options.category ?? null,
      deliveryState: options.deliveryState ?? null,
    };
    if (!await repository.hasSchema()) {
      return {
        state: 'configuration_error',
        localSchema: 'missing',
        provider: 'resend',
        dispatcherVersion: FORECAST_EMAIL_DISPATCHER_VERSION,
        configuration: {
          environment: configuration.environment,
          dispatchEnabled: configuration.dispatchEnabled,
          liveConfigurationComplete: liveConfigurationComplete(configuration),
        },
        filters,
        recipient: null,
        consent: null,
        counts: [],
        deliveries: [],
      };
    }
    const [recipientState, counts, rawDeliveries] = await Promise.all([
      repository.readRecipientState(profileId),
      repository.countDeliveryStatus(profileId),
      repository.listDeliveryStatus(profileId, {
        limit: options.limit,
        ...(options.deliveryState ? { state: options.deliveryState } : {}),
        ...(options.category ? { templateKind: options.category } : {}),
      }),
    ]);
    const deliveries = rawDeliveries
      .map((delivery) => ({
        correlationId: delivery.deliveryId,
        sourceKind: delivery.sourceKind,
        templateKind: delivery.templateKind,
        state: delivery.state,
        reconciliationState: delivery.reconciliationState,
        templateVersion: delivery.templateVersion,
        providerAcceptedAt: delivery.providerAcceptedAt,
        createdAt: delivery.createdAt,
        updatedAt: delivery.updatedAt,
      }));
    return {
      state: 'inspection_ready',
      localSchema: 'present',
      provider: 'resend',
      dispatcherVersion: FORECAST_EMAIL_DISPATCHER_VERSION,
      configuration: {
        environment: configuration.environment,
        dispatchEnabled: configuration.dispatchEnabled,
        liveConfigurationComplete: liveConfigurationComplete(configuration),
      },
      filters,
      recipient: visibleRecipient(recipientState.currentRecipient),
      consent: visibleConsent(recipientState.currentConsent),
      counts: counts.map((entry) => ({
        state: entry.state,
        reconciliationState: entry.reconciliationState,
        count: Number(entry.count),
      })),
      deliveries,
    };
  });
}

type Io = { out(value: string): void; error(value: string): void };
const defaultIo: Io = { out: console.log, error: console.error };

function safeFailure(error: unknown) {
  if (error instanceof ForecastEmailOperatorUsageError) {
    return { code: 2, category: 'invalid_invocation', message: error.message };
  }
  return {
    code: 1,
    category: 'system_failure',
    message: 'The forecast email operator could not produce a report.',
  };
}

async function runWithReport<TOptions extends { help: boolean; json: boolean }, TReport>(
  argv: string[],
  io: Io,
  parse: (value: string[]) => TOptions,
  usage: string,
  invoke: (options: TOptions) => Promise<TReport>,
  human: (report: TReport) => string,
) {
  let options: TOptions | undefined;
  try {
    options = parse(argv);
    if (options.help) {
      io.out(usage);
      return 0;
    }
    const report = await invoke(options);
    io.out(options.json ? JSON.stringify(report, null, 2) : human(report));
    return 0;
  } catch (error) {
    const failure = safeFailure(error);
    io.error(options?.json || argv.includes('--json')
      ? JSON.stringify({ error: { category: failure.category, message: failure.message } })
      : `${failure.message}\nRun with --help for usage.`);
    return failure.code;
  }
}

export function runRecipientOperator(
  argv: string[], io: Io = defaultIo, invoke = invokeRecipientOperator,
) {
  return runWithReport(argv, io, parseRecipientArgs, RECIPIENT_USAGE, invoke, renderRecipientHuman);
}

export function runConsentOperator(
  argv: string[], io: Io = defaultIo, invoke = invokeConsentOperator,
) {
  return runWithReport(argv, io, parseConsentArgs, CONSENT_USAGE, invoke, renderConsentHuman);
}

export function runVerificationSendOperator(
  argv: string[], io: Io = defaultIo, invoke = invokeVerificationSendOperator,
) {
  return runWithReport(
    argv, io, parseVerificationSendArgs, VERIFICATION_SEND_USAGE, invoke,
    renderVerificationSendHuman,
  );
}

export function runDispatchOperator(
  argv: string[], io: Io = defaultIo, invoke = invokeDispatchOperator,
) {
  return runWithReport(argv, io, parseDispatchArgs, DISPATCH_USAGE, invoke, renderDispatchHuman);
}

export function runEmailStatusOperator(
  argv: string[], io: Io = defaultIo, inspect = inspectEmailStatus,
) {
  return runWithReport(
    argv, io, parseEmailStatusArgs, EMAIL_STATUS_USAGE, inspect, renderEmailStatusHuman,
  );
}
