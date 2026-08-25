import { isCanonicalUtcInstant } from '../coordinator/contract.ts';
import { bytesToHex } from './safety.ts';
import {
  FORECAST_EMAIL_CAPABILITY_VERSION,
  type EmailCapabilityPurpose,
} from './types.ts';

export type { EmailCapabilityPurpose } from './types.ts';

export const EMAIL_CAPABILITY_WIRE_VERSION = 'v1' as const;
export const EMAIL_CAPABILITY_LOCATOR_BYTES = 18;
export const EMAIL_CAPABILITY_SIGNATURE_BYTES = 32;
export const EMAIL_CAPABILITY_SECRET_MIN_BYTES = 32;
export const EMAIL_CAPABILITY_PURPOSES = ['verification', 'unsubscribe'] as const;

export type PersistedEmailCapability = {
  id: string;
  tokenHash: string;
  tokenVersion: typeof FORECAST_EMAIL_CAPABILITY_VERSION;
  purpose: EmailCapabilityPurpose;
  recipientId: string;
  consentRevision: number | null;
  createdAt: string;
  expiresAt: string | null;
  consumedAt: string | null;
  revokedAt: string | null;
};

export type EmailCapabilityPrimitives = {
  randomBytes(length: number): Uint8Array;
  sha256(value: Uint8Array): Promise<Uint8Array>;
  signHmac(secret: Uint8Array, value: Uint8Array): Promise<Uint8Array>;
  verifyHmac(secret: Uint8Array, value: Uint8Array, signature: Uint8Array): Promise<boolean>;
  secureEqual(left: Uint8Array, right: Uint8Array): boolean;
};

export type IssueEmailCapabilityInput = {
  purpose: EmailCapabilityPurpose;
  recipientId: string;
  consentRevision: number | null;
  createdAt: string;
  expiresAt: string | null;
};

export type VerifyEmailCapabilityInput = {
  token: unknown;
  expectedPurpose: EmailCapabilityPurpose;
  record: PersistedEmailCapability;
  now: string;
};

export type EmailCapabilityVerification = {
  valid: true;
  purpose: EmailCapabilityPurpose;
  recipientId: string;
} | {
  valid: false;
  reason: 'malformed' | 'record_invalid' | 'purpose_mismatch' | 'revoked' | 'used' | 'expired' | 'integrity_failure';
};

export class EmailCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailCapabilityError';
  }
}

function bytes(value: Uint8Array) {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

async function hmacKey(secret: Uint8Array, usage: KeyUsage[]) {
  return globalThis.crypto.subtle.importKey(
    'raw', bytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage,
  );
}

export const webCryptoEmailCapabilityPrimitives: EmailCapabilityPrimitives = {
  randomBytes(length) {
    const value = new Uint8Array(length);
    globalThis.crypto.getRandomValues(value);
    return value;
  },
  async sha256(value) {
    return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes(value)));
  },
  async signHmac(secret, value) {
    return new Uint8Array(await globalThis.crypto.subtle.sign(
      'HMAC', await hmacKey(secret, ['sign']), bytes(value),
    ));
  },
  async verifyHmac(secret, value, signature) {
    return globalThis.crypto.subtle.verify(
      'HMAC', await hmacKey(secret, ['verify']), bytes(signature), bytes(value),
    );
  },
  secureEqual(left, right) {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
    return difference === 0;
  },
};

function base64url(value: Uint8Array) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64url(value: string) {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return null;
  const standard = value.replaceAll('-', '+').replaceAll('_', '/');
  try {
    const binary = atob(standard + '='.repeat((4 - standard.length % 4) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function validSecret(secret: Uint8Array) {
  return secret instanceof Uint8Array
    && secret.length >= EMAIL_CAPABILITY_SECRET_MIN_BYTES && secret.length <= 1_024;
}

function validPurpose(value: unknown): value is EmailCapabilityPurpose {
  return typeof value === 'string' && EMAIL_CAPABILITY_PURPOSES.includes(value as EmailCapabilityPurpose);
}

function validRecipientBinding(recipientId: unknown) {
  return typeof recipientId === 'string' && recipientId.length > 0 && recipientId.length <= 128
    && recipientId.trim() === recipientId && /^[A-Za-z0-9._-]+$/u.test(recipientId);
}

function validRecord(record: PersistedEmailCapability) {
  return record.tokenVersion === FORECAST_EMAIL_CAPABILITY_VERSION && validPurpose(record.purpose)
    && /^[A-Za-z0-9_-]{24}$/u.test(record.id) && /^[a-f0-9]{64}$/u.test(record.tokenHash)
    && validRecipientBinding(record.recipientId)
    && ((record.purpose === 'verification' && record.consentRevision === null)
      || (record.purpose === 'unsubscribe' && Number.isSafeInteger(record.consentRevision)
        && Number(record.consentRevision) > 0))
    && isCanonicalUtcInstant(record.createdAt)
    && (record.expiresAt === null || (
      isCanonicalUtcInstant(record.expiresAt) && record.expiresAt > record.createdAt
    ))
    && (record.purpose !== 'verification' || record.expiresAt !== null)
    && (record.consumedAt === null || (
      isCanonicalUtcInstant(record.consumedAt)
      && record.consumedAt >= record.createdAt
      && (record.expiresAt === null || record.consumedAt < record.expiresAt)
    ))
    && (record.revokedAt === null || (
      isCanonicalUtcInstant(record.revokedAt) && record.revokedAt >= record.createdAt
    ))
    && !(record.consumedAt !== null && record.revokedAt !== null);
}

function signingMessage(record: Pick<
  PersistedEmailCapability,
  'id' | 'tokenVersion' | 'purpose' | 'recipientId' | 'consentRevision'
>) {
  return new TextEncoder().encode(JSON.stringify({
    domain: 'northstar_email_capability',
    wireVersion: EMAIL_CAPABILITY_WIRE_VERSION,
    tokenVersion: record.tokenVersion,
    purpose: record.purpose,
    locator: record.id,
    recipientId: record.recipientId,
    consentRevision: record.consentRevision,
  }));
}

async function tokenFor(
  record: Pick<PersistedEmailCapability,
    'id' | 'tokenVersion' | 'purpose' | 'recipientId' | 'consentRevision'>,
  secret: Uint8Array,
  primitives: EmailCapabilityPrimitives,
) {
  const signature = await primitives.signHmac(secret, signingMessage(record));
  if (signature.length !== EMAIL_CAPABILITY_SIGNATURE_BYTES) {
    throw new EmailCapabilityError('Email capability HMAC has an invalid length.');
  }
  return `${EMAIL_CAPABILITY_WIRE_VERSION}.${record.id}.${base64url(signature)}`;
}

async function tokenHash(token: string, primitives: EmailCapabilityPrimitives) {
  const digest = await primitives.sha256(new TextEncoder().encode(token));
  if (digest.length !== 32) throw new EmailCapabilityError('Email capability digest has an invalid length.');
  return bytesToHex(digest);
}

export async function issueEmailCapability(
  input: IssueEmailCapabilityInput,
  secret: Uint8Array,
  primitives: EmailCapabilityPrimitives = webCryptoEmailCapabilityPrimitives,
) {
  if (!validSecret(secret) || !validPurpose(input.purpose)
    || !validRecipientBinding(input.recipientId)
    || !((input.purpose === 'verification' && input.consentRevision === null)
      || (input.purpose === 'unsubscribe' && Number.isSafeInteger(input.consentRevision)
        && Number(input.consentRevision) > 0))
    || !isCanonicalUtcInstant(input.createdAt)
    || (input.expiresAt !== null && (
      !isCanonicalUtcInstant(input.expiresAt) || input.expiresAt <= input.createdAt
    ))
    || (input.purpose === 'verification' && input.expiresAt === null)) {
    throw new EmailCapabilityError('Email capability issuance input is invalid.');
  }
  const random = primitives.randomBytes(EMAIL_CAPABILITY_LOCATOR_BYTES);
  if (!(random instanceof Uint8Array) || random.length !== EMAIL_CAPABILITY_LOCATOR_BYTES) {
    throw new EmailCapabilityError('Email capability randomness is invalid.');
  }
  const unsigned = {
    id: base64url(random),
    tokenVersion: FORECAST_EMAIL_CAPABILITY_VERSION,
    purpose: input.purpose,
    recipientId: input.recipientId,
    consentRevision: input.consentRevision,
  } as const;
  const token = await tokenFor(unsigned, secret, primitives);
  const record: PersistedEmailCapability = {
    ...unsigned,
    tokenHash: await tokenHash(token, primitives),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    consumedAt: null,
    revokedAt: null,
  };
  return { token, record };
}

/** Reconstructs an immutable capability for a durable retry without storing it plaintext. */
export async function materializeEmailCapability(
  record: PersistedEmailCapability,
  secret: Uint8Array,
  primitives: EmailCapabilityPrimitives = webCryptoEmailCapabilityPrimitives,
) {
  if (!validSecret(secret) || !validRecord(record)) {
    throw new EmailCapabilityError('Persisted email capability is invalid.');
  }
  if (record.consumedAt !== null || record.revokedAt !== null) {
    throw new EmailCapabilityError('Inactive email capability cannot be materialized.');
  }
  const token = await tokenFor(record, secret, primitives);
  const expected = Uint8Array.from(record.tokenHash.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
  const actual = await primitives.sha256(new TextEncoder().encode(token));
  if (!primitives.secureEqual(actual, expected)) {
    throw new EmailCapabilityError('Persisted email capability integrity check failed.');
  }
  return token;
}

function parseToken(value: unknown) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== EMAIL_CAPABILITY_WIRE_VERSION
    || !/^[A-Za-z0-9_-]{24}$/u.test(parts[1])) return null;
  const signature = decodeBase64url(parts[2]);
  return signature?.length === EMAIL_CAPABILITY_SIGNATURE_BYTES
    ? { token: value, locator: parts[1], signature }
    : null;
}

/** Returns only the opaque lookup locator; it authenticates nothing by itself. */
export function emailCapabilityLocator(value: unknown) {
  return parseToken(value)?.locator ?? null;
}

export async function verifyEmailCapability(
  input: VerifyEmailCapabilityInput,
  secret: Uint8Array,
  primitives: EmailCapabilityPrimitives = webCryptoEmailCapabilityPrimitives,
): Promise<EmailCapabilityVerification> {
  const parsed = parseToken(input.token);
  if (!parsed || !validSecret(secret) || !isCanonicalUtcInstant(input.now)) {
    return { valid: false, reason: 'malformed' };
  }
  if (!validRecord(input.record)) return { valid: false, reason: 'record_invalid' };
  if (input.record.purpose !== input.expectedPurpose) return { valid: false, reason: 'purpose_mismatch' };
  if (input.record.revokedAt !== null) return { valid: false, reason: 'revoked' };
  if (input.record.consumedAt !== null) return { valid: false, reason: 'used' };
  if (input.record.expiresAt !== null && input.now >= input.record.expiresAt) {
    return { valid: false, reason: 'expired' };
  }
  if (parsed.locator !== input.record.id) return { valid: false, reason: 'integrity_failure' };
  const signatureValid = await primitives.verifyHmac(
    secret, signingMessage(input.record), parsed.signature,
  );
  const digest = await primitives.sha256(new TextEncoder().encode(parsed.token));
  const expected = Uint8Array.from(input.record.tokenHash.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
  if (!signatureValid || !primitives.secureEqual(digest, expected)) {
    return { valid: false, reason: 'integrity_failure' };
  }
  return {
    valid: true,
    purpose: input.record.purpose,
    recipientId: input.record.recipientId,
  };
}
