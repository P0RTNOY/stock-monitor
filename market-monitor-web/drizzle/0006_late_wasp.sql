CREATE TABLE `forecast_notification_delivery_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`outbox_id` text NOT NULL,
	`profile_id` integer NOT NULL,
	`attempt_number` integer NOT NULL,
	`owner_token` text NOT NULL,
	`state` text NOT NULL,
	`retry_policy_version` text NOT NULL,
	`adapter_kind` text NOT NULL,
	`adapter_version` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`failure_classification` text,
	`redacted_error_category` text,
	`next_attempt_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`outbox_id`,`profile_id`) REFERENCES `forecast_notification_outbox`(`id`,`profile_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "forecast_notification_attempts_number_check" CHECK("forecast_notification_delivery_attempts"."attempt_number" > 0),
	CONSTRAINT "forecast_notification_attempts_state_check" CHECK("forecast_notification_delivery_attempts"."state" IN ('started', 'succeeded', 'retry_scheduled', 'terminal_failure', 'interrupted')),
	CONSTRAINT "forecast_notification_attempts_failure_classification_check" CHECK("forecast_notification_delivery_attempts"."failure_classification" IS NULL OR "forecast_notification_delivery_attempts"."failure_classification" IN ('retryable', 'terminal', 'interrupted')),
	CONSTRAINT "forecast_notification_attempts_completion_check" CHECK((
    "forecast_notification_delivery_attempts"."state" = 'started' AND "forecast_notification_delivery_attempts"."finished_at" IS NULL
      AND "forecast_notification_delivery_attempts"."failure_classification" IS NULL AND "forecast_notification_delivery_attempts"."redacted_error_category" IS NULL
      AND "forecast_notification_delivery_attempts"."next_attempt_at" IS NULL
  ) OR (
    "forecast_notification_delivery_attempts"."state" = 'succeeded' AND "forecast_notification_delivery_attempts"."finished_at" IS NOT NULL
      AND "forecast_notification_delivery_attempts"."failure_classification" IS NULL AND "forecast_notification_delivery_attempts"."redacted_error_category" IS NULL
      AND "forecast_notification_delivery_attempts"."next_attempt_at" IS NULL
  ) OR (
    "forecast_notification_delivery_attempts"."state" = 'retry_scheduled' AND "forecast_notification_delivery_attempts"."finished_at" IS NOT NULL
      AND "forecast_notification_delivery_attempts"."failure_classification" = 'retryable' AND "forecast_notification_delivery_attempts"."redacted_error_category" IS NOT NULL
      AND "forecast_notification_delivery_attempts"."next_attempt_at" IS NOT NULL
  ) OR (
    "forecast_notification_delivery_attempts"."state" = 'terminal_failure' AND "forecast_notification_delivery_attempts"."finished_at" IS NOT NULL
      AND "forecast_notification_delivery_attempts"."failure_classification" IN ('retryable', 'terminal') AND "forecast_notification_delivery_attempts"."redacted_error_category" IS NOT NULL
      AND "forecast_notification_delivery_attempts"."next_attempt_at" IS NULL
  ) OR (
    "forecast_notification_delivery_attempts"."state" = 'interrupted' AND "forecast_notification_delivery_attempts"."finished_at" IS NOT NULL
      AND "forecast_notification_delivery_attempts"."failure_classification" = 'interrupted' AND "forecast_notification_delivery_attempts"."redacted_error_category" IS NOT NULL
      AND "forecast_notification_delivery_attempts"."next_attempt_at" IS NULL
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_attempts_outbox_number` ON `forecast_notification_delivery_attempts` (`outbox_id`,`attempt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_attempts_owner_token` ON `forecast_notification_delivery_attempts` (`owner_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_attempts_started` ON `forecast_notification_delivery_attempts` (`outbox_id`) WHERE "forecast_notification_delivery_attempts"."state" = 'started';--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_attempts_succeeded` ON `forecast_notification_delivery_attempts` (`outbox_id`) WHERE "forecast_notification_delivery_attempts"."state" = 'succeeded';--> statement-breakpoint
CREATE INDEX `idx_forecast_notification_attempts_profile_created` ON `forecast_notification_delivery_attempts` (`profile_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `forecast_notification_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` integer NOT NULL,
	`forecast_id` integer NOT NULL,
	`evaluation_run_id` integer NOT NULL,
	`review_item_id` integer NOT NULL,
	`analysis_snapshot_id` integer,
	`category` text NOT NULL,
	`dedup_contract_version` text NOT NULL,
	`projector_version` text NOT NULL,
	`payload_schema_version` text NOT NULL,
	`dedup_key` text NOT NULL,
	`payload_json` text NOT NULL,
	`payload_fingerprint` text NOT NULL,
	`event_occurred_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`forecast_id`,`profile_id`) REFERENCES `forecasts`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evaluation_run_id`,`profile_id`) REFERENCES `evaluation_runs`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`review_item_id`,`profile_id`) REFERENCES `forecast_review_items`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`analysis_snapshot_id`,`profile_id`) REFERENCES `analysis_snapshots`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_notification_intents_category_check" CHECK("forecast_notification_intents"."category" IN ('target_hit', 'invalidated', 'expired', 'needs_review')),
	CONSTRAINT "forecast_notification_intents_dedup_key_check" CHECK(length("forecast_notification_intents"."dedup_key") = 64),
	CONSTRAINT "forecast_notification_intents_payload_check" CHECK(json_valid("forecast_notification_intents"."payload_json")),
	CONSTRAINT "forecast_notification_intents_payload_fingerprint_check" CHECK(length("forecast_notification_intents"."payload_fingerprint") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_intents_id_profile` ON `forecast_notification_intents` (`id`,`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_intents_dedup_key` ON `forecast_notification_intents` (`dedup_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_intents_source_category` ON `forecast_notification_intents` (`profile_id`,`evaluation_run_id`,`category`);--> statement-breakpoint
CREATE INDEX `idx_forecast_notification_intents_profile_created` ON `forecast_notification_intents` (`profile_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_notification_intents_profile_category` ON `forecast_notification_intents` (`profile_id`,`category`,`created_at`);--> statement-breakpoint
CREATE TABLE `forecast_notification_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`intent_id` text NOT NULL,
	`policy_decision_id` text NOT NULL,
	`profile_id` integer NOT NULL,
	`retry_policy_version` text NOT NULL,
	`quiet_hours_policy_version` text NOT NULL,
	`state` text NOT NULL,
	`available_at` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`last_attempt_at` text,
	`succeeded_at` text,
	`dead_lettered_at` text,
	`last_failure_category` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`intent_id`,`profile_id`) REFERENCES `forecast_notification_intents`(`id`,`profile_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`policy_decision_id`,`profile_id`) REFERENCES `forecast_notification_policy_decisions`(`id`,`profile_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "forecast_notification_outbox_state_check" CHECK("forecast_notification_outbox"."state" IN ('pending', 'deferred', 'suppressed', 'claimed', 'retry_scheduled', 'succeeded', 'dead_letter')),
	CONSTRAINT "forecast_notification_outbox_attempt_count_check" CHECK("forecast_notification_outbox"."attempt_count" >= 0 AND (
    ("forecast_notification_outbox"."state" IN ('pending', 'deferred', 'suppressed') AND "forecast_notification_outbox"."attempt_count" = 0)
    OR ("forecast_notification_outbox"."state" IN ('claimed', 'retry_scheduled', 'succeeded', 'dead_letter') AND "forecast_notification_outbox"."attempt_count" > 0)
  )),
	CONSTRAINT "forecast_notification_outbox_available_check" CHECK("forecast_notification_outbox"."state" IN ('suppressed', 'succeeded', 'dead_letter') OR "forecast_notification_outbox"."available_at" IS NOT NULL),
	CONSTRAINT "forecast_notification_outbox_lease_check" CHECK((
    "forecast_notification_outbox"."state" = 'claimed' AND "forecast_notification_outbox"."lease_token" IS NOT NULL AND "forecast_notification_outbox"."lease_expires_at" IS NOT NULL
  ) OR (
    "forecast_notification_outbox"."state" <> 'claimed' AND "forecast_notification_outbox"."lease_token" IS NULL AND "forecast_notification_outbox"."lease_expires_at" IS NULL
  )),
	CONSTRAINT "forecast_notification_outbox_success_check" CHECK((
    "forecast_notification_outbox"."state" = 'succeeded' AND "forecast_notification_outbox"."succeeded_at" IS NOT NULL
  ) OR (
    "forecast_notification_outbox"."state" <> 'succeeded' AND "forecast_notification_outbox"."succeeded_at" IS NULL
  )),
	CONSTRAINT "forecast_notification_outbox_dead_letter_check" CHECK((
    "forecast_notification_outbox"."state" = 'dead_letter' AND "forecast_notification_outbox"."dead_lettered_at" IS NOT NULL
  ) OR (
    "forecast_notification_outbox"."state" <> 'dead_letter' AND "forecast_notification_outbox"."dead_lettered_at" IS NULL
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_outbox_id_profile` ON `forecast_notification_outbox` (`id`,`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_outbox_intent` ON `forecast_notification_outbox` (`intent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_outbox_policy_decision` ON `forecast_notification_outbox` (`policy_decision_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_outbox_lease_token` ON `forecast_notification_outbox` (`lease_token`);--> statement-breakpoint
CREATE INDEX `idx_forecast_notification_outbox_profile_state_available` ON `forecast_notification_outbox` (`profile_id`,`state`,`available_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_notification_outbox_state_lease` ON `forecast_notification_outbox` (`state`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `forecast_notification_policy_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`intent_id` text NOT NULL,
	`profile_id` integer NOT NULL,
	`policy_version` text NOT NULL,
	`preference_revision` integer,
	`decision` text NOT NULL,
	`reason_code` text NOT NULL,
	`decided_at` text NOT NULL,
	`earliest_eligible_at` text,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`intent_id`,`profile_id`) REFERENCES `forecast_notification_intents`(`id`,`profile_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`,`preference_revision`) REFERENCES `forecast_notification_preference_revisions`(`profile_id`,`revision`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_notification_policy_decisions_decision_check" CHECK("forecast_notification_policy_decisions"."decision" IN ('eligible', 'deferred_quiet_hours', 'suppressed_no_consent', 'suppressed_category_disabled', 'suppressed_unsupported_category', 'suppressed_historical_cutover')),
	CONSTRAINT "forecast_notification_policy_decisions_earliest_check" CHECK((
    "forecast_notification_policy_decisions"."decision" = 'deferred_quiet_hours' AND "forecast_notification_policy_decisions"."earliest_eligible_at" IS NOT NULL
  ) OR (
    "forecast_notification_policy_decisions"."decision" <> 'deferred_quiet_hours' AND "forecast_notification_policy_decisions"."earliest_eligible_at" IS NULL
  )),
	CONSTRAINT "forecast_notification_policy_decisions_warnings_check" CHECK(json_valid("forecast_notification_policy_decisions"."warnings_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_policy_decisions_id_profile` ON `forecast_notification_policy_decisions` (`id`,`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_policy_decisions_intent` ON `forecast_notification_policy_decisions` (`intent_id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_notification_policy_decisions_profile_decided` ON `forecast_notification_policy_decisions` (`profile_id`,`decided_at`,`id`);--> statement-breakpoint
CREATE TABLE `forecast_notification_preference_revisions` (
	`profile_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`preference_version` text NOT NULL,
	`master_consent` integer DEFAULT false NOT NULL,
	`target_hit_enabled` integer DEFAULT false NOT NULL,
	`invalidated_enabled` integer DEFAULT false NOT NULL,
	`expired_enabled` integer DEFAULT false NOT NULL,
	`needs_review_enabled` integer DEFAULT false NOT NULL,
	`timezone` text NOT NULL,
	`quiet_hours_start` text,
	`quiet_hours_end` text,
	`change_source` text NOT NULL,
	`change_reason` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`profile_id`, `revision`),
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "forecast_notification_preference_revisions_revision_check" CHECK("forecast_notification_preference_revisions"."revision" > 0),
	CONSTRAINT "forecast_notification_preference_revisions_booleans_check" CHECK("forecast_notification_preference_revisions"."master_consent" IN (0, 1)
    AND "forecast_notification_preference_revisions"."target_hit_enabled" IN (0, 1) AND "forecast_notification_preference_revisions"."invalidated_enabled" IN (0, 1)
    AND "forecast_notification_preference_revisions"."expired_enabled" IN (0, 1) AND "forecast_notification_preference_revisions"."needs_review_enabled" IN (0, 1)),
	CONSTRAINT "forecast_notification_preference_revisions_quiet_hours_check" CHECK((
    "forecast_notification_preference_revisions"."quiet_hours_start" IS NULL AND "forecast_notification_preference_revisions"."quiet_hours_end" IS NULL
  ) OR (
    "forecast_notification_preference_revisions"."quiet_hours_start" IS NOT NULL AND "forecast_notification_preference_revisions"."quiet_hours_end" IS NOT NULL
    AND length("forecast_notification_preference_revisions"."quiet_hours_start") = 5 AND length("forecast_notification_preference_revisions"."quiet_hours_end") = 5
    AND "forecast_notification_preference_revisions"."quiet_hours_start" <> "forecast_notification_preference_revisions"."quiet_hours_end"
  ))
);
--> statement-breakpoint
CREATE INDEX `idx_forecast_notification_preference_revisions_created` ON `forecast_notification_preference_revisions` (`profile_id`,`created_at`,`revision`);--> statement-breakpoint
CREATE TABLE `forecast_notification_preferences` (
	`profile_id` integer PRIMARY KEY NOT NULL,
	`current_revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`,`current_revision`) REFERENCES `forecast_notification_preference_revisions`(`profile_id`,`revision`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_notification_preferences_revision_check" CHECK("forecast_notification_preferences"."current_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE `forecast_notification_projection_checkpoints` (
	`profile_id` integer NOT NULL,
	`projector_version` text NOT NULL,
	`baseline_evaluation_run_id` integer NOT NULL,
	`last_evaluation_run_id` integer NOT NULL,
	`activated_at` text NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`recovery_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`profile_id`, `projector_version`),
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "forecast_notification_projection_checkpoints_cursor_check" CHECK("forecast_notification_projection_checkpoints"."baseline_evaluation_run_id" >= 0 AND "forecast_notification_projection_checkpoints"."last_evaluation_run_id" >= "forecast_notification_projection_checkpoints"."baseline_evaluation_run_id"),
	CONSTRAINT "forecast_notification_projection_checkpoints_lease_check" CHECK(("forecast_notification_projection_checkpoints"."lease_token" IS NULL AND "forecast_notification_projection_checkpoints"."lease_expires_at" IS NULL) OR ("forecast_notification_projection_checkpoints"."lease_token" IS NOT NULL AND "forecast_notification_projection_checkpoints"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "forecast_notification_projection_checkpoints_recovery_check" CHECK("forecast_notification_projection_checkpoints"."recovery_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_forecast_notification_projection_checkpoints_lease` ON `forecast_notification_projection_checkpoints` (`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `forecast_notification_projection_items` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` integer NOT NULL,
	`projector_version` text NOT NULL,
	`evaluation_run_id` integer NOT NULL,
	`intent_id` text,
	`category` text,
	`dedup_key` text,
	`classification` text NOT NULL,
	`reason_code` text NOT NULL,
	`source_created_at` text NOT NULL,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`processed_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`profile_id`,`projector_version`) REFERENCES `forecast_notification_projection_checkpoints`(`profile_id`,`projector_version`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evaluation_run_id`,`profile_id`) REFERENCES `evaluation_runs`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`intent_id`,`profile_id`) REFERENCES `forecast_notification_intents`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_notification_projection_items_category_check" CHECK("forecast_notification_projection_items"."category" IS NULL OR "forecast_notification_projection_items"."category" IN ('target_hit', 'invalidated', 'expired', 'needs_review')),
	CONSTRAINT "forecast_notification_projection_items_dedup_check" CHECK("forecast_notification_projection_items"."dedup_key" IS NULL OR length("forecast_notification_projection_items"."dedup_key") = 64),
	CONSTRAINT "forecast_notification_projection_items_classification_check" CHECK("forecast_notification_projection_items"."classification" IN ('intent_materialized', 'excluded_no_change', 'excluded_unsupported', 'invalid_source_needs_review')),
	CONSTRAINT "forecast_notification_projection_items_materialization_check" CHECK((
    "forecast_notification_projection_items"."classification" = 'intent_materialized'
    AND "forecast_notification_projection_items"."intent_id" IS NOT NULL AND "forecast_notification_projection_items"."category" IS NOT NULL AND "forecast_notification_projection_items"."dedup_key" IS NOT NULL
  ) OR (
    "forecast_notification_projection_items"."classification" <> 'intent_materialized'
    AND "forecast_notification_projection_items"."intent_id" IS NULL AND "forecast_notification_projection_items"."category" IS NULL AND "forecast_notification_projection_items"."dedup_key" IS NULL
  )),
	CONSTRAINT "forecast_notification_projection_items_warnings_check" CHECK(json_valid("forecast_notification_projection_items"."warnings_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_projection_items_source` ON `forecast_notification_projection_items` (`profile_id`,`projector_version`,`evaluation_run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_projection_items_intent` ON `forecast_notification_projection_items` (`intent_id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_notification_projection_items_profile_processed` ON `forecast_notification_projection_items` (`profile_id`,`processed_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_analysis_snapshots_id_profile` ON `analysis_snapshots` (`id`,`profile_id`);
