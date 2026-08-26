export const AUTHORIZATION_ACTIONS = [
  'profile_read',
  'profile_update',
  'workspace_read',
  'portfolio_write',
  'market_read',
  'market_search',
  'analysis_run',
  'forecast_list',
  'forecast_read',
  'forecast_create',
  'forecast_edit',
  'forecast_delete',
  'forecast_activate',
  'forecast_cancel',
  'forecast_note',
  'forecast_evaluate',
  'evaluation_read',
  'review_list',
  'review_read',
  'review_acknowledge',
  'in_app_notification_list',
  'in_app_notification_read',
  'in_app_notification_state_update',
  'notification_projection',
  'scheduler_coordinate',
  'email_recipient_administer',
  'email_consent_administer',
  'email_dispatch',
  'resend_webhook_reconcile',
  'email_verification_consume',
  'email_unsubscribe_consume',
  'operator_status_inspect',
  'membership_administer',
] as const;

export type AuthorizationAction = typeof AUTHORIZATION_ACTIONS[number];
export type MembershipRole = 'owner' | 'editor' | 'viewer';
export type MembershipStatus = 'active' | 'revoked';
export type UserStatus = 'active' | 'disabled';

type ProfileScopedPrincipal = { profileId: number };

export type HumanPrincipal = ProfileScopedPrincipal & {
  kind: 'human';
  userId: string;
  userStatus: UserStatus;
  membershipId: string;
  membershipStatus: MembershipStatus;
  role: MembershipRole;
  assurance: {
    mechanism: 'local_bootstrap';
    externalIdentityLinked: false;
  };
};

export type SchedulerPrincipal = ProfileScopedPrincipal & {
  kind: 'system_scheduler';
  actorId: 'northstar_forecast_scheduler';
  schedulerVersion: string;
};

export type OperatorPrincipal = ProfileScopedPrincipal & {
  kind: 'system_operator';
  actorId: 'northstar_local_operator';
  allowedAction: AuthorizationAction;
  command: string;
};

export type ResendProviderPrincipal = {
  kind: 'provider_resend';
  provider: 'resend';
  webhookId: string;
  verifiedAt: string;
};

export type VerificationCapabilityPrincipal = ProfileScopedPrincipal & {
  kind: 'capability_email_verification';
  capabilityId: string;
  recipientId: string;
  expiresAt: string;
};

export type UnsubscribeCapabilityPrincipal = ProfileScopedPrincipal & {
  kind: 'capability_email_unsubscribe';
  capabilityId: string;
  recipientId: string;
  consentRevision: number;
};

export type AnonymousPrincipal = { kind: 'anonymous' };

export type Principal =
  | HumanPrincipal
  | SchedulerPrincipal
  | OperatorPrincipal
  | ResendProviderPrincipal
  | VerificationCapabilityPrincipal
  | UnsubscribeCapabilityPrincipal
  | AnonymousPrincipal;

export type ResourceScope = {
  profileId?: number;
  resourceType?: string;
  resourceId?: string | number;
  capabilityId?: string;
  recipientId?: string;
  consentRevision?: number;
  providerEventId?: string;
  now?: string;
};

export type AuthorizationReason =
  | 'allowed'
  | 'unknown_action'
  | 'unauthenticated'
  | 'user_disabled'
  | 'membership_inactive'
  | 'insufficient_role'
  | 'wrong_profile'
  | 'resource_unavailable'
  | 'capability_expired'
  | 'capability_purpose_mismatch'
  | 'system_action_not_allowed'
  | 'provider_action_not_allowed';

export type AuthorizationDecision = {
  allowed: boolean;
  reason: AuthorizationReason;
};

export type AuthorizedProfileScope = {
  readonly profileId: number;
  readonly action: AuthorizationAction;
  readonly principal: Principal;
};
