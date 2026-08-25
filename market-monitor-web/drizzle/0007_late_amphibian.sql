CREATE TABLE `forecast_email_capabilities` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` integer NOT NULL,
	`recipient_id` text NOT NULL,
	`purpose` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_version` text NOT NULL,
	`state` text NOT NULL,
	`expires_at` text,
	`consent_revision` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` text,
	`consumed_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_id`,`profile_id`) REFERENCES `forecast_email_recipients`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`,`consent_revision`,`recipient_id`) REFERENCES `forecast_email_consent_revisions`(`profile_id`,`revision`,`recipient_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_email_capabilities_purpose_check" CHECK("forecast_email_capabilities"."purpose" IN ('verification', 'unsubscribe')),
	CONSTRAINT "forecast_email_capabilities_token_check" CHECK(length("forecast_email_capabilities"."token_hash") = 64
    AND length("forecast_email_capabilities"."token_version") BETWEEN 1 AND 50),
	CONSTRAINT "forecast_email_capabilities_state_check" CHECK("forecast_email_capabilities"."state" IN ('active', 'consumed', 'revoked', 'expired')),
	CONSTRAINT "forecast_email_capabilities_binding_check" CHECK((
    "forecast_email_capabilities"."purpose" = 'verification' AND "forecast_email_capabilities"."expires_at" IS NOT NULL AND "forecast_email_capabilities"."consent_revision" IS NULL
  ) OR (
    "forecast_email_capabilities"."purpose" = 'unsubscribe' AND "forecast_email_capabilities"."consent_revision" IS NOT NULL
  )),
	CONSTRAINT "forecast_email_capabilities_state_timestamps_check" CHECK((
    "forecast_email_capabilities"."state" IN ('active', 'expired') AND "forecast_email_capabilities"."consumed_at" IS NULL AND "forecast_email_capabilities"."revoked_at" IS NULL
  ) OR (
    "forecast_email_capabilities"."state" = 'consumed' AND "forecast_email_capabilities"."consumed_at" IS NOT NULL AND "forecast_email_capabilities"."revoked_at" IS NULL
  ) OR (
    "forecast_email_capabilities"."state" = 'revoked' AND "forecast_email_capabilities"."consumed_at" IS NULL AND "forecast_email_capabilities"."revoked_at" IS NOT NULL
  )),
	CONSTRAINT "forecast_email_capabilities_attempt_check" CHECK("forecast_email_capabilities"."attempt_count" >= 0 AND (
    ("forecast_email_capabilities"."attempt_count" = 0 AND "forecast_email_capabilities"."last_attempt_at" IS NULL)
    OR ("forecast_email_capabilities"."attempt_count" > 0 AND "forecast_email_capabilities"."last_attempt_at" IS NOT NULL)
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_capabilities_id_profile` ON `forecast_email_capabilities` (`id`,`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_capabilities_token_hash` ON `forecast_email_capabilities` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_capabilities_active_purpose` ON `forecast_email_capabilities` (`profile_id`,`recipient_id`,`purpose`) WHERE "forecast_email_capabilities"."state" = 'active';--> statement-breakpoint
CREATE INDEX `idx_forecast_email_capabilities_expiry` ON `forecast_email_capabilities` (`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `forecast_email_consent_revisions` (
	`profile_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`recipient_id` text NOT NULL,
	`master_consent` integer DEFAULT false NOT NULL,
	`target_hit_enabled` integer DEFAULT false NOT NULL,
	`invalidated_enabled` integer DEFAULT false NOT NULL,
	`expired_enabled` integer DEFAULT false NOT NULL,
	`needs_review_enabled` integer DEFAULT false NOT NULL,
	`consent_source` text NOT NULL,
	`consented_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`profile_id`, `revision`),
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_id`,`profile_id`) REFERENCES `forecast_email_recipients`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_email_consent_revisions_revision_check" CHECK("forecast_email_consent_revisions"."revision" > 0),
	CONSTRAINT "forecast_email_consent_revisions_booleans_check" CHECK("forecast_email_consent_revisions"."master_consent" IN (0, 1)
    AND "forecast_email_consent_revisions"."target_hit_enabled" IN (0, 1) AND "forecast_email_consent_revisions"."invalidated_enabled" IN (0, 1)
    AND "forecast_email_consent_revisions"."expired_enabled" IN (0, 1) AND "forecast_email_consent_revisions"."needs_review_enabled" IN (0, 1)),
	CONSTRAINT "forecast_email_consent_revisions_source_check" CHECK("forecast_email_consent_revisions"."consent_source" IN (
    'operator', 'unsubscribe', 'provider_complaint', 'recipient_replacement', 'internal'
  )),
	CONSTRAINT "forecast_email_consent_revisions_lifecycle_check" CHECK((
    "forecast_email_consent_revisions"."master_consent" = 1 AND "forecast_email_consent_revisions"."consented_at" IS NOT NULL AND "forecast_email_consent_revisions"."revoked_at" IS NULL
  ) OR (
    "forecast_email_consent_revisions"."master_consent" = 0 AND "forecast_email_consent_revisions"."revoked_at" IS NOT NULL
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_consent_revisions_profile_revision_recipient` ON `forecast_email_consent_revisions` (`profile_id`,`revision`,`recipient_id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_email_consent_revisions_recipient_created` ON `forecast_email_consent_revisions` (`profile_id`,`recipient_id`,`created_at`,`revision`);--> statement-breakpoint
CREATE TABLE `forecast_email_consents` (
	`profile_id` integer PRIMARY KEY NOT NULL,
	`current_revision` integer NOT NULL,
	`recipient_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`,`current_revision`,`recipient_id`) REFERENCES `forecast_email_consent_revisions`(`profile_id`,`revision`,`recipient_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_id`,`profile_id`) REFERENCES `forecast_email_recipients`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_email_consents_revision_check" CHECK("forecast_email_consents"."current_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE `forecast_email_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` integer NOT NULL,
	`recipient_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`outbox_id` text,
	`pre_send_decision_id` text,
	`verification_capability_id` text,
	`template_kind` text NOT NULL,
	`template_version` text NOT NULL,
	`locale` text NOT NULL,
	`content_hash` text NOT NULL,
	`provider` text DEFAULT 'resend' NOT NULL,
	`idempotency_key` text NOT NULL,
	`canonical_request_hash` text NOT NULL,
	`state` text NOT NULL,
	`request_started_at` text,
	`last_request_at` text,
	`safe_retry_until` text,
	`provider_accepted_at` text,
	`provider_email_id` text,
	`dead_lettered_at` text,
	`reconciliation_state` text DEFAULT 'none' NOT NULL,
	`reconciliation_event_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_id`,`profile_id`) REFERENCES `forecast_email_recipients`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`outbox_id`,`profile_id`) REFERENCES `forecast_notification_outbox`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pre_send_decision_id`,`profile_id`) REFERENCES `forecast_email_pre_send_decisions`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`verification_capability_id`,`profile_id`) REFERENCES `forecast_email_capabilities`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_email_deliveries_source_check" CHECK((
    "forecast_email_deliveries"."source_kind" = 'forecast_notification' AND "forecast_email_deliveries"."outbox_id" IS NOT NULL
      AND "forecast_email_deliveries"."pre_send_decision_id" IS NOT NULL AND "forecast_email_deliveries"."verification_capability_id" IS NULL
  ) OR (
    "forecast_email_deliveries"."source_kind" = 'recipient_verification' AND "forecast_email_deliveries"."outbox_id" IS NULL
      AND "forecast_email_deliveries"."pre_send_decision_id" IS NULL AND "forecast_email_deliveries"."verification_capability_id" IS NOT NULL
  )),
	CONSTRAINT "forecast_email_deliveries_template_check" CHECK(length("forecast_email_deliveries"."template_kind") BETWEEN 1 AND 50
    AND length("forecast_email_deliveries"."template_version") BETWEEN 1 AND 50 AND length("forecast_email_deliveries"."locale") BETWEEN 2 AND 35),
	CONSTRAINT "forecast_email_deliveries_hashes_check" CHECK(length("forecast_email_deliveries"."content_hash") = 64
    AND length("forecast_email_deliveries"."canonical_request_hash") = 64),
	CONSTRAINT "forecast_email_deliveries_provider_check" CHECK("forecast_email_deliveries"."provider" = 'resend'
    AND length("forecast_email_deliveries"."idempotency_key") BETWEEN 1 AND 256),
	CONSTRAINT "forecast_email_deliveries_state_check" CHECK("forecast_email_deliveries"."state" IN (
    'prepared', 'request_started', 'provider_accepted', 'ambiguous', 'terminal_failure', 'dead_letter'
  )),
	CONSTRAINT "forecast_email_deliveries_request_check" CHECK((
    "forecast_email_deliveries"."request_started_at" IS NULL AND "forecast_email_deliveries"."last_request_at" IS NULL AND "forecast_email_deliveries"."safe_retry_until" IS NULL
  ) OR (
    "forecast_email_deliveries"."request_started_at" IS NOT NULL AND "forecast_email_deliveries"."last_request_at" IS NOT NULL
      AND "forecast_email_deliveries"."last_request_at" >= "forecast_email_deliveries"."request_started_at" AND "forecast_email_deliveries"."safe_retry_until" IS NOT NULL
      AND "forecast_email_deliveries"."safe_retry_until" > "forecast_email_deliveries"."request_started_at"
  )),
	CONSTRAINT "forecast_email_deliveries_acceptance_check" CHECK((
    "forecast_email_deliveries"."provider_accepted_at" IS NULL AND "forecast_email_deliveries"."provider_email_id" IS NULL
  ) OR (
    "forecast_email_deliveries"."provider_accepted_at" IS NOT NULL AND "forecast_email_deliveries"."provider_email_id" IS NOT NULL
      AND length("forecast_email_deliveries"."provider_email_id") BETWEEN 1 AND 200
  )),
	CONSTRAINT "forecast_email_deliveries_state_shape_check" CHECK((
    "forecast_email_deliveries"."state" = 'prepared' AND "forecast_email_deliveries"."request_started_at" IS NULL
      AND "forecast_email_deliveries"."provider_accepted_at" IS NULL AND "forecast_email_deliveries"."dead_lettered_at" IS NULL
  ) OR (
    "forecast_email_deliveries"."state" = 'request_started' AND "forecast_email_deliveries"."request_started_at" IS NOT NULL
      AND "forecast_email_deliveries"."provider_accepted_at" IS NULL AND "forecast_email_deliveries"."dead_lettered_at" IS NULL
  ) OR (
    "forecast_email_deliveries"."state" = 'provider_accepted' AND "forecast_email_deliveries"."request_started_at" IS NOT NULL
      AND "forecast_email_deliveries"."provider_accepted_at" IS NOT NULL AND "forecast_email_deliveries"."dead_lettered_at" IS NULL
  ) OR (
    "forecast_email_deliveries"."state" IN ('ambiguous', 'terminal_failure') AND "forecast_email_deliveries"."request_started_at" IS NOT NULL
      AND "forecast_email_deliveries"."dead_lettered_at" IS NULL
  ) OR (
    "forecast_email_deliveries"."state" = 'dead_letter' AND "forecast_email_deliveries"."dead_lettered_at" IS NOT NULL
  )),
	CONSTRAINT "forecast_email_deliveries_reconciliation_state_check" CHECK("forecast_email_deliveries"."reconciliation_state" IN (
    'none', 'delayed', 'delivered', 'failed', 'bounced', 'complained', 'suppressed'
  )),
	CONSTRAINT "forecast_email_deliveries_reconciliation_check" CHECK((
    "forecast_email_deliveries"."reconciliation_state" = 'none' AND "forecast_email_deliveries"."reconciliation_event_at" IS NULL
  ) OR (
    "forecast_email_deliveries"."reconciliation_state" <> 'none' AND "forecast_email_deliveries"."reconciliation_event_at" IS NOT NULL
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_deliveries_id_profile` ON `forecast_email_deliveries` (`id`,`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_deliveries_outbox` ON `forecast_email_deliveries` (`outbox_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_deliveries_pre_send_decision` ON `forecast_email_deliveries` (`pre_send_decision_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_deliveries_verification_capability` ON `forecast_email_deliveries` (`verification_capability_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_deliveries_idempotency_key` ON `forecast_email_deliveries` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_deliveries_provider_email_id` ON `forecast_email_deliveries` (`provider_email_id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_email_deliveries_profile_state_created` ON `forecast_email_deliveries` (`profile_id`,`state`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_email_deliveries_reconciliation` ON `forecast_email_deliveries` (`reconciliation_state`,`reconciliation_event_at`);--> statement-breakpoint
CREATE TABLE `forecast_email_pre_send_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`outbox_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`profile_id` integer NOT NULL,
	`recipient_id` text,
	`notification_preference_revision` integer,
	`email_consent_revision` integer,
	`decision` text NOT NULL,
	`reason_code` text NOT NULL,
	`checked_at` text NOT NULL,
	`next_available_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`outbox_id`,`profile_id`) REFERENCES `forecast_notification_outbox`(`id`,`profile_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attempt_id`,`profile_id`) REFERENCES `forecast_notification_delivery_attempts`(`id`,`profile_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_id`,`profile_id`) REFERENCES `forecast_email_recipients`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`,`notification_preference_revision`) REFERENCES `forecast_notification_preference_revisions`(`profile_id`,`revision`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`,`email_consent_revision`,`recipient_id`) REFERENCES `forecast_email_consent_revisions`(`profile_id`,`revision`,`recipient_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_email_pre_send_decisions_decision_check" CHECK("forecast_email_pre_send_decisions"."decision" IN ('eligible', 'deferred_quiet_hours', 'suppressed')),
	CONSTRAINT "forecast_email_pre_send_decisions_reason_check" CHECK(length("forecast_email_pre_send_decisions"."reason_code") BETWEEN 1 AND 100),
	CONSTRAINT "forecast_email_pre_send_decisions_shape_check" CHECK((
    "forecast_email_pre_send_decisions"."decision" = 'eligible' AND "forecast_email_pre_send_decisions"."recipient_id" IS NOT NULL
      AND "forecast_email_pre_send_decisions"."notification_preference_revision" IS NOT NULL AND "forecast_email_pre_send_decisions"."email_consent_revision" IS NOT NULL
      AND "forecast_email_pre_send_decisions"."next_available_at" IS NULL
  ) OR (
    "forecast_email_pre_send_decisions"."decision" = 'deferred_quiet_hours' AND "forecast_email_pre_send_decisions"."recipient_id" IS NOT NULL
      AND "forecast_email_pre_send_decisions"."notification_preference_revision" IS NOT NULL AND "forecast_email_pre_send_decisions"."email_consent_revision" IS NOT NULL
      AND "forecast_email_pre_send_decisions"."next_available_at" IS NOT NULL
  ) OR (
    "forecast_email_pre_send_decisions"."decision" = 'suppressed' AND "forecast_email_pre_send_decisions"."next_available_at" IS NULL
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_pre_send_decisions_id_profile` ON `forecast_email_pre_send_decisions` (`id`,`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_pre_send_decisions_attempt` ON `forecast_email_pre_send_decisions` (`attempt_id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_email_pre_send_decisions_profile_checked` ON `forecast_email_pre_send_decisions` (`profile_id`,`checked_at`,`id`);--> statement-breakpoint
CREATE TABLE `forecast_email_provider_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`profile_id` integer NOT NULL,
	`attempt_number` integer NOT NULL,
	`notification_attempt_id` text,
	`state` text NOT NULL,
	`failure_classification` text,
	`redacted_error_category` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`next_attempt_at` text,
	`safe_retry_until` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`delivery_id`,`profile_id`) REFERENCES `forecast_email_deliveries`(`id`,`profile_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`notification_attempt_id`,`profile_id`) REFERENCES `forecast_notification_delivery_attempts`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_email_provider_attempts_number_check" CHECK("forecast_email_provider_attempts"."attempt_number" > 0),
	CONSTRAINT "forecast_email_provider_attempts_state_check" CHECK("forecast_email_provider_attempts"."state" IN (
    'started', 'accepted', 'retry_scheduled', 'terminal_failure', 'ambiguous', 'interrupted'
  )),
	CONSTRAINT "forecast_email_provider_attempts_failure_check" CHECK("forecast_email_provider_attempts"."failure_classification" IS NULL
    OR "forecast_email_provider_attempts"."failure_classification" IN ('retryable', 'terminal', 'ambiguous', 'interrupted')),
	CONSTRAINT "forecast_email_provider_attempts_retry_window_check" CHECK("forecast_email_provider_attempts"."safe_retry_until" > "forecast_email_provider_attempts"."started_at"),
	CONSTRAINT "forecast_email_provider_attempts_completion_check" CHECK((
    "forecast_email_provider_attempts"."state" = 'started' AND "forecast_email_provider_attempts"."finished_at" IS NULL
      AND "forecast_email_provider_attempts"."failure_classification" IS NULL AND "forecast_email_provider_attempts"."redacted_error_category" IS NULL
      AND "forecast_email_provider_attempts"."next_attempt_at" IS NULL
  ) OR (
    "forecast_email_provider_attempts"."state" = 'accepted' AND "forecast_email_provider_attempts"."finished_at" IS NOT NULL
      AND "forecast_email_provider_attempts"."failure_classification" IS NULL AND "forecast_email_provider_attempts"."redacted_error_category" IS NULL
      AND "forecast_email_provider_attempts"."next_attempt_at" IS NULL
  ) OR (
    "forecast_email_provider_attempts"."state" = 'retry_scheduled' AND "forecast_email_provider_attempts"."finished_at" IS NOT NULL
      AND "forecast_email_provider_attempts"."failure_classification" = 'retryable' AND "forecast_email_provider_attempts"."redacted_error_category" IS NOT NULL
      AND "forecast_email_provider_attempts"."next_attempt_at" IS NOT NULL
  ) OR (
    "forecast_email_provider_attempts"."state" = 'terminal_failure' AND "forecast_email_provider_attempts"."finished_at" IS NOT NULL
      AND "forecast_email_provider_attempts"."failure_classification" IN ('retryable', 'terminal')
      AND "forecast_email_provider_attempts"."redacted_error_category" IS NOT NULL AND "forecast_email_provider_attempts"."next_attempt_at" IS NULL
  ) OR (
    "forecast_email_provider_attempts"."state" = 'ambiguous' AND "forecast_email_provider_attempts"."finished_at" IS NOT NULL
      AND "forecast_email_provider_attempts"."failure_classification" = 'ambiguous'
      AND "forecast_email_provider_attempts"."redacted_error_category" IS NOT NULL AND "forecast_email_provider_attempts"."next_attempt_at" IS NULL
  ) OR (
    "forecast_email_provider_attempts"."state" = 'interrupted' AND "forecast_email_provider_attempts"."finished_at" IS NOT NULL
      AND "forecast_email_provider_attempts"."failure_classification" = 'interrupted'
      AND "forecast_email_provider_attempts"."redacted_error_category" IS NOT NULL AND "forecast_email_provider_attempts"."next_attempt_at" IS NULL
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_provider_attempts_id_profile` ON `forecast_email_provider_attempts` (`id`,`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_provider_attempts_delivery_number` ON `forecast_email_provider_attempts` (`delivery_id`,`attempt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_provider_attempts_notification_attempt` ON `forecast_email_provider_attempts` (`notification_attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_provider_attempts_started` ON `forecast_email_provider_attempts` (`delivery_id`) WHERE "forecast_email_provider_attempts"."state" = 'started';--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_provider_attempts_accepted` ON `forecast_email_provider_attempts` (`delivery_id`) WHERE "forecast_email_provider_attempts"."state" = 'accepted';--> statement-breakpoint
CREATE INDEX `idx_forecast_email_provider_attempts_profile_created` ON `forecast_email_provider_attempts` (`profile_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `forecast_email_provider_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'resend' NOT NULL,
	`provider_event_id` text NOT NULL,
	`provider_email_id` text NOT NULL,
	`delivery_id` text,
	`profile_id` integer,
	`event_type` text NOT NULL,
	`supported` integer NOT NULL,
	`payload_hash` text NOT NULL,
	`event_occurred_at` text NOT NULL,
	`received_at` text NOT NULL,
	`handling_state` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`delivery_id`,`profile_id`) REFERENCES `forecast_email_deliveries`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_email_provider_events_provider_check" CHECK("forecast_email_provider_events"."provider" = 'resend'),
	CONSTRAINT "forecast_email_provider_events_supported_check" CHECK("forecast_email_provider_events"."supported" IN (0, 1)),
	CONSTRAINT "forecast_email_provider_events_hash_check" CHECK(length("forecast_email_provider_events"."payload_hash") = 64),
	CONSTRAINT "forecast_email_provider_events_resolution_check" CHECK((
    "forecast_email_provider_events"."delivery_id" IS NULL AND "forecast_email_provider_events"."profile_id" IS NULL
  ) OR (
    "forecast_email_provider_events"."delivery_id" IS NOT NULL AND "forecast_email_provider_events"."profile_id" IS NOT NULL
  )),
	CONSTRAINT "forecast_email_provider_events_handling_check" CHECK("forecast_email_provider_events"."handling_state" IN (
    'applied', 'unsupported', 'unknown_delivery', 'ignored_precedence', 'pending'
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_provider_events_id_profile` ON `forecast_email_provider_events` (`id`,`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_provider_events_provider_event` ON `forecast_email_provider_events` (`provider`,`provider_event_id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_email_provider_events_provider_email` ON `forecast_email_provider_events` (`provider`,`provider_email_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_forecast_email_provider_events_handling` ON `forecast_email_provider_events` (`handling_state`,`received_at`,`id`);--> statement-breakpoint
CREATE TABLE `forecast_email_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` integer NOT NULL,
	`recipient_revision` integer NOT NULL,
	`canonical_email` text NOT NULL,
	`masked_email` text NOT NULL,
	`state` text NOT NULL,
	`verification_requested_at` text,
	`verified_at` text,
	`revoked_at` text,
	`suppression_state` text DEFAULT 'none' NOT NULL,
	`suppression_reason` text,
	`suppressed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "forecast_email_recipients_revision_check" CHECK("forecast_email_recipients"."recipient_revision" > 0),
	CONSTRAINT "forecast_email_recipients_email_check" CHECK(length("forecast_email_recipients"."canonical_email") BETWEEN 3 AND 254
    AND "forecast_email_recipients"."canonical_email" = trim("forecast_email_recipients"."canonical_email")
    AND instr("forecast_email_recipients"."canonical_email", '@') > 1
    AND instr("forecast_email_recipients"."canonical_email", char(10)) = 0 AND instr("forecast_email_recipients"."canonical_email", char(13)) = 0
    AND length("forecast_email_recipients"."masked_email") BETWEEN 3 AND 254),
	CONSTRAINT "forecast_email_recipients_state_check" CHECK("forecast_email_recipients"."state" IN ('pending', 'verified', 'revoked', 'replaced')),
	CONSTRAINT "forecast_email_recipients_lifecycle_check" CHECK((
    "forecast_email_recipients"."state" = 'pending' AND "forecast_email_recipients"."verified_at" IS NULL AND "forecast_email_recipients"."revoked_at" IS NULL
  ) OR (
    "forecast_email_recipients"."state" = 'verified' AND "forecast_email_recipients"."verified_at" IS NOT NULL AND "forecast_email_recipients"."revoked_at" IS NULL
  ) OR (
    "forecast_email_recipients"."state" IN ('revoked', 'replaced') AND "forecast_email_recipients"."revoked_at" IS NOT NULL
  )),
	CONSTRAINT "forecast_email_recipients_suppression_state_check" CHECK("forecast_email_recipients"."suppression_state" IN ('none', 'suppressed')),
	CONSTRAINT "forecast_email_recipients_suppression_check" CHECK((
    "forecast_email_recipients"."suppression_state" = 'none' AND "forecast_email_recipients"."suppression_reason" IS NULL AND "forecast_email_recipients"."suppressed_at" IS NULL
  ) OR (
    "forecast_email_recipients"."suppression_state" = 'suppressed' AND "forecast_email_recipients"."suppression_reason" IS NOT NULL
      AND length("forecast_email_recipients"."suppression_reason") BETWEEN 1 AND 100 AND "forecast_email_recipients"."suppressed_at" IS NOT NULL
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_recipients_id_profile` ON `forecast_email_recipients` (`id`,`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_recipients_profile_revision` ON `forecast_email_recipients` (`profile_id`,`recipient_revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_recipients_current` ON `forecast_email_recipients` (`profile_id`) WHERE "forecast_email_recipients"."state" IN ('pending', 'verified');--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_recipients_current_address` ON `forecast_email_recipients` (`profile_id`,`canonical_email`) WHERE "forecast_email_recipients"."state" IN ('pending', 'verified');--> statement-breakpoint
CREATE INDEX `idx_forecast_email_recipients_profile_created` ON `forecast_email_recipients` (`profile_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `forecast_email_suppression_events` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` integer NOT NULL,
	`recipient_id` text NOT NULL,
	`provider_event_id` text,
	`action` text NOT NULL,
	`reason` text NOT NULL,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`recipient_id`,`profile_id`) REFERENCES `forecast_email_recipients`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_event_id`,`profile_id`) REFERENCES `forecast_email_provider_events`(`id`,`profile_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forecast_email_suppression_events_action_check" CHECK("forecast_email_suppression_events"."action" IN ('suppressed', 'cleared')),
	CONSTRAINT "forecast_email_suppression_events_reason_check" CHECK("forecast_email_suppression_events"."reason" IN (
    'hard_bounce', 'complaint', 'provider_suppressed', 'operator'
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_suppression_events_id_profile` ON `forecast_email_suppression_events` (`id`,`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_email_suppression_events_provider_event` ON `forecast_email_suppression_events` (`provider_event_id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_email_suppression_events_recipient_occurred` ON `forecast_email_suppression_events` (`profile_id`,`recipient_id`,`occurred_at`,`id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_forecast_notification_delivery_attempts` (
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
	CONSTRAINT "forecast_notification_attempts_number_check" CHECK("__new_forecast_notification_delivery_attempts"."attempt_number" > 0),
	CONSTRAINT "forecast_notification_attempts_state_check" CHECK("__new_forecast_notification_delivery_attempts"."state" IN ('started', 'succeeded', 'retry_scheduled', 'terminal_failure', 'interrupted', 'policy_deferred', 'policy_suppressed')),
	CONSTRAINT "forecast_notification_attempts_failure_classification_check" CHECK("__new_forecast_notification_delivery_attempts"."failure_classification" IS NULL OR "__new_forecast_notification_delivery_attempts"."failure_classification" IN ('retryable', 'terminal', 'interrupted')),
	CONSTRAINT "forecast_notification_attempts_completion_check" CHECK((
    "__new_forecast_notification_delivery_attempts"."state" = 'started' AND "__new_forecast_notification_delivery_attempts"."finished_at" IS NULL
      AND "__new_forecast_notification_delivery_attempts"."failure_classification" IS NULL AND "__new_forecast_notification_delivery_attempts"."redacted_error_category" IS NULL
      AND "__new_forecast_notification_delivery_attempts"."next_attempt_at" IS NULL
  ) OR (
    "__new_forecast_notification_delivery_attempts"."state" = 'succeeded' AND "__new_forecast_notification_delivery_attempts"."finished_at" IS NOT NULL
      AND "__new_forecast_notification_delivery_attempts"."failure_classification" IS NULL AND "__new_forecast_notification_delivery_attempts"."redacted_error_category" IS NULL
      AND "__new_forecast_notification_delivery_attempts"."next_attempt_at" IS NULL
  ) OR (
    "__new_forecast_notification_delivery_attempts"."state" = 'retry_scheduled' AND "__new_forecast_notification_delivery_attempts"."finished_at" IS NOT NULL
      AND "__new_forecast_notification_delivery_attempts"."failure_classification" = 'retryable' AND "__new_forecast_notification_delivery_attempts"."redacted_error_category" IS NOT NULL
      AND "__new_forecast_notification_delivery_attempts"."next_attempt_at" IS NOT NULL
  ) OR (
    "__new_forecast_notification_delivery_attempts"."state" = 'terminal_failure' AND "__new_forecast_notification_delivery_attempts"."finished_at" IS NOT NULL
      AND "__new_forecast_notification_delivery_attempts"."failure_classification" IN ('retryable', 'terminal') AND "__new_forecast_notification_delivery_attempts"."redacted_error_category" IS NOT NULL
      AND "__new_forecast_notification_delivery_attempts"."next_attempt_at" IS NULL
  ) OR (
    "__new_forecast_notification_delivery_attempts"."state" = 'interrupted' AND "__new_forecast_notification_delivery_attempts"."finished_at" IS NOT NULL
      AND "__new_forecast_notification_delivery_attempts"."failure_classification" = 'interrupted' AND "__new_forecast_notification_delivery_attempts"."redacted_error_category" IS NOT NULL
      AND "__new_forecast_notification_delivery_attempts"."next_attempt_at" IS NULL
  ) OR (
    "__new_forecast_notification_delivery_attempts"."state" = 'policy_deferred' AND "__new_forecast_notification_delivery_attempts"."finished_at" IS NOT NULL
      AND "__new_forecast_notification_delivery_attempts"."failure_classification" IS NULL AND "__new_forecast_notification_delivery_attempts"."redacted_error_category" IS NULL
      AND "__new_forecast_notification_delivery_attempts"."next_attempt_at" IS NOT NULL
  ) OR (
    "__new_forecast_notification_delivery_attempts"."state" = 'policy_suppressed' AND "__new_forecast_notification_delivery_attempts"."finished_at" IS NOT NULL
      AND "__new_forecast_notification_delivery_attempts"."failure_classification" IS NULL AND "__new_forecast_notification_delivery_attempts"."redacted_error_category" IS NULL
      AND "__new_forecast_notification_delivery_attempts"."next_attempt_at" IS NULL
  ))
);
--> statement-breakpoint
INSERT INTO `__new_forecast_notification_delivery_attempts`("id", "outbox_id", "profile_id", "attempt_number", "owner_token", "state", "retry_policy_version", "adapter_kind", "adapter_version", "started_at", "finished_at", "failure_classification", "redacted_error_category", "next_attempt_at", "created_at") SELECT "id", "outbox_id", "profile_id", "attempt_number", "owner_token", "state", "retry_policy_version", "adapter_kind", "adapter_version", "started_at", "finished_at", "failure_classification", "redacted_error_category", "next_attempt_at", "created_at" FROM `forecast_notification_delivery_attempts`;--> statement-breakpoint
DROP TABLE `forecast_notification_delivery_attempts`;--> statement-breakpoint
ALTER TABLE `__new_forecast_notification_delivery_attempts` RENAME TO `forecast_notification_delivery_attempts`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_attempts_id_profile` ON `forecast_notification_delivery_attempts` (`id`,`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_attempts_outbox_number` ON `forecast_notification_delivery_attempts` (`outbox_id`,`attempt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_attempts_owner_token` ON `forecast_notification_delivery_attempts` (`owner_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_attempts_started` ON `forecast_notification_delivery_attempts` (`outbox_id`) WHERE "forecast_notification_delivery_attempts"."state" = 'started';--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_attempts_succeeded` ON `forecast_notification_delivery_attempts` (`outbox_id`) WHERE "forecast_notification_delivery_attempts"."state" = 'succeeded';--> statement-breakpoint
CREATE INDEX `idx_forecast_notification_attempts_profile_created` ON `forecast_notification_delivery_attempts` (`profile_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `__new_forecast_notification_outbox` (
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
	`suppressed_at` text,
	`suppression_reason` text,
	`last_failure_category` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`intent_id`,`profile_id`) REFERENCES `forecast_notification_intents`(`id`,`profile_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`policy_decision_id`,`profile_id`) REFERENCES `forecast_notification_policy_decisions`(`id`,`profile_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "forecast_notification_outbox_state_check" CHECK("__new_forecast_notification_outbox"."state" IN ('pending', 'deferred', 'suppressed', 'claimed', 'retry_scheduled', 'succeeded', 'dead_letter')),
	CONSTRAINT "forecast_notification_outbox_attempt_count_check" CHECK("__new_forecast_notification_outbox"."attempt_count" >= 0 AND (
    ("__new_forecast_notification_outbox"."state" = 'pending' AND "__new_forecast_notification_outbox"."attempt_count" = 0)
    OR ("__new_forecast_notification_outbox"."state" IN ('deferred', 'suppressed') AND "__new_forecast_notification_outbox"."attempt_count" >= 0)
    OR ("__new_forecast_notification_outbox"."state" IN ('claimed', 'retry_scheduled', 'succeeded', 'dead_letter') AND "__new_forecast_notification_outbox"."attempt_count" > 0)
  )),
	CONSTRAINT "forecast_notification_outbox_available_check" CHECK("__new_forecast_notification_outbox"."state" IN ('suppressed', 'succeeded', 'dead_letter') OR "__new_forecast_notification_outbox"."available_at" IS NOT NULL),
	CONSTRAINT "forecast_notification_outbox_lease_check" CHECK((
    "__new_forecast_notification_outbox"."state" = 'claimed' AND "__new_forecast_notification_outbox"."lease_token" IS NOT NULL AND "__new_forecast_notification_outbox"."lease_expires_at" IS NOT NULL
  ) OR (
    "__new_forecast_notification_outbox"."state" <> 'claimed' AND "__new_forecast_notification_outbox"."lease_token" IS NULL AND "__new_forecast_notification_outbox"."lease_expires_at" IS NULL
  )),
	CONSTRAINT "forecast_notification_outbox_success_check" CHECK((
    "__new_forecast_notification_outbox"."state" = 'succeeded' AND "__new_forecast_notification_outbox"."succeeded_at" IS NOT NULL
  ) OR (
    "__new_forecast_notification_outbox"."state" <> 'succeeded' AND "__new_forecast_notification_outbox"."succeeded_at" IS NULL
  )),
	CONSTRAINT "forecast_notification_outbox_dead_letter_check" CHECK((
    "__new_forecast_notification_outbox"."state" = 'dead_letter' AND "__new_forecast_notification_outbox"."dead_lettered_at" IS NOT NULL
  ) OR (
    "__new_forecast_notification_outbox"."state" <> 'dead_letter' AND "__new_forecast_notification_outbox"."dead_lettered_at" IS NULL
  )),
	CONSTRAINT "forecast_notification_outbox_suppression_check" CHECK((
    "__new_forecast_notification_outbox"."state" = 'suppressed'
      AND (("__new_forecast_notification_outbox"."suppressed_at" IS NULL AND "__new_forecast_notification_outbox"."suppression_reason" IS NULL)
        OR ("__new_forecast_notification_outbox"."suppressed_at" IS NOT NULL AND "__new_forecast_notification_outbox"."suppression_reason" IS NOT NULL
          AND length("__new_forecast_notification_outbox"."suppression_reason") BETWEEN 1 AND 100))
  ) OR (
    "__new_forecast_notification_outbox"."state" <> 'suppressed' AND "__new_forecast_notification_outbox"."suppressed_at" IS NULL
      AND "__new_forecast_notification_outbox"."suppression_reason" IS NULL
  ))
);
--> statement-breakpoint
INSERT INTO `__new_forecast_notification_outbox`("id", "intent_id", "policy_decision_id", "profile_id", "retry_policy_version", "quiet_hours_policy_version", "state", "available_at", "attempt_count", "lease_token", "lease_expires_at", "last_attempt_at", "succeeded_at", "dead_lettered_at", "suppressed_at", "suppression_reason", "last_failure_category", "created_at", "updated_at") SELECT "id", "intent_id", "policy_decision_id", "profile_id", "retry_policy_version", "quiet_hours_policy_version", "state", "available_at", "attempt_count", "lease_token", "lease_expires_at", "last_attempt_at", "succeeded_at", "dead_lettered_at", NULL, NULL, "last_failure_category", "created_at", "updated_at" FROM `forecast_notification_outbox`;--> statement-breakpoint
DROP TABLE `forecast_notification_outbox`;--> statement-breakpoint
ALTER TABLE `__new_forecast_notification_outbox` RENAME TO `forecast_notification_outbox`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_outbox_id_profile` ON `forecast_notification_outbox` (`id`,`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_outbox_intent` ON `forecast_notification_outbox` (`intent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_outbox_policy_decision` ON `forecast_notification_outbox` (`policy_decision_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_notification_outbox_lease_token` ON `forecast_notification_outbox` (`lease_token`);--> statement-breakpoint
CREATE INDEX `idx_forecast_notification_outbox_profile_state_available` ON `forecast_notification_outbox` (`profile_id`,`state`,`available_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_forecast_notification_outbox_state_lease` ON `forecast_notification_outbox` (`state`,`lease_expires_at`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
