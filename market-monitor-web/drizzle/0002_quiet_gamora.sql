CREATE TABLE `analysis_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`forecast_id` integer NOT NULL,
	`profile_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`generated_at` text NOT NULL,
	`analysis_as_of` text NOT NULL,
	`completed_bar_as_of` text,
	`provider` text NOT NULL,
	`adjustment_mode` text NOT NULL,
	`engine_version` text NOT NULL,
	`ruleset_version` text NOT NULL,
	`data_hash` text NOT NULL,
	`scenario_id` text NOT NULL,
	`setup` text NOT NULL,
	`timeframe` text NOT NULL,
	`lifecycle_state` text NOT NULL,
	`direction` text NOT NULL,
	`range_lower` real NOT NULL,
	`range_upper` real NOT NULL,
	`range_height` real NOT NULL,
	`measured_target` real,
	`evidence_json` text NOT NULL,
	`warnings_json` text NOT NULL,
	`report_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`forecast_id`) REFERENCES `forecasts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "analysis_snapshots_range_check" CHECK("analysis_snapshots"."range_lower" > 0 AND "analysis_snapshots"."range_upper" > "analysis_snapshots"."range_lower" AND "analysis_snapshots"."range_height" > 0),
	CONSTRAINT "analysis_snapshots_direction_check" CHECK("analysis_snapshots"."direction" IN ('bullish', 'bearish', 'undetermined'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_analysis_snapshots_forecast` ON `analysis_snapshots` (`forecast_id`);--> statement-breakpoint
CREATE INDEX `idx_analysis_snapshots_profile_symbol` ON `analysis_snapshots` (`profile_id`,`symbol`,`created_at`);--> statement-breakpoint
CREATE TABLE `forecast_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`forecast_id` integer NOT NULL,
	`profile_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`event_type` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`forecast_id`) REFERENCES `forecasts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "forecast_events_revision_check" CHECK("forecast_events"."revision" > 0),
	CONSTRAINT "forecast_events_type_check" CHECK("forecast_events"."event_type" IN ('draft_created', 'draft_updated', 'activated', 'cancelled', 'amendment', 'review_note'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_events_revision` ON `forecast_events` (`forecast_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_forecast_events_profile_forecast` ON `forecast_events` (`profile_id`,`forecast_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `forecasts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`direction` text NOT NULL,
	`confidence` integer NOT NULL,
	`thesis` text NOT NULL,
	`supporting_evidence` text NOT NULL,
	`counter_evidence` text NOT NULL,
	`setup_tag` text NOT NULL,
	`evaluation_date` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_price` real,
	`target_lower` real,
	`target_upper` real,
	`invalidation_price` real,
	`analysis_seed_json` text,
	`analysis_seed_scenario_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`activated_at` text,
	`market_data_as_of` text,
	`activation_price` real,
	`activation_currency` text,
	`market_provider` text,
	`resolved_at` text,
	`resolution_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "forecasts_direction_check" CHECK("forecasts"."direction" IN ('bullish', 'bearish', 'neutral')),
	CONSTRAINT "forecasts_confidence_check" CHECK("forecasts"."confidence" BETWEEN 0 AND 100),
	CONSTRAINT "forecasts_status_check" CHECK("forecasts"."status" IN ('draft', 'active', 'target_hit', 'invalidated', 'expired', 'cancelled')),
	CONSTRAINT "forecasts_target_check" CHECK((
    ("forecasts"."target_kind" = 'price' AND "forecasts"."target_price" IS NOT NULL AND "forecasts"."target_price" > 0 AND "forecasts"."target_lower" IS NULL AND "forecasts"."target_upper" IS NULL)
    OR
    ("forecasts"."target_kind" = 'range' AND "forecasts"."target_price" IS NULL AND "forecasts"."target_lower" IS NOT NULL AND "forecasts"."target_lower" > 0 AND "forecasts"."target_upper" IS NOT NULL AND "forecasts"."target_upper" > "forecasts"."target_lower")
  )),
	CONSTRAINT "forecasts_invalidation_check" CHECK("forecasts"."invalidation_price" IS NULL OR "forecasts"."invalidation_price" > 0),
	CONSTRAINT "forecasts_analysis_seed_check" CHECK(("forecasts"."analysis_seed_json" IS NULL AND "forecasts"."analysis_seed_scenario_id" IS NULL) OR ("forecasts"."analysis_seed_json" IS NOT NULL AND "forecasts"."analysis_seed_scenario_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_forecasts_profile_status` ON `forecasts` (`profile_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_forecasts_profile_symbol` ON `forecasts` (`profile_id`,`symbol`,`updated_at`);