import { sql } from 'drizzle-orm';
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
  check('forecast_events_type_check', sql`${table.eventType} IN ('draft_created', 'draft_updated', 'activated', 'cancelled', 'amendment', 'review_note')`),
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
  index('idx_analysis_snapshots_profile_symbol').on(table.profileId, table.symbol, table.createdAt),
  check('analysis_snapshots_range_check', sql`${table.rangeLower} > 0 AND ${table.rangeUpper} > ${table.rangeLower} AND ${table.rangeHeight} > 0`),
  check('analysis_snapshots_direction_check', sql`${table.direction} IN ('bullish', 'bearish', 'undetermined')`),
]);
