import { authConfigurationFromEnv, AuthConfigurationError, type AuthEnvironmentBindings } from './config.ts';
import { authorizeProfileScope, AuthorizationBoundaryError, type AuthorizedProfileScope } from './enforcement.ts';
import type { AuthorizationAction, OperatorPrincipal, SchedulerPrincipal } from './types.ts';

export const OPERATOR_COMMAND_ACTIONS = {
  'forecast:coordinate': 'scheduler_coordinate',
  'forecast:notifications:project': 'notification_projection',
  'forecast:notifications:backfill': 'notification_projection',
  'forecast:notifications:status': 'operator_status_inspect',
  'forecast:notifications:in-app:project': 'notification_projection',
  'forecast:notifications:in-app:backfill': 'notification_projection',
  'forecast:notifications:in-app:status': 'operator_status_inspect',
  'forecast:schedule:simulate': 'scheduler_coordinate',
  'forecast:schedule:status': 'operator_status_inspect',
  'forecast:email:recipient:status': 'operator_status_inspect',
  'forecast:email:recipient:administer': 'email_recipient_administer',
  'forecast:email:consent:status': 'operator_status_inspect',
  'forecast:email:consent:administer': 'email_consent_administer',
  'forecast:email:verification:send': 'email_dispatch',
  'forecast:email:dispatch': 'email_dispatch',
  'forecast:email:status': 'operator_status_inspect',
} as const satisfies Record<string, AuthorizationAction>;

function configuredProfileId(bindings: unknown) {
  let configuration;
  try {
    configuration = authConfigurationFromEnv(bindings as AuthEnvironmentBindings);
  } catch (error) {
    if (error instanceof AuthConfigurationError) throw new AuthorizationBoundaryError('configuration_invalid');
    throw error;
  }
  if (configuration.systemProfileId === null) {
    throw new AuthorizationBoundaryError('configuration_invalid');
  }
  return configuration;
}

export function trustedSchedulerScope(
  bindings: unknown,
  schedulerVersion: string,
): AuthorizedProfileScope<'scheduler_coordinate'> {
  const configuration = configuredProfileId(bindings);
  const principal: SchedulerPrincipal = {
    kind: 'system_scheduler',
    actorId: 'northstar_forecast_scheduler',
    profileId: configuration.systemProfileId as number,
    schedulerVersion,
  };
  return authorizeProfileScope(principal, 'scheduler_coordinate', { profileId: principal.profileId });
}

export function trustedOperatorScope<A extends AuthorizationAction>(
  bindings: unknown,
  action: A,
  command: string,
): AuthorizedProfileScope<A> {
  const configuration = configuredProfileId(bindings);
  if (configuration.environment !== 'local' && configuration.environment !== 'test') {
    throw new AuthorizationBoundaryError('configuration_invalid');
  }
  const fixedAction = OPERATOR_COMMAND_ACTIONS[command as keyof typeof OPERATOR_COMMAND_ACTIONS];
  if (!fixedAction || fixedAction !== action) {
    throw new AuthorizationBoundaryError('configuration_invalid');
  }
  const principal: OperatorPrincipal = {
    kind: 'system_operator',
    actorId: 'northstar_local_operator',
    profileId: configuration.systemProfileId as number,
    allowedAction: action,
    command,
  };
  return authorizeProfileScope(principal, action, { profileId: principal.profileId });
}
