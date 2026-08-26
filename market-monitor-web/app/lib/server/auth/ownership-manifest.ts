export type OwnershipKind = 'global_operational' | 'identity_global' | 'tenant_root'
  | 'profile_direct' | 'profile_inherited' | 'provider_hybrid';

export type TableOwnership = {
  table: string;
  ownership: OwnershipKind;
  parent: string | null;
  humanAccess: 'none' | 'read' | 'owner_manage' | 'role_scoped';
  systemAccess: 'none' | 'read' | 'write';
  providerAccess: 'none' | 'reconcile_only';
  capabilityAccess: 'none' | 'exact_mutation';
  requiredConstraint: string;
};

const profile = (
  table: string,
  parent: string,
  humanAccess: TableOwnership['humanAccess'] = 'read',
  systemAccess: TableOwnership['systemAccess'] = 'write',
): TableOwnership => ({
  table, ownership: parent === 'investment_profiles' ? 'profile_direct' : 'profile_inherited',
  parent, humanAccess, systemAccess, providerAccess: 'none', capabilityAccess: 'none',
  requiredConstraint: parent === 'investment_profiles'
    ? 'Foreign key profile_id -> investment_profiles.id; profile-qualified indexes/uniqueness as declared.'
    : `Profile-bound foreign key relationship to ${parent}; composite ownership keys as declared.`,
});

export const TABLE_OWNERSHIP_MANIFEST: readonly TableOwnership[] = [
  { table: 'app_metadata', ownership: 'global_operational', parent: null, humanAccess: 'none', systemAccess: 'write', providerAccess: 'none', capabilityAccess: 'none', requiredConstraint: 'Primary key key; no tenant data.' },
  { table: 'investment_profiles', ownership: 'tenant_root', parent: null, humanAccess: 'role_scoped', systemAccess: 'read', providerAccess: 'none', capabilityAccess: 'none', requiredConstraint: 'Primary key id defines the tenant boundary.' },
  { table: 'identity_users', ownership: 'identity_global', parent: null, humanAccess: 'none', systemAccess: 'write', providerAccess: 'none', capabilityAccess: 'none', requiredConstraint: 'Immutable primary key id and lifecycle CHECK constraints; no email identity.' },
  { table: 'profile_memberships', ownership: 'profile_direct', parent: 'investment_profiles', humanAccess: 'owner_manage', systemAccess: 'write', providerAccess: 'none', capabilityAccess: 'none', requiredConstraint: 'FKs to user/profile; unique user+profile and id+user+profile; immutable identity plus matching next-revision event triggers.' },
  { table: 'profile_membership_events', ownership: 'profile_inherited', parent: 'profile_memberships', humanAccess: 'read', systemAccess: 'write', providerAccess: 'none', capabilityAccess: 'none', requiredConstraint: 'Composite FK membership+user+profile; unique membership+revision; append-only triggers.' },
  profile('positions', 'investment_profiles', 'role_scoped'),
  profile('watchlist_items', 'investment_profiles', 'role_scoped'),
  profile('journal_entries', 'investment_profiles', 'role_scoped'),
  profile('review_alerts', 'investment_profiles', 'role_scoped'),
  profile('forecasts', 'investment_profiles', 'role_scoped'),
  { ...profile('forecast_events', 'forecasts'), requiredConstraint: 'Insert/update tenant guard requires forecast id+profile; forecast profile is immutable.' },
  { ...profile('analysis_snapshots', 'forecasts'), requiredConstraint: 'Insert/update tenant guard requires forecast id+profile; immutable snapshot semantics.' },
  { ...profile('evaluation_runs', 'forecasts'), requiredConstraint: 'Insert/update tenant guard requires forecast id+profile; profile-bound fingerprint uniqueness.' },
  { ...profile('forecast_review_items', 'evaluation_runs', 'role_scoped'), requiredConstraint: 'Tenant guard requires forecast and evaluation run to share profile and forecast.' },
  profile('forecast_coordinator_runs', 'investment_profiles'),
  profile('forecast_coordinator_run_items', 'forecast_coordinator_runs'),
  profile('forecast_coordinator_item_attempts', 'forecast_coordinator_run_items'),
  profile('forecast_coordinator_claims', 'forecasts'),
  profile('forecast_scheduler_invocations', 'investment_profiles'),
  profile('forecast_scheduler_pages', 'forecast_scheduler_invocations'),
  profile('forecast_notification_projection_checkpoints', 'investment_profiles'),
  profile('forecast_notification_preference_revisions', 'investment_profiles', 'owner_manage'),
  profile('forecast_notification_preferences', 'forecast_notification_preference_revisions', 'owner_manage'),
  profile('forecast_notification_intents', 'evaluation_runs'),
  profile('forecast_notification_policy_decisions', 'forecast_notification_intents'),
  profile('forecast_notification_outbox', 'forecast_notification_intents'),
  profile('forecast_notification_projection_items', 'forecast_notification_projection_checkpoints'),
  profile('forecast_notification_delivery_attempts', 'forecast_notification_outbox'),
  profile('forecast_in_app_notification_projection_checkpoints', 'investment_profiles'),
  profile('forecast_in_app_notification_entries', 'forecast_notification_intents', 'role_scoped'),
  profile('forecast_in_app_notification_projection_items', 'forecast_in_app_notification_projection_checkpoints'),
  profile('forecast_in_app_notification_state_events', 'forecast_in_app_notification_entries', 'role_scoped'),
  profile('forecast_email_recipients', 'investment_profiles', 'owner_manage'),
  profile('forecast_email_consent_revisions', 'forecast_email_recipients', 'owner_manage'),
  profile('forecast_email_consents', 'forecast_email_consent_revisions', 'owner_manage'),
  { ...profile('forecast_email_capabilities', 'forecast_email_recipients', 'none'), capabilityAccess: 'exact_mutation' },
  profile('forecast_email_pre_send_decisions', 'forecast_notification_outbox'),
  profile('forecast_email_deliveries', 'forecast_notification_outbox'),
  profile('forecast_email_provider_attempts', 'forecast_email_deliveries'),
  {
    table: 'forecast_email_provider_events', ownership: 'provider_hybrid', parent: 'forecast_email_deliveries',
    humanAccess: 'none', systemAccess: 'read', providerAccess: 'reconcile_only', capabilityAccess: 'none',
    requiredConstraint: 'Unique provider+event ID; nullable delivery/profile pair constrained together; stored delivery resolves tenant.',
  },
  profile('forecast_email_suppression_events', 'forecast_email_recipients'),
] as const;

export const PLATFORM_MANAGED_TABLES = new Set(['d1_migrations', '_cf_METADATA']);
