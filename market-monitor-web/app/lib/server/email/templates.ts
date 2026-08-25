import { isCanonicalUtcInstant } from '../coordinator/contract.ts';
import { parseNotificationPayload } from '../notifications/payload.ts';
import type { NotificationCategory, NotificationPayload } from '../notifications/types.ts';
import {
  buildJournalUrl,
  buildUnsubscribeUrl,
  buildVerificationUrl,
  type PublicAppBaseUrl,
} from './links.ts';
import {
  EMAIL_MAX_SUBJECT_LENGTH,
  EmailSafetyError,
  assertSafeEmailHeaderValue,
  escapeHtml,
  sha256Hex,
} from './safety.ts';

export const EMAIL_TEMPLATE_LOCALE = 'en-US' as const;
export const EMAIL_TEMPLATE_MAX_TEXT_LENGTH = 8_192;
export const EMAIL_TEMPLATE_MAX_HTML_LENGTH = 24_576;
export const EMAIL_DISCLAIMER = 'This message reflects a journaled forecast for informational purposes and is not investment advice.';

export const EMAIL_TEMPLATE_VERSIONS = {
  verification: 'northstar-email-verification-1.0.0',
  target_hit: 'northstar-forecast-target-hit-1.0.0',
  invalidated: 'northstar-forecast-invalidated-1.0.0',
  expired: 'northstar-forecast-expired-1.0.0',
  needs_review: 'northstar-forecast-needs-review-1.0.0',
} as const;

export type EmailTemplateId = keyof typeof EMAIL_TEMPLATE_VERSIONS;

type RenderedEmailBase = {
  templateVersion: typeof EMAIL_TEMPLATE_VERSIONS[EmailTemplateId];
  locale: typeof EMAIL_TEMPLATE_LOCALE;
  subject: string;
  text: string;
  html: string;
  contentHash: string;
};

export type ForecastEmailHeaders = Readonly<{
  'List-Unsubscribe': string;
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click';
}>;

export type RenderedForecastEmail = RenderedEmailBase & {
  templateId: NotificationCategory;
  headers: ForecastEmailHeaders;
};

export type RenderedVerificationEmail = RenderedEmailBase & {
  templateId: 'verification';
  headers: Readonly<Record<string, never>>;
};

export type RenderedEmail = RenderedForecastEmail | RenderedVerificationEmail;

export type RenderForecastEmailInput = {
  payload: unknown;
  publicAppBaseUrl: PublicAppBaseUrl;
  unsubscribeToken: string;
};

export type RenderVerificationEmailInput = {
  publicAppBaseUrl: PublicAppBaseUrl;
  verificationToken: string;
  expiresAt: string;
};

const SUBJECTS: Record<NotificationCategory, (symbol: string) => string> = {
  target_hit: (symbol) => `Northstar journal update: ${symbol} target reached`,
  invalidated: (symbol) => `Northstar journal update: ${symbol} forecast invalidated`,
  expired: (symbol) => `Northstar journal update: ${symbol} forecast expired`,
  needs_review: (symbol) => `Northstar journal update: ${symbol} forecast needs review`,
};

function formatPrice(value: number, currency: string) {
  const rendered = value.toFixed(4).replace(/\.0+$/u, '').replace(/(\.\d*?)0+$/u, '$1');
  return `${currency} ${rendered}`;
}

function forecastFacts(payload: NotificationPayload) {
  const facts: Array<readonly [string, string]> = [['Symbol', payload.symbol]];
  switch (payload.category) {
    case 'target_hit':
      facts.push(['Recorded target boundary', formatPrice(payload.targetBoundary as number, payload.activationCurrency)]);
      if (payload.targetRange) {
        facts.push(['Recorded target range', `${formatPrice(payload.targetRange[0], payload.activationCurrency)}–${formatPrice(payload.targetRange[1], payload.activationCurrency)}`]);
      }
      facts.push(['Triggering market date', payload.triggeringMarketDate as string]);
      break;
    case 'invalidated':
      facts.push(['Recorded invalidation boundary', formatPrice(payload.invalidationBoundary as number, payload.activationCurrency)]);
      facts.push(['Triggering market date', payload.triggeringMarketDate as string]);
      break;
    case 'expired':
      facts.push(['Evaluated through', payload.evaluatedThrough as string]);
      break;
    case 'needs_review':
      if (payload.triggeringMarketDate) facts.push(['Relevant market date', payload.triggeringMarketDate]);
      break;
  }
  facts.push(['Journal event recorded', payload.occurredAt]);
  return facts;
}

function forecastLead(category: NotificationCategory) {
  switch (category) {
    case 'target_hit': return 'A forecast in your journal reached its recorded target.';
    case 'invalidated': return 'A forecast in your journal reached its recorded invalidation boundary.';
    case 'expired': return 'A forecast in your journal completed its recorded horizon without a terminal boundary touch.';
    case 'needs_review': return 'A forecast in your journal needs review of its persisted evaluation evidence.';
  }
}

function boundedRenderedContent(subject: string, text: string, html: string) {
  assertSafeEmailHeaderValue(subject, 'Email subject', EMAIL_MAX_SUBJECT_LENGTH);
  if (!text || text.length > EMAIL_TEMPLATE_MAX_TEXT_LENGTH
    || !html || html.length > EMAIL_TEMPLATE_MAX_HTML_LENGTH) {
    throw new EmailSafetyError('Rendered email content exceeds its frozen bound.', 'content_too_large');
  }
}

async function finalize<
  TemplateId extends EmailTemplateId,
  Headers extends Readonly<Record<string, string>>,
>(
  templateId: TemplateId,
  subject: string,
  text: string,
  html: string,
  headers: Headers,
) {
  boundedRenderedContent(subject, text, html);
  const canonicalHeaders = Object.entries(headers).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  for (const [name, value] of canonicalHeaders) {
    if (!/^[A-Za-z0-9-]{1,64}$/u.test(name)) throw new EmailSafetyError('Email header name is invalid.', 'invalid_header');
    assertSafeEmailHeaderValue(value, name);
  }
  const templateVersion = EMAIL_TEMPLATE_VERSIONS[templateId];
  const contentHash = await sha256Hex(JSON.stringify({
    templateId,
    templateVersion,
    locale: EMAIL_TEMPLATE_LOCALE,
    subject,
    text,
    html,
    headers: canonicalHeaders,
  }));
  return {
    templateId,
    templateVersion,
    locale: EMAIL_TEMPLATE_LOCALE,
    subject,
    text,
    html,
    headers,
    contentHash,
  };
}

export async function renderForecastEmail(input: RenderForecastEmailInput) {
  const payload = parseNotificationPayload(input.payload);
  const templateId = payload.category;
  const subject = SUBJECTS[payload.category](payload.symbol);
  const lead = forecastLead(payload.category);
  const journalUrl = buildJournalUrl(input.publicAppBaseUrl);
  const unsubscribeUrl = buildUnsubscribeUrl(input.publicAppBaseUrl, input.unsubscribeToken);
  const facts = forecastFacts(payload);
  const text = [
    'Northstar forecast journal',
    '',
    lead,
    '',
    ...facts.map(([label, value]) => `${label}: ${value}`),
    '',
    `Open your Northstar journal: ${journalUrl}`,
    '',
    EMAIL_DISCLAIMER,
    '',
    `Unsubscribe from forecast email: ${unsubscribeUrl}`,
  ].join('\n');
  const htmlFacts = facts.map(([label, value]) => (
    `<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</li>`
  )).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head><body><main><p>Northstar forecast journal</p><h1>${escapeHtml(lead)}</h1><ul>${htmlFacts}</ul><p><a href="${escapeHtml(journalUrl)}">Open your Northstar journal</a></p><p>${escapeHtml(EMAIL_DISCLAIMER)}</p><p><a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe from forecast email</a></p></main></body></html>`;
  const headers: ForecastEmailHeaders = {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  } as const;
  return finalize(templateId, subject, text, html, headers);
}

export async function renderVerificationEmail(input: RenderVerificationEmailInput) {
  if (!isCanonicalUtcInstant(input.expiresAt)) {
    throw new EmailSafetyError('Verification expiry is invalid.', 'invalid_text');
  }
  const subject = 'Verify your Northstar email';
  const verificationUrl = buildVerificationUrl(input.publicAppBaseUrl, input.verificationToken);
  const text = [
    'Northstar email verification',
    '',
    'Confirm the email address registered for Northstar.',
    'Verification confirms the recipient only. It does not enable forecast emails.',
    '',
    `Confirm email: ${verificationUrl}`,
    `This link expires at ${input.expiresAt}.`,
    '',
    'If you did not request this verification, you can ignore this message.',
  ].join('\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head><body><main><p>Northstar email verification</p><h1>Confirm the email address registered for Northstar.</h1><p>Verification confirms the recipient only. It does not enable forecast emails.</p><p><a href="${escapeHtml(verificationUrl)}">Confirm email</a></p><p>This link expires at ${escapeHtml(input.expiresAt)}.</p><p>If you did not request this verification, you can ignore this message.</p></main></body></html>`;
  return finalize('verification', subject, text, html, {} as Readonly<Record<string, never>>);
}
