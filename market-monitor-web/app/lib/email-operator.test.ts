import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONSENT_USAGE,
  DISPATCH_USAGE,
  EMAIL_STATUS_USAGE,
  ForecastEmailOperatorUsageError,
  RECIPIENT_USAGE,
  VERIFICATION_SEND_USAGE,
  parseConsentArgs,
  parseDispatchArgs,
  parseEmailStatusArgs,
  parseRecipientArgs,
  parseVerificationSendArgs,
  renderConsentHuman,
  renderDispatchHuman,
  renderEmailStatusHuman,
  renderRecipientHuman,
  renderVerificationSendHuman,
  runDispatchOperator,
  runRecipientOperator,
  type ConsentOperatorReport,
  type DispatchOperatorReport,
  type EmailStatusReport,
  type RecipientOperatorReport,
  type VerificationSendOperatorReport,
} from '../../operator/forecast-email.ts';

const cutoff = '2026-08-25T12:00:00.000Z';

function visibleRecipient() {
  return {
    maskedAddress: 'p***@e***.net',
    revision: 2,
    lifecycle: 'verified' as const,
    verificationRequestedAt: '2026-08-25T10:00:00.000Z',
    verifiedAt: '2026-08-25T10:05:00.000Z',
    revokedAt: null,
    suppressionState: 'none' as const,
    suppressionReason: null,
    suppressedAt: null,
    createdAt: '2026-08-25T10:00:00.000Z',
    updatedAt: '2026-08-25T10:05:00.000Z',
  };
}

function recipientReport(): RecipientOperatorReport {
  return {
    action: 'status',
    disposition: 'recipient_found',
    recipient: visibleRecipient(),
    verification: { state: 'prepared', expiresAt: '2026-08-26T10:00:00.000Z' },
  };
}

function consentReport(): ConsentOperatorReport {
  return {
    action: 'status',
    disposition: 'consent_found',
    recipient: { maskedAddress: 'p***@e***.net', lifecycle: 'verified' },
    consent: {
      revision: 3,
      masterConsent: true,
      categories: {
        target_hit: true,
        invalidated: false,
        expired: true,
        needs_review: false,
      },
      source: 'operator',
      consentedAt: '2026-08-25T10:06:00.000Z',
      revokedAt: null,
      createdAt: '2026-08-25T10:06:00.000Z',
    },
  };
}

function verificationReport(): VerificationSendOperatorReport {
  return {
    mode: 'dry_run',
    cutoff,
    disposition: 'dry_run_candidate',
    recipient: { maskedAddress: 'p***@e***.net', lifecycle: 'pending' },
    providerCallAttempted: false,
    providerAccepted: false,
    retryAt: null,
    failureCategory: null,
  };
}

function dispatchReport(): DispatchOperatorReport {
  return {
    dispatcherVersion: 'forecast-email-dispatcher-1.0.0',
    mode: 'dry_run',
    cutoff,
    limit: 10,
    disposition: 'page_completed',
    selectedCount: 1,
    processedCount: 1,
    acceptedCount: 0,
    deferredCount: 0,
    suppressedCount: 1,
    retryScheduledCount: 0,
    deadLetterCount: 0,
    durationMs: 12,
    items: [{
      correlationId: 'delivery-correlation-1',
      classification: 'suppressed_no_consent',
      preSendDecision: 'suppressed_email_consent',
      retryAt: null,
      providerClassification: null,
    }],
    claimConflictCount: 0,
    unexpectedErrorCount: 0,
  };
}

function statusReport(): EmailStatusReport {
  return {
    state: 'inspection_ready',
    localSchema: 'present',
    provider: 'resend',
    dispatcherVersion: 'forecast-email-dispatcher-1.0.0',
    configuration: { environment: 'local', dispatchEnabled: false, liveConfigurationComplete: false },
    filters: { limit: 20, category: null, deliveryState: null },
    recipient: visibleRecipient(),
    consent: consentReport().consent,
    counts: [{ state: 'prepared', reconciliationState: 'none', count: 1 }],
    deliveries: [{
      correlationId: 'delivery-correlation-1',
      sourceKind: 'forecast_notification',
      templateKind: 'target_hit',
      state: 'prepared',
      reconciliationState: 'none',
      templateVersion: 'northstar-forecast-target-hit-1.0.0',
      providerAcceptedAt: null,
      createdAt: '2026-08-25T10:00:00.000Z',
      updatedAt: '2026-08-25T10:00:00.000Z',
    }],
  };
}

function io() {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    adapter: {
      out: (value: string) => output.push(value),
      error: (value: string) => errors.push(value),
    },
  };
}

test('recipient parser requires exactly one fixed-profile action and normalizes only the domain', () => {
  assert.deepEqual(parseRecipientArgs(['--set', 'Trader@EXAMPLE.NET', '--json']), {
    help: false,
    json: true,
    action: 'set',
    email: 'Trader@example.net',
  });
  assert.deepEqual(parseRecipientArgs(['--status']), {
    help: false, json: false, action: 'status',
  });
  assert.deepEqual(parseRecipientArgs(['--request-verification']), {
    help: false, json: false, action: 'request_verification',
  });
  assert.deepEqual(parseRecipientArgs(['--help']), { help: true, json: false });
  assert.match(RECIPIENT_USAGE, /never includes the\s+raw recipient address/i);

  for (const argv of [
    [],
    ['--status', '--revoke'],
    ['--set', 'invalid'],
    ['--set', 'a@example.net\r\nBcc:x@example.net'],
    ['--profile', '1'],
    ['--status', '--status'],
    ['--help', '--json'],
  ]) assert.throws(() => parseRecipientArgs(argv), ForecastEmailOperatorUsageError);
});

test('consent parser treats enable categories as a strict complete allowlist', () => {
  assert.deepEqual(parseConsentArgs([
    '--enable', '--categories', 'needs_review,target_hit,expired', '--json',
  ]), {
    help: false,
    json: true,
    action: 'enable',
    categories: ['target_hit', 'expired', 'needs_review'],
  });
  assert.deepEqual(parseConsentArgs(['--disable']), {
    help: false, json: false, action: 'disable',
  });
  assert.deepEqual(parseConsentArgs(['--help']), { help: true, json: false });
  assert.match(CONSENT_USAGE, /complete allowlist/i);

  for (const argv of [
    [],
    ['--enable'],
    ['--disable', '--categories', 'target_hit'],
    ['--enable', '--categories', ''],
    ['--enable', '--categories', 'target_hit, target_hit'],
    ['--enable', '--categories', 'target_hit,target_hit'],
    ['--enable', '--categories', 'marketing'],
    ['--status', '--profile', '1'],
    ['--help', '--json'],
  ]) assert.throws(() => parseConsentArgs(argv), ForecastEmailOperatorUsageError);
});

test('verification and forecast dispatch are dry-run by default and require strict live flags', () => {
  assert.deepEqual(parseVerificationSendArgs(['--cutoff', cutoff]), {
    help: false, json: false, cutoff, mode: 'dry_run',
  });
  assert.deepEqual(parseVerificationSendArgs(['--cutoff', cutoff, '--send-live', '--json']), {
    help: false, json: true, cutoff, mode: 'send_live',
  });
  assert.deepEqual(parseDispatchArgs(['--cutoff', cutoff]), {
    help: false, json: false, cutoff, limit: 10, mode: 'dry_run',
  });
  assert.deepEqual(parseDispatchArgs(['--cutoff', cutoff, '--limit', '50', '--send-live']), {
    help: false, json: false, cutoff, limit: 50, mode: 'send_live',
  });
  assert.match(VERIFICATION_SEND_USAGE, /DISPATCH_ENABLED=true/u);
  assert.match(DISPATCH_USAGE, /Dry-run never claims/u);

  for (const parse of [parseVerificationSendArgs, parseDispatchArgs]) {
    for (const argv of [
      [],
      ['--cutoff', '2026-08-25T12:00:00Z'],
      ['--cutoff', cutoff, '--dry-run', '--send-live'],
      ['--cutoff', cutoff, '--api-key', 'secret'],
      ['--cutoff', cutoff, '--profile', '1'],
      ['--help', '--json'],
    ]) assert.throws(() => parse(argv), ForecastEmailOperatorUsageError);
  }
  for (const argv of [
    ['--cutoff', cutoff, '--limit', '0'],
    ['--cutoff', cutoff, '--limit', '51'],
    ['--cutoff', cutoff, '--limit', '1.5'],
  ]) assert.throws(() => parseDispatchArgs(argv), ForecastEmailOperatorUsageError);
});

test('email status parser has bounded allowlisted read-only filters', () => {
  assert.deepEqual(parseEmailStatusArgs([]), { help: false, json: false, limit: 20 });
  assert.deepEqual(parseEmailStatusArgs([
    '--limit', '50', '--category', 'invalidated', '--delivery-state', 'ambiguous', '--json',
  ]), {
    help: false,
    json: true,
    limit: 50,
    category: 'invalidated',
    deliveryState: 'ambiguous',
  });
  assert.match(EMAIL_STATUS_USAGE, /local and read-only|local, read-only/i);
  for (const argv of [
    ['--limit', '0'],
    ['--category', 'marketing'],
    ['--delivery-state', 'delivered'],
    ['--profile', '1'],
    ['--json', '--json'],
    ['--help', '--json'],
  ]) assert.throws(() => parseEmailStatusArgs(argv), ForecastEmailOperatorUsageError);
});

test('human renderers preserve safe facts while never needing sensitive provider fields', () => {
  for (const [rendered, expected] of [
    [renderRecipientHuman(recipientReport()), ['p***@e***.net', 'verified', 'Raw address']],
    [renderConsentHuman(consentReport()), ['master=true', 'target_hit=true', 'invalidated=false']],
    [renderVerificationSendHuman(verificationReport()), ['dry_run_candidate', 'attempted=false']],
    [renderDispatchHuman(dispatchReport()), ['suppressed_no_consent', 'External delivery: not attempted']],
    [renderEmailStatusHuman(statusReport()), ['local, read-only', 'dispatchEnabled=false', 'prepared/none=1']],
  ] as const) {
    for (const value of expected) assert.ok(rendered.toLowerCase().includes(value.toLowerCase()));
  }
});

test('runners keep help and invalid invocations away from D1 and emit stable redacted JSON', async () => {
  const streams = io();
  let calls = 0;
  const invoke = async () => {
    calls += 1;
    return recipientReport();
  };
  assert.equal(await runRecipientOperator(['--help'], streams.adapter, invoke), 0);
  assert.equal(streams.output.at(-1), RECIPIENT_USAGE);
  assert.equal(calls, 0);
  assert.equal(await runRecipientOperator(['--status', '--revoke'], streams.adapter, invoke), 2);
  assert.equal(calls, 0);
  assert.equal(await runRecipientOperator(['--status', '--json'], streams.adapter, invoke), 0);
  assert.deepEqual(JSON.parse(streams.output.at(-1) ?? '{}'), recipientReport());
  assert.equal(calls, 1);
  for (const forbidden of [
    'canonicalEmail', 'verificationToken', 'capabilityId', 'recipientId',
    'ownerToken', 'claimToken', 'providerEmailId', 'idempotencyKey',
    'canonicalRequestHash', 'payloadJson', 'html', 'text',
  ]) assert.doesNotMatch(streams.output.at(-1) ?? '', new RegExp(forbidden, 'iu'));

  const secret = 'recipient@example.net secret-api-key raw-html claim-token';
  assert.equal(await runDispatchOperator([
    '--cutoff', cutoff, '--send-live', '--json',
  ], streams.adapter, async () => { throw new Error(secret); }), 1);
  assert.doesNotMatch(streams.errors.at(-1) ?? '', /recipient@example|secret-api|raw-html|claim-token/iu);
  assert.deepEqual(JSON.parse(streams.errors.at(-1) ?? '{}'), {
    error: {
      category: 'system_failure',
      message: 'The forecast email operator could not produce a report.',
    },
  });
});
