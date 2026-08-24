import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
