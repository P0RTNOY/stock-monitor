CREATE TABLE `investment_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`base_currency` text DEFAULT 'USD' NOT NULL,
	`cash_balance` real DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`entry_date` text NOT NULL,
	`symbol` text NOT NULL,
	`direction` text NOT NULL,
	`confidence` integer NOT NULL,
	`thesis` text NOT NULL,
	`target` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_journal_profile_date` ON `journal_entries` (`profile_id`,`entry_date`);--> statement-breakpoint
CREATE TABLE `positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`company_name` text NOT NULL,
	`shares` real NOT NULL,
	`average_cost` real NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_positions_profile_symbol` ON `positions` (`profile_id`,`symbol`);--> statement-breakpoint
CREATE TABLE `review_alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`condition_type` text NOT NULL,
	`threshold` real NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_alerts_profile_active` ON `review_alerts` (`profile_id`,`active`);--> statement-breakpoint
CREATE TABLE `watchlist_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`company_name` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_watchlist_profile_symbol` ON `watchlist_items` (`profile_id`,`symbol`);