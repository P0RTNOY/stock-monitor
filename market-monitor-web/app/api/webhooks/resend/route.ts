import { env } from 'cloudflare:workers';
import { ensureDatabase, getD1 } from '@/db';
import {
  emailConfigurationFromEnv,
  type EmailEnvironmentBindings,
} from '@/app/lib/server/email/config';
import { createResendWebhookHandler } from '@/app/lib/server/email/webhook-http';
import { D1EmailWebhookRepository } from '@/app/lib/server/email/webhook-repository';
import { ResendWebhookService } from '@/app/lib/server/email/webhook-service';

function configuration() {
  return emailConfigurationFromEnv(env as EmailEnvironmentBindings);
}

export async function POST(request: Request) {
  let config;
  try {
    config = configuration();
  } catch {
    return new Response('Webhook unavailable.', {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
        'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  return createResendWebhookHandler({
    webhookSecret: config.resendWebhookSecret,
    maxBodyBytes: config.webhookMaxBytes,
    now: () => new Date().toISOString(),
    nowEpochSeconds: () => Math.floor(Date.now() / 1_000),
    async service() {
      await ensureDatabase();
      return new ResendWebhookService(
        new D1EmailWebhookRepository(getD1()),
        {
          log(event) {
            console.info(JSON.stringify(event));
          },
        },
      );
    },
  })(request);
}
