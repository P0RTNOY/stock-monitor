import type { ForecastCoordinatorService } from '../coordinator/service.ts';
import type { ForecastEmailDispatchInput, ForecastEmailDispatcherService } from '../email/dispatcher.ts';
import type { EmailRecipientService } from '../email/recipient-service.ts';
import type {
  SendVerificationEmailInput,
  VerificationEmailDeliveryService,
} from '../email/verification-delivery.ts';
import type {
  InAppBackfillInput,
  InAppNotificationService,
  InAppProjectionInput,
} from '../in-app-notifications/service.ts';
import type {
  NotificationHistoricalPreviewInput,
  NotificationProjectorService,
} from '../notifications/service.ts';
import type { NotificationProjectionInput } from '../notifications/contract.ts';
import type { ForecastSchedulerService, RunScheduledInvocationInput } from '../scheduler/service.ts';
import { profileIdFromScope, type AuthorizedProfileScope } from './enforcement.ts';

/**
 * These adapters are the authorization seam for trusted non-human workflows.
 * Domain services retain numeric profile IDs internally, but an operator or
 * Worker cannot invoke them through this seam without an exact-action scope.
 */
export class AuthorizedCoordinatorService {
  private readonly scope: AuthorizedProfileScope<'scheduler_coordinate'>;
  private readonly service: Pick<ForecastCoordinatorService, 'coordinate'>;

  constructor(
    scope: AuthorizedProfileScope<'scheduler_coordinate'>,
    service: Pick<ForecastCoordinatorService, 'coordinate'>,
  ) {
    this.scope = scope;
    this.service = service;
  }

  coordinate(value: unknown) {
    return this.service.coordinate(value, profileIdFromScope(this.scope, 'scheduler_coordinate'));
  }
}

export class AuthorizedSchedulerService {
  private readonly scope: AuthorizedProfileScope<'scheduler_coordinate'>;
  private readonly service: Pick<ForecastSchedulerService, 'run'>;

  constructor(
    scope: AuthorizedProfileScope<'scheduler_coordinate'>,
    service: Pick<ForecastSchedulerService, 'run'>,
  ) {
    this.scope = scope;
    this.service = service;
  }

  run(input: Omit<RunScheduledInvocationInput, 'profileId'>) {
    return this.service.run({
      ...input,
      profileId: profileIdFromScope(this.scope, 'scheduler_coordinate'),
    });
  }
}

export class AuthorizedNotificationProjectorService {
  private readonly scope: AuthorizedProfileScope<'notification_projection'>;
  private readonly service: Pick<NotificationProjectorService, 'project' | 'previewHistoricalBackfill'>;

  constructor(
    scope: AuthorizedProfileScope<'notification_projection'>,
    service: Pick<NotificationProjectorService, 'project' | 'previewHistoricalBackfill'>,
  ) {
    this.scope = scope;
    this.service = service;
  }

  project(input: Omit<NotificationProjectionInput, 'profileId'>) {
    const profileId = profileIdFromScope(this.scope, 'notification_projection');
    return this.service.project({ ...input, profileId }, profileId);
  }

  previewHistoricalBackfill(input: Omit<NotificationHistoricalPreviewInput, 'profileId'>) {
    const profileId = profileIdFromScope(this.scope, 'notification_projection');
    return this.service.previewHistoricalBackfill({ ...input, profileId }, profileId);
  }
}

export class AuthorizedInAppProjectorService {
  private readonly scope: AuthorizedProfileScope<'notification_projection'>;
  private readonly service: Pick<InAppNotificationService, 'project' | 'backfill'>;

  constructor(
    scope: AuthorizedProfileScope<'notification_projection'>,
    service: Pick<InAppNotificationService, 'project' | 'backfill'>,
  ) {
    this.scope = scope;
    this.service = service;
  }

  project(input: Omit<InAppProjectionInput, 'profileId'>) {
    const profileId = profileIdFromScope(this.scope, 'notification_projection');
    return this.service.project({ ...input, profileId }, profileId);
  }

  backfill(input: Omit<InAppBackfillInput, 'profileId'>) {
    const profileId = profileIdFromScope(this.scope, 'notification_projection');
    return this.service.backfill({ ...input, profileId }, profileId);
  }
}

export class AuthorizedEmailDispatcherService {
  private readonly scope: AuthorizedProfileScope<'email_dispatch'>;
  private readonly service: Pick<ForecastEmailDispatcherService, 'dispatch'>;

  constructor(
    scope: AuthorizedProfileScope<'email_dispatch'>,
    service: Pick<ForecastEmailDispatcherService, 'dispatch'>,
  ) {
    this.scope = scope;
    this.service = service;
  }

  dispatch(input: Omit<ForecastEmailDispatchInput, 'profileId'>) {
    return this.service.dispatch({
      ...input,
      profileId: profileIdFromScope(this.scope, 'email_dispatch'),
    });
  }
}

export class AuthorizedEmailRecipientService {
  private readonly scope: AuthorizedProfileScope<'email_recipient_administer'>;
  private readonly service: Pick<EmailRecipientService, 'register' | 'revoke' | 'requestVerification'>;

  constructor(
    scope: AuthorizedProfileScope<'email_recipient_administer'>,
    service: Pick<EmailRecipientService, 'register' | 'revoke' | 'requestVerification'>,
  ) {
    this.scope = scope;
    this.service = service;
  }

  register(address: unknown) {
    return this.service.register(profileIdFromScope(this.scope, 'email_recipient_administer'), address);
  }

  revoke() {
    return this.service.revoke(profileIdFromScope(this.scope, 'email_recipient_administer'));
  }

  requestVerification() {
    return this.service.requestVerification(profileIdFromScope(this.scope, 'email_recipient_administer'));
  }
}

export class AuthorizedEmailConsentService {
  private readonly scope: AuthorizedProfileScope<'email_consent_administer'>;
  private readonly service: Pick<EmailRecipientService, 'enableConsent' | 'disableConsent'>;

  constructor(
    scope: AuthorizedProfileScope<'email_consent_administer'>,
    service: Pick<EmailRecipientService, 'enableConsent' | 'disableConsent'>,
  ) {
    this.scope = scope;
    this.service = service;
  }

  enable(categories: unknown) {
    return this.service.enableConsent(profileIdFromScope(this.scope, 'email_consent_administer'), categories);
  }

  disable() {
    return this.service.disableConsent(profileIdFromScope(this.scope, 'email_consent_administer'));
  }
}

export class AuthorizedVerificationDeliveryService {
  private readonly scope: AuthorizedProfileScope<'email_dispatch'>;
  private readonly service: Pick<VerificationEmailDeliveryService, 'send'>;

  constructor(
    scope: AuthorizedProfileScope<'email_dispatch'>,
    service: Pick<VerificationEmailDeliveryService, 'send'>,
  ) {
    this.scope = scope;
    this.service = service;
  }

  send(input: Omit<SendVerificationEmailInput, 'profileId'>) {
    return this.service.send({
      ...input,
      profileId: profileIdFromScope(this.scope, 'email_dispatch'),
    });
  }
}
