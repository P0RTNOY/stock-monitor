CREATE TABLE `forecast_in_app_notification_entries` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`profile_id` integer NOT NULL,
	`source_intent_id` text NOT NULL,
	`forecast_id` integer NOT NULL,
	`evaluation_run_id` integer NOT NULL,
	`review_item_id` integer NOT NULL,
	`analysis_snapshot_id` integer,
	`category` text NOT NULL,
	`symbol` text NOT NULL,
	`occurred_at` text NOT NULL,
	`presentation_version` text NOT NULL,
	`presentation_json` text NOT NULL,
	`presentation_fingerprint` text NOT NULL,
	`deep_link_kind` text NOT NULL,
	`state` text DEFAULT 'unread' NOT NULL,
	`first_read_at` text,
	`state_updated_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_intent_id`,`profile_id`) REFERENCES `forecast_notification_intents`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`forecast_id`,`profile_id`) REFERENCES `forecasts`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evaluation_run_id`,`profile_id`) REFERENCES `evaluation_runs`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`review_item_id`,`profile_id`) REFERENCES `forecast_review_items`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`analysis_snapshot_id`,`profile_id`) REFERENCES `analysis_snapshots`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_in_app_entries_category_check" CHECK("forecast_in_app_notification_entries"."category" IN ('target_hit', 'invalidated', 'expired', 'needs_review')),
	CONSTRAINT "forecast_in_app_entries_state_check" CHECK("forecast_in_app_notification_entries"."state" IN ('unread', 'read')),
	CONSTRAINT "forecast_in_app_entries_read_check" CHECK("forecast_in_app_notification_entries"."state" = 'unread' OR "forecast_in_app_notification_entries"."first_read_at" IS NOT NULL),
	CONSTRAINT "forecast_in_app_entries_presentation_check" CHECK(json_valid("forecast_in_app_notification_entries"."presentation_json")
    AND length("forecast_in_app_notification_entries"."presentation_fingerprint") = 64),
	CONSTRAINT "forecast_in_app_entries_link_check" CHECK("forecast_in_app_notification_entries"."deep_link_kind" = 'notification_evidence')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_in_app_entries_id` ON `forecast_in_app_notification_entries` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_in_app_entries_id_profile` ON `forecast_in_app_notification_entries` (`id`,`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_in_app_entries_source` ON `forecast_in_app_notification_entries` (`profile_id`,`source_intent_id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_in_app_entries_list` ON `forecast_in_app_notification_entries` (`profile_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_in_app_entries_unread` ON `forecast_in_app_notification_entries` (`profile_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_forecast_in_app_entries_category_list` ON `forecast_in_app_notification_entries` (`profile_id`,`category`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_in_app_entries_high_water` ON `forecast_in_app_notification_entries` (`profile_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `forecast_in_app_notification_projection_checkpoints` (
	`profile_id` integer NOT NULL,
	`projector_version` text NOT NULL,
	`baseline_evaluation_run_id` integer NOT NULL,
	`baseline_intent_id` text NOT NULL,
	`last_evaluation_run_id` integer NOT NULL,
	`last_intent_id` text NOT NULL,
	`activated_at` text NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`recovery_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`profile_id`, `projector_version`),
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "forecast_in_app_checkpoints_cursor_check" CHECK("forecast_in_app_notification_projection_checkpoints"."baseline_evaluation_run_id" >= 0
    AND "forecast_in_app_notification_projection_checkpoints"."last_evaluation_run_id" >= "forecast_in_app_notification_projection_checkpoints"."baseline_evaluation_run_id"
    AND ("forecast_in_app_notification_projection_checkpoints"."baseline_evaluation_run_id" > 0 OR "forecast_in_app_notification_projection_checkpoints"."baseline_intent_id" = '')
    AND ("forecast_in_app_notification_projection_checkpoints"."last_evaluation_run_id" > 0 OR "forecast_in_app_notification_projection_checkpoints"."last_intent_id" = '')
    AND ("forecast_in_app_notification_projection_checkpoints"."last_evaluation_run_id" > "forecast_in_app_notification_projection_checkpoints"."baseline_evaluation_run_id"
      OR "forecast_in_app_notification_projection_checkpoints"."last_intent_id" >= "forecast_in_app_notification_projection_checkpoints"."baseline_intent_id")),
	CONSTRAINT "forecast_in_app_checkpoints_lease_check" CHECK((
    "forecast_in_app_notification_projection_checkpoints"."lease_token" IS NULL AND "forecast_in_app_notification_projection_checkpoints"."lease_expires_at" IS NULL
  ) OR (
    "forecast_in_app_notification_projection_checkpoints"."lease_token" IS NOT NULL AND "forecast_in_app_notification_projection_checkpoints"."lease_expires_at" IS NOT NULL
  )),
	CONSTRAINT "forecast_in_app_checkpoints_recovery_check" CHECK("forecast_in_app_notification_projection_checkpoints"."recovery_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_forecast_in_app_checkpoints_lease` ON `forecast_in_app_notification_projection_checkpoints` (`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `forecast_in_app_notification_projection_items` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` integer NOT NULL,
	`projector_version` text NOT NULL,
	`source_intent_id` text NOT NULL,
	`evaluation_run_id` integer NOT NULL,
	`entry_id` text,
	`classification` text NOT NULL,
	`reason_code` text NOT NULL,
	`source_created_at` text NOT NULL,
	`processed_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`profile_id`,`projector_version`) REFERENCES `forecast_in_app_notification_projection_checkpoints`(`profile_id`,`projector_version`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_intent_id`,`profile_id`) REFERENCES `forecast_notification_intents`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entry_id`,`profile_id`) REFERENCES `forecast_in_app_notification_entries`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_in_app_projection_classification_check" CHECK("forecast_in_app_notification_projection_items"."classification" IN (
    'materialized', 'duplicate', 'unsupported_source', 'malformed_source'
  )),
	CONSTRAINT "forecast_in_app_projection_entry_check" CHECK((
    "forecast_in_app_notification_projection_items"."classification" IN ('materialized', 'duplicate') AND "forecast_in_app_notification_projection_items"."entry_id" IS NOT NULL
  ) OR (
    "forecast_in_app_notification_projection_items"."classification" IN ('unsupported_source', 'malformed_source') AND "forecast_in_app_notification_projection_items"."entry_id" IS NULL
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_in_app_projection_source` ON `forecast_in_app_notification_projection_items` (`profile_id`,`projector_version`,`source_intent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_in_app_projection_entry` ON `forecast_in_app_notification_projection_items` (`entry_id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_in_app_projection_processed` ON `forecast_in_app_notification_projection_items` (`profile_id`,`processed_at`,`id`);--> statement-breakpoint
CREATE TABLE `forecast_in_app_notification_state_events` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` integer NOT NULL,
	`entry_id` text,
	`event_kind` text NOT NULL,
	`high_water_sequence` integer,
	`affected_count` integer NOT NULL,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_id`,`profile_id`) REFERENCES `forecast_in_app_notification_entries`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_in_app_state_events_kind_check" CHECK("forecast_in_app_notification_state_events"."event_kind" IN ('read', 'unread', 'mark_all_read')),
	CONSTRAINT "forecast_in_app_state_events_count_check" CHECK("forecast_in_app_notification_state_events"."affected_count" > 0),
	CONSTRAINT "forecast_in_app_state_events_shape_check" CHECK((
    "forecast_in_app_notification_state_events"."event_kind" IN ('read', 'unread') AND "forecast_in_app_notification_state_events"."entry_id" IS NOT NULL
      AND "forecast_in_app_notification_state_events"."high_water_sequence" IS NULL AND "forecast_in_app_notification_state_events"."affected_count" = 1
  ) OR (
    "forecast_in_app_notification_state_events"."event_kind" = 'mark_all_read' AND "forecast_in_app_notification_state_events"."entry_id" IS NULL
      AND "forecast_in_app_notification_state_events"."high_water_sequence" IS NOT NULL AND "forecast_in_app_notification_state_events"."high_water_sequence" >= 0
  ))
);
--> statement-breakpoint
CREATE INDEX `idx_forecast_in_app_state_events_profile_created` ON `forecast_in_app_notification_state_events` (`profile_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_in_app_state_events_entry` ON `forecast_in_app_notification_state_events` (`entry_id`,`created_at`);--> statement-breakpoint
CREATE TRIGGER `forecast_in_app_entries_immutable_presentation`
BEFORE UPDATE ON `forecast_in_app_notification_entries`
WHEN OLD.id <> NEW.id OR OLD.profile_id <> NEW.profile_id
  OR OLD.source_intent_id <> NEW.source_intent_id OR OLD.forecast_id <> NEW.forecast_id
  OR OLD.evaluation_run_id <> NEW.evaluation_run_id OR OLD.review_item_id <> NEW.review_item_id
  OR OLD.analysis_snapshot_id IS NOT NEW.analysis_snapshot_id OR OLD.category <> NEW.category
  OR OLD.symbol <> NEW.symbol OR OLD.occurred_at <> NEW.occurred_at
  OR OLD.presentation_version <> NEW.presentation_version
  OR OLD.presentation_json <> NEW.presentation_json
  OR OLD.presentation_fingerprint <> NEW.presentation_fingerprint
  OR OLD.deep_link_kind <> NEW.deep_link_kind OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'in-app notification presentation is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `forecast_in_app_state_events_append_only_update`
BEFORE UPDATE ON `forecast_in_app_notification_state_events`
BEGIN
  SELECT RAISE(ABORT, 'in-app notification state events are append-only');
END;--> statement-breakpoint
CREATE TRIGGER `forecast_in_app_state_events_append_only_delete`
BEFORE DELETE ON `forecast_in_app_notification_state_events`
BEGIN
  SELECT RAISE(ABORT, 'in-app notification state events are append-only');
END;
