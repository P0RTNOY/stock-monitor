import assert from 'node:assert/strict';
import test from 'node:test';
import { Webhook } from 'standardwebhooks';
import {
  DEFAULT_EMAIL_DISPATCH_LIMIT,
  DEFAULT_RESEND_RESPONSE_MAX_BYTES,
  DEFAULT_RESEND_TIMEOUT_MS,
  DEFAULT_RESEND_WEBHOOK_MAX_BYTES,
  EmailConfigurationError,
  emailConfigurationFromEnv,
  parseEmailConfiguration,
  requireLiveEmailConfiguration,
} from './server/email/config.ts';
import {
  RESEND_EMAIL_API_URL,
  ResendEmailAdapter,
  canonicalResendRequestJson,
  createResendProviderIdentity,
  type ResendEmailRequest,
} from './server/email/resend.ts';
import {
  RESEND_WEBHOOK_TOLERANCE_SECONDS,
  ResendWebhookVerificationError,
  verifyResendWebhookRequest,
} from './server/email/webhook-verifier.ts';

const request: ResendEmailRequest = {
  from: 'Northstar <journal@northstar.example>',
  to: ['recipient@example.net'],
  subject: 'Your forecast journal has an update',
  text: 'A forecast in your journal reached its recorded target.',
  html: '<p>A forecast in your journal reached its recorded target.</p>',
  replyTo: 'support@northstar.example',
  headers: {
    'List-Unsubscribe': '<https://northstar.example/unsubscribe/opaque-token>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  },
};

const liveEnvironment = {
  FORECAST_EMAIL_ENVIRONMENT: 'staging',
  FORECAST_EMAIL_DISPATCH_ENABLED: 'true',
  RESEND_API_KEY: 're_test_key_1234',
  RESEND_WEBHOOK_SECRET: 'whsec_dGVzdF9zZWNyZXRfdmFsdWU=',
  FORECAST_EMAIL_CAPABILITY_SECRET: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  FORECAST_EMAIL_FROM: 'Northstar <journal@northstar.example>',
  FORECAST_EMAIL_REPLY_TO: 'support@northstar.example',
  PUBLIC_APP_URL: 'https://northstar.example/',
};

function expectConfigError(action: () => unknown, field: string) {
  assert.throws(action, (error: unknown) => (
    error instanceof EmailConfigurationError && error.field === field
  ));
}

test('email configuration is strict, defaults disabled, and requires complete live-send values', () => {
  assert.deepEqual(parseEmailConfiguration({}), {
    environment: 'local',
    dispatchEnabled: false,
    resendApiKey: null,
    resendWebhookSecret: null,
    capabilitySecret: null,
    from: null,
    replyTo: null,
    publicAppUrl: null,
    providerTimeoutMs: DEFAULT_RESEND_TIMEOUT_MS,
    providerResponseMaxBytes: DEFAULT_RESEND_RESPONSE_MAX_BYTES,
    dispatcherLimit: DEFAULT_EMAIL_DISPATCH_LIMIT,
    webhookMaxBytes: DEFAULT_RESEND_WEBHOOK_MAX_BYTES,
  });
  const config = emailConfigurationFromEnv(liveEnvironment);
  assert.equal(config.publicAppUrl, 'https://northstar.example');
  assert.equal(requireLiveEmailConfiguration(config).resendApiKey, 're_test_key_1234');

  assert.throws(
    () => requireLiveEmailConfiguration(parseEmailConfiguration({})),
    (error: unknown) => error instanceof EmailConfigurationError
      && error.code === 'dispatch_disabled',
  );
  expectConfigError(() => parseEmailConfiguration({ unknown: true }), 'configuration');
  expectConfigError(() => parseEmailConfiguration({ dispatchEnabled: 'TRUE' }), 'dispatchEnabled');
  expectConfigError(() => parseEmailConfiguration({ environment: 'dev' }), 'environment');
  expectConfigError(() => parseEmailConfiguration({
    environment: 'production', publicAppUrl: 'http://localhost:3000',
  }), 'publicAppUrl');
  expectConfigError(() => parseEmailConfiguration({
    environment: 'production', publicAppUrl: 'https://northstar.example:8443',
  }), 'publicAppUrl');
  expectConfigError(() => parseEmailConfiguration({
    environment: 'staging', publicAppUrl: 'https://northstar',
  }), 'publicAppUrl');
  expectConfigError(() => parseEmailConfiguration({ from: 'Northstar\r\nBcc: x@example.net' }), 'from');
  expectConfigError(() => parseEmailConfiguration({ providerTimeoutMs: '999' }), 'providerTimeoutMs');
});

test('canonical request identity is stable, payload-bound, and contains no recipient identity', async () => {
  const identity = await createResendProviderIdentity({
    deliveryId: 'delivery_abc123', templateVersion: 'forecast-target-hit-1.0.0', environment: 'local', request,
  });
  assert.match(identity.idempotencyKey, /^northstar-email-v1-[a-f0-9]{64}$/u);
  assert.doesNotMatch(identity.idempotencyKey, /recipient|example|delivery_abc123/u);
  assert.match(identity.canonicalRequestHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(identity, await createResendProviderIdentity({
    deliveryId: 'delivery_abc123', templateVersion: 'forecast-target-hit-1.0.0', environment: 'local', request,
  }));
  const changed = await createResendProviderIdentity({
    deliveryId: 'delivery_abc123',
    templateVersion: 'forecast-target-hit-1.0.0',
    environment: 'local',
    request: { ...request, subject: 'A different immutable request' },
  });
  assert.equal(changed.idempotencyKey, identity.idempotencyKey);
  assert.notEqual(changed.canonicalRequestHash, identity.canonicalRequestHash);

  const canonical = JSON.parse(canonicalResendRequestJson(request)) as Record<string, unknown>;
  assert.equal(canonical.reply_to, request.replyTo);
  assert.equal(canonical.replyTo, undefined);
  assert.throws(() => canonicalResendRequestJson({
    ...request,
    headers: {
      'List-Unsubscribe': '<http://northstar.example/unsubscribe/token>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  }));
});

test('Resend adapter sends one canonical fixed-endpoint request and accepts only a bounded provider id', async () => {
  const identity = await createResendProviderIdentity({
    deliveryId: 'delivery_abc123', templateVersion: 'forecast-target-hit-1.0.0', environment: 'local', request,
  });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = new ResendEmailAdapter({
    apiKey: 're_test_key_1234',
    timeoutMs: 1_000,
    responseMaxBytes: 1_024,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' });
    },
  });
  assert.deepEqual(await adapter.send({ request, ...identity }), {
    disposition: 'accepted',
    providerEmailId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RESEND_EMAIL_API_URL);
  assert.equal(calls[0].init?.method, 'POST');
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer re_test_key_1234');
  assert.equal(headers.get('idempotency-key'), identity.idempotencyKey);
  assert.equal(headers.get('user-agent'), 'northstar-forecast-journal/1.0');
  assert.equal(calls[0].init?.body, canonicalResendRequestJson(request));
});

test('Resend adapter rejects identity drift before fetch and sanitizes provider outcomes', async () => {
  const identity = await createResendProviderIdentity({
    deliveryId: 'delivery_abc123', templateVersion: 'forecast-target-hit-1.0.0', environment: 'local', request,
  });
  let calls = 0;
  const noCall = new ResendEmailAdapter({
    apiKey: 're_test_key_1234', timeoutMs: 1_000, responseMaxBytes: 1_024,
    fetch: async () => { calls += 1; return Response.json({ id: 'should-not-send' }); },
  });
  assert.deepEqual(await noCall.send({
    request: { ...request, subject: 'mutated after persistence' }, ...identity,
  }), { disposition: 'terminal', classification: 'idempotency_integrity_failure' });
  assert.equal(calls, 0);

  for (const [response, expected] of [
    [new Response(JSON.stringify({ name: 'invalid_idempotent_request', message: 'raw secret' }), {
      status: 409,
    }), { disposition: 'terminal', classification: 'idempotency_integrity_failure' }],
    [new Response(JSON.stringify({ name: 'concurrent_idempotent_requests' }), {
      status: 409, headers: { 'retry-after': '5' },
    }), {
      disposition: 'retryable', classification: 'concurrent_idempotent_request',
      retryAfterSeconds: 5,
    }],
    [new Response(JSON.stringify({ name: 'rate_limit_exceeded' }), {
      status: 429, headers: { 'retry-after': '999999' },
    }), {
      disposition: 'retryable', classification: 'provider_rate_limited',
      retryAfterSeconds: null,
    }],
    [new Response(JSON.stringify({ name: 'monthly_quota_exceeded' }), {
      status: 429,
    }), { disposition: 'terminal', classification: 'provider_quota_exceeded' }],
    [new Response(JSON.stringify({ name: 'validation_error', message: 'recipient@example.net' }), {
      status: 422,
    }), { disposition: 'terminal', classification: 'provider_rejected' }],
    [new Response('{"id":"wrong","extra":true}', { status: 200 }), {
      disposition: 'ambiguous', classification: 'provider_response_invalid',
    }],
    [new Response('unavailable', { status: 503 }), {
      disposition: 'ambiguous', classification: 'provider_unavailable',
    }],
  ] as const) {
    const adapter = new ResendEmailAdapter({
      apiKey: 're_test_key_1234', timeoutMs: 1_000, responseMaxBytes: 1_024,
      fetch: async () => response.clone(),
    });
    assert.deepEqual(await adapter.send({ request, ...identity }), expected);
  }

  const oversized = new ResendEmailAdapter({
    apiKey: 're_test_key_1234', timeoutMs: 1_000, responseMaxBytes: 1_024,
    fetch: async () => new Response('{"id":"x"}', {
      status: 200, headers: { 'content-length': '2048' },
    }),
  });
  assert.deepEqual(await oversized.send({ request, ...identity }), {
    disposition: 'ambiguous', classification: 'provider_response_too_large',
  });
});

test('Resend adapter aborts a provider request at the configured deadline', async () => {
  const identity = await createResendProviderIdentity({
    deliveryId: 'delivery_timeout', templateVersion: 'forecast-target-hit-1.0.0', environment: 'local', request,
  });
  const adapter = new ResendEmailAdapter({
    apiKey: 're_test_key_1234', timeoutMs: 1_000, responseMaxBytes: 1_024,
    fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('raw abort')), { once: true });
    }),
  });
  assert.deepEqual(await adapter.send({ request, ...identity }), {
    disposition: 'ambiguous', classification: 'provider_timeout',
  });
});

test('Resend adapter deadline also bounds a response body that never completes', async () => {
  const identity = await createResendProviderIdentity({
    deliveryId: 'delivery_body_timeout',
    templateVersion: 'forecast-target-hit-1.0.0',
    environment: 'local',
    request,
  });
  const adapter = new ResendEmailAdapter({
    apiKey: 're_test_key_1234', timeoutMs: 1_000, responseMaxBytes: 1_024,
    fetch: async (_url, init) => {
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(new TextEncoder().encode('{"id":"partial'));
        },
      });
      init?.signal?.addEventListener('abort', () => streamController.error(new Error('abort')), {
        once: true,
      });
      return new Response(body, { status: 200 });
    },
  });
  assert.deepEqual(await adapter.send({ request, ...identity }), {
    disposition: 'ambiguous', classification: 'provider_timeout',
  });
});

function webhookFixture() {
  const rawBody = JSON.stringify({
    type: 'email.delivered',
    created_at: '2026-08-25T12:00:00.000Z',
    data: { email_id: 'provider-id' },
  });
  const webhookId = 'msg_test_123';
  const timestamp = Math.floor(Date.now() / 1_000);
  const webhookSecret = `whsec_${Buffer.from('a sufficiently long test secret').toString('base64')}`;
  const signature = new Webhook(webhookSecret).sign(webhookId, new Date(timestamp * 1_000), rawBody);
  return { rawBody, webhookId, timestamp, webhookSecret, signature };
}

test('webhook verifier authenticates the exact raw body and returns only verified content', () => {
  const fixture = webhookFixture();
  const verified = verifyResendWebhookRequest({
    rawBody: fixture.rawBody,
    headers: {
      'svix-id': fixture.webhookId,
      'svix-timestamp': String(fixture.timestamp),
      'svix-signature': fixture.signature,
    },
    webhookSecret: fixture.webhookSecret,
    maxBodyBytes: 4_096,
    nowEpochSeconds: fixture.timestamp,
  });
  assert.equal(verified.webhookId, fixture.webhookId);
  assert.equal(verified.timestamp, fixture.timestamp);
  assert.deepEqual(verified.payload, JSON.parse(fixture.rawBody));

  assert.throws(() => verifyResendWebhookRequest({
    rawBody: `${fixture.rawBody} `,
    headers: {
      'svix-id': fixture.webhookId,
      'svix-timestamp': String(fixture.timestamp),
      'svix-signature': fixture.signature,
    },
    webhookSecret: fixture.webhookSecret,
    maxBodyBytes: 4_096,
    nowEpochSeconds: fixture.timestamp,
  }), (error: unknown) => error instanceof ResendWebhookVerificationError
    && error.code === 'invalid_signature');
});

test('webhook verifier rejects missing, stale, malformed, and byte-oversized requests generically', () => {
  const fixture = webhookFixture();
  const common = {
    rawBody: fixture.rawBody,
    headers: {
      'svix-id': fixture.webhookId,
      'svix-timestamp': String(fixture.timestamp),
      'svix-signature': fixture.signature,
    },
    webhookSecret: fixture.webhookSecret,
    maxBodyBytes: 4_096,
    nowEpochSeconds: fixture.timestamp,
  };
  for (const [input, code] of [
    [{ ...common, headers: { ...common.headers, 'svix-id': null } }, 'missing_headers'],
    [{ ...common, headers: { ...common.headers, 'svix-timestamp': '1.5' } }, 'invalid_headers'],
    [{ ...common, nowEpochSeconds: fixture.timestamp + RESEND_WEBHOOK_TOLERANCE_SECONDS + 1 },
      'stale_timestamp'],
    [{ ...common, rawBody: '€', maxBodyBytes: 2 }, 'body_too_large'],
  ] as const) {
    assert.throws(() => verifyResendWebhookRequest(input), (error: unknown) => (
      error instanceof ResendWebhookVerificationError
      && error.code === code
      && error.message === 'Invalid webhook request.'
    ));
  }
});
