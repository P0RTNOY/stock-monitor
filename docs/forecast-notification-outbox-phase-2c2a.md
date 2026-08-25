# Forecast Notification Outbox — Phase 2C2A

This document is the normative Northstar Phase 2C2A contract. Phase 2C2A creates a durable, replay-safe notification projection and channel-neutral outbox foundation. It does not deliver email, push, SMS, webhooks, Slack, Discord, or any other external message.

Notifications are projections of trusted persisted facts. They are not a second evaluator:

- Phase 2A remains the only authority for forecast outcomes and evidence.
- Phase 2B remains the only authority for due-forecast coordination.
- Phase 2C1 remains the only authority for scheduled coordinator invocation.
- Phase 2C2A reads completed Phase 2A records and writes only notification-domain records.

There is no notification route in the browser, no production delivery adapter, no notification Cron, and no notification call in the Phase 2C1 Worker callback.

## Frozen versions

Notification semantics are independently versioned. A semantic change requires a new version; existing records retain the version under which they were created.

| Contract | Version |
| --- | --- |
| Projector | `forecast-notification-projector-1.0.0` |
| Projection cursor | `1` |
| Deduplication | `forecast-notification-dedup-1.0.0` |
| Payload schema | `forecast-notification-payload-1.0.0` |
| Policy | `forecast-notification-policy-1.0.0` |
| Preference schema | `forecast-notification-preferences-1.0.0` |
| Quiet hours | `forecast-notification-quiet-hours-1.0.0` |
| Retry | `forecast-notification-retry-1.0.0` |

Policy, preference, quiet-hours, and retry versions are deliberately excluded from source deduplication. Changing a preference or retry rule must not manufacture a second notification for the same trusted evaluation.

## Trust boundary and authoritative sources

The authoritative notification source identity is the profile-owned `evaluation_runs.id`. The projector joins that run to its same-profile `forecast_review_items` record and to the saved forecast and optional analysis-snapshot references. Terminal Phase 2A results have a `resolved` review item; `needs_review` has a `needs_review` review item. A missing, cross-profile, or contradictory relationship is quarantined as an invalid source rather than repaired from mutable state.

The projector does not infer an outcome from `forecasts.status`. Phase 2A persisted every supported run while the forecast was active, so the notification payload derives lifecycle context from the frozen evaluation result:

- `target_hit`, `invalidated`, and `expired` have previous status `active` and the corresponding resulting terminal status;
- `needs_review` has previous and resulting status `active`.

The forecast join supplies the profile-owned saved symbol and optional immutable analysis-snapshot reference. It is not used to recompute a price outcome. Review acknowledgement is not a notification source and cannot alter a materialized intent.

The projector never calls Yahoo, the Python evaluator, the coordinator, or the scheduler. It never accepts a profile, source identifier, category, symbol, forecast terms, outcome, recipient, or evidence document from browser input.

## Supported and excluded facts

Phase 2C2A supports exactly these persisted Phase 2A result kinds:

| Evaluation result | Notification category | Informational meaning |
| --- | --- | --- |
| `target_hit` | `target_hit` | A tracked forecast reached its recorded target. |
| `invalidated` | `invalidated` | A tracked forecast reached its recorded invalidation boundary. |
| `expired` | `expired` | A tracked forecast completed its recorded horizon without a terminal touch. |
| `needs_review` | `needs_review` | A tracked forecast requires review of persisted evaluation evidence. |

`no_change` is durably classified as excluded and never creates a notification intent. Provider unavailability and timeouts, coordinator or scheduler failures, claim conflicts, validation failures outside a persisted evaluation, and unexpected operational errors are not Phase 2A outcome facts and never become user notifications.

Draft creation, editing, activation, notes, amendments, user cancellation, and review acknowledgement are also excluded. Operational failures belong in sanitized logs and operator reports.

## Immutable payload and deterministic deduplication

The versioned payload is canonicalized and validated before persistence. It contains only bounded facts needed to explain the intent:

- profile, forecast, evaluation-run, review-item, and optional analysis-snapshot references;
- category, previous/resulting status, saved symbol, stable reason code, and occurrence time;
- evaluation cutoff, evaluated-through date, and triggering market date when present;
- already-persisted target, range, invalidation, detection, and crossed-boundary evidence;
- verified activation currency and observed currency when present;
- evaluator, evaluation-ruleset, and payload versions.

It excludes thesis text, arbitrary metadata, raw provider responses, OHLC history, exception messages, credentials, recipient data, and template-ready HTML. The payload fingerprint is SHA-256 over canonical payload JSON.

The source deduplication key is SHA-256 over canonical JSON containing the deduplication version, projector version, payload version, trusted profile ID, evaluation-run ID, and category. The intent ID is deterministically derived from that key. D1 uniqueness protects both the global deduplication key and `(profile_id, evaluation_run_id, category)`; an application lookup is not the only duplicate defense.

Consequently, the same evaluation run, cutoff replay, coordinator replay, scheduler replay, or concurrent projector cannot create a second intent. A genuinely new Phase 2A evaluation run has a new immutable identity and may create a new intent if it is supported and passes policy.

## Projection, ordering, and durable progress

Projection input requires an explicit canonical UTC cutoff, an internally resolved trusted profile, a limit from 1 through 100, and an optional opaque cursor. The default limit is 25 and the default mode is `dry_run`.

Sources are selected in increasing `evaluation_runs.id` order. The cursor carries the last evaluation-run ID plus its creation time for cutoff auditing; source time is not used as an unstable offset. A source after the injected cutoff stops the scan without advancing around it. Cursors are versioned, checksummed, profile/cutoff-bound, canonical base64url documents and must be passed back unchanged.

In commit mode, processing one source durably records its projection classification before advancing the checkpoint. A valid source writes its immutable intent, policy decision, initial outbox row, and projection item as one logical transaction. An excluded or malformed source writes an append-preserving projection classification so one poisoned row cannot block unrelated later records. Database uniqueness turns replay and concurrent insertion into reuse, not duplication.

Dry-run validates and classifies the bounded page without creating a checkpoint, intent, policy decision, outbox entry, projection item, preference revision, attempt, claim, evaluation, review item, or forecast event.

## Historical cutover

Ordinary first activation is profile-scoped and flood-safe. It establishes the projector checkpoint at the current maximum evaluation-run ID: `baseline_evaluation_run_id` and `last_evaluation_run_id` begin at that same value. Runs that already existed at activation are therefore outside ordinary forward projection, including unresolved historical review items.

Normal projection cannot move behind the baseline. A same-cutoff or same-cursor replay cannot weaken it. This baseline is durable per profile and projector version.

Historical inspection is a separate, dry-run-only preview. It must require explicit bounds and report the exact source identities, categories, and classifications it would encounter. Phase 2C2A provides no committing historical backfill mode and never sends a historical message. Adding an authorized backfill later requires a new explicit policy and must remain idempotent; preference changes alone cannot release old suppressed or baseline-excluded facts.

## Preferences and consent

Preferences are profile-scoped because Northstar does not yet have authenticated identities or verified recipients. Phase 2C2A stores no email address, telephone number, push token, webhook URL, or provider destination.

Each immutable preference revision records:

- preference schema version and monotonically increasing revision;
- master notification consent;
- separate booleans for `target_hit`, `invalidated`, `expired`, and `needs_review`;
- a validated named IANA timezone;
- either no quiet hours or distinct `HH:mm` start and end values;
- creation time and bounded audit source/reason.

The current-preference row points to one append-preserved revision. Updating preferences must atomically append a revision and advance that pointer with an expected-revision check.

The safe default is no row and therefore no consent. A malformed, unknown-version, cross-profile, or invalid revision also fails closed as no consent. No external channel is active, and existing profiles are never automatically opted in.

Materialization-time decisions are persisted with the exact preference revision used:

- `eligible` creates a `pending` outbox row;
- `deferred_quiet_hours` creates a `deferred` row with its earliest eligible instant;
- `suppressed_no_consent` and `suppressed_category_disabled` create terminal `suppressed` rows.

The frozen policy function also defines `suppressed_unsupported_category` and `suppressed_historical_cutover`. In the current projector, an unsupported evaluation result is recorded only as `excluded_unsupported` projection evidence, before any intent exists. Historical preview returns `suppressed_historical_cutover` as an explainable simulation result but performs no persistence. Those classifications are retained in the policy/schema contract for an explicitly designed future source or authorized-backfill path; Phase 2C2A does not manufacture an intent merely to store them. Invalid or contradictory trusted rows likewise receive only `invalid_source_needs_review` projection evidence, not an intent or outbox row.

An `eligible` decision means only that the stored profile policy allowed the intent. It does not claim that a verified recipient, delivery channel, or production adapter exists. A suppressed row is auditable and cannot later become pending because a preference was enabled. Phase 2C2B must recheck current consent immediately before any future provider call so revocation also stops an older pending item.

## Quiet-hours semantics

Quiet-hours evaluation is a pure function over an explicit canonical UTC instant, validated named IANA timezone, optional local `HH:mm` boundaries, and quiet-hours policy version. It uses `@js-temporal/polyfill` rather than the machine timezone or hand-written daylight-saving tables.

- With no quiet hours, delivery is allowed at the supplied instant.
- Start is inclusive and end is exclusive.
- `start < end` is a same-local-day interval.
- `start > end` crosses local midnight.
- Equal boundaries, one missing boundary, malformed time, invalid timezone, invalid instant, or wrong version fail closed.
- An ambiguous fall-back start uses the earlier occurrence.
- An ambiguous fall-back end uses the later occurrence.
- A nonexistent spring-forward boundary shifts forward by the actual timezone gap.

The result explains whether the instant is inside quiet hours, gives the earliest allowed canonical UTC instant, and preserves warnings for ambiguous or nonexistent boundaries. Those computed values are persisted; replay does not reinterpret an old intent under a newly installed timezone database.

## Durable records and outbox state machine

Migration `market-monitor-web/drizzle/0006_late_wasp.sql` adds the Phase 2C2A tables:

- `forecast_notification_projection_checkpoints`
- `forecast_notification_projection_items`
- `forecast_notification_preference_revisions`
- `forecast_notification_preferences`
- `forecast_notification_intents`
- `forecast_notification_policy_decisions`
- `forecast_notification_outbox`
- `forecast_notification_delivery_attempts`

Profile-aware composite foreign keys prevent cross-profile references. Checks constrain categories, states, booleans, counters, lease coherence, terminal timestamps, JSON fields, and attempt completion shapes. Unique indexes protect intent source identity, one outbox row per intent, monotonic attempt numbers, and at most one started or succeeded attempt per outbox item.

The channel-neutral outbox states are:

```text
materialize eligible  -> pending
materialize quiet     -> deferred
materialize suppress  -> suppressed (terminal)

pending/deferred/retry_scheduled --available_at reached + claim--> claimed
claimed --success-----------------------------------------------> succeeded (terminal)
claimed --retryable failure------------------------------------> retry_scheduled
claimed --terminal failure or exhausted attempts---------------> dead_letter (terminal)
claimed --expired lease recovery-------------------------------> claimed with a new attempt,
                                                                  or dead_letter at the cap
```

`deferred` and `retry_scheduled` are not claimable before `available_at`; `suppressed` is never claimable. No Phase 2C2A production code interprets the absence of a provider as success.

## Retry, attempts, leases, and fencing

Retry policy `forecast-notification-retry-1.0.0` is deterministic and contains no jitter or sleep. The maximum is six attempts. Retryable failures completed on attempts 1 through 5 receive delays of:

| Completed attempt | Delay before next attempt |
| ---: | ---: |
| 1 | 1 minute |
| 2 | 4 minutes |
| 3 | 16 minutes |
| 4 | 64 minutes |
| 5 | 256 minutes |
| 6 | Dead letter |

The next instant is calculated from the injected canonical completion time. Terminal failure classes dead-letter immediately. Failure classes and persisted diagnostics are bounded allowlists; provider bodies and exception messages are not stored.

Claims use opaque owner tokens and expiring leases. Claim and completion updates must condition on profile, outbox ID, `claimed` state, owner token, and an unexpired lease. A stale owner cannot succeed, schedule a retry, or dead-letter after takeover.

Each claim appends a unique monotonically increasing attempt. Attempts are never overwritten or deleted. A crashed or expired attempt becomes `interrupted`; takeover appends the next attempt and counts toward the maximum. At most one attempt may remain started and at most one may record success for an outbox item. This provides at-most-once recorded success, not proof of exactly-once behavior in a future external provider.

Phase 2C2A may use deterministic injected fake adapters in tests only. No fake is wired into the Worker or a production runtime, and no row is marked succeeded merely because a provider is absent.

## Local operator boundary

The safe operator command shapes are:

```bash
cd market-monitor-web

# Dry-run is the default and performs no notification-domain writes.
npm run forecast:notifications:project -- \
  --cutoff 2026-08-25T06:30:00.000Z --limit 25 --dry-run

# Forward projection mutation requires an explicit commit flag.
npm run forecast:notifications:project -- \
  --cutoff 2026-08-25T06:30:00.000Z --limit 25 --commit

# Historical inspection is explicitly bounded, confirmed, and still read-only.
npm run forecast:notifications:backfill -- \
  --from-id 1 --through-id 100 \
  --cutoff 2026-08-25T06:30:00.000Z \
  --confirm-historical-preview

# Read-only inspection.
npm run forecast:notifications:status -- --limit 20
npm run --silent forecast:notifications:status -- --limit 20 --json
```

Projection resolves the fixed profile internally. Cutoff, limits, modes, cursors, filters, duplicate arguments, and unknown arguments are strictly validated. Human output is the default; JSON mode is stable and contains no incidental logging on stdout. Status supports only allowlisted state/category filters and performs no schema initialization, provider call, lifecycle mutation, claim, or preference update.

Historical sources may be inspected only through an explicitly bounded and confirmed dry-run preview. Existing historical `needs_review` records remain excluded unless `--include-needs-review` is also supplied. There is no `--commit` historical backfill in Phase 2C2A.

Operator output reports source classifications, materialized/duplicate/suppressed/deferred counts, safe policy reasons, cursor/continuation state, outbox state totals, and append-preserved attempt summaries. It redacts payload JSON, payload/configuration fingerprints, profile details, lease/owner tokens, provider diagnostics, and secrets.

These are local operator boundaries, not application routes or browser controls. They never call market data or a delivery provider.

## Security and privacy decisions

- Every source query and foreign-key relationship is profile-scoped.
- Source identities and deduplication keys are derived internally; browser-provided IDs or keys are not accepted.
- Payload parsing is exact, bounded, and versioned. Control characters, arbitrary metadata, forged lifecycle transitions, contradictory evidence, and oversized JSON fail closed.
- No raw evaluator/provider document, forecast thesis, recipient identifier, credential, token, or exception message is copied into notification storage or logs.
- No URL-like destination exists, preventing a webhook field from becoming an SSRF boundary in this phase.
- Malformed sources are quarantined and do not poison later projection progress.
- Historical baselines prevent accidental notification floods.
- Missing preferences and missing channels never imply consent.
- Informational category wording is permitted; “Buy now,” “Sell now,” or other prescriptive financial advice is not.

The fixed profile resolver is still not authentication or tenant isolation. These controls preserve current profile separation but do not make Northstar safe for public multi-user deployment.

## Scheduler separation

Phase 2C2A does not change `market-monitor-web/worker/index.ts`, its `fetch` handler, the Phase 2C1 `scheduled` callback, or the `30 6 * * *` Cron configuration. Evaluation success never depends on notification projection. The forecast scheduler does not create, claim, or deliver notification rows.

Projection and future delivery are independently invokable and recoverable. No additional Cron trigger, queue consumer, provider binding, or notification environment variable is activated in Phase 2C2A.

## Migration, verification, and deployment limits

The generated additive migration is `market-monitor-web/drizzle/0006_late_wasp.sql`. Runtime initialization must remain structurally consistent with it. Applying it to remote D1 is a separate authorized write and was not performed by this phase:

```bash
npx wrangler d1 migrations apply DB --remote --config <staging-wrangler-config>
```

Local verification is:

```bash
source .venv312/bin/activate
python --version
python -m unittest discover -v
python -m compileall -q app.py ai.py analysis db.py finance.py indicators.py journal.py models.py news.py tests

cd market-monitor-web
npm test
npm run lint
npx tsc --noEmit
npm run db:generate
npm run build
```

Local tests and operator inspection do not prove that migration `0006` is applied remotely, a deployed build contains these contracts, remote D1 transaction behavior matches local emulation, a production identity or recipient is verified, or an external delivery provider is configured. No Worker deployment, remote migration, Cron activation, or real notification delivery is part of Phase 2C2A.

## Exact Phase 2C2B boundary

Phase 2C2B begins only after this durable foundation. Its scope is:

1. Add an authenticated, verified recipient and channel model with channel-specific consent and unsubscribe/revocation behavior.
2. Add bounded informational templates that consume only the persisted versioned payload.
3. Implement one explicitly configured provider adapter behind the outbox claim contract; never accept arbitrary destination URLs.
4. Recheck current master/category/channel consent immediately before the provider call and durably suppress an unsent item after revocation.
5. Add a separately configured, default-disabled dispatcher boundary with bounded claims, lease renewal/takeover, retry execution, provider idempotency keys, delivery reconciliation, and sanitized observability.
6. Define the unavoidable “provider accepted but local success write failed” ambiguity and the provider-specific reconciliation policy; do not claim exactly-once external delivery without evidence.
7. Verify the remote D1 migration, staging provider credentials, deployed runtime limits, alerting, kill switch, and rollback before production enablement.

Phase 2C2B must not reevaluate forecasts, mutate Phase 2A evidence, make Phase 2B/2C1 success depend on messaging, expose a browser dispatch API, or send directly from the Phase 2C1 scheduler loop. In-app notification centers, unread state, additional channels, global analytics, and public multi-user operation remain later work unless separately designed and authorized.
