# Forecast Scheduled Operations — Phase 2C1

This document is the normative Northstar Phase 2C1 contract. Scheduler contract version `forecast-scheduler-1.0.0` invokes coordinator contract `forecast-coordinator-1.0.0`. Phase 2A remains the only authority for evaluating and mutating one forecast; Phase 2B remains the only authority for due selection, scan snapshots, opaque cursors, claims, attempts, replay, and coordinator recovery.

Phase 2C1 adds timing, bounded multi-page execution, scheduler recovery, audit history, and operator inspection. It adds no notification or public run endpoint.

## Architecture and trust boundary

The current Vinext deployment supports a custom Worker entry, so Phase 2C1 uses the smallest repository-native design:

- `market-monitor-web/worker/index.ts` delegates every HTTP request unchanged to `vinext/server/fetch-handler`.
- The same Worker exports a Cloudflare `scheduled` callback. No HTTP route invokes it.
- The callback trusts only Cloudflare's `scheduledTime` and `cron`, resolves the fixed profile internally, validates named environment fields, initializes D1 only after enabled configuration is valid, and calls the internal scheduler service.
- The scheduler calls `ForecastCoordinatorService.coordinate(..., trustedProfileId)` directly. It never queries forecasts, fetches market data, decodes a cursor, or calls the evaluator/provider itself.
- The coordinator calls the existing Phase 2A service. Browser input cannot provide a profile, symbol, OHLC data, forecast terms, cutoff, or result to this path.

The fixed profile resolver is a deployment limitation, not tenant authentication. Phase 2C1 is production-shaped but must not be treated as multi-user ready.

## Schedule and cutoff

The initial deployment configuration is:

```text
30 6 * * *
```

Cloudflare Cron is UTC. This means one invocation daily at 06:30 UTC. For the US calendars currently supported by the Phase 2A policy, the conservative next-exchange-local-midnight availability point is normally before 06:30 UTC, leaving a buffer while limiting provider and D1 load. One UTC run cannot guarantee immediate evaluation for every global exchange; the schedule is an operational cadence, not a market-data completeness assertion. Phase 2A still decides whether completed evidence exists.

The immutable evaluation cutoff is exactly `new Date(controller.scheduledTime).toISOString()`. Current wall time and machine timezone never determine it. Continuation pages reuse that same cutoff and the original Phase 2B cursor, which preserves the coordinator's frozen scan time and maximum forecast ID.

The source configuration contains the Cron expression, but `FORECAST_SCHEDULER_ENABLED` defaults to `false`. No deployment or remote activation was performed in Phase 2C1.

## Identity and replay

An occurrence key is the SHA-256 digest of a canonical record containing scheduler version, environment, trusted profile ID, exact Cron expression, and canonical scheduled UTC time:

```text
fsched1:<64 lowercase hexadecimal characters>
```

Each page uses the Phase 2B operator key:

```text
<occurrence-key>:page:<one-based-page-number>
```

The occurrence key deliberately excludes adjustable bounds. A persisted configuration fingerprint is compared before replay or recovery, so the same occurrence cannot silently resume under different limits. Replaying a terminal occurrence increments its durable replay count/last-replayed time and returns its existing scheduler invocation and pages without calling Phase 2B. A new scheduled time creates a different key and cutoff.

## Configuration and hard bounds

Only exact named values are accepted. Unknown fields, whitespace-padded or fractional integers, zero, negative, excessive values, version mismatches, and a runtime reserve greater than or equal to the runtime budget are rejected.

| Setting | Environment name | Default | Hard range |
|---|---|---:|---:|
| Kill switch | `FORECAST_SCHEDULER_ENABLED` | `false` | exact `true` or `false` |
| Environment | `FORECAST_SCHEDULER_ENVIRONMENT` | `local` | `local`, `preview`, `staging`, `production` |
| Page size | `FORECAST_SCHEDULER_PAGE_SIZE` | 10 | 1–25 |
| Maximum pages | `FORECAST_SCHEDULER_MAX_PAGES` | 3 | 1–10 |
| Maximum selected items | `FORECAST_SCHEDULER_MAX_ITEMS` | 25 | 1–100 |
| Runtime budget | `FORECAST_SCHEDULER_MAX_RUNTIME_MS` | 480000 | 1000–720000 ms |
| Required reserve | `FORECAST_SCHEDULER_MIN_REMAINING_MS` | 45000 | 1000–120000 ms and less than runtime |
| Scheduler version | `FORECAST_SCHEDULER_VERSION` | compiled version | exact compiled version |
| Coordinator version | `FORECAST_COORDINATOR_VERSION` | compiled version | exact compiled version |

An enabled scheduler also requires `ANALYSIS_API_URL`. Local execution may use explicit HTTP loopback. Preview, staging, and production require HTTPS and reject credentials, query strings, fragments, localhost, and loopback addresses. The URL is injected into the existing evaluator client and is neither persisted in scheduler configuration nor logged.

The runtime budget is cooperative at page boundaries and applies independently to each lease-owning execution attempt, including a recovery attempt. The durable invocation duration still measures from the original start for honest audit history. Phase 2B completes or safely recovers one whole page; Phase 2C1 does not claim to cancel an in-flight provider request. The 12-minute hard limit leaves headroom below Cloudflare's scheduled wall limit, but plan-specific CPU and subrequest limits must still be verified before enablement.

## Pagination and stopping rules

Before each page the scheduler checks operational authority, completed page count, selected item count, and remaining runtime. The coordinator limit is `min(pageSize, maxItems - selectedSoFar)`. The scheduler persists page intent before calling Phase 2B and passes the returned continuation cursor byte-for-byte to the next page.

Execution stops with:

- `no_more_work` when Phase 2B returns no cursor;
- `max_pages_reached`, `max_items_reached`, or `runtime_budget_reached` with `moreWork=true`;
- `authority_lost` if the fenced scheduler lease is no longer owned;
- `overlap_in_progress` when an existing scheduler invocation or Phase 2B page is still running;
- `repeated_cursor` if a cursor repeats the input or any previously seen cursor;
- `coordinator_failure` or `unexpected_error` after a sanitized failure.

There is no offset pagination, cursor decoding, cursor rewriting, or unbounded loop.

## Overlap, crash recovery, and fencing

Scheduler invocation and page rows supplement—not replace—Phase 2B safety:

- The unique `(profile_id, occurrence_key)` constraint prevents duplicate occurrence records.
- A live scheduler lease causes same-event overlap to return `running` without another page call.
- An expired scheduler lease can be acquired with a new token and increments `recovery_count`.
- Page intent is durable before coordination. Recovery uses the same page number, input cursor, limit, cutoff, and operator key.
- If Phase 2B completed after Phase 2A persistence but scheduler reporting crashed, the same page key returns the existing Phase 2B report. Phase 2A idempotency prevents a duplicate lifecycle transition.
- Page completion and invocation aggregates are written in one D1 batch. A crash after that batch resumes at the next persisted cursor.
- Every page, renewal, completion, failure, and finalization write is fenced by invocation ID, profile ID, running state, lease token, and unexpired lease. A stale owner cannot finalize after takeover.
- Different occurrences have different identities. If they overlap, Phase 2B claims and evaluation idempotency remain the per-forecast safety layer; Phase 2C1 does not bypass them.

A Phase 2B report whose status is still `running` is not counted as a completed page and never advances the cursor.

## Persistence

Migration `market-monitor-web/drizzle/0005_thin_ikaris.sql` adds:

- `forecast_scheduler_invocations`: immutable occurrence/config/cutoff fields, lease/recovery state, durable replay count and last-replayed time, start/end/duration, aggregate counts and outcomes, cursor state, `more_work`, stop/error classification, and coordinator-run IDs.
- `forecast_scheduler_pages`: one append-preserving page intent/outcome per invocation ordinal, including the exact Phase 2B key, input/output cursor, limit, coordinator run/status, counts, replay flag, timing, and sanitized failure fields.

Coordinator runs, coordinator item attempts, evaluation runs, review evidence, and forecast events remain in their Phase 2A/2B tables. Scheduler history never overwrites them.

## Operational states and logs

Structured results use `disabled`, `ready`, `running`, `completed`, `partial_budget_exhausted`, `replayed`, `recovered`, `configuration_error`, `coordinator_failure`, and `unexpected_error` where applicable. Persisted invocation status is separate from the presentation state, so a recovered terminal run remains auditable as `completed` or its failure status while the immediate report says `recovered`.

Stable JSON log events are:

- `forecast_schedule_received`
- `forecast_schedule_disabled`
- `forecast_schedule_configuration_invalid`
- `forecast_schedule_started`
- `forecast_schedule_page_started`
- `forecast_schedule_page_completed`
- `forecast_schedule_budget_reached`
- `forecast_schedule_replay_detected`
- `forecast_schedule_recovery_detected`
- `forecast_schedule_completed`
- `forecast_schedule_failed`

Logs contain safe correlation IDs, versions, environment, cutoff, counts, duration, state, stop reason, and sanitized error category/type. They do not contain raw environment contents, provider bodies, exception messages, authorization material, evaluator evidence, or forecast text.

## Local operator commands

Run from `market-monitor-web`:

```bash
npm run forecast:schedule:simulate -- --help
npm run forecast:schedule:simulate -- \
  --scheduled-at 2026-08-25T06:30:00.000Z \
  --enabled true
npm run --silent forecast:schedule:simulate -- \
  --scheduled-at 2026-08-25T06:30:00.000Z \
  --enabled false --json

npm run forecast:schedule:status -- --limit 20
npm run --silent forecast:schedule:status -- --run-id <scheduler-invocation-id> --json
```

Simulation requires an explicit canonical scheduled time and explicit kill-switch value. It invokes the same scheduler service locally through Wrangler D1 and no public endpoint. Enabled simulation defaults to the explicit local provider `http://127.0.0.1:8502`; start the Python service when due forecasts exist. Set `NORTHSTAR_COORDINATOR_PERSIST_PATH` to isolate or share local state.

Status is read-only: it performs no DDL, provider call, coordinator call, or lifecycle mutation. It reports the local schema, recent invocation/page records, partial/failure/replay details, and linked coordinator run IDs. Scheduler lease tokens, raw configuration JSON, and configuration fingerprints are deliberately omitted from human and JSON output. `inspection_ready` means only that local read-only inspection is available; it does not claim the scheduler itself is enabled or remotely healthy.

## Health and readiness truthfulness

Local state can establish that:

- the compiled/source schedule and default-disabled variables exist;
- local schema is present or missing;
- a local invocation completed, failed, remains running, or left more work;
- persisted coordinator outcomes include provider failure classifications.

Local state cannot establish that:

- migration `0005` is applied to remote D1;
- the remote Worker has this build or configuration;
- the Cloudflare Cron trigger is active;
- the deployed analysis provider is reachable;
- the current Cloudflare plan has sufficient CPU/subrequest allowance.

An HTTP build or healthy page does not prove scheduler readiness.

## Staging and production checklist

Read-only/local preparation:

1. Keep `FORECAST_SCHEDULER_ENABLED=false`.
2. Set a real staging D1 database ID in a staging Wrangler configuration and set its D1 `migrations_dir` to `./drizzle` (or the correct path relative to that config).
3. Configure an explicit deployed HTTPS `ANALYSIS_API_URL` without credentials in the URL.
4. Run the full tests, typecheck, lint, production build, local simulation/replay/disabled checks, and status commands.
5. Inspect generated `dist/server/wrangler.json`; confirm the custom `index.js`, expected Cron, D1 binding, and disabled variables.
6. Read remote migration state:

   ```bash
   npx wrangler d1 migrations list DB --remote --config <staging-wrangler-config>
   ```

Remote writes require separate authorization. The expected migration command is:

```bash
npx wrangler d1 migrations apply DB --remote --config <staging-wrangler-config>
```

That command mutates remote D1. A later deployment would update the Worker and Cron trigger; enabling the scheduler would permit lifecycle/provider work. None of those actions were performed here.

Before production enablement, verify a disabled scheduled event, an empty-due enabled event, same-event replay, a bounded due set, remote invocation/page/coordinator linkage, provider failure classifications, observability retention, and the rollback procedure.

## Rollback and kill switch

The first response to operational trouble is to set `FORECAST_SCHEDULER_ENABLED=false` and deploy that configuration through the authorized release process. Disabled events return a structured `disabled` result before D1 initialization, coordinator calls, provider calls, or lifecycle mutation. Existing audit rows remain intact.

If necessary, remove or change the Cron trigger in deployment configuration through a separately authorized deployment. Do not delete scheduler, coordinator, evaluation, review, or forecast history as rollback. Migration `0005` is additive; leaving its tables in place is safe while disabled.

## Known limitations

- Remote D1 migration, Worker deployment, Cron activation, remote provider behavior, and plan limits are not verified locally.
- Cron provides at-least-once operational delivery, not exactly-once execution; deterministic identity and leases provide application safety.
- Runtime enforcement occurs between coordinator pages, not mid-page.
- The fixed profile is not authentication or tenant isolation.
- The single daily UTC cadence does not promise immediate processing for all exchanges.
- Phase 2C1 emits logs but does not add an external alerting destination.
- No notification or delivery semantics exist.

## Exact Phase 2C2 boundary

Phase 2C2 should begin with a durable notification outbox derived only from persisted trusted forecast/evaluation events. It should define delivery policy, user consent and preferences, deduplication keys, quiet hours/retry behavior, channel adapters, and append-preserving delivery history. It must never make evaluation decisions, rewrite Phase 2A evidence, use scheduler logs as the source of truth, or send directly from the Phase 2C1 page loop. Phase 2C1 does not begin that work.
