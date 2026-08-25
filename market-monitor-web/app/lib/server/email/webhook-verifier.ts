import { Webhook } from 'standardwebhooks';

export const RESEND_WEBHOOK_TOLERANCE_SECONDS = 300;

export class ResendWebhookVerificationError extends Error {
  readonly code: 'body_too_large' | 'missing_headers' | 'invalid_headers'
    | 'stale_timestamp' | 'invalid_signature';

  constructor(code: ResendWebhookVerificationError['code']) {
    super('Invalid webhook request.');
    this.name = 'ResendWebhookVerificationError';
    this.code = code;
  }
}

export type ResendWebhookHeaders = {
  'svix-id': string | null | undefined;
  'svix-timestamp': string | null | undefined;
  'svix-signature': string | null | undefined;
};

export type VerifiedResendWebhook = {
  webhookId: string;
  timestamp: number;
  payload: unknown;
};

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function verifyResendWebhookRequest(input: {
  rawBody: string;
  headers: ResendWebhookHeaders;
  webhookSecret: string;
  maxBodyBytes: number;
  nowEpochSeconds?: number;
}): VerifiedResendWebhook {
  if (typeof input.rawBody !== 'string'
    || !Number.isSafeInteger(input.maxBodyBytes) || input.maxBodyBytes < 1
    || input.maxBodyBytes > 262_144
    || utf8Length(input.rawBody) > input.maxBodyBytes) {
    throw new ResendWebhookVerificationError('body_too_large');
  }
  const webhookId = input.headers['svix-id'];
  const timestampHeader = input.headers['svix-timestamp'];
  const signature = input.headers['svix-signature'];
  if (!webhookId || !timestampHeader || !signature) {
    throw new ResendWebhookVerificationError('missing_headers');
  }
  if (webhookId.length > 200 || !/^[A-Za-z0-9._:-]+$/u.test(webhookId)
    || timestampHeader.length > 20 || !/^(0|[1-9][0-9]*)$/u.test(timestampHeader)
    || signature.length > 4_096 || /[\r\n\u0000]/u.test(signature)
    || typeof input.webhookSecret !== 'string'
    || input.webhookSecret.length < 10 || input.webhookSecret.length > 512
    || !input.webhookSecret.startsWith('whsec_')) {
    throw new ResendWebhookVerificationError('invalid_headers');
  }
  const timestamp = Number(timestampHeader);
  const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(now)) {
    throw new ResendWebhookVerificationError('invalid_headers');
  }
  if (Math.abs(now - timestamp) > RESEND_WEBHOOK_TOLERANCE_SECONDS) {
    throw new ResendWebhookVerificationError('stale_timestamp');
  }
  try {
    const payload = new Webhook(input.webhookSecret).verify(input.rawBody, {
      'webhook-id': webhookId,
      'webhook-timestamp': timestampHeader,
      'webhook-signature': signature,
    });
    return { webhookId, timestamp, payload };
  } catch {
    throw new ResendWebhookVerificationError('invalid_signature');
  }
}
