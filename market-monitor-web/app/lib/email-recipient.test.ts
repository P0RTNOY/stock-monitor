import assert from 'node:assert/strict';
import test from 'node:test';
import type { NotificationPreferenceSnapshot } from './server/notifications/preference.ts';
import {
  EmailRecipientService,
  EmailRecipientServiceError,
  type EmailRecipientRepository,
  type EmailRecipientState,
  type EnableEmailConsentRepositoryInput,
  type ReplaceRecipientRepositoryInput,
  type RevokeRecipientRepositoryInput,
  type StoredEmailCapability,
} from './server/email/recipient-service.ts';
import {
  unsubscribeConfirmationGet,
  unsubscribeConfirmationPost,
  verificationConfirmationGet,
  verificationConfirmationPost,
  type EmailPublicActionService,
} from './server/email/public-actions.ts';
import { webCryptoEmailCapabilityPrimitives } from './server/email/capability.ts';
import type { EmailConsentSnapshot, EmailRecipient } from './server/email/types.ts';

class MemoryEmailRepository implements EmailRecipientRepository {
  recipients: EmailRecipient[] = [];
  consentHistory: EmailConsentSnapshot[] = [];
  capabilities = new Map<string, StoredEmailCapability>();
  notificationPreference: NotificationPreferenceSnapshot | null = null;
  currentRecipient: EmailRecipient | null = null;
  currentConsent: EmailConsentSnapshot | null = null;

  async readRecipientState(profileId: number): Promise<EmailRecipientState> {
    return {
      currentRecipient: this.currentRecipient?.profileId === profileId ? { ...this.currentRecipient } : null,
      currentConsent: this.currentConsent?.profileId === profileId ? structuredClone(this.currentConsent) : null,
      notificationPreference: this.notificationPreference?.profileId === profileId
        ? structuredClone(this.notificationPreference) : null,
      latestRecipientRevision: this.recipients
        .filter((recipient) => recipient.profileId === profileId)
        .reduce((maximum, recipient) => Math.max(maximum, recipient.revision), 0),
    };
  }

  private consentMatches(expected: number) {
    return (this.currentConsent?.revision ?? 0) === expected;
  }

  private revokeCapabilities(recipientId: string, now: string) {
    for (const [id, capability] of this.capabilities) {
      if (capability.recipientId === recipientId && capability.state === 'active') {
        this.capabilities.set(id, { ...capability, state: 'revoked', revokedAt: now });
      }
    }
  }

  async replaceRecipient(input: ReplaceRecipientRepositoryInput) {
    if ((this.currentRecipient?.id ?? null) !== input.expectedRecipientId
      || !this.consentMatches(input.expectedConsentRevision)) return false;
    if (this.currentRecipient) {
      const replaced = {
        ...this.currentRecipient,
        lifecycle: 'replaced' as const,
        revokedAt: input.recipient.createdAt,
        updatedAt: input.recipient.createdAt,
      };
      this.recipients = this.recipients.map((recipient) => recipient.id === replaced.id ? replaced : recipient);
      this.revokeCapabilities(replaced.id, input.recipient.createdAt);
    }
    this.recipients.push(structuredClone(input.recipient));
    this.currentRecipient = structuredClone(input.recipient);
    this.currentConsent = structuredClone(input.disabledConsent);
    this.consentHistory.push(structuredClone(input.disabledConsent));
    return true;
  }

  async revokeRecipient(input: RevokeRecipientRepositoryInput) {
    if (this.currentRecipient?.id !== input.expectedRecipientId
      || !this.consentMatches(input.expectedConsentRevision)) return false;
    const revoked = {
      ...this.currentRecipient,
      lifecycle: 'revoked' as const,
      revokedAt: input.revokedAt,
      updatedAt: input.revokedAt,
    };
    this.recipients = this.recipients.map((recipient) => recipient.id === revoked.id ? revoked : recipient);
    this.currentRecipient = null;
    this.currentConsent = structuredClone(input.disabledConsent);
    this.consentHistory.push(structuredClone(input.disabledConsent));
    this.revokeCapabilities(revoked.id, input.revokedAt);
    return true;
  }

  async storeVerificationCapability(input: {
    profileId: number;
    expectedRecipientId: string;
    requestedAt: string;
    capability: StoredEmailCapability;
  }) {
    if (this.currentRecipient?.id !== input.expectedRecipientId
      || this.currentRecipient.lifecycle !== 'pending') return false;
    this.revokeCapabilities(input.expectedRecipientId, input.requestedAt);
    this.capabilities.set(input.capability.id, structuredClone(input.capability));
    this.currentRecipient = {
      ...this.currentRecipient,
      verificationRequestedAt: input.requestedAt,
      updatedAt: input.requestedAt,
    };
    this.recipients = this.recipients.map((recipient) => (
      recipient.id === input.expectedRecipientId ? structuredClone(this.currentRecipient as EmailRecipient) : recipient
    ));
    return true;
  }

  async loadCapabilityForAttempt(input: {
    profileId: number;
    capabilityId: string;
    purpose: 'verification' | 'unsubscribe';
    attemptedAt: string;
    maximumAttempts: number;
  }) {
    const capability = this.capabilities.get(input.capabilityId);
    if (!capability || capability.profileId !== input.profileId || capability.purpose !== input.purpose
      || capability.state !== 'active' || capability.attemptCount >= input.maximumAttempts) return null;
    const attempted = {
      ...capability,
      attemptCount: capability.attemptCount + 1,
      lastAttemptAt: input.attemptedAt,
    };
    this.capabilities.set(input.capabilityId, attempted);
    return structuredClone(attempted);
  }

  async consumeVerification(input: {
    profileId: number;
    recipientId: string;
    capabilityId: string;
    tokenHash: string;
    confirmedAt: string;
  }) {
    const capability = this.capabilities.get(input.capabilityId);
    if (!capability || capability.profileId !== input.profileId
      || capability.recipientId !== input.recipientId || capability.tokenHash !== input.tokenHash
      || capability.state !== 'active' || this.currentRecipient?.id !== input.recipientId
      || this.currentRecipient.lifecycle !== 'pending') return false;
    this.capabilities.set(input.capabilityId, {
      ...capability, state: 'consumed', consumedAt: input.confirmedAt,
    });
    this.currentRecipient = {
      ...this.currentRecipient,
      lifecycle: 'verified',
      verifiedAt: input.confirmedAt,
      updatedAt: input.confirmedAt,
    };
    this.recipients = this.recipients.map((recipient) => (
      recipient.id === input.recipientId ? structuredClone(this.currentRecipient as EmailRecipient) : recipient
    ));
    return true;
  }

  async enableEmailConsent(input: EnableEmailConsentRepositoryInput) {
    if (this.currentRecipient?.id !== input.expectedRecipientId
      || this.currentRecipient.lifecycle !== 'verified'
      || !this.consentMatches(input.expectedEmailConsentRevision)
      || (this.notificationPreference?.revision ?? 0) !== input.expectedNotificationPreferenceRevision) return false;
    this.notificationPreference = structuredClone(input.notificationPreference);
    this.currentConsent = structuredClone(input.emailConsent);
    this.consentHistory.push(structuredClone(input.emailConsent));
    this.revokeCapabilities(input.expectedRecipientId, input.emailConsent.createdAt);
    this.capabilities.set(input.unsubscribeCapability.id, structuredClone(input.unsubscribeCapability));
    return true;
  }

  async disableEmailConsent(input: {
    profileId: number;
    expectedRecipientId: string;
    expectedConsentRevision: number;
    consent: EmailConsentSnapshot;
  }) {
    if (this.currentRecipient?.id !== input.expectedRecipientId
      || !this.consentMatches(input.expectedConsentRevision)) return false;
    this.currentConsent = structuredClone(input.consent);
    this.consentHistory.push(structuredClone(input.consent));
    this.revokeCapabilities(input.expectedRecipientId, input.consent.createdAt);
    return true;
  }

  async consumeUnsubscribe(input: {
    profileId: number;
    expectedRecipientId: string;
    capabilityId: string;
    tokenHash: string;
    expectedConsentRevision: number;
    consent: EmailConsentSnapshot;
  }) {
    const capability = this.capabilities.get(input.capabilityId);
    if (!capability || capability.profileId !== input.profileId || capability.state !== 'active'
      || capability.recipientId !== input.expectedRecipientId
      || capability.tokenHash !== input.tokenHash
      || capability.consentRevision !== input.expectedConsentRevision
      || !this.consentMatches(input.expectedConsentRevision)) return false;
    this.capabilities.set(input.capabilityId, {
      ...capability, state: 'consumed', consumedAt: input.consent.createdAt,
    });
    this.currentConsent = structuredClone(input.consent);
    this.consentHistory.push(structuredClone(input.consent));
    return true;
  }
}

function fixture() {
  const repository = new MemoryEmailRepository();
  let clock = '2026-08-25T06:30:00.000Z';
  let recipientSequence = 0;
  let randomSequence = 0;
  const primitives = {
    ...webCryptoEmailCapabilityPrimitives,
    randomBytes(length: number) {
      randomSequence += 1;
      return Uint8Array.from({ length }, (_, index) => (index + randomSequence) % 256);
    },
  };
  const service = new EmailRecipientService({
    repository,
    runtime: {
      now: () => clock,
      recipientId: () => `recipient_${++recipientSequence}`,
      verificationExpiresAt: (issuedAt) => new Date(Date.parse(issuedAt) + 86_400_000).toISOString(),
    },
    capabilitySecret: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    capabilityPrimitives: primitives,
    initialTimeZone: 'Asia/Jerusalem',
  });
  return { repository, service, setClock(value: string) { clock = value; } };
}

test('registration is canonical, masked, pending, and deny-by-default', async () => {
  const { repository, service } = fixture();
  const recipient = await service.register(1, '  First.Last+alerts@EXAMPLE.COM  ');
  assert.equal(recipient.canonicalEmail, 'First.Last+alerts@example.com');
  assert.equal(recipient.maskedEmail, 'F***@e***.com');
  assert.equal(recipient.lifecycle, 'pending');
  assert.equal(repository.currentConsent?.masterConsent, false);
  assert.deepEqual(Object.values(repository.currentConsent?.categories ?? {}), [false, false, false, false]);
  assert.equal((await service.register(1, recipient.canonicalEmail)).id, recipient.id);
  assert.equal(repository.recipients.length, 1);
});

test('replacement revokes old capabilities and requires new verification and consent', async () => {
  const { repository, service, setClock } = fixture();
  const first = await service.register(1, 'first@example.com');
  const verification = await service.requestVerification(1);
  setClock('2026-08-25T07:00:00.000Z');
  const second = await service.register(1, 'second@example.com');
  assert.notEqual(second.id, first.id);
  assert.equal(second.lifecycle, 'pending');
  assert.equal(repository.capabilities.get(verification.capabilityId)?.state, 'revoked');
  assert.equal(repository.currentConsent?.recipientId, second.id);
  assert.equal(repository.currentConsent?.masterConsent, false);
  assert.equal(await service.confirmVerification(1, verification.verificationToken), false);
});

test('verification tokens are hashed, bounded, single-use, and never grant consent', async () => {
  const { repository, service, setClock } = fixture();
  await service.register(1, 'verified@example.com');
  const issued = await service.requestVerification(1);
  const stored = repository.capabilities.get(issued.capabilityId);
  assert.ok(stored);
  assert.match(stored.tokenHash, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(issued.verificationToken, 'u'));
  setClock('2026-08-25T06:45:00.000Z');
  assert.equal(await service.confirmVerification(1, issued.verificationToken), true);
  assert.equal(repository.currentRecipient?.lifecycle, 'verified');
  assert.equal(repository.currentConsent?.masterConsent, false);
  assert.equal(await service.confirmVerification(1, issued.verificationToken), false);
  assert.equal(repository.consentHistory.length, 1);
});

test('enabling channel consent requires verification and preserves broader notification preferences', async () => {
  const { repository, service, setClock } = fixture();
  await service.register(1, 'consent@example.com');
  await assert.rejects(
    () => service.enableConsent(1, ['target_hit']),
    (error: unknown) => error instanceof EmailRecipientServiceError
      && error.code === 'recipient_unverified',
  );
  const issued = await service.requestVerification(1);
  setClock('2026-08-25T06:45:00.000Z');
  await service.confirmVerification(1, issued.verificationToken);
  repository.notificationPreference = {
    profileId: 1,
    schemaVersion: 'forecast-notification-preferences-1.0.0',
    revision: 4,
    masterConsent: false,
    categories: {
      target_hit: false, invalidated: true, expired: false, needs_review: false,
    },
    timeZone: 'America/New_York',
    quietHours: { start: '22:00', end: '07:00' },
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  };
  setClock('2026-08-25T07:00:00.000Z');
  const consent = await service.enableConsent(1, ['target_hit', 'expired']);
  assert.equal(consent.masterConsent, true);
  assert.deepEqual(consent.categories, {
    target_hit: true, invalidated: false, expired: true, needs_review: false,
  });
  assert.equal(repository.notificationPreference?.masterConsent, true);
  assert.deepEqual(repository.notificationPreference?.categories, {
    target_hit: true, invalidated: true, expired: true, needs_review: false,
  });
  assert.equal(repository.notificationPreference?.timeZone, 'America/New_York');
  assert.deepEqual(repository.notificationPreference?.quietHours, { start: '22:00', end: '07:00' });
  assert.equal(repository.notificationPreference?.createdAt, '2026-08-20T00:00:00.000Z');
  assert.equal([...repository.capabilities.values()].some((capability) => (
    capability.purpose === 'unsubscribe' && capability.state === 'active'
  )), true);
});

test('unsubscribe disables only email consent and is idempotent', async () => {
  const { repository, service, setClock } = fixture();
  await service.register(1, 'unsubscribe@example.com');
  const verification = await service.requestVerification(1);
  setClock('2026-08-25T06:40:00.000Z');
  await service.confirmVerification(1, verification.verificationToken);
  setClock('2026-08-25T06:50:00.000Z');
  await service.enableConsent(1, ['needs_review']);
  const capability = [...repository.capabilities.values()].find((value) => value.purpose === 'unsubscribe');
  assert.ok(capability);
  const token = await import('./server/email/capability.ts').then(({ materializeEmailCapability }) => (
    materializeEmailCapability(
      capability,
      Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      { ...webCryptoEmailCapabilityPrimitives, randomBytes: () => new Uint8Array() },
    )
  ));
  const preservedPreference = structuredClone(repository.notificationPreference);
  const historyBefore = repository.consentHistory.length;
  setClock('2026-08-25T07:00:00.000Z');
  assert.equal(await service.unsubscribe(1, token), true);
  assert.equal(repository.currentConsent?.masterConsent, false);
  assert.equal(repository.currentConsent?.source, 'unsubscribe');
  assert.deepEqual(repository.notificationPreference, preservedPreference);
  assert.equal(await service.unsubscribe(1, token), false);
  assert.equal(repository.consentHistory.length, historyBefore + 1);
});

test('verification and unsubscribe GETs never expose tokens and emit defensive headers', async () => {
  const request = new Request(`https://northstar.example/email/verify?token=v1.${'a'.repeat(24)}.${'b'.repeat(43)}`);
  for (const response of [verificationConfirmationGet(request), unsubscribeConfirmationGet(request)]) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store, private');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('content-security-policy') ?? '', /form-action 'self'/u);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
    assert.doesNotMatch(await response.text(), /v1\.|name="token"|action=/u);
  }
});

test('public POST cores are bounded, generic, and support human and one-click unsubscribe', async () => {
  const calls: string[] = [];
  const actions: EmailPublicActionService = {
    async confirmVerification(token) { calls.push(`verify:${token}`); return true; },
    async unsubscribe(token) { calls.push(`unsubscribe:${token}`); return true; },
  };
  const token = `v1.${'a'.repeat(24)}.${'b'.repeat(43)}`;
  const verification = await verificationConfirmationPost(new Request(`https://northstar.example/email/verify?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ confirm: 'verify' }),
  }), actions);
  assert.equal(verification.status, 200);
  assert.deepEqual(calls, [`verify:${token}`]);

  const invalid = await verificationConfirmationPost(new Request('https://northstar.example/email/verify?token=invalid', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ confirm: 'verify' }),
  }), actions);
  assert.equal(await invalid.text(), await verification.clone().text());
  assert.equal(calls.length, 1);

  let lazyResolutions = 0;
  await verificationConfirmationPost(new Request('https://northstar.example/email/verify?token=invalid', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ confirm: 'verify' }),
  }), async () => {
    lazyResolutions += 1;
    return actions;
  });
  assert.equal(lazyResolutions, 0);

  await verificationConfirmationPost(new Request(`https://northstar.example/email/verify?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ confirm: 'verify' }),
  }), async () => {
    lazyResolutions += 1;
    return actions;
  });
  assert.equal(lazyResolutions, 1);

  await unsubscribeConfirmationPost(new Request(`https://northstar.example/email/unsubscribe?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ confirm: 'unsubscribe' }),
  }), actions);
  await unsubscribeConfirmationPost(new Request(`https://northstar.example/email/unsubscribe?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  }), actions);
  assert.deepEqual(calls.slice(2), [`unsubscribe:${token}`, `unsubscribe:${token}`]);

  const oversized = await verificationConfirmationPost(new Request('https://northstar.example/email/verify', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': '9999',
    },
    body: 'token=x',
  }), actions);
  assert.equal(oversized.status, 413);
});
