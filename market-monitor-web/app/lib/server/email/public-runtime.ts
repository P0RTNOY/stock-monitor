import { env } from 'cloudflare:workers';
import { ensureDatabase, getD1 } from '@/db';
import { decodeEmailCapabilitySecret, type EmailEnvironmentBindings } from './config.ts';
import type { EmailPublicActionService } from './public-actions.ts';
import { EmailRecipientService } from './recipient-service.ts';
import { D1EmailRepository } from './repository.ts';

const VERIFICATION_LIFETIME_MS = 24 * 60 * 60 * 1_000;

/**
 * Resolves mutable dependencies only after a syntactically valid POST intent.
 * Public GET handlers deliberately never call this function.
 */
export async function emailPublicActionService(request: Request): Promise<EmailPublicActionService> {
  void request;
  const bindings = env as EmailEnvironmentBindings;
  if (!bindings.FORECAST_EMAIL_CAPABILITY_SECRET) {
    throw new Error('Email capability verification is unavailable.');
  }
  const capabilitySecret = decodeEmailCapabilitySecret(bindings.FORECAST_EMAIL_CAPABILITY_SECRET);
  await ensureDatabase();
  const recipientService = new EmailRecipientService({
    repository: new D1EmailRepository(getD1()),
    capabilitySecret,
    initialTimeZone: 'UTC',
    runtime: {
      now: () => new Date().toISOString(),
      recipientId: () => crypto.randomUUID(),
      verificationExpiresAt: (issuedAt) => new Date(
        new Date(issuedAt).getTime() + VERIFICATION_LIFETIME_MS,
      ).toISOString(),
    },
  });
  return {
    confirmVerification: (token) => recipientService.confirmVerification(token),
    unsubscribe: (token) => recipientService.unsubscribe(token),
  };
}
