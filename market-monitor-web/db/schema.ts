import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const appMetadata = sqliteTable('app_metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const investmentProfiles = sqliteTable('investment_profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  baseCurrency: text('base_currency').notNull().default('USD'),
  cashBalance: real('cash_balance').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

export const positions = sqliteTable('positions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').notNull().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  symbol: text('symbol').notNull(),
  companyName: text('company_name').notNull(),
  shares: real('shares').notNull(),
  averageCost: real('average_cost').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_positions_profile_symbol').on(table.profileId, table.symbol),
]);

export const watchlistItems = sqliteTable('watchlist_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').notNull().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  symbol: text('symbol').notNull(),
  companyName: text('company_name').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_watchlist_profile_symbol').on(table.profileId, table.symbol),
]);

export const journalEntries = sqliteTable('journal_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').notNull().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  entryDate: text('entry_date').notNull(),
  symbol: text('symbol').notNull(),
  direction: text('direction').notNull(),
  confidence: integer('confidence').notNull(),
  thesis: text('thesis').notNull(),
  target: text('target').notNull().default(''),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_journal_profile_date').on(table.profileId, table.entryDate),
]);

export const reviewAlerts = sqliteTable('review_alerts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').notNull().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  symbol: text('symbol').notNull(),
  conditionType: text('condition_type').notNull(),
  threshold: real('threshold').notNull(),
  note: text('note').notNull().default(''),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_alerts_profile_active').on(table.profileId, table.active),
]);

export const forecasts = sqliteTable('forecasts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').notNull().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  symbol: text('symbol').notNull(),
  direction: text('direction').notNull(),
  confidence: integer('confidence').notNull(),
  thesis: text('thesis').notNull(),
  supportingEvidence: text('supporting_evidence').notNull(),
  counterEvidence: text('counter_evidence').notNull(),
  setupTag: text('setup_tag').notNull(),
  evaluationDate: text('evaluation_date').notNull(),
  targetKind: text('target_kind').notNull(),
  targetPrice: real('target_price'),
  targetLower: real('target_lower'),
  targetUpper: real('target_upper'),
  invalidationPrice: real('invalidation_price'),
  analysisSeedJson: text('analysis_seed_json'),
  analysisSeedScenarioId: text('analysis_seed_scenario_id'),
  status: text('status').notNull().default('draft'),
  activatedAt: text('activated_at'),
  marketDataAsOf: text('market_data_as_of'),
  activationPrice: real('activation_price'),
  activationCurrency: text('activation_currency'),
  marketProvider: text('market_provider'),
  resolvedAt: text('resolved_at'),
  resolutionReason: text('resolution_reason'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecasts_id_profile').on(table.id, table.profileId),
  index('idx_forecasts_profile_status').on(table.profileId, table.status, table.updatedAt),
  index('idx_forecasts_profile_symbol').on(table.profileId, table.symbol, table.updatedAt),
  check('forecasts_direction_check', sql`${table.direction} IN ('bullish', 'bearish', 'neutral')`),
  check('forecasts_confidence_check', sql`${table.confidence} BETWEEN 0 AND 100`),
  check('forecasts_status_check', sql`${table.status} IN ('draft', 'active', 'target_hit', 'invalidated', 'expired', 'cancelled')`),
  check('forecasts_target_check', sql`(
    (${table.targetKind} = 'price' AND ${table.targetPrice} IS NOT NULL AND ${table.targetPrice} > 0 AND ${table.targetLower} IS NULL AND ${table.targetUpper} IS NULL)
    OR
    (${table.targetKind} = 'range' AND ${table.targetPrice} IS NULL AND ${table.targetLower} IS NOT NULL AND ${table.targetLower} > 0 AND ${table.targetUpper} IS NOT NULL AND ${table.targetUpper} > ${table.targetLower})
  )`),
  check('forecasts_invalidation_check', sql`${table.invalidationPrice} IS NULL OR ${table.invalidationPrice} > 0`),
  check('forecasts_analysis_seed_check', sql`(${table.analysisSeedJson} IS NULL AND ${table.analysisSeedScenarioId} IS NULL) OR (${table.analysisSeedJson} IS NOT NULL AND ${table.analysisSeedScenarioId} IS NOT NULL)`),
]);

export const forecastEvents = sqliteTable('forecast_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  forecastId: integer('forecast_id').notNull().references(() => forecasts.id, { onDelete: 'cascade' }),
  profileId: integer('profile_id').notNull().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  eventType: text('event_type').notNull(),
  note: text('note').notNull().default(''),
  payloadJson: text('payload_json').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecast_events_revision').on(table.forecastId, table.revision),
  index('idx_forecast_events_profile_forecast').on(table.profileId, table.forecastId, table.createdAt),
  check('forecast_events_revision_check', sql`${table.revision} > 0`),
  check('forecast_events_type_check', sql`${table.eventType} IN ('draft_created', 'draft_updated', 'activated', 'cancelled', 'amendment', 'review_note', 'evaluated', 'evaluation_review_acknowledged')`),
]);

export const evaluationRuns = sqliteTable('evaluation_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').notNull().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  forecastId: integer('forecast_id').notNull().references(() => forecasts.id, { onDelete: 'cascade' }),
  resultKind: text('result_kind').notNull(),
  reasonCode: text('reason_code').notNull(),
  explanation: text('explanation').notNull(),
  evaluatorVersion: text('evaluator_version').notNull(),
  rulesetVersion: text('ruleset_version').notNull(),
  evaluatedThrough: text('evaluated_through'),
  evaluationCutoff: text('evaluation_cutoff').notNull(),
  evidenceJson: text('evidence_json').notNull(),
  warningsJson: text('warnings_json').notNull(),
  inputFingerprint: text('input_fingerprint').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_evaluation_runs_idempotency').on(
    table.forecastId,
    table.evaluatorVersion,
    table.rulesetVersion,
    table.inputFingerprint,
  ),
  index('idx_evaluation_runs_profile_forecast').on(table.profileId, table.forecastId, table.createdAt),
  uniqueIndex('idx_evaluation_runs_id_profile').on(table.id, table.profileId),
  check('evaluation_runs_kind_check', sql`${table.resultKind} IN ('no_change', 'target_hit', 'invalidated', 'expired', 'needs_review')`),
]);

export const forecastReviewItems = sqliteTable('forecast_review_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').notNull().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  forecastId: integer('forecast_id').notNull().references(() => forecasts.id, { onDelete: 'cascade' }),
  evaluationRunId: integer('evaluation_run_id').notNull().references(() => evaluationRuns.id, { onDelete: 'cascade' }),
  reviewKind: text('review_kind').notNull(),
  acknowledgedAt: text('acknowledged_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecast_review_items_run').on(table.evaluationRunId),
  index('idx_forecast_review_items_profile_open').on(table.profileId, table.acknowledgedAt, table.createdAt),
  uniqueIndex('idx_forecast_review_items_id_profile').on(table.id, table.profileId),
  check('forecast_review_items_kind_check', sql`${table.reviewKind} IN ('resolved', 'needs_review')`),
]);

export const forecastCoordinatorRuns = sqliteTable('forecast_coordinator_runs', {
  id: text('id').primaryKey(),
  profileId: integer('profile_id').notNull().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  coordinatorVersion: text('coordinator_version').notNull(),
  mode: text('mode').notNull(),
  evaluationCutoff: text('evaluation_cutoff').notNull(),
  batchLimit: integer('batch_limit').notNull(),
  scanStartedAt: text('scan_started_at').notNull(),
  snapshotMaxForecastId: integer('snapshot_max_forecast_id').notNull(),
  initialCursor: text('initial_cursor'),
  resumeCursor: text('resume_cursor'),
  nextCursor: text('next_cursor'),
  operatorRunKey: text('operator_run_key'),
  requestFingerprint: text('request_fingerprint').notNull(),
  status: text('status').notNull(),
  leaseToken: text('lease_token'),
  leaseExpiresAt: text('lease_expires_at'),
  recoveryCount: integer('recovery_count').notNull().default(0),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  durationMs: integer('duration_ms'),
  selectedCount: integer('selected_count').notNull().default(0),
  attemptedCount: integer('attempted_count').notNull().default(0),
  mutationCount: integer('mutation_count').notNull().default(0),
  unexpectedErrorCount: integer('unexpected_error_count').notNull().default(0),
  outcomeCountsJson: text('outcome_counts_json').notNull().default('{}'),
  warningsJson: text('warnings_json').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecast_coordinator_runs_profile_key').on(table.profileId, table.operatorRunKey),
  uniqueIndex('idx_forecast_coordinator_runs_id_profile').on(table.id, table.profileId),
  index('idx_forecast_coordinator_runs_profile_created').on(table.profileId, table.createdAt, table.id),
  index('idx_forecast_coordinator_runs_status_lease').on(table.status, table.leaseExpiresAt),
  check('forecast_coordinator_runs_mode_check', sql`${table.mode} IN ('dry_run', 'execute')`),
  check('forecast_coordinator_runs_limit_check', sql`${table.batchLimit} BETWEEN 1 AND 100`),
  check('forecast_coordinator_runs_snapshot_check', sql`${table.snapshotMaxForecastId} >= 0`),
  check('forecast_coordinator_runs_fingerprint_check', sql`length(${table.requestFingerprint}) = 64`),
  check('forecast_coordinator_runs_status_check', sql`${table.status} IN ('running', 'completed', 'completed_with_errors', 'interrupted', 'failed_before_processing')`),
  check('forecast_coordinator_runs_recovery_check', sql`${table.recoveryCount} >= 0`),
  check('forecast_coordinator_runs_duration_check', sql`${table.durationMs} IS NULL OR ${table.durationMs} >= 0`),
  check('forecast_coordinator_runs_counts_check', sql`${table.selectedCount} >= 0 AND ${table.attemptedCount} >= 0 AND ${table.mutationCount} >= 0 AND ${table.unexpectedErrorCount} >= 0`),
  check('forecast_coordinator_runs_outcomes_json_check', sql`json_valid(${table.outcomeCountsJson})`),
  check('forecast_coordinator_runs_warnings_json_check', sql`json_valid(${table.warningsJson})`),
]);

export const forecastCoordinatorRunItems = sqliteTable('forecast_coordinator_run_items', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  profileId: integer('profile_id').notNull(),
  forecastId: integer('forecast_id').notNull(),
  ordinal: integer('ordinal').notNull(),
  symbol: text('symbol').notNull(),
  evaluationCutoff: text('evaluation_cutoff').notNull(),
  sortEvaluationDate: text('sort_evaluation_date').notNull(),
  sortForecastId: integer('sort_forecast_id').notNull(),
  dueReason: text('due_reason').notNull(),
  previousStatus: text('previous_status').notNull(),
  currentStatus: text('current_status'),
  latestEvaluationRunId: integer('latest_evaluation_run_id'),
  latestEvaluationKind: text('latest_evaluation_kind'),
  latestEvaluationCutoff: text('latest_evaluation_cutoff'),
  state: text('state').notNull().default('pending'),
  classification: text('classification'),
  evaluatorResultKind: text('evaluator_result_kind'),
  evaluationRunId: integer('evaluation_run_id'),
  reviewItemId: integer('review_item_id'),
  reasonCode: text('reason_code'),
  safeExplanation: text('safe_explanation'),
  attemptStartedAt: text('attempt_started_at'),
  attemptFinishedAt: text('attempt_finished_at'),
  mutated: integer('mutated', { mode: 'boolean' }).notNull().default(false),
  retryUseful: integer('retry_useful', { mode: 'boolean' }).notNull().default(false),
  redactedErrorCategory: text('redacted_error_category'),
  providerVersion: text('provider_version'),
  evaluatorVersion: text('evaluator_version'),
  rulesetVersion: text('ruleset_version'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecast_coordinator_items_run_forecast').on(table.runId, table.forecastId),
  uniqueIndex('idx_forecast_coordinator_items_run_ordinal').on(table.runId, table.ordinal),
  uniqueIndex('idx_forecast_coordinator_items_id_profile').on(table.id, table.profileId),
  uniqueIndex('idx_forecast_coordinator_items_id_run_profile').on(table.id, table.runId, table.profileId),
  index('idx_forecast_coordinator_items_profile_forecast').on(table.profileId, table.forecastId, table.completedAt),
  index('idx_forecast_coordinator_items_run_state').on(table.runId, table.state, table.ordinal),
  foreignKey({
    columns: [table.runId, table.profileId],
    foreignColumns: [forecastCoordinatorRuns.id, forecastCoordinatorRuns.profileId],
    name: 'forecast_coordinator_items_run_profile_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.forecastId, table.profileId],
    foreignColumns: [forecasts.id, forecasts.profileId],
    name: 'forecast_coordinator_items_forecast_profile_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.latestEvaluationRunId, table.profileId],
    foreignColumns: [evaluationRuns.id, evaluationRuns.profileId],
    name: 'forecast_coordinator_items_latest_evaluation_profile_fk',
  }),
  foreignKey({
    columns: [table.evaluationRunId, table.profileId],
    foreignColumns: [evaluationRuns.id, evaluationRuns.profileId],
    name: 'forecast_coordinator_items_evaluation_profile_fk',
  }),
  foreignKey({
    columns: [table.reviewItemId, table.profileId],
    foreignColumns: [forecastReviewItems.id, forecastReviewItems.profileId],
    name: 'forecast_coordinator_items_review_profile_fk',
  }),
  check('forecast_coordinator_items_ordinal_check', sql`${table.ordinal} > 0`),
  check('forecast_coordinator_items_due_reason_check', sql`${table.dueReason} IN ('never_evaluated', 'new_information_possible', 'new_information_possible_after_no_change', 'new_information_possible_after_needs_review', 'horizon_may_be_complete', 'retry_after_provider_unavailable', 'retry_after_provider_timeout', 'retry_after_stale_state', 'retry_after_unexpected_error')`),
  check('forecast_coordinator_items_previous_status_check', sql`${table.previousStatus} IN ('active')`),
  check('forecast_coordinator_items_current_status_check', sql`${table.currentStatus} IS NULL OR ${table.currentStatus} IN ('draft', 'active', 'target_hit', 'invalidated', 'expired', 'cancelled')`),
  check('forecast_coordinator_items_state_check', sql`${table.state} IN ('pending', 'completed')`),
  check('forecast_coordinator_items_classification_check', sql`${table.classification} IS NULL OR ${table.classification} IN ('no_change', 'target_hit', 'invalidated', 'expired', 'needs_review', 'duplicate_or_replayed', 'provider_unavailable', 'provider_timeout', 'stale_state', 'not_active', 'not_due', 'claim_conflict', 'validation_failure', 'unexpected_error', 'dry_run_candidate')`),
  check('forecast_coordinator_items_evaluator_kind_check', sql`${table.evaluatorResultKind} IS NULL OR ${table.evaluatorResultKind} IN ('no_change', 'target_hit', 'invalidated', 'expired', 'needs_review')`),
  check('forecast_coordinator_items_latest_kind_check', sql`${table.latestEvaluationKind} IS NULL OR ${table.latestEvaluationKind} IN ('no_change', 'target_hit', 'invalidated', 'expired', 'needs_review')`),
]);

export const forecastCoordinatorItemAttempts = sqliteTable('forecast_coordinator_item_attempts', {
  id: text('id').primaryKey(),
  itemId: text('item_id').notNull(),
  runId: text('run_id').notNull(),
  profileId: integer('profile_id').notNull(),
  attemptNumber: integer('attempt_number').notNull(),
  ownerToken: text('owner_token').notNull(),
  state: text('state').notNull(),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  classification: text('classification'),
  reasonCode: text('reason_code'),
  safeExplanation: text('safe_explanation'),
  evaluationRunId: integer('evaluation_run_id'),
  reviewItemId: integer('review_item_id'),
  mutated: integer('mutated', { mode: 'boolean' }).notNull().default(false),
  retryUseful: integer('retry_useful', { mode: 'boolean' }).notNull().default(false),
  redactedErrorCategory: text('redacted_error_category'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecast_coordinator_attempts_item_number').on(table.itemId, table.attemptNumber),
  index('idx_forecast_coordinator_attempts_run_item').on(table.runId, table.itemId, table.attemptNumber),
  foreignKey({
    columns: [table.itemId, table.runId, table.profileId],
    foreignColumns: [forecastCoordinatorRunItems.id, forecastCoordinatorRunItems.runId, forecastCoordinatorRunItems.profileId],
    name: 'forecast_coordinator_attempts_item_run_profile_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.evaluationRunId, table.profileId],
    foreignColumns: [evaluationRuns.id, evaluationRuns.profileId],
    name: 'forecast_coordinator_attempts_evaluation_profile_fk',
  }),
  foreignKey({
    columns: [table.reviewItemId, table.profileId],
    foreignColumns: [forecastReviewItems.id, forecastReviewItems.profileId],
    name: 'forecast_coordinator_attempts_review_profile_fk',
  }),
  check('forecast_coordinator_attempts_number_check', sql`${table.attemptNumber} > 0`),
  check('forecast_coordinator_attempts_state_check', sql`${table.state} IN ('started', 'completed', 'interrupted')`),
  check('forecast_coordinator_attempts_classification_check', sql`${table.classification} IS NULL OR ${table.classification} IN ('no_change', 'target_hit', 'invalidated', 'expired', 'needs_review', 'duplicate_or_replayed', 'provider_unavailable', 'provider_timeout', 'stale_state', 'not_active', 'not_due', 'claim_conflict', 'validation_failure', 'unexpected_error')`),
]);

export const forecastCoordinatorClaims = sqliteTable('forecast_coordinator_claims', {
  profileId: integer('profile_id').notNull(),
  forecastId: integer('forecast_id').notNull(),
  ownerRunId: text('owner_run_id').notNull(),
  ownerItemId: text('owner_item_id').notNull(),
  ownerToken: text('owner_token').notNull(),
  claimCutoff: text('claim_cutoff').notNull(),
  state: text('state').notNull(),
  acquiredAt: text('acquired_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  completedAt: text('completed_at'),
}, (table) => [
  primaryKey({ columns: [table.profileId, table.forecastId], name: 'forecast_coordinator_claims_pk' }),
  uniqueIndex('idx_forecast_coordinator_claims_owner_token').on(table.ownerToken),
  index('idx_forecast_coordinator_claims_expiry').on(table.state, table.expiresAt),
  foreignKey({
    columns: [table.forecastId, table.profileId],
    foreignColumns: [forecasts.id, forecasts.profileId],
    name: 'forecast_coordinator_claims_forecast_profile_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.ownerItemId, table.ownerRunId, table.profileId],
    foreignColumns: [forecastCoordinatorRunItems.id, forecastCoordinatorRunItems.runId, forecastCoordinatorRunItems.profileId],
    name: 'forecast_coordinator_claims_item_run_profile_fk',
  }).onDelete('cascade'),
  check('forecast_coordinator_claims_state_check', sql`${table.state} IN ('active', 'completed')`),
]);

export const forecastSchedulerInvocations = sqliteTable('forecast_scheduler_invocations', {
  id: text('id').primaryKey(),
  profileId: integer('profile_id').notNull().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  schedulerVersion: text('scheduler_version').notNull(),
  coordinatorVersion: text('coordinator_version').notNull(),
  environment: text('environment').notNull(),
  occurrenceKey: text('occurrence_key').notNull(),
  scheduleExpression: text('schedule_expression').notNull(),
  scheduledTime: text('scheduled_time').notNull(),
  cutoff: text('evaluation_cutoff').notNull(),
  configFingerprint: text('config_fingerprint').notNull(),
  configurationJson: text('configuration_json').notNull(),
  status: text('status').notNull(),
  leaseToken: text('lease_token'),
  leaseExpiresAt: text('lease_expires_at'),
  recoveryCount: integer('recovery_count').notNull().default(0),
  replayCount: integer('replay_count').notNull().default(0),
  lastReplayedAt: text('last_replayed_at'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  durationMs: integer('duration_ms'),
  pagesRequested: integer('pages_requested').notNull().default(0),
  pagesCompleted: integer('pages_completed').notNull().default(0),
  selectedCount: integer('selected_count').notNull().default(0),
  attemptedCount: integer('attempted_count').notNull().default(0),
  mutationCount: integer('mutation_count').notNull().default(0),
  unexpectedErrorCount: integer('unexpected_error_count').notNull().default(0),
  outcomeCountsJson: text('outcome_counts_json').notNull().default('{}'),
  initialCursor: text('initial_cursor'),
  finalCursor: text('final_cursor'),
  moreWork: integer('more_work', { mode: 'boolean' }).notNull().default(true),
  stopReason: text('stop_reason'),
  errorCategory: text('error_category'),
  coordinatorRunIdsJson: text('coordinator_run_ids_json').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecast_scheduler_invocations_profile_occurrence').on(table.profileId, table.occurrenceKey),
  uniqueIndex('idx_forecast_scheduler_invocations_id_profile').on(table.id, table.profileId),
  index('idx_forecast_scheduler_invocations_profile_scheduled').on(table.profileId, table.scheduledTime, table.id),
  index('idx_forecast_scheduler_invocations_status_lease').on(table.status, table.leaseExpiresAt),
  check('forecast_scheduler_invocations_environment_check', sql`${table.environment} IN ('local', 'preview', 'staging', 'production')`),
  check('forecast_scheduler_invocations_fingerprint_check', sql`length(${table.configFingerprint}) = 64`),
  check('forecast_scheduler_invocations_configuration_check', sql`json_valid(${table.configurationJson})`),
  check('forecast_scheduler_invocations_status_check', sql`${table.status} IN ('running', 'completed', 'partial_budget_exhausted', 'coordinator_failure', 'unexpected_error')`),
  check('forecast_scheduler_invocations_counts_check', sql`${table.recoveryCount} >= 0 AND ${table.replayCount} >= 0 AND ${table.pagesRequested} >= 0 AND ${table.pagesCompleted} >= 0 AND ${table.pagesCompleted} <= ${table.pagesRequested} AND ${table.selectedCount} >= 0 AND ${table.attemptedCount} >= 0 AND ${table.mutationCount} >= 0 AND ${table.unexpectedErrorCount} >= 0`),
  check('forecast_scheduler_invocations_duration_check', sql`${table.durationMs} IS NULL OR ${table.durationMs} >= 0`),
  check('forecast_scheduler_invocations_outcomes_check', sql`json_valid(${table.outcomeCountsJson})`),
  check('forecast_scheduler_invocations_runs_check', sql`json_valid(${table.coordinatorRunIdsJson})`),
]);

export const forecastSchedulerPages = sqliteTable('forecast_scheduler_pages', {
  id: text('id').primaryKey(),
  invocationId: text('invocation_id').notNull(),
  profileId: integer('profile_id').notNull(),
  pageNumber: integer('page_number').notNull(),
  state: text('state').notNull(),
  coordinatorRunId: text('coordinator_run_id'),
  coordinatorRunStatus: text('coordinator_run_status'),
  operatorRunKey: text('operator_run_key').notNull(),
  batchLimit: integer('batch_limit').notNull(),
  inputCursor: text('input_cursor'),
  outputCursor: text('output_cursor'),
  selectedCount: integer('selected_count').notNull().default(0),
  attemptedCount: integer('attempted_count').notNull().default(0),
  mutationCount: integer('mutation_count').notNull().default(0),
  unexpectedErrorCount: integer('unexpected_error_count').notNull().default(0),
  outcomeCountsJson: text('outcome_counts_json').notNull().default('{}'),
  replayUsedExistingRun: integer('replay_used_existing_run', { mode: 'boolean' }).notNull().default(false),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  durationMs: integer('duration_ms'),
  errorCategory: text('error_category'),
  errorType: text('error_type'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecast_scheduler_pages_invocation_number').on(table.invocationId, table.pageNumber),
  uniqueIndex('idx_forecast_scheduler_pages_profile_key').on(table.profileId, table.operatorRunKey),
  uniqueIndex('idx_forecast_scheduler_pages_coordinator_run').on(table.coordinatorRunId),
  index('idx_forecast_scheduler_pages_invocation_state').on(table.invocationId, table.state, table.pageNumber),
  foreignKey({
    columns: [table.invocationId, table.profileId],
    foreignColumns: [forecastSchedulerInvocations.id, forecastSchedulerInvocations.profileId],
    name: 'forecast_scheduler_pages_invocation_profile_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.coordinatorRunId, table.profileId],
    foreignColumns: [forecastCoordinatorRuns.id, forecastCoordinatorRuns.profileId],
    name: 'forecast_scheduler_pages_coordinator_profile_fk',
  }),
  check('forecast_scheduler_pages_number_check', sql`${table.pageNumber} > 0`),
  check('forecast_scheduler_pages_state_check', sql`${table.state} IN ('started', 'completed', 'failed')`),
  check('forecast_scheduler_pages_limit_check', sql`${table.batchLimit} BETWEEN 1 AND 100`),
  check('forecast_scheduler_pages_coordinator_status_check', sql`${table.coordinatorRunStatus} IS NULL OR ${table.coordinatorRunStatus} IN ('running', 'completed', 'completed_with_errors', 'interrupted', 'failed_before_processing')`),
  check('forecast_scheduler_pages_counts_check', sql`${table.selectedCount} >= 0 AND ${table.attemptedCount} >= 0 AND ${table.mutationCount} >= 0 AND ${table.unexpectedErrorCount} >= 0`),
  check('forecast_scheduler_pages_duration_check', sql`${table.durationMs} IS NULL OR ${table.durationMs} >= 0`),
  check('forecast_scheduler_pages_outcomes_check', sql`json_valid(${table.outcomeCountsJson})`),
]);

export const analysisSnapshots = sqliteTable('analysis_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  forecastId: integer('forecast_id').notNull().references(() => forecasts.id, { onDelete: 'cascade' }),
  profileId: integer('profile_id').notNull().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  symbol: text('symbol').notNull(),
  generatedAt: text('generated_at').notNull(),
  analysisAsOf: text('analysis_as_of').notNull(),
  completedBarAsOf: text('completed_bar_as_of'),
  provider: text('provider').notNull(),
  adjustmentMode: text('adjustment_mode').notNull(),
  engineVersion: text('engine_version').notNull(),
  rulesetVersion: text('ruleset_version').notNull(),
  dataHash: text('data_hash').notNull(),
  scenarioId: text('scenario_id').notNull(),
  setup: text('setup').notNull(),
  timeframe: text('timeframe').notNull(),
  lifecycleState: text('lifecycle_state').notNull(),
  direction: text('direction').notNull(),
  rangeLower: real('range_lower').notNull(),
  rangeUpper: real('range_upper').notNull(),
  rangeHeight: real('range_height').notNull(),
  measuredTarget: real('measured_target'),
  evidenceJson: text('evidence_json').notNull(),
  warningsJson: text('warnings_json').notNull(),
  reportJson: text('report_json').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_analysis_snapshots_forecast').on(table.forecastId),
  uniqueIndex('idx_analysis_snapshots_id_profile').on(table.id, table.profileId),
  index('idx_analysis_snapshots_profile_symbol').on(table.profileId, table.symbol, table.createdAt),
  check('analysis_snapshots_range_check', sql`${table.rangeLower} > 0 AND ${table.rangeUpper} > ${table.rangeLower} AND ${table.rangeHeight} > 0`),
  check('analysis_snapshots_direction_check', sql`${table.direction} IN ('bullish', 'bearish', 'undetermined')`),
]);

export const forecastNotificationProjectionCheckpoints = sqliteTable('forecast_notification_projection_checkpoints', {
  profileId: integer('profile_id').notNull().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  projectorVersion: text('projector_version').notNull(),
  baselineEvaluationRunId: integer('baseline_evaluation_run_id').notNull(),
  lastEvaluationRunId: integer('last_evaluation_run_id').notNull(),
  activatedAt: text('activated_at').notNull(),
  leaseToken: text('lease_token'),
  leaseExpiresAt: text('lease_expires_at'),
  recoveryCount: integer('recovery_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({
    columns: [table.profileId, table.projectorVersion],
    name: 'forecast_notification_projection_checkpoints_pk',
  }),
  index('idx_forecast_notification_projection_checkpoints_lease').on(table.leaseExpiresAt),
  check('forecast_notification_projection_checkpoints_cursor_check', sql`${table.baselineEvaluationRunId} >= 0 AND ${table.lastEvaluationRunId} >= ${table.baselineEvaluationRunId}`),
  check('forecast_notification_projection_checkpoints_lease_check', sql`(${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`),
  check('forecast_notification_projection_checkpoints_recovery_check', sql`${table.recoveryCount} >= 0`),
]);

export const forecastNotificationPreferenceRevisions = sqliteTable('forecast_notification_preference_revisions', {
  profileId: integer('profile_id').notNull().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  preferenceVersion: text('preference_version').notNull(),
  masterConsent: integer('master_consent', { mode: 'boolean' }).notNull().default(false),
  targetHitEnabled: integer('target_hit_enabled', { mode: 'boolean' }).notNull().default(false),
  invalidatedEnabled: integer('invalidated_enabled', { mode: 'boolean' }).notNull().default(false),
  expiredEnabled: integer('expired_enabled', { mode: 'boolean' }).notNull().default(false),
  needsReviewEnabled: integer('needs_review_enabled', { mode: 'boolean' }).notNull().default(false),
  timezone: text('timezone').notNull(),
  quietHoursStart: text('quiet_hours_start'),
  quietHoursEnd: text('quiet_hours_end'),
  changeSource: text('change_source').notNull(),
  changeReason: text('change_reason').notNull().default(''),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({
    columns: [table.profileId, table.revision],
    name: 'forecast_notification_preference_revisions_pk',
  }),
  index('idx_forecast_notification_preference_revisions_created').on(table.profileId, table.createdAt, table.revision),
  check('forecast_notification_preference_revisions_revision_check', sql`${table.revision} > 0`),
  check('forecast_notification_preference_revisions_booleans_check', sql`${table.masterConsent} IN (0, 1)
    AND ${table.targetHitEnabled} IN (0, 1) AND ${table.invalidatedEnabled} IN (0, 1)
    AND ${table.expiredEnabled} IN (0, 1) AND ${table.needsReviewEnabled} IN (0, 1)`),
  check('forecast_notification_preference_revisions_quiet_hours_check', sql`(
    ${table.quietHoursStart} IS NULL AND ${table.quietHoursEnd} IS NULL
  ) OR (
    ${table.quietHoursStart} IS NOT NULL AND ${table.quietHoursEnd} IS NOT NULL
    AND length(${table.quietHoursStart}) = 5 AND length(${table.quietHoursEnd}) = 5
    AND ${table.quietHoursStart} <> ${table.quietHoursEnd}
  )`),
]);

export const forecastNotificationPreferences = sqliteTable('forecast_notification_preferences', {
  profileId: integer('profile_id').primaryKey().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  currentRevision: integer('current_revision').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  foreignKey({
    columns: [table.profileId, table.currentRevision],
    foreignColumns: [forecastNotificationPreferenceRevisions.profileId, forecastNotificationPreferenceRevisions.revision],
    name: 'forecast_notification_preferences_revision_fk',
  }),
  check('forecast_notification_preferences_revision_check', sql`${table.currentRevision} > 0`),
]);

export const forecastNotificationIntents = sqliteTable('forecast_notification_intents', {
  id: text('id').primaryKey(),
  profileId: integer('profile_id').notNull().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  forecastId: integer('forecast_id').notNull(),
  evaluationRunId: integer('evaluation_run_id').notNull(),
  reviewItemId: integer('review_item_id').notNull(),
  analysisSnapshotId: integer('analysis_snapshot_id'),
  category: text('category').notNull(),
  dedupContractVersion: text('dedup_contract_version').notNull(),
  projectorVersion: text('projector_version').notNull(),
  payloadSchemaVersion: text('payload_schema_version').notNull(),
  dedupKey: text('dedup_key').notNull(),
  payloadJson: text('payload_json').notNull(),
  payloadFingerprint: text('payload_fingerprint').notNull(),
  eventOccurredAt: text('event_occurred_at').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecast_notification_intents_id_profile').on(table.id, table.profileId),
  uniqueIndex('idx_forecast_notification_intents_dedup_key').on(table.dedupKey),
  uniqueIndex('idx_forecast_notification_intents_source_category').on(
    table.profileId,
    table.evaluationRunId,
    table.category,
  ),
  index('idx_forecast_notification_intents_profile_created').on(table.profileId, table.createdAt, table.id),
  index('idx_forecast_notification_intents_profile_category').on(table.profileId, table.category, table.createdAt),
  foreignKey({
    columns: [table.forecastId, table.profileId],
    foreignColumns: [forecasts.id, forecasts.profileId],
    name: 'forecast_notification_intents_forecast_profile_fk',
  }),
  foreignKey({
    columns: [table.evaluationRunId, table.profileId],
    foreignColumns: [evaluationRuns.id, evaluationRuns.profileId],
    name: 'forecast_notification_intents_evaluation_profile_fk',
  }),
  foreignKey({
    columns: [table.reviewItemId, table.profileId],
    foreignColumns: [forecastReviewItems.id, forecastReviewItems.profileId],
    name: 'forecast_notification_intents_review_profile_fk',
  }),
  foreignKey({
    columns: [table.analysisSnapshotId, table.profileId],
    foreignColumns: [analysisSnapshots.id, analysisSnapshots.profileId],
    name: 'forecast_notification_intents_snapshot_profile_fk',
  }),
  check('forecast_notification_intents_category_check', sql`${table.category} IN ('target_hit', 'invalidated', 'expired', 'needs_review')`),
  check('forecast_notification_intents_dedup_key_check', sql`length(${table.dedupKey}) = 64`),
  check('forecast_notification_intents_payload_check', sql`json_valid(${table.payloadJson})`),
  check('forecast_notification_intents_payload_fingerprint_check', sql`length(${table.payloadFingerprint}) = 64`),
]);

export const forecastNotificationPolicyDecisions = sqliteTable('forecast_notification_policy_decisions', {
  id: text('id').primaryKey(),
  intentId: text('intent_id').notNull(),
  profileId: integer('profile_id').notNull(),
  policyVersion: text('policy_version').notNull(),
  preferenceRevision: integer('preference_revision'),
  decision: text('decision').notNull(),
  reasonCode: text('reason_code').notNull(),
  decidedAt: text('decided_at').notNull(),
  earliestEligibleAt: text('earliest_eligible_at'),
  warningsJson: text('warnings_json').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecast_notification_policy_decisions_id_profile').on(table.id, table.profileId),
  uniqueIndex('idx_forecast_notification_policy_decisions_intent').on(table.intentId),
  index('idx_forecast_notification_policy_decisions_profile_decided').on(table.profileId, table.decidedAt, table.id),
  foreignKey({
    columns: [table.intentId, table.profileId],
    foreignColumns: [forecastNotificationIntents.id, forecastNotificationIntents.profileId],
    name: 'forecast_notification_policy_decisions_intent_profile_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.profileId, table.preferenceRevision],
    foreignColumns: [forecastNotificationPreferenceRevisions.profileId, forecastNotificationPreferenceRevisions.revision],
    name: 'forecast_notification_policy_decisions_preference_revision_fk',
  }),
  check('forecast_notification_policy_decisions_decision_check', sql`${table.decision} IN ('eligible', 'deferred_quiet_hours', 'suppressed_no_consent', 'suppressed_category_disabled', 'suppressed_unsupported_category', 'suppressed_historical_cutover')`),
  check('forecast_notification_policy_decisions_earliest_check', sql`(
    ${table.decision} = 'deferred_quiet_hours' AND ${table.earliestEligibleAt} IS NOT NULL
  ) OR (
    ${table.decision} <> 'deferred_quiet_hours' AND ${table.earliestEligibleAt} IS NULL
  )`),
  check('forecast_notification_policy_decisions_warnings_check', sql`json_valid(${table.warningsJson})`),
]);

export const forecastNotificationOutbox = sqliteTable('forecast_notification_outbox', {
  id: text('id').primaryKey(),
  intentId: text('intent_id').notNull(),
  policyDecisionId: text('policy_decision_id').notNull(),
  profileId: integer('profile_id').notNull(),
  retryPolicyVersion: text('retry_policy_version').notNull(),
  quietHoursPolicyVersion: text('quiet_hours_policy_version').notNull(),
  state: text('state').notNull(),
  availableAt: text('available_at'),
  attemptCount: integer('attempt_count').notNull().default(0),
  leaseToken: text('lease_token'),
  leaseExpiresAt: text('lease_expires_at'),
  lastAttemptAt: text('last_attempt_at'),
  succeededAt: text('succeeded_at'),
  deadLetteredAt: text('dead_lettered_at'),
  suppressedAt: text('suppressed_at'),
  suppressionReason: text('suppression_reason'),
  lastFailureCategory: text('last_failure_category'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecast_notification_outbox_id_profile').on(table.id, table.profileId),
  uniqueIndex('idx_forecast_notification_outbox_intent').on(table.intentId),
  uniqueIndex('idx_forecast_notification_outbox_policy_decision').on(table.policyDecisionId),
  uniqueIndex('idx_forecast_notification_outbox_lease_token').on(table.leaseToken),
  index('idx_forecast_notification_outbox_profile_state_available').on(table.profileId, table.state, table.availableAt, table.id),
  index('idx_forecast_notification_outbox_state_lease').on(table.state, table.leaseExpiresAt),
  foreignKey({
    columns: [table.intentId, table.profileId],
    foreignColumns: [forecastNotificationIntents.id, forecastNotificationIntents.profileId],
    name: 'forecast_notification_outbox_intent_profile_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.policyDecisionId, table.profileId],
    foreignColumns: [forecastNotificationPolicyDecisions.id, forecastNotificationPolicyDecisions.profileId],
    name: 'forecast_notification_outbox_policy_profile_fk',
  }).onDelete('cascade'),
  check('forecast_notification_outbox_state_check', sql`${table.state} IN ('pending', 'deferred', 'suppressed', 'claimed', 'retry_scheduled', 'succeeded', 'dead_letter')`),
  check('forecast_notification_outbox_attempt_count_check', sql`${table.attemptCount} >= 0 AND (
    (${table.state} = 'pending' AND ${table.attemptCount} = 0)
    OR (${table.state} IN ('deferred', 'suppressed') AND ${table.attemptCount} >= 0)
    OR (${table.state} IN ('claimed', 'retry_scheduled', 'succeeded', 'dead_letter') AND ${table.attemptCount} > 0)
  )`),
  check('forecast_notification_outbox_available_check', sql`${table.state} IN ('suppressed', 'succeeded', 'dead_letter') OR ${table.availableAt} IS NOT NULL`),
  check('forecast_notification_outbox_lease_check', sql`(
    ${table.state} = 'claimed' AND ${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL
  ) OR (
    ${table.state} <> 'claimed' AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL
  )`),
  check('forecast_notification_outbox_success_check', sql`(
    ${table.state} = 'succeeded' AND ${table.succeededAt} IS NOT NULL
  ) OR (
    ${table.state} <> 'succeeded' AND ${table.succeededAt} IS NULL
  )`),
  check('forecast_notification_outbox_dead_letter_check', sql`(
    ${table.state} = 'dead_letter' AND ${table.deadLetteredAt} IS NOT NULL
  ) OR (
    ${table.state} <> 'dead_letter' AND ${table.deadLetteredAt} IS NULL
  )`),
  check('forecast_notification_outbox_suppression_check', sql`(
    ${table.state} = 'suppressed'
      AND ((${table.suppressedAt} IS NULL AND ${table.suppressionReason} IS NULL)
        OR (${table.suppressedAt} IS NOT NULL AND ${table.suppressionReason} IS NOT NULL
          AND length(${table.suppressionReason}) BETWEEN 1 AND 100))
  ) OR (
    ${table.state} <> 'suppressed' AND ${table.suppressedAt} IS NULL
      AND ${table.suppressionReason} IS NULL
  )`),
]);

export const forecastNotificationProjectionItems = sqliteTable('forecast_notification_projection_items', {
  id: text('id').primaryKey(),
  profileId: integer('profile_id').notNull(),
  projectorVersion: text('projector_version').notNull(),
  evaluationRunId: integer('evaluation_run_id').notNull(),
  intentId: text('intent_id'),
  category: text('category'),
  dedupKey: text('dedup_key'),
  classification: text('classification').notNull(),
  reasonCode: text('reason_code').notNull(),
  sourceCreatedAt: text('source_created_at').notNull(),
  warningsJson: text('warnings_json').notNull().default('[]'),
  processedAt: text('processed_at').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecast_notification_projection_items_source').on(
    table.profileId,
    table.projectorVersion,
    table.evaluationRunId,
  ),
  uniqueIndex('idx_forecast_notification_projection_items_intent').on(table.intentId),
  index('idx_forecast_notification_projection_items_profile_processed').on(table.profileId, table.processedAt, table.id),
  foreignKey({
    columns: [table.profileId, table.projectorVersion],
    foreignColumns: [forecastNotificationProjectionCheckpoints.profileId, forecastNotificationProjectionCheckpoints.projectorVersion],
    name: 'forecast_notification_projection_items_checkpoint_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.evaluationRunId, table.profileId],
    foreignColumns: [evaluationRuns.id, evaluationRuns.profileId],
    name: 'forecast_notification_projection_items_evaluation_profile_fk',
  }),
  foreignKey({
    columns: [table.intentId, table.profileId],
    foreignColumns: [forecastNotificationIntents.id, forecastNotificationIntents.profileId],
    name: 'forecast_notification_projection_items_intent_profile_fk',
  }),
  check('forecast_notification_projection_items_category_check', sql`${table.category} IS NULL OR ${table.category} IN ('target_hit', 'invalidated', 'expired', 'needs_review')`),
  check('forecast_notification_projection_items_dedup_check', sql`${table.dedupKey} IS NULL OR length(${table.dedupKey}) = 64`),
  check('forecast_notification_projection_items_classification_check', sql`${table.classification} IN ('intent_materialized', 'excluded_no_change', 'excluded_unsupported', 'invalid_source_needs_review')`),
  check('forecast_notification_projection_items_materialization_check', sql`(
    ${table.classification} = 'intent_materialized'
    AND ${table.intentId} IS NOT NULL AND ${table.category} IS NOT NULL AND ${table.dedupKey} IS NOT NULL
  ) OR (
    ${table.classification} <> 'intent_materialized'
    AND ${table.intentId} IS NULL AND ${table.category} IS NULL AND ${table.dedupKey} IS NULL
  )`),
  check('forecast_notification_projection_items_warnings_check', sql`json_valid(${table.warningsJson})`),
]);

export const forecastNotificationDeliveryAttempts = sqliteTable('forecast_notification_delivery_attempts', {
  id: text('id').primaryKey(),
  outboxId: text('outbox_id').notNull(),
  profileId: integer('profile_id').notNull(),
  attemptNumber: integer('attempt_number').notNull(),
  ownerToken: text('owner_token').notNull(),
  state: text('state').notNull(),
  retryPolicyVersion: text('retry_policy_version').notNull(),
  adapterKind: text('adapter_kind').notNull(),
  adapterVersion: text('adapter_version').notNull(),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  failureClassification: text('failure_classification'),
  redactedErrorCategory: text('redacted_error_category'),
  nextAttemptAt: text('next_attempt_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecast_notification_attempts_id_profile').on(table.id, table.profileId),
  uniqueIndex('idx_forecast_notification_attempts_outbox_number').on(table.outboxId, table.attemptNumber),
  uniqueIndex('idx_forecast_notification_attempts_owner_token').on(table.ownerToken),
  uniqueIndex('idx_forecast_notification_attempts_started').on(table.outboxId)
    .where(sql`${table.state} = 'started'`),
  uniqueIndex('idx_forecast_notification_attempts_succeeded').on(table.outboxId)
    .where(sql`${table.state} = 'succeeded'`),
  index('idx_forecast_notification_attempts_profile_created').on(table.profileId, table.createdAt, table.id),
  foreignKey({
    columns: [table.outboxId, table.profileId],
    foreignColumns: [forecastNotificationOutbox.id, forecastNotificationOutbox.profileId],
    name: 'forecast_notification_attempts_outbox_profile_fk',
  }).onDelete('cascade'),
  check('forecast_notification_attempts_number_check', sql`${table.attemptNumber} > 0`),
  check('forecast_notification_attempts_state_check', sql`${table.state} IN ('started', 'succeeded', 'retry_scheduled', 'terminal_failure', 'interrupted', 'policy_deferred', 'policy_suppressed')`),
  check('forecast_notification_attempts_failure_classification_check', sql`${table.failureClassification} IS NULL OR ${table.failureClassification} IN ('retryable', 'terminal', 'interrupted')`),
  check('forecast_notification_attempts_completion_check', sql`(
    ${table.state} = 'started' AND ${table.finishedAt} IS NULL
      AND ${table.failureClassification} IS NULL AND ${table.redactedErrorCategory} IS NULL
      AND ${table.nextAttemptAt} IS NULL
  ) OR (
    ${table.state} = 'succeeded' AND ${table.finishedAt} IS NOT NULL
      AND ${table.failureClassification} IS NULL AND ${table.redactedErrorCategory} IS NULL
      AND ${table.nextAttemptAt} IS NULL
  ) OR (
    ${table.state} = 'retry_scheduled' AND ${table.finishedAt} IS NOT NULL
      AND ${table.failureClassification} = 'retryable' AND ${table.redactedErrorCategory} IS NOT NULL
      AND ${table.nextAttemptAt} IS NOT NULL
  ) OR (
    ${table.state} = 'terminal_failure' AND ${table.finishedAt} IS NOT NULL
      AND ${table.failureClassification} IN ('retryable', 'terminal') AND ${table.redactedErrorCategory} IS NOT NULL
      AND ${table.nextAttemptAt} IS NULL
  ) OR (
    ${table.state} = 'interrupted' AND ${table.finishedAt} IS NOT NULL
      AND ${table.failureClassification} = 'interrupted' AND ${table.redactedErrorCategory} IS NOT NULL
      AND ${table.nextAttemptAt} IS NULL
  ) OR (
    ${table.state} = 'policy_deferred' AND ${table.finishedAt} IS NOT NULL
      AND ${table.failureClassification} IS NULL AND ${table.redactedErrorCategory} IS NULL
      AND ${table.nextAttemptAt} IS NOT NULL
  ) OR (
    ${table.state} = 'policy_suppressed' AND ${table.finishedAt} IS NOT NULL
      AND ${table.failureClassification} IS NULL AND ${table.redactedErrorCategory} IS NULL
      AND ${table.nextAttemptAt} IS NULL
  )`),
]);

export const forecastEmailRecipients = sqliteTable('forecast_email_recipients', {
  id: text('id').primaryKey(),
  profileId: integer('profile_id').notNull().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  recipientRevision: integer('recipient_revision').notNull(),
  canonicalEmail: text('canonical_email').notNull(),
  maskedEmail: text('masked_email').notNull(),
  state: text('state').notNull(),
  verificationRequestedAt: text('verification_requested_at'),
  verifiedAt: text('verified_at'),
  revokedAt: text('revoked_at'),
  suppressionState: text('suppression_state').notNull().default('none'),
  suppressionReason: text('suppression_reason'),
  suppressedAt: text('suppressed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecast_email_recipients_id_profile').on(table.id, table.profileId),
  uniqueIndex('idx_forecast_email_recipients_profile_revision').on(table.profileId, table.recipientRevision),
  uniqueIndex('idx_forecast_email_recipients_current').on(table.profileId)
    .where(sql`${table.state} IN ('pending', 'verified')`),
  uniqueIndex('idx_forecast_email_recipients_current_address').on(table.profileId, table.canonicalEmail)
    .where(sql`${table.state} IN ('pending', 'verified')`),
  index('idx_forecast_email_recipients_profile_created').on(table.profileId, table.createdAt, table.id),
  check('forecast_email_recipients_revision_check', sql`${table.recipientRevision} > 0`),
  check('forecast_email_recipients_email_check', sql`length(${table.canonicalEmail}) BETWEEN 3 AND 254
    AND ${table.canonicalEmail} = trim(${table.canonicalEmail})
    AND instr(${table.canonicalEmail}, '@') > 1
    AND instr(${table.canonicalEmail}, char(10)) = 0 AND instr(${table.canonicalEmail}, char(13)) = 0
    AND length(${table.maskedEmail}) BETWEEN 3 AND 254`),
  check('forecast_email_recipients_state_check', sql`${table.state} IN ('pending', 'verified', 'revoked', 'replaced')`),
  check('forecast_email_recipients_lifecycle_check', sql`(
    ${table.state} = 'pending' AND ${table.verifiedAt} IS NULL AND ${table.revokedAt} IS NULL
  ) OR (
    ${table.state} = 'verified' AND ${table.verifiedAt} IS NOT NULL AND ${table.revokedAt} IS NULL
  ) OR (
    ${table.state} IN ('revoked', 'replaced') AND ${table.revokedAt} IS NOT NULL
  )`),
  check('forecast_email_recipients_suppression_state_check', sql`${table.suppressionState} IN ('none', 'suppressed')`),
  check('forecast_email_recipients_suppression_check', sql`(
    ${table.suppressionState} = 'none' AND ${table.suppressionReason} IS NULL AND ${table.suppressedAt} IS NULL
  ) OR (
    ${table.suppressionState} = 'suppressed' AND ${table.suppressionReason} IS NOT NULL
      AND length(${table.suppressionReason}) BETWEEN 1 AND 100 AND ${table.suppressedAt} IS NOT NULL
  )`),
]);

export const forecastEmailConsentRevisions = sqliteTable('forecast_email_consent_revisions', {
  profileId: integer('profile_id').notNull().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  recipientId: text('recipient_id').notNull(),
  masterConsent: integer('master_consent', { mode: 'boolean' }).notNull().default(false),
  targetHitEnabled: integer('target_hit_enabled', { mode: 'boolean' }).notNull().default(false),
  invalidatedEnabled: integer('invalidated_enabled', { mode: 'boolean' }).notNull().default(false),
  expiredEnabled: integer('expired_enabled', { mode: 'boolean' }).notNull().default(false),
  needsReviewEnabled: integer('needs_review_enabled', { mode: 'boolean' }).notNull().default(false),
  consentSource: text('consent_source').notNull(),
  consentedAt: text('consented_at'),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.profileId, table.revision], name: 'forecast_email_consent_revisions_pk' }),
  uniqueIndex('idx_forecast_email_consent_revisions_profile_revision_recipient')
    .on(table.profileId, table.revision, table.recipientId),
  index('idx_forecast_email_consent_revisions_recipient_created')
    .on(table.profileId, table.recipientId, table.createdAt, table.revision),
  foreignKey({
    columns: [table.recipientId, table.profileId],
    foreignColumns: [forecastEmailRecipients.id, forecastEmailRecipients.profileId],
    name: 'forecast_email_consent_revisions_recipient_profile_fk',
  }),
  check('forecast_email_consent_revisions_revision_check', sql`${table.revision} > 0`),
  check('forecast_email_consent_revisions_booleans_check', sql`${table.masterConsent} IN (0, 1)
    AND ${table.targetHitEnabled} IN (0, 1) AND ${table.invalidatedEnabled} IN (0, 1)
    AND ${table.expiredEnabled} IN (0, 1) AND ${table.needsReviewEnabled} IN (0, 1)`),
  check('forecast_email_consent_revisions_source_check', sql`${table.consentSource} IN (
    'operator', 'unsubscribe', 'provider_complaint', 'recipient_replacement', 'internal'
  )`),
  check('forecast_email_consent_revisions_lifecycle_check', sql`(
    ${table.masterConsent} = 1 AND ${table.consentedAt} IS NOT NULL AND ${table.revokedAt} IS NULL
  ) OR (
    ${table.masterConsent} = 0 AND ${table.revokedAt} IS NOT NULL
  )`),
]);

export const forecastEmailConsents = sqliteTable('forecast_email_consents', {
  profileId: integer('profile_id').primaryKey().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  currentRevision: integer('current_revision').notNull(),
  recipientId: text('recipient_id').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  foreignKey({
    columns: [table.profileId, table.currentRevision, table.recipientId],
    foreignColumns: [
      forecastEmailConsentRevisions.profileId,
      forecastEmailConsentRevisions.revision,
      forecastEmailConsentRevisions.recipientId,
    ],
    name: 'forecast_email_consents_current_revision_fk',
  }),
  foreignKey({
    columns: [table.recipientId, table.profileId],
    foreignColumns: [forecastEmailRecipients.id, forecastEmailRecipients.profileId],
    name: 'forecast_email_consents_recipient_profile_fk',
  }),
  check('forecast_email_consents_revision_check', sql`${table.currentRevision} > 0`),
]);

export const forecastEmailCapabilities = sqliteTable('forecast_email_capabilities', {
  id: text('id').primaryKey(),
  profileId: integer('profile_id').notNull().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  recipientId: text('recipient_id').notNull(),
  purpose: text('purpose').notNull(),
  tokenHash: text('token_hash').notNull(),
  tokenVersion: text('token_version').notNull(),
  state: text('state').notNull(),
  expiresAt: text('expires_at'),
  consentRevision: integer('consent_revision'),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastAttemptAt: text('last_attempt_at'),
  consumedAt: text('consumed_at'),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecast_email_capabilities_id_profile').on(table.id, table.profileId),
  uniqueIndex('idx_forecast_email_capabilities_token_hash').on(table.tokenHash),
  uniqueIndex('idx_forecast_email_capabilities_active_purpose').on(table.profileId, table.recipientId, table.purpose)
    .where(sql`${table.state} = 'active'`),
  index('idx_forecast_email_capabilities_expiry').on(table.state, table.expiresAt),
  foreignKey({
    columns: [table.recipientId, table.profileId],
    foreignColumns: [forecastEmailRecipients.id, forecastEmailRecipients.profileId],
    name: 'forecast_email_capabilities_recipient_profile_fk',
  }),
  foreignKey({
    columns: [table.profileId, table.consentRevision, table.recipientId],
    foreignColumns: [
      forecastEmailConsentRevisions.profileId,
      forecastEmailConsentRevisions.revision,
      forecastEmailConsentRevisions.recipientId,
    ],
    name: 'forecast_email_capabilities_consent_revision_fk',
  }),
  check('forecast_email_capabilities_purpose_check', sql`${table.purpose} IN ('verification', 'unsubscribe')`),
  check('forecast_email_capabilities_token_check', sql`length(${table.tokenHash}) = 64
    AND length(${table.tokenVersion}) BETWEEN 1 AND 50`),
  check('forecast_email_capabilities_state_check', sql`${table.state} IN ('active', 'consumed', 'revoked', 'expired')`),
  check('forecast_email_capabilities_binding_check', sql`(
    ${table.purpose} = 'verification' AND ${table.expiresAt} IS NOT NULL AND ${table.consentRevision} IS NULL
  ) OR (
    ${table.purpose} = 'unsubscribe' AND ${table.consentRevision} IS NOT NULL
  )`),
  check('forecast_email_capabilities_state_timestamps_check', sql`(
    ${table.state} IN ('active', 'expired') AND ${table.consumedAt} IS NULL AND ${table.revokedAt} IS NULL
  ) OR (
    ${table.state} = 'consumed' AND ${table.consumedAt} IS NOT NULL AND ${table.revokedAt} IS NULL
  ) OR (
    ${table.state} = 'revoked' AND ${table.consumedAt} IS NULL AND ${table.revokedAt} IS NOT NULL
  )`),
  check('forecast_email_capabilities_attempt_check', sql`${table.attemptCount} >= 0 AND (
    (${table.attemptCount} = 0 AND ${table.lastAttemptAt} IS NULL)
    OR (${table.attemptCount} > 0 AND ${table.lastAttemptAt} IS NOT NULL)
  )`),
]);

export const forecastEmailPreSendDecisions = sqliteTable('forecast_email_pre_send_decisions', {
  id: text('id').primaryKey(),
  outboxId: text('outbox_id').notNull(),
  attemptId: text('attempt_id').notNull(),
  profileId: integer('profile_id').notNull(),
  recipientId: text('recipient_id'),
  notificationPreferenceRevision: integer('notification_preference_revision'),
  emailConsentRevision: integer('email_consent_revision'),
  decision: text('decision').notNull(),
  reasonCode: text('reason_code').notNull(),
  checkedAt: text('checked_at').notNull(),
  nextAvailableAt: text('next_available_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecast_email_pre_send_decisions_id_profile').on(table.id, table.profileId),
  uniqueIndex('idx_forecast_email_pre_send_decisions_attempt').on(table.attemptId),
  index('idx_forecast_email_pre_send_decisions_profile_checked').on(table.profileId, table.checkedAt, table.id),
  foreignKey({
    columns: [table.outboxId, table.profileId],
    foreignColumns: [forecastNotificationOutbox.id, forecastNotificationOutbox.profileId],
    name: 'forecast_email_pre_send_decisions_outbox_profile_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.attemptId, table.profileId],
    foreignColumns: [forecastNotificationDeliveryAttempts.id, forecastNotificationDeliveryAttempts.profileId],
    name: 'forecast_email_pre_send_decisions_attempt_profile_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.recipientId, table.profileId],
    foreignColumns: [forecastEmailRecipients.id, forecastEmailRecipients.profileId],
    name: 'forecast_email_pre_send_decisions_recipient_profile_fk',
  }),
  foreignKey({
    columns: [table.profileId, table.notificationPreferenceRevision],
    foreignColumns: [forecastNotificationPreferenceRevisions.profileId, forecastNotificationPreferenceRevisions.revision],
    name: 'forecast_email_pre_send_decisions_notification_preference_fk',
  }),
  foreignKey({
    columns: [table.profileId, table.emailConsentRevision, table.recipientId],
    foreignColumns: [
      forecastEmailConsentRevisions.profileId,
      forecastEmailConsentRevisions.revision,
      forecastEmailConsentRevisions.recipientId,
    ],
    name: 'forecast_email_pre_send_decisions_email_consent_fk',
  }),
  check('forecast_email_pre_send_decisions_decision_check', sql`${table.decision} IN ('eligible', 'deferred_quiet_hours', 'suppressed')`),
  check('forecast_email_pre_send_decisions_reason_check', sql`length(${table.reasonCode}) BETWEEN 1 AND 100`),
  check('forecast_email_pre_send_decisions_shape_check', sql`(
    ${table.decision} = 'eligible' AND ${table.recipientId} IS NOT NULL
      AND ${table.notificationPreferenceRevision} IS NOT NULL AND ${table.emailConsentRevision} IS NOT NULL
      AND ${table.nextAvailableAt} IS NULL
  ) OR (
    ${table.decision} = 'deferred_quiet_hours' AND ${table.recipientId} IS NOT NULL
      AND ${table.notificationPreferenceRevision} IS NOT NULL AND ${table.emailConsentRevision} IS NOT NULL
      AND ${table.nextAvailableAt} IS NOT NULL
  ) OR (
    ${table.decision} = 'suppressed' AND ${table.nextAvailableAt} IS NULL
  )`),
]);

export const forecastEmailDeliveries = sqliteTable('forecast_email_deliveries', {
  id: text('id').primaryKey(),
  profileId: integer('profile_id').notNull().references(() => investmentProfiles.id, { onDelete: 'cascade' }),
  recipientId: text('recipient_id').notNull(),
  sourceKind: text('source_kind').notNull(),
  outboxId: text('outbox_id'),
  preSendDecisionId: text('pre_send_decision_id'),
  verificationCapabilityId: text('verification_capability_id'),
  templateKind: text('template_kind').notNull(),
  templateVersion: text('template_version').notNull(),
  locale: text('locale').notNull(),
  contentHash: text('content_hash').notNull(),
  provider: text('provider').notNull().default('resend'),
  idempotencyKey: text('idempotency_key').notNull(),
  canonicalRequestHash: text('canonical_request_hash').notNull(),
  state: text('state').notNull(),
  requestStartedAt: text('request_started_at'),
  lastRequestAt: text('last_request_at'),
  safeRetryUntil: text('safe_retry_until'),
  providerAcceptedAt: text('provider_accepted_at'),
  providerEmailId: text('provider_email_id'),
  deadLetteredAt: text('dead_lettered_at'),
  reconciliationState: text('reconciliation_state').notNull().default('none'),
  reconciliationEventAt: text('reconciliation_event_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecast_email_deliveries_id_profile').on(table.id, table.profileId),
  uniqueIndex('idx_forecast_email_deliveries_outbox').on(table.outboxId),
  uniqueIndex('idx_forecast_email_deliveries_pre_send_decision').on(table.preSendDecisionId),
  uniqueIndex('idx_forecast_email_deliveries_verification_capability').on(table.verificationCapabilityId),
  uniqueIndex('idx_forecast_email_deliveries_idempotency_key').on(table.idempotencyKey),
  uniqueIndex('idx_forecast_email_deliveries_provider_email_id').on(table.providerEmailId),
  index('idx_forecast_email_deliveries_profile_state_created').on(table.profileId, table.state, table.createdAt, table.id),
  index('idx_forecast_email_deliveries_reconciliation').on(table.reconciliationState, table.reconciliationEventAt),
  foreignKey({
    columns: [table.recipientId, table.profileId],
    foreignColumns: [forecastEmailRecipients.id, forecastEmailRecipients.profileId],
    name: 'forecast_email_deliveries_recipient_profile_fk',
  }),
  foreignKey({
    columns: [table.outboxId, table.profileId],
    foreignColumns: [forecastNotificationOutbox.id, forecastNotificationOutbox.profileId],
    name: 'forecast_email_deliveries_outbox_profile_fk',
  }),
  foreignKey({
    columns: [table.preSendDecisionId, table.profileId],
    foreignColumns: [forecastEmailPreSendDecisions.id, forecastEmailPreSendDecisions.profileId],
    name: 'forecast_email_deliveries_pre_send_decision_profile_fk',
  }),
  foreignKey({
    columns: [table.verificationCapabilityId, table.profileId],
    foreignColumns: [forecastEmailCapabilities.id, forecastEmailCapabilities.profileId],
    name: 'forecast_email_deliveries_verification_capability_profile_fk',
  }),
  check('forecast_email_deliveries_source_check', sql`(
    ${table.sourceKind} = 'forecast_notification' AND ${table.outboxId} IS NOT NULL
      AND ${table.preSendDecisionId} IS NOT NULL AND ${table.verificationCapabilityId} IS NULL
  ) OR (
    ${table.sourceKind} = 'recipient_verification' AND ${table.outboxId} IS NULL
      AND ${table.preSendDecisionId} IS NULL AND ${table.verificationCapabilityId} IS NOT NULL
  )`),
  check('forecast_email_deliveries_template_check', sql`length(${table.templateKind}) BETWEEN 1 AND 50
    AND length(${table.templateVersion}) BETWEEN 1 AND 50 AND length(${table.locale}) BETWEEN 2 AND 35`),
  check('forecast_email_deliveries_hashes_check', sql`length(${table.contentHash}) = 64
    AND length(${table.canonicalRequestHash}) = 64`),
  check('forecast_email_deliveries_provider_check', sql`${table.provider} = 'resend'
    AND length(${table.idempotencyKey}) BETWEEN 1 AND 256`),
  check('forecast_email_deliveries_state_check', sql`${table.state} IN (
    'prepared', 'request_started', 'provider_accepted', 'ambiguous', 'terminal_failure', 'dead_letter'
  )`),
  check('forecast_email_deliveries_request_check', sql`(
    ${table.requestStartedAt} IS NULL AND ${table.lastRequestAt} IS NULL AND ${table.safeRetryUntil} IS NULL
  ) OR (
    ${table.requestStartedAt} IS NOT NULL AND ${table.lastRequestAt} IS NOT NULL
      AND ${table.lastRequestAt} >= ${table.requestStartedAt} AND ${table.safeRetryUntil} IS NOT NULL
      AND ${table.safeRetryUntil} > ${table.requestStartedAt}
  )`),
  check('forecast_email_deliveries_acceptance_check', sql`(
    ${table.providerAcceptedAt} IS NULL AND ${table.providerEmailId} IS NULL
  ) OR (
    ${table.providerAcceptedAt} IS NOT NULL AND ${table.providerEmailId} IS NOT NULL
      AND length(${table.providerEmailId}) BETWEEN 1 AND 200
  )`),
  check('forecast_email_deliveries_state_shape_check', sql`(
    ${table.state} = 'prepared' AND ${table.requestStartedAt} IS NULL
      AND ${table.providerAcceptedAt} IS NULL AND ${table.deadLetteredAt} IS NULL
  ) OR (
    ${table.state} = 'request_started' AND ${table.requestStartedAt} IS NOT NULL
      AND ${table.providerAcceptedAt} IS NULL AND ${table.deadLetteredAt} IS NULL
  ) OR (
    ${table.state} = 'provider_accepted' AND ${table.requestStartedAt} IS NOT NULL
      AND ${table.providerAcceptedAt} IS NOT NULL AND ${table.deadLetteredAt} IS NULL
  ) OR (
    ${table.state} IN ('ambiguous', 'terminal_failure') AND ${table.requestStartedAt} IS NOT NULL
      AND ${table.deadLetteredAt} IS NULL
  ) OR (
    ${table.state} = 'dead_letter' AND ${table.deadLetteredAt} IS NOT NULL
  )`),
  check('forecast_email_deliveries_reconciliation_state_check', sql`${table.reconciliationState} IN (
    'none', 'delayed', 'delivered', 'failed', 'bounced', 'complained', 'suppressed'
  )`),
  check('forecast_email_deliveries_reconciliation_check', sql`(
    ${table.reconciliationState} = 'none' AND ${table.reconciliationEventAt} IS NULL
  ) OR (
    ${table.reconciliationState} <> 'none' AND ${table.reconciliationEventAt} IS NOT NULL
  )`),
]);

export const forecastEmailProviderAttempts = sqliteTable('forecast_email_provider_attempts', {
  id: text('id').primaryKey(),
  deliveryId: text('delivery_id').notNull(),
  profileId: integer('profile_id').notNull(),
  attemptNumber: integer('attempt_number').notNull(),
  notificationAttemptId: text('notification_attempt_id'),
  state: text('state').notNull(),
  failureClassification: text('failure_classification'),
  redactedErrorCategory: text('redacted_error_category'),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  nextAttemptAt: text('next_attempt_at'),
  safeRetryUntil: text('safe_retry_until').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecast_email_provider_attempts_id_profile').on(table.id, table.profileId),
  uniqueIndex('idx_forecast_email_provider_attempts_delivery_number').on(table.deliveryId, table.attemptNumber),
  uniqueIndex('idx_forecast_email_provider_attempts_notification_attempt').on(table.notificationAttemptId),
  uniqueIndex('idx_forecast_email_provider_attempts_started').on(table.deliveryId)
    .where(sql`${table.state} = 'started'`),
  uniqueIndex('idx_forecast_email_provider_attempts_accepted').on(table.deliveryId)
    .where(sql`${table.state} = 'accepted'`),
  index('idx_forecast_email_provider_attempts_profile_created').on(table.profileId, table.createdAt, table.id),
  foreignKey({
    columns: [table.deliveryId, table.profileId],
    foreignColumns: [forecastEmailDeliveries.id, forecastEmailDeliveries.profileId],
    name: 'forecast_email_provider_attempts_delivery_profile_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.notificationAttemptId, table.profileId],
    foreignColumns: [forecastNotificationDeliveryAttempts.id, forecastNotificationDeliveryAttempts.profileId],
    name: 'forecast_email_provider_attempts_notification_attempt_profile_fk',
  }),
  check('forecast_email_provider_attempts_number_check', sql`${table.attemptNumber} > 0`),
  check('forecast_email_provider_attempts_state_check', sql`${table.state} IN (
    'started', 'accepted', 'retry_scheduled', 'terminal_failure', 'ambiguous', 'interrupted'
  )`),
  check('forecast_email_provider_attempts_failure_check', sql`${table.failureClassification} IS NULL
    OR ${table.failureClassification} IN ('retryable', 'terminal', 'ambiguous', 'interrupted')`),
  check('forecast_email_provider_attempts_retry_window_check', sql`${table.safeRetryUntil} > ${table.startedAt}`),
  check('forecast_email_provider_attempts_completion_check', sql`(
    ${table.state} = 'started' AND ${table.finishedAt} IS NULL
      AND ${table.failureClassification} IS NULL AND ${table.redactedErrorCategory} IS NULL
      AND ${table.nextAttemptAt} IS NULL
  ) OR (
    ${table.state} = 'accepted' AND ${table.finishedAt} IS NOT NULL
      AND ${table.failureClassification} IS NULL AND ${table.redactedErrorCategory} IS NULL
      AND ${table.nextAttemptAt} IS NULL
  ) OR (
    ${table.state} = 'retry_scheduled' AND ${table.finishedAt} IS NOT NULL
      AND ${table.failureClassification} = 'retryable' AND ${table.redactedErrorCategory} IS NOT NULL
      AND ${table.nextAttemptAt} IS NOT NULL
  ) OR (
    ${table.state} = 'terminal_failure' AND ${table.finishedAt} IS NOT NULL
      AND ${table.failureClassification} IN ('retryable', 'terminal')
      AND ${table.redactedErrorCategory} IS NOT NULL AND ${table.nextAttemptAt} IS NULL
  ) OR (
    ${table.state} = 'ambiguous' AND ${table.finishedAt} IS NOT NULL
      AND ${table.failureClassification} = 'ambiguous'
      AND ${table.redactedErrorCategory} IS NOT NULL AND ${table.nextAttemptAt} IS NULL
  ) OR (
    ${table.state} = 'interrupted' AND ${table.finishedAt} IS NOT NULL
      AND ${table.failureClassification} = 'interrupted'
      AND ${table.redactedErrorCategory} IS NOT NULL AND ${table.nextAttemptAt} IS NULL
  )`),
]);

export const forecastEmailProviderEvents = sqliteTable('forecast_email_provider_events', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull().default('resend'),
  providerEventId: text('provider_event_id').notNull(),
  providerEmailId: text('provider_email_id').notNull(),
  deliveryId: text('delivery_id'),
  profileId: integer('profile_id'),
  eventType: text('event_type').notNull(),
  supported: integer('supported', { mode: 'boolean' }).notNull(),
  payloadHash: text('payload_hash').notNull(),
  eventOccurredAt: text('event_occurred_at').notNull(),
  receivedAt: text('received_at').notNull(),
  handlingState: text('handling_state').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecast_email_provider_events_id_profile').on(table.id, table.profileId),
  uniqueIndex('idx_forecast_email_provider_events_provider_event').on(table.provider, table.providerEventId),
  index('idx_forecast_email_provider_events_provider_email').on(table.provider, table.providerEmailId, table.receivedAt),
  index('idx_forecast_email_provider_events_handling').on(table.handlingState, table.receivedAt, table.id),
  foreignKey({
    columns: [table.deliveryId, table.profileId],
    foreignColumns: [forecastEmailDeliveries.id, forecastEmailDeliveries.profileId],
    name: 'forecast_email_provider_events_delivery_profile_fk',
  }),
  check('forecast_email_provider_events_provider_check', sql`${table.provider} = 'resend'`),
  check('forecast_email_provider_events_supported_check', sql`${table.supported} IN (0, 1)`),
  check('forecast_email_provider_events_hash_check', sql`length(${table.payloadHash}) = 64`),
  check('forecast_email_provider_events_resolution_check', sql`(
    ${table.deliveryId} IS NULL AND ${table.profileId} IS NULL
  ) OR (
    ${table.deliveryId} IS NOT NULL AND ${table.profileId} IS NOT NULL
  )`),
  check('forecast_email_provider_events_handling_check', sql`${table.handlingState} IN (
    'applied', 'unsupported', 'unknown_delivery', 'ignored_precedence', 'pending'
  )`),
]);

export const forecastEmailSuppressionEvents = sqliteTable('forecast_email_suppression_events', {
  id: text('id').primaryKey(),
  profileId: integer('profile_id').notNull(),
  recipientId: text('recipient_id').notNull(),
  providerEventId: text('provider_event_id'),
  action: text('action').notNull(),
  reason: text('reason').notNull(),
  occurredAt: text('occurred_at').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_forecast_email_suppression_events_id_profile').on(table.id, table.profileId),
  uniqueIndex('idx_forecast_email_suppression_events_provider_event').on(table.providerEventId),
  index('idx_forecast_email_suppression_events_recipient_occurred')
    .on(table.profileId, table.recipientId, table.occurredAt, table.id),
  foreignKey({
    columns: [table.recipientId, table.profileId],
    foreignColumns: [forecastEmailRecipients.id, forecastEmailRecipients.profileId],
    name: 'forecast_email_suppression_events_recipient_profile_fk',
  }),
  foreignKey({
    columns: [table.providerEventId, table.profileId],
    foreignColumns: [forecastEmailProviderEvents.id, forecastEmailProviderEvents.profileId],
    name: 'forecast_email_suppression_events_provider_event_profile_fk',
  }),
  check('forecast_email_suppression_events_action_check', sql`${table.action} IN ('suppressed', 'cleared')`),
  check('forecast_email_suppression_events_reason_check', sql`${table.reason} IN (
    'hard_bounce', 'complaint', 'provider_suppressed', 'operator'
  )`),
]);
