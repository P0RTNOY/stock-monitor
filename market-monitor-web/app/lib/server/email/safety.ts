export const EMAIL_MAX_SUBJECT_LENGTH = 160;
export const EMAIL_MAX_HEADER_VALUE_LENGTH = 2_048;

export type EmailSafetyErrorCode =
  | 'invalid_text'
  | 'invalid_header'
  | 'content_too_large';

export class EmailSafetyError extends Error {
  readonly code: EmailSafetyErrorCode;

  constructor(message: string, code: EmailSafetyErrorCode) {
    super(message);
    this.name = 'EmailSafetyError';
    this.code = code;
  }
}

function hasUnpairedSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function assertWellFormedEmailText(value: unknown, maximum: number, label = 'Email text') {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || hasUnpairedSurrogate(value)) {
    throw new EmailSafetyError(`${label} is invalid or too large.`, 'invalid_text');
  }
  return value;
}

/** Escapes both HTML text and quoted-attribute metacharacters. */
export function escapeHtml(value: unknown) {
  if (typeof value !== 'string' || hasUnpairedSurrogate(value)) {
    throw new EmailSafetyError('Dynamic email HTML text is invalid.', 'invalid_text');
  }
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Header values are deliberately stricter than RFC folding rules. Northstar
 * emits one unfolded value and rejects all ASCII controls, including CR/LF.
 */
export function assertSafeEmailHeaderValue(
  value: unknown,
  label = 'Email header',
  maximum = EMAIL_MAX_HEADER_VALUE_LENGTH,
) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)
    || hasUnpairedSurrogate(value)) {
    throw new EmailSafetyError(`${label} is not a safe unfolded header value.`, 'invalid_header');
  }
  return value;
}

export function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}
