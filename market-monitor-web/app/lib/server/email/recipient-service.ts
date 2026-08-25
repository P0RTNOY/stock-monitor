import { isCanonicalUtcInstant } from '../coordinator/contract.ts';
import {
  NOTIFICATION_PREFERENCE_SCHEMA_VERSION,
  isValidIanaTimeZone,
  normalizeNotificationPreferenceSnapshot,
  type NotificationPreferenceSnapshot,
} from '../notifications/preference.ts';
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from '../notifications/types.ts';
import { maskEmailAddress, normalizeEmailAddress } from './address.ts';
import {
  emailCapabilityLocator,
  issueEmailCapability,
  verifyEmailCapability,
  webCryptoEmailCapabilityPrimitives,
  type EmailCapabilityPrimitives,
  type PersistedEmailCapability,
} from './capability.ts';
import {
  FORECAST_EMAIL_CONSENT_VERSION,
  type EmailCapabilityState,
  type EmailConsentSnapshot,
  type EmailRecipient,
} from './types.ts';

export const EMAIL_PUBLIC_CAPABILITY_MAX_ATTEMPTS = 5;

export type StoredEmailCapability = PersistedEmailCapability & {
  profileId: number;
  state: EmailCapabilityState;
  consentRevision: number | null;
  attemptCount: number;
  lastAttemptAt: string | null;
};

export type EmailRecipientState = {
  currentRecipient: EmailRecipient | null;
  currentConsent: EmailConsentSnapshot | null;
  notificationPreference: NotificationPreferenceSnapshot | null;
  latestRecipientRevision: number;
};

export type ReplaceRecipientRepositoryInput = {
  profileId: number;
  expectedRecipientId: string | null;
  expectedConsentRevision: number;
  recipient: EmailRecipient;
  disabledConsent: EmailConsentSnapshot;
};

export type RevokeRecipientRepositoryInput = {
  profileId: number;
  expectedRecipientId: string;
  expectedConsentRevision: number;
  revokedAt: string;
  disabledConsent: EmailConsentSnapshot;
};

export type EnableEmailConsentRepositoryInput = {
  profileId: number;
  expectedRecipientId: string;
  expectedEmailConsentRevision: number;
  expectedNotificationPreferenceRevision: number;
  emailConsent: EmailConsentSnapshot;
  notificationPreference: NotificationPreferenceSnapshot;
  unsubscribeCapability: StoredEmailCapability;
};

export interface EmailRecipientRepository {
  readRecipientState(profileId: number): Promise<EmailRecipientState>;
  replaceRecipient(input: ReplaceRecipientRepositoryInput): Promise<boolean>;
  revokeRecipient(input: RevokeRecipientRepositoryInput): Promise<boolean>;
  storeVerificationCapability(input: {
    profileId: number;
    expectedRecipientId: string;
    requestedAt: string;
    capability: StoredEmailCapability;
  }): Promise<boolean>;
  loadCapabilityForAttempt(input: {
    profileId: number;
    capabilityId: string;
    purpose: 'verification' | 'unsubscribe';
    attemptedAt: string;
    maximumAttempts: number;
  }): Promise<StoredEmailCapability | null>;
  consumeVerification(input: {
    profileId: number;
    recipientId: string;
    capabilityId: string;
    tokenHash: string;
    confirmedAt: string;
  }): Promise<boolean>;
  enableEmailConsent(input: EnableEmailConsentRepositoryInput): Promise<boolean>;
  disableEmailConsent(input: {
    profileId: number;
    expectedRecipientId: string;
    expectedConsentRevision: number;
    consent: EmailConsentSnapshot;
  }): Promise<boolean>;
  consumeUnsubscribe(input: {
    profileId: number;
    expectedRecipientId: string;
    capabilityId: string;
    tokenHash: string;
    expectedConsentRevision: number;
    consent: EmailConsentSnapshot;
  }): Promise<boolean>;
}

export type EmailRecipientRuntime = {
  now(): string;
  recipientId(): string;
  verificationExpiresAt(issuedAt: string): string;
};

export class EmailRecipientServiceError extends Error {
  readonly code: 'invalid_input' | 'conflict' | 'recipient_unavailable' | 'recipient_unverified';

  constructor(code: EmailRecipientServiceError['code'], message: string) {
    super(message);
    this.name = 'EmailRecipientServiceError';
    this.code = code;
  }
}

function trustedProfileId(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new EmailRecipientServiceError('invalid_input', 'Trusted email profile is invalid.');
  }
  return value;
}

function instant(value: string, label: string) {
  if (!isCanonicalUtcInstant(value)) {
    throw new EmailRecipientServiceError('invalid_input', `${label} is invalid.`);
  }
  return value;
}

function recipientId(value: string) {
  if (!value || value.length > 128 || !/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new EmailRecipientServiceError('invalid_input', 'Generated recipient identity is invalid.');
  }
  return value;
}

function disabledCategories() {
  return Object.fromEntries(NOTIFICATION_CATEGORIES.map((category) => [category, false])) as Record<NotificationCategory, boolean>;
}

function selectedCategories(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > NOTIFICATION_CATEGORIES.length) {
    throw new EmailRecipientServiceError('invalid_input', 'At least one bounded email category is required.');
  }
  const selected = new Set<NotificationCategory>();
  for (const category of value) {
    if (typeof category !== 'string'
      || !NOTIFICATION_CATEGORIES.includes(category as NotificationCategory)
      || selected.has(category as NotificationCategory)) {
      throw new EmailRecipientServiceError('invalid_input', 'Email categories are invalid or duplicated.');
    }
    selected.add(category as NotificationCategory);
  }
  return Object.fromEntries(
    NOTIFICATION_CATEGORIES.map((category) => [category, selected.has(category)]),
  ) as Record<NotificationCategory, boolean>;
}

function disabledConsent(
  state: EmailRecipientState,
  profileId: number,
  recipient: EmailRecipient,
  now: string,
  source: EmailConsentSnapshot['source'],
): EmailConsentSnapshot {
  return {
    profileId,
    revision: (state.currentConsent?.revision ?? 0) + 1,
    recipientId: recipient.id,
    schemaVersion: FORECAST_EMAIL_CONSENT_VERSION,
    masterConsent: false,
    categories: disabledCategories(),
    source,
    consentedAt: null,
    revokedAt: now,
    createdAt: now,
  };
}

function storedCapability(
  record: PersistedEmailCapability,
  profileId: number,
  consentRevision: number | null,
): StoredEmailCapability {
  return {
    ...record,
    profileId,
    state: 'active',
    consentRevision,
    attemptCount: 0,
    lastAttemptAt: null,
  };
}

export class EmailRecipientService {
  private readonly repository: EmailRecipientRepository;
  private readonly runtime: EmailRecipientRuntime;
  private readonly capabilitySecret: Uint8Array;
  private readonly capabilityPrimitives: EmailCapabilityPrimitives;
  private readonly initialTimeZone: string;

  constructor(input: {
    repository: EmailRecipientRepository;
    runtime: EmailRecipientRuntime;
    capabilitySecret: Uint8Array;
    capabilityPrimitives?: EmailCapabilityPrimitives;
    initialTimeZone: string;
  }) {
    if (!isValidIanaTimeZone(input.initialTimeZone)) {
      throw new EmailRecipientServiceError('invalid_input', 'Initial notification timezone is invalid.');
    }
    this.repository = input.repository;
    this.runtime = input.runtime;
    this.capabilitySecret = input.capabilitySecret;
    this.capabilityPrimitives = input.capabilityPrimitives ?? webCryptoEmailCapabilityPrimitives;
    this.initialTimeZone = input.initialTimeZone;
  }

  async status(profileId: number) {
    return this.repository.readRecipientState(trustedProfileId(profileId));
  }

  async register(profileId: number, address: unknown) {
    const trusted = trustedProfileId(profileId);
    const canonicalEmail = normalizeEmailAddress(address);
    const state = await this.repository.readRecipientState(trusted);
    if (state.currentRecipient?.canonicalEmail === canonicalEmail) return state.currentRecipient;
    const now = instant(this.runtime.now(), 'Recipient registration time');
    const recipient: EmailRecipient = {
      id: recipientId(this.runtime.recipientId()),
      profileId: trusted,
      revision: state.latestRecipientRevision + 1,
      canonicalEmail,
      maskedEmail: maskEmailAddress(canonicalEmail),
      lifecycle: 'pending',
      verificationRequestedAt: null,
      verifiedAt: null,
      revokedAt: null,
      suppressionState: 'none',
      suppressionReason: null,
      suppressedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const consent = disabledConsent(
      state, trusted, recipient, now,
      state.currentRecipient ? 'recipient_replacement' : 'internal',
    );
    if (!await this.repository.replaceRecipient({
      profileId: trusted,
      expectedRecipientId: state.currentRecipient?.id ?? null,
      expectedConsentRevision: state.currentConsent?.revision ?? 0,
      recipient,
      disabledConsent: consent,
    })) throw new EmailRecipientServiceError('conflict', 'Email recipient changed concurrently.');
    return recipient;
  }

  async revoke(profileId: number) {
    const trusted = trustedProfileId(profileId);
    const state = await this.repository.readRecipientState(trusted);
    const current = state.currentRecipient;
    if (!current) return null;
    const now = instant(this.runtime.now(), 'Recipient revocation time');
    const consent = disabledConsent(state, trusted, current, now, 'operator');
    if (!await this.repository.revokeRecipient({
      profileId: trusted,
      expectedRecipientId: current.id,
      expectedConsentRevision: state.currentConsent?.revision ?? 0,
      revokedAt: now,
      disabledConsent: consent,
    })) throw new EmailRecipientServiceError('conflict', 'Email recipient changed concurrently.');
    return { ...current, lifecycle: 'revoked' as const, revokedAt: now, updatedAt: now };
  }

  async requestVerification(profileId: number) {
    const trusted = trustedProfileId(profileId);
    const state = await this.repository.readRecipientState(trusted);
    const recipient = state.currentRecipient;
    if (!recipient || recipient.lifecycle !== 'pending') {
      throw new EmailRecipientServiceError('recipient_unavailable', 'A pending email recipient is required.');
    }
    const now = instant(this.runtime.now(), 'Verification request time');
    const expiresAt = instant(this.runtime.verificationExpiresAt(now), 'Verification expiry');
    if (expiresAt <= now) throw new EmailRecipientServiceError('invalid_input', 'Verification expiry must advance.');
    const issued = await issueEmailCapability({
      purpose: 'verification', recipientId: recipient.id, consentRevision: null,
      createdAt: now, expiresAt,
    }, this.capabilitySecret, this.capabilityPrimitives);
    const capability = storedCapability(issued.record, trusted, null);
    if (!await this.repository.storeVerificationCapability({
      profileId: trusted,
      expectedRecipientId: recipient.id,
      requestedAt: now,
      capability,
    })) throw new EmailRecipientServiceError('conflict', 'Email recipient changed concurrently.');
    return {
      recipient: { ...recipient, verificationRequestedAt: now, updatedAt: now },
      verificationToken: issued.token,
      expiresAt,
      capabilityId: capability.id,
    };
  }

  async confirmVerification(profileId: number, token: unknown) {
    const trusted = trustedProfileId(profileId);
    const capabilityId = emailCapabilityLocator(token);
    if (!capabilityId) return false;
    const now = instant(this.runtime.now(), 'Verification confirmation time');
    const capability = await this.repository.loadCapabilityForAttempt({
      profileId: trusted,
      capabilityId,
      purpose: 'verification',
      attemptedAt: now,
      maximumAttempts: EMAIL_PUBLIC_CAPABILITY_MAX_ATTEMPTS,
    });
    if (!capability) return false;
    const verification = await verifyEmailCapability({
      token,
      expectedPurpose: 'verification',
      record: capability,
      now,
    }, this.capabilitySecret, this.capabilityPrimitives);
    if (!verification.valid || verification.recipientId !== capability.recipientId) return false;
    return this.repository.consumeVerification({
      profileId: trusted,
      recipientId: capability.recipientId,
      capabilityId: capability.id,
      tokenHash: capability.tokenHash,
      confirmedAt: now,
    });
  }

  async enableConsent(profileId: number, categories: unknown) {
    const trusted = trustedProfileId(profileId);
    const enabledCategories = selectedCategories(categories);
    const state = await this.repository.readRecipientState(trusted);
    const recipient = state.currentRecipient;
    if (!recipient || recipient.lifecycle !== 'verified' || !recipient.verifiedAt
      || recipient.suppressionState !== 'none') {
      throw new EmailRecipientServiceError('recipient_unverified', 'A verified active email recipient is required.');
    }
    const now = instant(this.runtime.now(), 'Email consent time');
    const currentPreference = state.notificationPreference === null
      ? null
      : normalizeNotificationPreferenceSnapshot(state.notificationPreference);
    const preference: NotificationPreferenceSnapshot = currentPreference ? {
      ...currentPreference,
      revision: currentPreference.revision + 1,
      masterConsent: true,
      categories: Object.fromEntries(NOTIFICATION_CATEGORIES.map((category) => [
        category,
        currentPreference.categories[category] || enabledCategories[category],
      ])) as Record<NotificationCategory, boolean>,
      updatedAt: now,
    } : {
      profileId: trusted,
      schemaVersion: NOTIFICATION_PREFERENCE_SCHEMA_VERSION,
      revision: 1,
      masterConsent: true,
      categories: { ...enabledCategories },
      timeZone: this.initialTimeZone,
      quietHours: null,
      createdAt: now,
      updatedAt: now,
    };
    const consent: EmailConsentSnapshot = {
      profileId: trusted,
      revision: (state.currentConsent?.revision ?? 0) + 1,
      recipientId: recipient.id,
      schemaVersion: FORECAST_EMAIL_CONSENT_VERSION,
      masterConsent: true,
      categories: enabledCategories,
      source: 'operator',
      consentedAt: now,
      revokedAt: null,
      createdAt: now,
    };
    const issued = await issueEmailCapability({
      purpose: 'unsubscribe', recipientId: recipient.id, consentRevision: consent.revision,
      createdAt: now, expiresAt: null,
    }, this.capabilitySecret, this.capabilityPrimitives);
    const unsubscribeCapability = storedCapability(issued.record, trusted, consent.revision);
    if (!await this.repository.enableEmailConsent({
      profileId: trusted,
      expectedRecipientId: recipient.id,
      expectedEmailConsentRevision: state.currentConsent?.revision ?? 0,
      expectedNotificationPreferenceRevision: currentPreference?.revision ?? 0,
      emailConsent: consent,
      notificationPreference: preference,
      unsubscribeCapability,
    })) throw new EmailRecipientServiceError('conflict', 'Email consent changed concurrently.');
    return consent;
  }

  async disableConsent(profileId: number) {
    const trusted = trustedProfileId(profileId);
    const state = await this.repository.readRecipientState(trusted);
    const recipient = state.currentRecipient;
    if (!recipient || !state.currentConsent) return null;
    if (!state.currentConsent.masterConsent) return state.currentConsent;
    const now = instant(this.runtime.now(), 'Email consent revocation time');
    const consent = disabledConsent(state, trusted, recipient, now, 'operator');
    if (!await this.repository.disableEmailConsent({
      profileId: trusted,
      expectedRecipientId: recipient.id,
      expectedConsentRevision: state.currentConsent.revision,
      consent,
    })) throw new EmailRecipientServiceError('conflict', 'Email consent changed concurrently.');
    return consent;
  }

  async unsubscribe(profileId: number, token: unknown) {
    const trusted = trustedProfileId(profileId);
    const capabilityId = emailCapabilityLocator(token);
    if (!capabilityId) return false;
    const now = instant(this.runtime.now(), 'Unsubscribe time');
    const capability = await this.repository.loadCapabilityForAttempt({
      profileId: trusted,
      capabilityId,
      purpose: 'unsubscribe',
      attemptedAt: now,
      maximumAttempts: EMAIL_PUBLIC_CAPABILITY_MAX_ATTEMPTS,
    });
    if (!capability || capability.consentRevision === null) return false;
    const verification = await verifyEmailCapability({
      token, expectedPurpose: 'unsubscribe', record: capability, now,
    }, this.capabilitySecret, this.capabilityPrimitives);
    if (!verification.valid) return false;
    const state = await this.repository.readRecipientState(trusted);
    if (state.currentRecipient?.id !== capability.recipientId
      || state.currentConsent?.revision !== capability.consentRevision) return false;
    const consent = disabledConsent(
      state, trusted, state.currentRecipient, now, 'unsubscribe',
    );
    return this.repository.consumeUnsubscribe({
      profileId: trusted,
      expectedRecipientId: capability.recipientId,
      capabilityId: capability.id,
      tokenHash: capability.tokenHash,
      expectedConsentRevision: capability.consentRevision,
      consent,
    });
  }
}
