# Northstar due-forecast coordinator — Phase 2B

This document is the normative contract for the Phase 2B coordinator. The frozen coordinator version is `forecast-coordinator-1.0.0`. It is deliberately independent of the evaluator and evaluation-ruleset versions.

## Responsibility boundary

The coordinator selects and sequences saved forecasts. It never evaluates prices, duplicates exchange-calendar logic, accepts forecast terms or OHLC data from an operator, or writes forecast lifecycle state directly. Execute mode calls the existing Phase 2A `ForecastEvaluationService` through its internal TypeScript service boundary with the frozen cutoff. Phase 2A remains authoritative for provider retrieval, completed-bar semantics, fingerprints, optimistic concurrency, lifecycle transitions, review items, and atomic evaluation persistence.

Phase 2B is operator-invoked only. It adds no application route, browser control, Cron or Scheduled Worker trigger, notification channel, authentication system, or deployment.

## Input contract

The internal input is:

```text
profileId          trusted positive integer supplied by the operator adapter
cutoff             required canonical UTC instant
limit              integer, default 25, minimum 1, maximum 100
cursor             optional opaque Phase 2B continuation token
mode               dry_run or execute
operatorRunKey     optional 1–128 character idempotency key
```

The current adapter obtains `profileId` from the existing fixed current-profile resolver; it does not expose a profile flag. A run key is scoped to a profile. Reusing it with the same normalized request returns or resumes the same run. Reusing it with a different cutoff, mode, limit, or initial cursor is rejected.

The cutoff is never inferred inside the coordinator. The adapter resolves any desired current time once and passes it explicitly. Attempt, lease, and completion timestamps are supplied by an injected orchestration clock; the coordinator domain contains no implicit `new Date()` source. UTC instants are stored canonically with millisecond precision.

## Due-selection policy

SQL deliberately does not attempt to decide whether an exchange-local daily bar has completed. A forecast is a candidate when all of these hold:

1. It belongs to the trusted profile.
2. It is `active`.
3. It was activated no later than both the requested cutoff and the frozen scan start.
4. Its ID is no greater than the scan's frozen maximum forecast ID.
5. It has no successful evaluation or completed coordinator item at or after the requested cutoff.
6. Its same-cutoff retry budget is not exhausted.

Every later cutoff conservatively represents a point at which new completed information may exist. This applies before, at, and after the horizon. A previous `no_change` or `needs_review` result is due again at a later cutoff. Provider-unavailable, timeout, stale-state, unexpected failures, and interrupted provider work share a budget of three provider/evaluator attempts for the exact `(profile, forecast, cutoff)` tuple; a later cutoff starts a new budget. Claim conflicts do not consume that budget because no attempt begins. Validation failures are not retried at the same cutoff. Dry-runs consume no retry budget.

Review Queue acknowledgement is never part of eligibility. Cancelled and terminal forecasts are excluded. A cutoff at or older than successfully processed state is not due, preventing state regression. The trusted evaluator can still return `no_change` when conservative SQL selection finds no new completed bar.

Stable due reasons are `never_evaluated`, `new_information_possible`, `new_information_possible_after_no_change`, `new_information_possible_after_needs_review`, `horizon_may_be_complete`, `retry_after_provider_unavailable`, `retry_after_provider_timeout`, `retry_after_stale_state`, and `retry_after_unexpected_error`. They explain selection; they do not predict an evaluation outcome.

## Ordering and scan snapshot

Candidates are ordered by immutable keys:

```sql
ORDER BY evaluation_date ASC, id ASC
```

`id` is the unique immutable final tie-breaker. Pagination uses the keyset predicate:

```sql
evaluation_date > :afterDate
OR (evaluation_date = :afterDate AND id > :afterId)
```

The first page freezes `scanStartedAt` and `snapshotMaxForecastId`. Later pages keep those values. Forecasts created or activated during the scan are deferred to a future scan. A selected forecast becoming terminal or otherwise ineligible cannot shift an offset or cause a later key to be skipped.

## Cursor contract

Cursor schema version 1 is canonical JSON encoded as unpadded base64url, followed by a dot and the unpadded base64url SHA-256 checksum of the exact JSON bytes. The payload is:

```json
{
  "v": 1,
  "coordinator": "forecast-coordinator-1.0.0",
  "profileId": 1,
  "cutoff": "2026-08-24T12:00:00.000Z",
  "scanStartedAt": "2026-08-24T12:00:01.000Z",
  "snapshotMaxForecastId": 42,
  "after": { "evaluationDate": "2026-09-30", "forecastId": 12 }
}
```

`after` may be null. Validation rejects overlong, malformed, padded, non-canonical, truncated, unknown-version, unknown-field, checksum-mismatched, cross-profile, and cross-cutoff tokens. Cursor values never contain secrets or SQL. The checksum detects corruption at this internal boundary; it is not authentication. A future public boundary would require authenticated invocation and a keyed signature.

`nextCursor` is the continuation position after a fully planned page when more frozen-scan candidates remain. `resumeCursor` is the last contiguous candidate whose coordinator outcome is durably recorded. A persisted start cursor with `after: null` represents a crash before item one. Recovery uses the run key/run ID and its preplanned candidates; cursors remain auditable progress boundaries. Both cursors are null only after the frozen scan is complete.

## Runs, planned items, and attempts

One coordinator run represents one bounded page. Before execute-mode provider work begins, the complete selected page is persisted in order as pending run items with symbol, prior status, immutable sort key, due reason, latest evaluation summary, and cutoff. This prevents a terminal Phase 2A write followed by a process crash from making the selected forecast disappear from coordinator history.

Runs record the coordinator version, normalized request fingerprint, mode, cutoff, limit, initial/resume/next cursors, scan snapshot, optional operator key, status, run lease, timestamps, counts, and deterministic outcome-count JSON. Run items preserve the selected candidate and final coordinator report fields. Every provider/evaluator attempt has a separate append-preserved row linked to the planned item; only that row's `started` state is finalized as `completed` or `interrupted`, so retries remain independently explainable. Claims are operational lease rows and may be conditionally replaced after expiry.

Version 1 writes `running`, `completed`, and `completed_with_errors`. `completed` means all selected items have durable outcomes and no unexpected item error. Expected isolated outcomes such as provider unavailability or a claim conflict remain visible in the report; an unexpected error produces `completed_with_errors`. The schema reserves `interrupted` and `failed_before_processing` for future operator recovery tooling, but this implementation does not emit them: an expired `running` run is recovered in place, while a failure before durable planning has no run to update.

## Execution and outcome classes

Version 1 executes sequentially. For each preplanned candidate it rechecks profile and current state, checks same-cutoff processed state and retry budget, acquires a fenced lease, invokes Phase 2A, records the attempt and item result, conditionally completes the lease, and advances recoverable progress. No database transaction spans a provider request, and no transaction spans the whole batch. One item failure does not stop later items.

Stable coordinator classifications are:

```text
no_change
target_hit
invalidated
expired
needs_review
duplicate_or_replayed
provider_unavailable
provider_timeout
stale_state
not_active
not_due
claim_conflict
validation_failure
unexpected_error
dry_run_candidate
```

An item retains the underlying evaluator decision, evaluation-run and review-item IDs when available, prior/current status, safe reason and explanation, evaluator/provider versions when known, injected start/finish timestamps, cutoff, sort key, mutation and retry flags, and a redacted error category. Reports never include stack traces, raw unexpected messages, provider URLs, credentials, or tokens. `mutated` is true only when the current invocation can attribute a durable Phase 2A mutation to itself.

## Claims and concurrency

There is one claim row per `(profile, forecast)`. Acquisition is a single conditional upsert that succeeds only when no live claim exists or the previous lease expired. A claim contains the owner run/item, an unpredictable token, frozen cutoff, acquisition time, expiry, and state. Completion and release compare profile, forecast, owner, and token. An old owner therefore cannot complete or release a recovered claim.

The fixed-duration claim lease exceeds the Phase 2A provider timeout. An expired claim permits recovery so a crashed process cannot block a forecast forever. Forecast claims reduce duplicate provider work; Phase 2A's fingerprint and atomic state transition remain the final duplicate-persistence protections. A separate run lease prevents concurrent reuse of the same operator key; it is renewed before every page item, and attempt/item/progress writes are fenced by its token.

## Replay and crash recovery

Same-key replay of a completed run returns its stored report without provider work and sets `replayUsedExistingRun`. Same-key replay of an expired `running` run reacquires the run lease and processes its original pending page using the original cutoff, scan snapshot, and selected order.

Progress advances only after an item outcome is durable. If a crash occurs:

- before item one, the first pending item remains the recovery point;
- after an earlier item, the persisted resume cursor identifies that contiguous boundary;
- after Phase 2A persistence but before coordinator completion, recovery reconciles the exact-cutoff evaluation/current forecast state and records `duplicate_or_replayed` when attribution is not provable;
- after item completion but before cached run progress, recovery derives truth from completed items and repairs the cursor/count cache without another provider call.

An unrecorded planned item is never skipped. Original cutoff is never replaced with the recovery time. Repeating a cursor page under a new run is safe: processed-state checks and Phase 2A idempotency prevent duplicate terminal events, lifecycle transitions, and Review Queue rows.

## Dry-run

Dry-run uses the same selector, frozen snapshot, ordering, cursor, and limit. It persists an audit run and planned `dry_run_candidate` items, but it creates no claims or provider-attempt records, calls no provider or evaluator, creates no evaluation run or Review Queue item, and performs no forecast/event/lifecycle mutation. `attemptedCount` and `mutatedCount` are zero. Execute-mode `attemptedCount` counts completed planned items that reached an execute outcome; append-preserved attempt rows are the authoritative provider-call and retry history. The report states why each forecast is due and that execute mode would potentially call the provider; it never predicts the outcome.

## Operator boundary and reporting

The local operator CLI uses Wrangler's local platform proxy with an operator-only configuration and `remoteBindings: false` to obtain a genuine persisted D1 binding. It initializes the same runtime schema, resolves the current fixed profile internally, constructs the D1 repositories and real Phase 2A service, and invokes the coordinator directly. It is not an HTTP application route and is not part of the deployable Vinext entry point.

The command requires explicit `--cutoff` and `--mode`; it supports `--limit`, `--cursor`, `--run-key`, and `--json`. Invalid invocation or a system-level failure exits non-zero. Item-level failures remain represented honestly in a completed report. Human and JSON renderers use the same report object and therefore share status and counts. Local execute mode requires the trusted Python analysis API to be running at `ANALYSIS_API_URL`.

From `market-monitor-web`, inspect the exact local contract and preview one bounded page with:

```bash
npm run forecast:coordinate -- --help
npm run forecast:coordinate -- \
  --cutoff 2026-08-24T12:00:00.000Z \
  --mode dry_run \
  --limit 25 \
  --run-key preview-2026-08-24T12:00Z
```

For machine-readable output, use `npm run --silent forecast:coordinate -- ... --json` so npm does not prefix stdout. For execute mode, first run the documented local Python analysis service, then invoke:

```bash
ANALYSIS_API_URL=http://127.0.0.1:8502 \
npm run forecast:coordinate -- \
  --cutoff 2026-08-24T12:00:00.000Z \
  --mode execute \
  --limit 25 \
  --run-key execute-2026-08-24T12:00Z
```

Pass a returned `nextCursor` with `--cursor` for the next page. Reuse the same `--run-key` only to replay or recover the exact same page contract. Wrangler local state defaults to `market-monitor-web/.wrangler/state/v3`; `NORTHSTAR_COORDINATOR_PERSIST_PATH` may point verification at an isolated local directory. Neither option enables remote D1.

## Current limitations and Phase 2C boundary

Phase 2B does not verify remote Cloudflare D1, deployed browser behavior, operating-system process-kill recovery, live Yahoo behavior, or production operator authentication. The current fixed profile resolver is not tenant isolation. Lease timing assumes canonical UTC strings and a single D1 primary; future read replication would require session/bookmark review.

Phase 2C may attach a scheduler to this internal contract only after production authentication/authorization, remote D1 and deployment verification, operational observability, secrets handling, retry cadence, and notification policy are designed. Phase 2C must not change the frozen Phase 2B cutoff, cursor, claim, replay, and per-item honesty guarantees without a new coordinator version.
