/** Cloudflare-independent additive DDL for the in-app notification projection. */
export function inAppNotificationInitializationStatements() {
  return [
    `CREATE TABLE IF NOT EXISTS forecast_in_app_notification_projection_checkpoints (
      profile_id INTEGER NOT NULL,
      projector_version TEXT NOT NULL,
      baseline_evaluation_run_id INTEGER NOT NULL,
      baseline_intent_id TEXT NOT NULL,
      last_evaluation_run_id INTEGER NOT NULL,
      last_intent_id TEXT NOT NULL,
      activated_at TEXT NOT NULL,
      lease_token TEXT,
      lease_expires_at TEXT,
      recovery_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, projector_version),
      CHECK (baseline_evaluation_run_id >= 0 AND last_evaluation_run_id >= baseline_evaluation_run_id
        AND (baseline_evaluation_run_id > 0 OR baseline_intent_id = '')
        AND (last_evaluation_run_id > 0 OR last_intent_id = '')
        AND (last_evaluation_run_id > baseline_evaluation_run_id
          OR last_intent_id >= baseline_intent_id)),
      CHECK ((lease_token IS NULL AND lease_expires_at IS NULL)
        OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
      CHECK (recovery_count >= 0),
      FOREIGN KEY (profile_id) REFERENCES investment_profiles(id) ON DELETE CASCADE
    )`,
    'CREATE INDEX IF NOT EXISTS idx_forecast_in_app_checkpoints_lease ON forecast_in_app_notification_projection_checkpoints(lease_expires_at)',
    `CREATE TABLE IF NOT EXISTS forecast_in_app_notification_entries (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      id TEXT NOT NULL,
      profile_id INTEGER NOT NULL,
      source_intent_id TEXT NOT NULL,
      forecast_id INTEGER NOT NULL,
      evaluation_run_id INTEGER NOT NULL,
      review_item_id INTEGER NOT NULL,
      analysis_snapshot_id INTEGER,
      category TEXT NOT NULL CHECK (category IN ('target_hit', 'invalidated', 'expired', 'needs_review')),
      symbol TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      presentation_version TEXT NOT NULL,
      presentation_json TEXT NOT NULL CHECK (json_valid(presentation_json)),
      presentation_fingerprint TEXT NOT NULL CHECK (length(presentation_fingerprint) = 64),
      deep_link_kind TEXT NOT NULL CHECK (deep_link_kind = 'notification_evidence'),
      state TEXT NOT NULL DEFAULT 'unread' CHECK (state IN ('unread', 'read')),
      first_read_at TEXT,
      state_updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (state = 'unread' OR first_read_at IS NOT NULL),
      FOREIGN KEY (profile_id) REFERENCES investment_profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (source_intent_id, profile_id) REFERENCES forecast_notification_intents(id, profile_id),
      FOREIGN KEY (forecast_id, profile_id) REFERENCES forecasts(id, profile_id),
      FOREIGN KEY (evaluation_run_id, profile_id) REFERENCES evaluation_runs(id, profile_id),
      FOREIGN KEY (review_item_id, profile_id) REFERENCES forecast_review_items(id, profile_id),
      FOREIGN KEY (analysis_snapshot_id, profile_id) REFERENCES analysis_snapshots(id, profile_id)
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_forecast_in_app_entries_id ON forecast_in_app_notification_entries(id)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_forecast_in_app_entries_id_profile ON forecast_in_app_notification_entries(id, profile_id)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_forecast_in_app_entries_source ON forecast_in_app_notification_entries(profile_id, source_intent_id)',
    'CREATE INDEX IF NOT EXISTS idx_forecast_in_app_entries_list ON forecast_in_app_notification_entries(profile_id, occurred_at, id)',
    'CREATE INDEX IF NOT EXISTS idx_forecast_in_app_entries_unread ON forecast_in_app_notification_entries(profile_id, state)',
    'CREATE INDEX IF NOT EXISTS idx_forecast_in_app_entries_category_list ON forecast_in_app_notification_entries(profile_id, category, occurred_at, id)',
    'CREATE INDEX IF NOT EXISTS idx_forecast_in_app_entries_high_water ON forecast_in_app_notification_entries(profile_id, sequence)',
    `CREATE TABLE IF NOT EXISTS forecast_in_app_notification_projection_items (
      id TEXT PRIMARY KEY NOT NULL,
      profile_id INTEGER NOT NULL,
      projector_version TEXT NOT NULL,
      source_intent_id TEXT NOT NULL,
      evaluation_run_id INTEGER NOT NULL,
      entry_id TEXT,
      classification TEXT NOT NULL CHECK (classification IN (
        'materialized', 'duplicate', 'unsupported_source', 'malformed_source'
      )),
      reason_code TEXT NOT NULL,
      source_created_at TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK ((classification IN ('materialized', 'duplicate') AND entry_id IS NOT NULL)
        OR (classification IN ('unsupported_source', 'malformed_source') AND entry_id IS NULL)),
      FOREIGN KEY (profile_id, projector_version)
        REFERENCES forecast_in_app_notification_projection_checkpoints(profile_id, projector_version) ON DELETE CASCADE,
      FOREIGN KEY (source_intent_id, profile_id) REFERENCES forecast_notification_intents(id, profile_id),
      FOREIGN KEY (entry_id, profile_id) REFERENCES forecast_in_app_notification_entries(id, profile_id)
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_forecast_in_app_projection_source ON forecast_in_app_notification_projection_items(profile_id, projector_version, source_intent_id)',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_forecast_in_app_projection_entry ON forecast_in_app_notification_projection_items(entry_id)',
    'CREATE INDEX IF NOT EXISTS idx_forecast_in_app_projection_processed ON forecast_in_app_notification_projection_items(profile_id, processed_at, id)',
    `CREATE TABLE IF NOT EXISTS forecast_in_app_notification_state_events (
      id TEXT PRIMARY KEY NOT NULL,
      profile_id INTEGER NOT NULL,
      entry_id TEXT,
      event_kind TEXT NOT NULL CHECK (event_kind IN ('read', 'unread', 'mark_all_read')),
      high_water_sequence INTEGER,
      affected_count INTEGER NOT NULL CHECK (affected_count > 0),
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK ((event_kind IN ('read', 'unread') AND entry_id IS NOT NULL
          AND high_water_sequence IS NULL AND affected_count = 1)
        OR (event_kind = 'mark_all_read' AND entry_id IS NULL
          AND high_water_sequence IS NOT NULL AND high_water_sequence >= 0)),
      FOREIGN KEY (profile_id) REFERENCES investment_profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (entry_id, profile_id) REFERENCES forecast_in_app_notification_entries(id, profile_id)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_forecast_in_app_state_events_profile_created ON forecast_in_app_notification_state_events(profile_id, created_at, id)',
    'CREATE INDEX IF NOT EXISTS idx_forecast_in_app_state_events_entry ON forecast_in_app_notification_state_events(entry_id, created_at)',
    `CREATE TRIGGER IF NOT EXISTS forecast_in_app_entries_immutable_presentation
      BEFORE UPDATE ON forecast_in_app_notification_entries
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
      END`,
    `CREATE TRIGGER IF NOT EXISTS forecast_in_app_state_events_append_only_update
      BEFORE UPDATE ON forecast_in_app_notification_state_events
      BEGIN
        SELECT RAISE(ABORT, 'in-app notification state events are append-only');
      END`,
    `CREATE TRIGGER IF NOT EXISTS forecast_in_app_state_events_append_only_delete
      BEFORE DELETE ON forecast_in_app_notification_state_events
      BEGIN
        SELECT RAISE(ABORT, 'in-app notification state events are append-only');
      END`,
  ];
}
