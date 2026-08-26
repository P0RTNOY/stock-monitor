import {
  AUTHORIZATION_ACTIONS,
  type AuthorizationAction,
  type AuthorizationDecision,
  type MembershipRole,
  type Principal,
  type ResourceScope,
} from './types.ts';

const ACTION_SET = new Set<string>(AUTHORIZATION_ACTIONS);

const VIEWER_ACTIONS = new Set<AuthorizationAction>([
  'profile_read',
  'workspace_read',
  'market_read',
  'market_search',
  'forecast_list',
  'forecast_read',
  'evaluation_read',
  'review_list',
  'review_read',
  'in_app_notification_list',
  'in_app_notification_read',
]);

const EDITOR_ACTIONS = new Set<AuthorizationAction>([
  ...VIEWER_ACTIONS,
  'analysis_run',
  'forecast_create',
  'forecast_edit',
  'forecast_delete',
  'forecast_activate',
  'forecast_cancel',
  'forecast_note',
  'forecast_evaluate',
  'review_acknowledge',
  'in_app_notification_state_update',
]);

const OWNER_ACTIONS = new Set<AuthorizationAction>([
  ...EDITOR_ACTIONS,
  'profile_update',
  'portfolio_write',
  'email_recipient_administer',
  'email_consent_administer',
  'membership_administer',
]);

export const HUMAN_ROLE_ACTIONS: Readonly<Record<MembershipRole, ReadonlySet<AuthorizationAction>>> = {
  owner: OWNER_ACTIONS,
  editor: EDITOR_ACTIONS,
  viewer: VIEWER_ACTIONS,
};

function denied(reason: AuthorizationDecision['reason']): AuthorizationDecision {
  return { allowed: false, reason };
}

function profileMatches(principal: { profileId: number }, resource: ResourceScope) {
  return resource.profileId !== undefined && resource.profileId === principal.profileId;
}

/** Pure, deterministic and deny-by-default authorization policy. */
export function authorize(
  principal: Principal,
  action: AuthorizationAction | string,
  resource: ResourceScope = {},
): AuthorizationDecision {
  if (!ACTION_SET.has(action)) return denied('unknown_action');
  const typedAction = action as AuthorizationAction;

  if (principal.kind === 'anonymous') return denied('unauthenticated');

  if (principal.kind === 'human') {
    if (principal.userStatus !== 'active') return denied('user_disabled');
    if (principal.membershipStatus !== 'active') return denied('membership_inactive');
    if (!profileMatches(principal, resource)) return denied('wrong_profile');
    const allowedActions = HUMAN_ROLE_ACTIONS[principal.role];
    return allowedActions?.has(typedAction)
      ? { allowed: true, reason: 'allowed' }
      : denied('insufficient_role');
  }

  if (principal.kind === 'system_scheduler') {
    if (!profileMatches(principal, resource)) return denied('wrong_profile');
    return typedAction === 'scheduler_coordinate'
      ? { allowed: true, reason: 'allowed' }
      : denied('system_action_not_allowed');
  }

  if (principal.kind === 'system_operator') {
    if (!profileMatches(principal, resource)) return denied('wrong_profile');
    return typedAction === principal.allowedAction
      ? { allowed: true, reason: 'allowed' }
      : denied('system_action_not_allowed');
  }

  if (principal.kind === 'provider_resend') {
    if (typedAction !== 'resend_webhook_reconcile') return denied('provider_action_not_allowed');
    if (resource.providerEventId !== principal.webhookId) {
      return denied('resource_unavailable');
    }
    return { allowed: true, reason: 'allowed' };
  }

  if (!profileMatches(principal, resource)) return denied('wrong_profile');
  if (principal.kind === 'capability_email_verification'
    && typedAction !== 'email_verification_consume') return denied('capability_purpose_mismatch');
  if (principal.kind === 'capability_email_unsubscribe'
    && typedAction !== 'email_unsubscribe_consume') return denied('capability_purpose_mismatch');
  if (resource.capabilityId !== principal.capabilityId) {
    return denied('resource_unavailable');
  }
  if (resource.recipientId !== principal.recipientId) {
    return denied('resource_unavailable');
  }
  if (principal.kind === 'capability_email_verification') {
    if (resource.now === undefined) return denied('resource_unavailable');
    if (principal.expiresAt <= resource.now) return denied('capability_expired');
    return { allowed: true, reason: 'allowed' };
  }
  if (resource.consentRevision !== principal.consentRevision) {
    return denied('resource_unavailable');
  }
  return { allowed: true, reason: 'allowed' };
}
