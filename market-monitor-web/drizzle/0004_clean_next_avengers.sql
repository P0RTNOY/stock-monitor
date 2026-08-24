CREATE TABLE `forecast_coordinator_claims` (
	`profile_id` integer NOT NULL,
	`forecast_id` integer NOT NULL,
	`owner_run_id` text NOT NULL,
	`owner_item_id` text NOT NULL,
	`owner_token` text NOT NULL,
	`claim_cutoff` text NOT NULL,
	`state` text NOT NULL,
	`acquired_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`completed_at` text,
	PRIMARY KEY(`profile_id`, `forecast_id`),
	FOREIGN KEY (`forecast_id`,`profile_id`) REFERENCES `forecasts`(`id`,`profile_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_item_id`,`owner_run_id`,`profile_id`) REFERENCES `forecast_coordinator_run_items`(`id`,`run_id`,`profile_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "forecast_coordinator_claims_state_check" CHECK("forecast_coordinator_claims"."state" IN ('active', 'completed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_coordinator_claims_owner_token` ON `forecast_coordinator_claims` (`owner_token`);--> statement-breakpoint
CREATE INDEX `idx_forecast_coordinator_claims_expiry` ON `forecast_coordinator_claims` (`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `forecast_coordinator_item_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`run_id` text NOT NULL,
	`profile_id` integer NOT NULL,
	`attempt_number` integer NOT NULL,
	`owner_token` text NOT NULL,
	`state` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`classification` text,
	`reason_code` text,
	`safe_explanation` text,
	`evaluation_run_id` integer,
	`review_item_id` integer,
	`mutated` integer DEFAULT false NOT NULL,
	`retry_useful` integer DEFAULT false NOT NULL,
	`redacted_error_category` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`item_id`,`run_id`,`profile_id`) REFERENCES `forecast_coordinator_run_items`(`id`,`run_id`,`profile_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evaluation_run_id`,`profile_id`) REFERENCES `evaluation_runs`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`review_item_id`,`profile_id`) REFERENCES `forecast_review_items`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_coordinator_attempts_number_check" CHECK("forecast_coordinator_item_attempts"."attempt_number" > 0),
	CONSTRAINT "forecast_coordinator_attempts_state_check" CHECK("forecast_coordinator_item_attempts"."state" IN ('started', 'completed', 'interrupted')),
	CONSTRAINT "forecast_coordinator_attempts_classification_check" CHECK("forecast_coordinator_item_attempts"."classification" IS NULL OR "forecast_coordinator_item_attempts"."classification" IN ('no_change', 'target_hit', 'invalidated', 'expired', 'needs_review', 'duplicate_or_replayed', 'provider_unavailable', 'provider_timeout', 'stale_state', 'not_active', 'not_due', 'claim_conflict', 'validation_failure', 'unexpected_error'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_coordinator_attempts_item_number` ON `forecast_coordinator_item_attempts` (`item_id`,`attempt_number`);--> statement-breakpoint
CREATE INDEX `idx_forecast_coordinator_attempts_run_item` ON `forecast_coordinator_item_attempts` (`run_id`,`item_id`,`attempt_number`);--> statement-breakpoint
CREATE TABLE `forecast_coordinator_run_items` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`profile_id` integer NOT NULL,
	`forecast_id` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`symbol` text NOT NULL,
	`evaluation_cutoff` text NOT NULL,
	`sort_evaluation_date` text NOT NULL,
	`sort_forecast_id` integer NOT NULL,
	`due_reason` text NOT NULL,
	`previous_status` text NOT NULL,
	`current_status` text,
	`latest_evaluation_run_id` integer,
	`latest_evaluation_kind` text,
	`latest_evaluation_cutoff` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`classification` text,
	`evaluator_result_kind` text,
	`evaluation_run_id` integer,
	`review_item_id` integer,
	`reason_code` text,
	`safe_explanation` text,
	`attempt_started_at` text,
	`attempt_finished_at` text,
	`mutated` integer DEFAULT false NOT NULL,
	`retry_useful` integer DEFAULT false NOT NULL,
	`redacted_error_category` text,
	`provider_version` text,
	`evaluator_version` text,
	`ruleset_version` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`,`profile_id`) REFERENCES `forecast_coordinator_runs`(`id`,`profile_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`forecast_id`,`profile_id`) REFERENCES `forecasts`(`id`,`profile_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`latest_evaluation_run_id`,`profile_id`) REFERENCES `evaluation_runs`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evaluation_run_id`,`profile_id`) REFERENCES `evaluation_runs`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`review_item_id`,`profile_id`) REFERENCES `forecast_review_items`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_coordinator_items_ordinal_check" CHECK("forecast_coordinator_run_items"."ordinal" > 0),
	CONSTRAINT "forecast_coordinator_items_due_reason_check" CHECK("forecast_coordinator_run_items"."due_reason" IN ('never_evaluated', 'new_information_possible', 'new_information_possible_after_no_change', 'new_information_possible_after_needs_review', 'horizon_may_be_complete', 'retry_after_provider_unavailable', 'retry_after_provider_timeout', 'retry_after_stale_state', 'retry_after_unexpected_error')),
	CONSTRAINT "forecast_coordinator_items_previous_status_check" CHECK("forecast_coordinator_run_items"."previous_status" IN ('active')),
	CONSTRAINT "forecast_coordinator_items_current_status_check" CHECK("forecast_coordinator_run_items"."current_status" IS NULL OR "forecast_coordinator_run_items"."current_status" IN ('draft', 'active', 'target_hit', 'invalidated', 'expired', 'cancelled')),
	CONSTRAINT "forecast_coordinator_items_state_check" CHECK("forecast_coordinator_run_items"."state" IN ('pending', 'completed')),
	CONSTRAINT "forecast_coordinator_items_classification_check" CHECK("forecast_coordinator_run_items"."classification" IS NULL OR "forecast_coordinator_run_items"."classification" IN ('no_change', 'target_hit', 'invalidated', 'expired', 'needs_review', 'duplicate_or_replayed', 'provider_unavailable', 'provider_timeout', 'stale_state', 'not_active', 'not_due', 'claim_conflict', 'validation_failure', 'unexpected_error', 'dry_run_candidate')),
	CONSTRAINT "forecast_coordinator_items_evaluator_kind_check" CHECK("forecast_coordinator_run_items"."evaluator_result_kind" IS NULL OR "forecast_coordinator_run_items"."evaluator_result_kind" IN ('no_change', 'target_hit', 'invalidated', 'expired', 'needs_review')),
	CONSTRAINT "forecast_coordinator_items_latest_kind_check" CHECK("forecast_coordinator_run_items"."latest_evaluation_kind" IS NULL OR "forecast_coordinator_run_items"."latest_evaluation_kind" IN ('no_change', 'target_hit', 'invalidated', 'expired', 'needs_review'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_coordinator_items_run_forecast` ON `forecast_coordinator_run_items` (`run_id`,`forecast_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_coordinator_items_run_ordinal` ON `forecast_coordinator_run_items` (`run_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_coordinator_items_id_profile` ON `forecast_coordinator_run_items` (`id`,`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_coordinator_items_id_run_profile` ON `forecast_coordinator_run_items` (`id`,`run_id`,`profile_id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_coordinator_items_profile_forecast` ON `forecast_coordinator_run_items` (`profile_id`,`forecast_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `idx_forecast_coordinator_items_run_state` ON `forecast_coordinator_run_items` (`run_id`,`state`,`ordinal`);--> statement-breakpoint
CREATE TABLE `forecast_coordinator_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` integer NOT NULL,
	`coordinator_version` text NOT NULL,
	`mode` text NOT NULL,
	`evaluation_cutoff` text NOT NULL,
	`batch_limit` integer NOT NULL,
	`scan_started_at` text NOT NULL,
	`snapshot_max_forecast_id` integer NOT NULL,
	`initial_cursor` text,
	`resume_cursor` text,
	`next_cursor` text,
	`operator_run_key` text,
	`request_fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`recovery_count` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`duration_ms` integer,
	`selected_count` integer DEFAULT 0 NOT NULL,
	`attempted_count` integer DEFAULT 0 NOT NULL,
	`mutation_count` integer DEFAULT 0 NOT NULL,
	`unexpected_error_count` integer DEFAULT 0 NOT NULL,
	`outcome_counts_json` text DEFAULT '{}' NOT NULL,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "forecast_coordinator_runs_mode_check" CHECK("forecast_coordinator_runs"."mode" IN ('dry_run', 'execute')),
	CONSTRAINT "forecast_coordinator_runs_limit_check" CHECK("forecast_coordinator_runs"."batch_limit" BETWEEN 1 AND 100),
	CONSTRAINT "forecast_coordinator_runs_snapshot_check" CHECK("forecast_coordinator_runs"."snapshot_max_forecast_id" >= 0),
	CONSTRAINT "forecast_coordinator_runs_fingerprint_check" CHECK(length("forecast_coordinator_runs"."request_fingerprint") = 64),
	CONSTRAINT "forecast_coordinator_runs_status_check" CHECK("forecast_coordinator_runs"."status" IN ('running', 'completed', 'completed_with_errors', 'interrupted', 'failed_before_processing')),
	CONSTRAINT "forecast_coordinator_runs_recovery_check" CHECK("forecast_coordinator_runs"."recovery_count" >= 0),
	CONSTRAINT "forecast_coordinator_runs_duration_check" CHECK("forecast_coordinator_runs"."duration_ms" IS NULL OR "forecast_coordinator_runs"."duration_ms" >= 0),
	CONSTRAINT "forecast_coordinator_runs_counts_check" CHECK("forecast_coordinator_runs"."selected_count" >= 0 AND "forecast_coordinator_runs"."attempted_count" >= 0 AND "forecast_coordinator_runs"."mutation_count" >= 0 AND "forecast_coordinator_runs"."unexpected_error_count" >= 0),
	CONSTRAINT "forecast_coordinator_runs_outcomes_json_check" CHECK(json_valid("forecast_coordinator_runs"."outcome_counts_json")),
	CONSTRAINT "forecast_coordinator_runs_warnings_json_check" CHECK(json_valid("forecast_coordinator_runs"."warnings_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_coordinator_runs_profile_key` ON `forecast_coordinator_runs` (`profile_id`,`operator_run_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_coordinator_runs_id_profile` ON `forecast_coordinator_runs` (`id`,`profile_id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_coordinator_runs_profile_created` ON `forecast_coordinator_runs` (`profile_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_coordinator_runs_status_lease` ON `forecast_coordinator_runs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evaluation_runs_id_profile` ON `evaluation_runs` (`id`,`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_review_items_id_profile` ON `forecast_review_items` (`id`,`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecasts_id_profile` ON `forecasts` (`id`,`profile_id`);