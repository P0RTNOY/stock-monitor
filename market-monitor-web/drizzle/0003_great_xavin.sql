CREATE TABLE `evaluation_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`forecast_id` integer NOT NULL,
	`result_kind` text NOT NULL,
	`reason_code` text NOT NULL,
	`explanation` text NOT NULL,
	`evaluator_version` text NOT NULL,
	`ruleset_version` text NOT NULL,
	`evaluated_through` text,
	`evaluation_cutoff` text NOT NULL,
	`evidence_json` text NOT NULL,
	`warnings_json` text NOT NULL,
	`input_fingerprint` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`forecast_id`) REFERENCES `forecasts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "evaluation_runs_kind_check" CHECK("evaluation_runs"."result_kind" IN ('no_change', 'target_hit', 'invalidated', 'expired', 'needs_review'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evaluation_runs_idempotency` ON `evaluation_runs` (`forecast_id`,`evaluator_version`,`ruleset_version`,`input_fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_evaluation_runs_profile_forecast` ON `evaluation_runs` (`profile_id`,`forecast_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `forecast_review_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`forecast_id` integer NOT NULL,
	`evaluation_run_id` integer NOT NULL,
	`review_kind` text NOT NULL,
	`acknowledged_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`forecast_id`) REFERENCES `forecasts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evaluation_run_id`) REFERENCES `evaluation_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "forecast_review_items_kind_check" CHECK("forecast_review_items"."review_kind" IN ('resolved', 'needs_review'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_review_items_run` ON `forecast_review_items` (`evaluation_run_id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_review_items_profile_open` ON `forecast_review_items` (`profile_id`,`acknowledged_at`,`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_forecast_events` (
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
	CONSTRAINT "forecast_events_revision_check" CHECK("__new_forecast_events"."revision" > 0),
	CONSTRAINT "forecast_events_type_check" CHECK("__new_forecast_events"."event_type" IN ('draft_created', 'draft_updated', 'activated', 'cancelled', 'amendment', 'review_note', 'evaluated', 'evaluation_review_acknowledged'))
);
--> statement-breakpoint
INSERT INTO `__new_forecast_events`("id", "forecast_id", "profile_id", "revision", "event_type", "note", "payload_json", "created_at") SELECT "id", "forecast_id", "profile_id", "revision", "event_type", "note", "payload_json", "created_at" FROM `forecast_events`;--> statement-breakpoint
DROP TABLE `forecast_events`;--> statement-breakpoint
ALTER TABLE `__new_forecast_events` RENAME TO `forecast_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_events_revision` ON `forecast_events` (`forecast_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_forecast_events_profile_forecast` ON `forecast_events` (`profile_id`,`forecast_id`,`created_at`);