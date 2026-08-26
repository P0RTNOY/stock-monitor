CREATE TABLE `northstar_auth_migration_guard` (
	`profile_count` integer NOT NULL CHECK (`profile_count` BETWEEN 0 AND 1),
	`foreign_key_violation_count` integer NOT NULL CHECK (`foreign_key_violation_count` = 0),
	`cross_profile_violation_count` integer NOT NULL CHECK (`cross_profile_violation_count` = 0)
);
--> statement-breakpoint
INSERT INTO `northstar_auth_migration_guard`
SELECT
	(SELECT COUNT(*) FROM investment_profiles),
	(SELECT COUNT(*) FROM pragma_foreign_key_check),
	(
		(SELECT COUNT(*) FROM forecast_events c LEFT JOIN forecasts p ON p.id = c.forecast_id WHERE p.id IS NULL OR p.profile_id <> c.profile_id) +
		(SELECT COUNT(*) FROM evaluation_runs c LEFT JOIN forecasts p ON p.id = c.forecast_id WHERE p.id IS NULL OR p.profile_id <> c.profile_id) +
		(SELECT COUNT(*) FROM analysis_snapshots c LEFT JOIN forecasts p ON p.id = c.forecast_id WHERE p.id IS NULL OR p.profile_id <> c.profile_id) +
		(SELECT COUNT(*) FROM forecast_review_items c LEFT JOIN forecasts p ON p.id = c.forecast_id WHERE p.id IS NULL OR p.profile_id <> c.profile_id) +
		(SELECT COUNT(*) FROM forecast_review_items c LEFT JOIN evaluation_runs r ON r.id = c.evaluation_run_id WHERE r.id IS NULL OR r.profile_id <> c.profile_id OR r.forecast_id <> c.forecast_id)
	);
--> statement-breakpoint
DROP TABLE `northstar_auth_migration_guard`;
--> statement-breakpoint
CREATE TABLE `identity_users` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`external_identity_state` text DEFAULT 'bootstrap_pending' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`disabled_at` text,
	CONSTRAINT "identity_users_status_check" CHECK("identity_users"."status" IN ('active', 'disabled')),
	CONSTRAINT "identity_users_external_identity_state_check" CHECK("identity_users"."external_identity_state" IN ('bootstrap_pending', 'unlinked', 'linked')),
	CONSTRAINT "identity_users_disabled_state_check" CHECK(("identity_users"."status" = 'active' AND "identity_users"."disabled_at" IS NULL) OR ("identity_users"."status" = 'disabled' AND "identity_users"."disabled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `profile_membership_events` (
	`id` text PRIMARY KEY NOT NULL,
	`membership_id` text NOT NULL,
	`user_id` text NOT NULL,
	`profile_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`event_type` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`actor_kind` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`membership_id`,`user_id`,`profile_id`) REFERENCES `profile_memberships`(`id`,`user_id`,`profile_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "profile_membership_events_revision_check" CHECK("profile_membership_events"."revision" >= 1),
	CONSTRAINT "profile_membership_events_type_check" CHECK("profile_membership_events"."event_type" IN ('created', 'role_changed', 'revoked', 'restored')),
	CONSTRAINT "profile_membership_events_role_check" CHECK("profile_membership_events"."role" IN ('owner', 'editor', 'viewer')),
	CONSTRAINT "profile_membership_events_status_check" CHECK("profile_membership_events"."status" IN ('active', 'revoked')),
	CONSTRAINT "profile_membership_events_actor_check" CHECK("profile_membership_events"."actor_kind" IN ('bootstrap_migration', 'system_operator', 'future_identity_provider'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_profile_membership_events_membership_revision` ON `profile_membership_events` (`membership_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_profile_membership_events_profile_created` ON `profile_membership_events` (`profile_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `profile_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_id` integer NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `identity_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_id`) REFERENCES `investment_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "profile_memberships_role_check" CHECK("profile_memberships"."role" IN ('owner', 'editor', 'viewer')),
	CONSTRAINT "profile_memberships_status_check" CHECK("profile_memberships"."status" IN ('active', 'revoked')),
	CONSTRAINT "profile_memberships_revision_check" CHECK("profile_memberships"."revision" >= 1),
	CONSTRAINT "profile_memberships_revocation_check" CHECK(("profile_memberships"."status" = 'active' AND "profile_memberships"."revoked_at" IS NULL) OR ("profile_memberships"."status" = 'revoked' AND "profile_memberships"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_profile_memberships_user_profile` ON `profile_memberships` (`user_id`,`profile_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_profile_memberships_id_user_profile` ON `profile_memberships` (`id`,`user_id`,`profile_id`);--> statement-breakpoint
CREATE INDEX `idx_profile_memberships_profile_status` ON `profile_memberships` (`profile_id`,`status`,`role`);
--> statement-breakpoint
INSERT INTO `identity_users`
  (`id`, `status`, `external_identity_state`, `created_at`, `updated_at`, `disabled_at`)
SELECT 'northstar-bootstrap-user-v1', 'active', 'bootstrap_pending',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
WHERE (SELECT COUNT(*) FROM investment_profiles) = 1;
--> statement-breakpoint
INSERT INTO `profile_memberships`
  (`id`, `user_id`, `profile_id`, `role`, `status`, `revision`, `created_at`, `updated_at`, `revoked_at`)
SELECT 'northstar-bootstrap-owner-v1', 'northstar-bootstrap-user-v1', id,
  'owner', 'active', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
FROM investment_profiles
WHERE (SELECT COUNT(*) FROM investment_profiles) = 1;
--> statement-breakpoint
INSERT INTO `profile_membership_events`
  (`id`, `membership_id`, `user_id`, `profile_id`, `revision`, `event_type`, `role`, `status`, `actor_kind`, `created_at`)
SELECT 'northstar-bootstrap-owner-created-v1', 'northstar-bootstrap-owner-v1',
  'northstar-bootstrap-user-v1', id, 1, 'created', 'owner', 'active',
  'bootstrap_migration', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM investment_profiles
WHERE (SELECT COUNT(*) FROM investment_profiles) = 1;
--> statement-breakpoint
CREATE TRIGGER `profile_membership_events_append_only_update`
BEFORE UPDATE ON `profile_membership_events`
BEGIN SELECT RAISE(ABORT, 'MembershipEventAppendOnly'); END;
--> statement-breakpoint
CREATE TRIGGER `profile_membership_events_append_only_delete`
BEFORE DELETE ON `profile_membership_events`
BEGIN SELECT RAISE(ABORT, 'MembershipEventAppendOnly'); END;
--> statement-breakpoint
CREATE TRIGGER `profile_memberships_identity_immutable`
BEFORE UPDATE OF `id`, `user_id`, `profile_id`, `created_at` ON `profile_memberships`
BEGIN SELECT RAISE(ABORT, 'MembershipIdentityImmutable'); END;
--> statement-breakpoint
CREATE TRIGGER `profile_memberships_change_requires_event`
BEFORE UPDATE OF `role`, `status`, `revision`, `revoked_at` ON `profile_memberships`
WHEN NEW.`revision` <> OLD.`revision` + 1
  OR (NEW.`status` = OLD.`status` AND NEW.`role` = OLD.`role`)
  OR (NEW.`status` <> OLD.`status` AND NEW.`role` <> OLD.`role`)
  OR NOT EXISTS (
    SELECT 1 FROM `profile_membership_events` e
    WHERE e.`membership_id` = OLD.`id` AND e.`user_id` = OLD.`user_id`
      AND e.`profile_id` = OLD.`profile_id` AND e.`revision` = NEW.`revision`
      AND e.`role` = NEW.`role` AND e.`status` = NEW.`status`
      AND e.`event_type` = CASE
        WHEN OLD.`status` = 'active' AND NEW.`status` = 'revoked' THEN 'revoked'
        WHEN OLD.`status` = 'revoked' AND NEW.`status` = 'active' THEN 'restored'
        ELSE 'role_changed'
      END)
BEGIN SELECT RAISE(ABORT, 'MembershipEventRequired'); END;
--> statement-breakpoint
CREATE TRIGGER `profile_memberships_delete_requires_history_preservation`
BEFORE DELETE ON `profile_memberships`
BEGIN SELECT RAISE(ABORT, 'MembershipDeleteForbidden'); END;
--> statement-breakpoint
CREATE TRIGGER `forecasts_profile_immutable`
BEFORE UPDATE OF `profile_id` ON `forecasts`
BEGIN SELECT RAISE(ABORT, 'ForecastProfileImmutable'); END;
--> statement-breakpoint
CREATE TRIGGER `forecast_events_tenant_guard_insert`
BEFORE INSERT ON `forecast_events`
WHEN NOT EXISTS (SELECT 1 FROM forecasts p WHERE p.id = NEW.forecast_id AND p.profile_id = NEW.profile_id)
BEGIN SELECT RAISE(ABORT, 'CrossProfileForecastEvent'); END;
--> statement-breakpoint
CREATE TRIGGER `forecast_events_tenant_guard_update`
BEFORE UPDATE OF `forecast_id`, `profile_id` ON `forecast_events`
WHEN NOT EXISTS (SELECT 1 FROM forecasts p WHERE p.id = NEW.forecast_id AND p.profile_id = NEW.profile_id)
BEGIN SELECT RAISE(ABORT, 'CrossProfileForecastEvent'); END;
--> statement-breakpoint
CREATE TRIGGER `evaluation_runs_tenant_guard_insert`
BEFORE INSERT ON `evaluation_runs`
WHEN NOT EXISTS (SELECT 1 FROM forecasts p WHERE p.id = NEW.forecast_id AND p.profile_id = NEW.profile_id)
BEGIN SELECT RAISE(ABORT, 'CrossProfileEvaluationRun'); END;
--> statement-breakpoint
CREATE TRIGGER `evaluation_runs_tenant_guard_update`
BEFORE UPDATE OF `forecast_id`, `profile_id` ON `evaluation_runs`
WHEN NOT EXISTS (SELECT 1 FROM forecasts p WHERE p.id = NEW.forecast_id AND p.profile_id = NEW.profile_id)
BEGIN SELECT RAISE(ABORT, 'CrossProfileEvaluationRun'); END;
--> statement-breakpoint
CREATE TRIGGER `analysis_snapshots_tenant_guard_insert`
BEFORE INSERT ON `analysis_snapshots`
WHEN NOT EXISTS (SELECT 1 FROM forecasts p WHERE p.id = NEW.forecast_id AND p.profile_id = NEW.profile_id)
BEGIN SELECT RAISE(ABORT, 'CrossProfileAnalysisSnapshot'); END;
--> statement-breakpoint
CREATE TRIGGER `analysis_snapshots_tenant_guard_update`
BEFORE UPDATE OF `forecast_id`, `profile_id` ON `analysis_snapshots`
WHEN NOT EXISTS (SELECT 1 FROM forecasts p WHERE p.id = NEW.forecast_id AND p.profile_id = NEW.profile_id)
BEGIN SELECT RAISE(ABORT, 'CrossProfileAnalysisSnapshot'); END;
--> statement-breakpoint
CREATE TRIGGER `forecast_review_items_tenant_guard_insert`
BEFORE INSERT ON `forecast_review_items`
WHEN NOT EXISTS (
  SELECT 1 FROM forecasts p JOIN evaluation_runs r
    ON r.id = NEW.evaluation_run_id AND r.profile_id = NEW.profile_id AND r.forecast_id = NEW.forecast_id
  WHERE p.id = NEW.forecast_id AND p.profile_id = NEW.profile_id
)
BEGIN SELECT RAISE(ABORT, 'CrossProfileForecastReview'); END;
--> statement-breakpoint
CREATE TRIGGER `forecast_review_items_tenant_guard_update`
BEFORE UPDATE OF `forecast_id`, `evaluation_run_id`, `profile_id` ON `forecast_review_items`
WHEN NOT EXISTS (
  SELECT 1 FROM forecasts p JOIN evaluation_runs r
    ON r.id = NEW.evaluation_run_id AND r.profile_id = NEW.profile_id AND r.forecast_id = NEW.forecast_id
  WHERE p.id = NEW.forecast_id AND p.profile_id = NEW.profile_id
)
BEGIN SELECT RAISE(ABORT, 'CrossProfileForecastReview'); END;
