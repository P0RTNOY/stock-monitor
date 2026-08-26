# Forecast In-App Notification Center — Phase 2C2C

Phase 2C2C adds a durable, fixed-profile in-app Notification Center to Northstar. It is an internal presentation projection over Phase 2C2A notification intents. It does not reevaluate forecasts, fetch market data, call Resend, send email, initialize schema from a browser `GET`, or change any notification/email consent decision.

This phase remains a personal journal feature. Notifications describe persisted forecast outcomes and review obligations; they are not buy, sell, hold, or trading recommendations.

## Trust and channel boundaries

`forecast_notification_intents` is the only materialization source. The in-app projector verifies the stored payload schema version, canonical payload JSON, payload fingerprint, same-profile identities, category, occurrence time, and frozen evaluator reason allowlist before creating an entry. Mutable forecast rows, the Review Queue, notification outbox, email recipients, email consent, and provider state do not determine whether an in-app entry exists.

The supported categories are exactly `target_hit`, `invalidated`, `expired`, and `needs_review`. In-app visibility is independent of email consent and delivery. Current email evidence is a secondary live join only. Provider acceptance, mail-server delivery, delay, ambiguity, failure, bounce, complaint, suppression, and missing configuration have separate labels. Provider acceptance is not represented as final delivery, and neither state is represented as user reading.

## Persistence and immutable presentation

Migration `market-monitor-web/drizzle/0008_vengeful_the_watchers.sql` adds four tables, immutable-presentation enforcement, and append-only state-event enforcement without rebuilding or editing migrations `0006` or `0007`:

- `forecast_in_app_notification_projection_checkpoints` stores the versioned profile baseline, composite `(evaluation_run_id, intent_id)` forward high-water mark, lease, and recovery count.
- `forecast_in_app_notification_entries` stores one deterministic entry per intent, an autoincrement sequence, immutable presentation JSON/fingerprint, allowlisted deep-link kind, current read state, and permanent first-read timestamp.
- `forecast_in_app_notification_projection_items` records every materialized, duplicate, unsupported, or malformed decision before forward progress advances.
- `forecast_in_app_notification_state_events` append-preserves individual read/unread changes and set-based mark-all actions.

The presentation version is `forecast-in-app-presentation-1.0.0`. Snapshots contain bounded informational title, summary, allowlisted details, symbol, category, occurrence time, and trusted forecast/evaluation/review/snapshot identifiers. They contain no raw HTML, address, capability, provider ID, claim/lease token, secret, arbitrary URL, raw provider payload, or mutable forecast prose. A database trigger prevents presentation/source fields from being rewritten while allowing read-state changes.

The server derives deep links as `/notifications/{entryId}`. It never stores or accepts a browser-supplied URL. The detail route rejoins the exact same-profile forecast, evaluation run, and review item referenced by the entry; it never substitutes the latest evaluation. Frozen notification evidence, current forecast status, review acknowledgement, notification read state, and email state are presented separately.

## Forward projection and historical cutover

The projector version is `forecast-in-app-projector-1.0.0`. It processes intents in increasing composite `(evaluation_run_id, intent_id)` order, uses an explicit intent-materialization cutoff, bounded pages from 1 through 100, an expiring fenced lease, deterministic IDs, database uniqueness, and checkpoint compare-and-set authority. The intent-ID tie-breaker prevents a page boundary or recovery from skipping another category attached to the same evaluation. Authority checks intervening notification intents rather than evaluation runs because Phase 2C2A intentionally produces no intent for `no_change` and excluded sources.

The first dry run reports the prospective baseline without mutation. The first commit captures the current maximum intent evaluation-run ID and creates no entries, preventing an accidental historical flood. Later commits process only intents above that baseline. Malformed and unsupported intents receive durable isolated decisions; operational persistence/crypto failures stop the page without advancing around the failed source. Replays are idempotent.

Historical materialization is a separate bounded operator action. Preview is the default and requires `--confirm-historical-preview`. A historical commit additionally requires `--commit` and `--confirm-historical-commit`. It is constrained by explicit evaluation-run bounds and cutoff, does not move the forward checkpoint, and uses insert-only uniqueness so replay cannot duplicate an entry or reset read state.

## Read state and pagination

List ordering is stable `(occurred_at DESC, id DESC)` keyset pagination. The default page is 20 and maximum is 50. The opaque canonical base64url cursor is checksummed and bound to version, fixed profile, read filter, category filter, and last sort tuple. Unknown/duplicate query fields, padded limits, malformed encodings, noncanonical JSON, checksum changes, wrong profiles, and wrong filters are rejected.

Individual state actions use the server clock and append an event only when state changes. Repeated requests are idempotent. `first_read_at` is populated once and never cleared by marking unread.

List/count responses issue an opaque checksummed high-water token over the current maximum entry sequence. Mark-all uses it in one transaction, records one aggregate event with affected count, and updates only unread entries at or below the captured sequence. Entries projected later remain unread. Unread totals always use direct `COUNT(*)`; the API is exact and only the visible bell caps at `99+`.

## Browser API

The fixed profile is resolved internally. Browser requests cannot choose profile IDs, timestamps, content, category, or links. Responses are `Cache-Control: no-store`.

- `GET /api/notifications?state=all|unread|read&category=all|target_hit|invalidated|expired|needs_review&limit=1..50&cursor=...`
- `GET /api/notifications/unread-count`
- `GET /api/notifications/:id`
- `POST /api/notifications/:id/read` with exact `{}`
- `POST /api/notifications/:id/unread` with exact `{}`
- `POST /api/notifications/mark-all-read` with exact `{ "highWaterToken": "..." }`

The notification request context only resolves the fixed profile and obtains D1. It does not call `ensureDatabase`, build a forecast/evaluation service, project notifications, access a provider, or trigger delivery. Missing and cross-profile entry mutations use the same not-found response.

## User experience

`/notifications` is a dedicated responsive route rather than a modal. It does not mount `MarketWorkspace`, load portfolio data, or request market quotes. The main workspace exposes a real notification link and bell with exact accessible count wording.

The Center supports loading, retry, true empty, filtered empty, filters, conventional load-more, explicit read/unread, and confirmed mark-all. Fetching, rendering, scrolling, prefetching, or opening evidence never marks read. Status is not conveyed by color alone; cards include category, read state, forecast outcome, email state, and semantic absolute time.

The evidence route is read-only and distinguishes immutable intent presentation from exact linked evaluation/review records and current email evidence. Mark-all reuses the focus-trapping `AccessibleDialog`; the conservative cancel action receives initial focus. Notification links/controls have visible focus styling and 44-pixel touch targets.

## Operator commands

Run from `market-monitor-web`:

```bash
npm run forecast:notifications:in-app:project -- --help
npm run forecast:notifications:in-app:project -- --cutoff 2026-08-26T12:00:00.000Z --limit 25 --dry-run
npm run forecast:notifications:in-app:project -- --cutoff 2026-08-26T12:00:00.000Z --limit 25 --commit

npm run forecast:notifications:in-app:backfill -- --from-id 1 --through-id 100 \
  --cutoff 2026-08-26T12:00:00.000Z --confirm-historical-preview
npm run forecast:notifications:in-app:backfill -- --from-id 1 --through-id 100 \
  --cutoff 2026-08-26T12:00:00.000Z --confirm-historical-preview \
  --commit --confirm-historical-commit

npm run forecast:notifications:in-app:status
npm run forecast:notifications:in-app:status -- --json
```

Project/backfill are dry-run by default. Human and JSON output omit the profile, source intent IDs, addresses, payloads, fingerprints, capability/provider IDs, secrets, and leases. Commands never evaluate a forecast or call a provider.

## Local migration and smoke verification

Use a disposable local D1 first:

```bash
SMOKE_ROOT="$(mktemp -d /tmp/northstar-inapp.XXXXXX)"
cd market-monitor-web
npx wrangler d1 migrations apply DB --local --persist-to "$SMOKE_ROOT" \
  --config operator/wrangler.operator.jsonc
env NORTHSTAR_COORDINATOR_PERSIST_PATH="$SMOKE_ROOT" \
  npm run forecast:notifications:in-app:status
```

Before real rollout:

1. Back up and inspect target D1.
2. Confirm migrations `0000` through `0007` are recorded in order.
3. Apply `0008` in staging and run `PRAGMA foreign_key_check`.
4. Verify existing intent, outbox, attempt, recipient, consent, delivery, and provider-event evidence is unchanged.
5. Establish the in-app baseline with a bounded commit.
6. Create one new trusted intent through the existing workflow, then project it.
7. Verify list/count/detail/read/unread/mark-all and that outbox/email rows do not change.
8. Test bounded historical preview before any separately approved historical commit.
9. Repeat in production only after staging evidence and rollback ownership are recorded.

No remote migration, deployment, live Resend request, Cron registration, webhook/DNS change, branch push, PR, or merge is performed by this phase.

## Verification and known limits

Automated coverage includes cutover, all categories, malformed/unsupported isolation, composite-key batch continuation, same-cutoff and existing-entry replay, concurrent projectors, injected crypto and persistence failure, transactional crash recovery, SQLite uniqueness/constraints, strict presentation version/fingerprint validation, snapshot immutability, profile isolation, concurrent and idempotent read/unread, permanent first-read time, high-water races, timestamp-tie pagination, padded/truncated/tampered/unknown-version cursor and filter/profile rejection, historical preview/replay, runtime/migration parity, and populated `0007` to `0008` preservation. Static UI/API contract checks cover route isolation, no GET initialization/provider work, semantic controls, bell accessibility, and no read mutation on detail fetch. The production build verifies TSX integration.

There is no browser automation dependency, so keyboard, screen-reader, responsive, and end-to-end behavior are implemented and statically checked but not claimed as real-browser verification. Remote D1 concurrency, deployed Worker behavior, and production observability remain unverified.

Northstar still uses a centralized fixed profile, not authentication. The exact next phase is Phase 3A: authenticated identity, authorization, and tenant isolation. The Center must not be exposed as a public multi-user service before that boundary exists.
