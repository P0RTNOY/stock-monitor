import { assertSafeEmailHeaderValue } from './safety.ts';

export const EMAIL_ADDRESS_MAX_LENGTH = 254;
export const EMAIL_LOCAL_PART_MAX_LENGTH = 64;

export type CanonicalEmailAddress = string & { readonly __canonicalEmailAddress: unique symbol };

export class EmailAddressValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailAddressValidationError';
  }
}

const LOCAL_ATOM_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u;
const DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const DISPLAY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,'-]{0,79}$/u;

/**
 * Phase 2C2B supports a conservative ASCII dot-atom mailbox. It trims only
 * outer whitespace, preserves the local part exactly, and lowercases only the
 * domain. It never rewrites dots, plus tags, aliases, or local-part casing.
 */
export function normalizeEmailAddress(value: unknown): CanonicalEmailAddress {
  if (typeof value !== 'string') throw new EmailAddressValidationError('Email address must be text.');
  const candidate = value.trim();
  if (!candidate || candidate.length > EMAIL_ADDRESS_MAX_LENGTH
    || /[\u0000-\u0020\u007f-\uffff]/u.test(candidate)) {
    throw new EmailAddressValidationError('Email address is invalid or unsupported.');
  }
  const at = candidate.lastIndexOf('@');
  if (at <= 0 || at !== candidate.indexOf('@')) {
    throw new EmailAddressValidationError('Email address must contain one mailbox separator.');
  }
  const local = candidate.slice(0, at);
  const domain = candidate.slice(at + 1);
  if (local.length > EMAIL_LOCAL_PART_MAX_LENGTH || !LOCAL_ATOM_PATTERN.test(local)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    throw new EmailAddressValidationError('Email local part is invalid or unsupported.');
  }
  if (!domain || domain.length > 253 || domain.startsWith('.') || domain.endsWith('.')
    || !domain.includes('.')) {
    throw new EmailAddressValidationError('Email domain is invalid or unsupported.');
  }
  const labels = domain.split('.');
  if (labels.some((label) => !DOMAIN_LABEL_PATTERN.test(label))) {
    throw new EmailAddressValidationError('Email domain is invalid or unsupported.');
  }
  const canonical = `${local}@${domain.toLowerCase()}`;
  if (canonical.length > EMAIL_ADDRESS_MAX_LENGTH) {
    throw new EmailAddressValidationError('Email address is too large.');
  }
  return canonical as CanonicalEmailAddress;
}

export function maskEmailAddress(value: CanonicalEmailAddress | string) {
  const canonical = normalizeEmailAddress(value);
  const [local, domain] = canonical.split('@') as [string, string];
  const labels = domain.split('.');
  const suffix = labels.at(-1) as string;
  const maskedLocal = local.length === 1 ? '*' : `${local[0]}***`;
  const domainPrefix = labels[0];
  return `${maskedLocal}@${domainPrefix[0]}***.${suffix}`;
}

/** Accepts a bare mailbox or a deliberately narrow ASCII display-name form. */
export function normalizeEmailMailboxHeader(value: unknown) {
  const header = assertSafeEmailHeaderValue(value, 'Email mailbox', 320);
  const match = /^([^<>]+)<([^<>]+)>$/u.exec(header);
  if (!match) return normalizeEmailAddress(header);
  const displayName = match[1].trim();
  if (!DISPLAY_NAME_PATTERN.test(displayName)) {
    throw new EmailAddressValidationError('Email display name is invalid or unsupported.');
  }
  const address = normalizeEmailAddress(match[2].trim());
  return `${displayName} <${address}>`;
}
