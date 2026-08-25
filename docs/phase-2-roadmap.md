# Forecasts Phase 2 Roadmap

Phase 2 should make active forecasts measurable without weakening the immutable Phase 1 record. It should not broaden Northstar into trading automation, personalized advice, or AI-generated predictions.

## Phase 2A — complete

Phase 2A implements the trustworthy manual-evaluation slice:

- a pure deterministic Python evaluator over immutable activation terms, normalized completed daily bars, an explicit cutoff, and exchange-session coverage proof;
- a frozen versioned policy for targets, ranges, gaps, same-bar collisions, expiry, currency, corporate actions, and unsupported neutral semantics;
- exact results `no_change`, `target_hit`, `invalidated`, `expired`, and `needs_review`, with stable reasons, evidence, and a logical-input fingerprint;
- append-only D1 evaluation runs, atomic terminal transitions, optimistic concurrency checks, and idempotent replay;
- a manual **Evaluate now** confirmation and durable Review Queue;
- append-only acknowledgement that never overrides or reclassifies an evaluator result.

The implementation is documented in [`forecast-evaluation-phase-2a.md`](forecast-evaluation-phase-2a.md), with normative policy in [`forecast-evaluation-ruleset-v1.md`](forecast-evaluation-ruleset-v1.md).

The Phase 2A browser workflow remains manual. Batch coordination is implemented separately in Phase 2B and controlled scheduling in Phase 2C1; delivery, global accuracy analytics, authentication, and multi-user isolation remain absent. Remote Cloudflare D1 execution and browser end-to-end behavior have not been verified.

## Phase 2B — complete

Phase 2B implements the bounded, idempotent, operator-invoked due-forecast coordinator defined in [`forecast-coordinator-phase-2b.md`](forecast-coordinator-phase-2b.md):

- conservative profile-scoped due selection before, at, and after a forecast horizon;
- immutable `(evaluation_date, forecast_id)` ordering with a frozen scan snapshot and validated keyset cursors;
- bounded pages of 1 through 100 forecasts, defaulting to 25;
- direct invocation of the existing Phase 2A service without bypassing provider, fingerprint, concurrency, review, or atomic lifecycle protections;
- per-item classification and isolation for evaluator outcomes, replay, provider failures, state races, claim conflicts, validation failures, and unexpected errors;
- persisted runs, preplanned items, append-only attempts, recoverable progress, and fenced expiring claims;
- same-key replay, same-cutoff retry limits, crash-safe resume with the original cutoff, and dry-run without provider or forecast-domain mutation;
- concise human output and machine-readable JSON through the non-public `npm run forecast:coordinate` operator command.

There is no public batch endpoint or browser automation control. Phase 2C1 attaches the coordinator to a scheduled Worker boundary, but no email, push, webhook, or SMS delivery exists. Automated verification uses deterministic fixtures and local SQLite/D1-compatible boundaries; it does not establish remote D1 behavior, deployed operator security, live provider behavior, or operating-system process recovery.

## Phase 2C1 — complete

Phase 2C1 implements the default-disabled scheduled-operations boundary defined in [`forecast-scheduled-operations-phase-2c1.md`](forecast-scheduled-operations-phase-2c1.md):

- a custom Vinext Worker that preserves HTTP fetch handling and adds no public scheduler route;
- a trusted scheduled-event cutoff and deterministic occurrence/page identities;
- strict default-disabled configuration with conservative page, item, and runtime hard bounds;
- bounded opaque-cursor pagination through the unchanged Phase 2B coordinator;
- durable invocation/page history, expiring leases, fenced recovery, terminal replay, and repeated-cursor protection;
- structured sanitized logs and local simulation/read-only status commands;
- an additive D1 migration and a remote staging/production runbook without applying or deploying it remotely.

Remote D1 migration, deployed provider behavior, Cron activation, and Cloudflare plan limits remain deliberately unverified. The fixed profile also remains a migration seam rather than an authenticated tenant boundary.

## Phase 2C2A — complete

Phase 2C2A implements the durable notification outbox foundation defined in [`forecast-notification-outbox-phase-2c2a.md`](forecast-notification-outbox-phase-2c2a.md):

- profile-scoped projection from authoritative persisted Phase 2A evaluation runs and review items, without reevaluation or market-data access;
- support for `target_hit`, `invalidated`, `expired`, and `needs_review`, with `no_change` and operational failures explicitly excluded;
- canonical bounded payload snapshots, deterministic intent/deduplication identities, and database-enforced replay/concurrency uniqueness;
- stable evaluation-run keyset cursors, injected cutoffs, bounded pages, durable projection classifications, and crash-safe checkpoint advancement;
- a first-run profile baseline that prevents existing evaluations or unresolved review items from becoming an accidental historical flood;
- profile-scoped append-preserved preference revisions with default no consent, category settings, validated IANA timezones, and no recipient fields;
- persisted policy decisions and deterministic Temporal-based quiet-hour calculation across same-day, overnight, daylight-saving gap, and overlap cases;
- channel-neutral outbox states, deterministic bounded retries, expiring leases, stale-owner fencing, and append-preserved attempt history;
- safe local dry-run/commit projection and read-only status command boundaries, with historical inspection restricted to dry-run;
- additive migration `market-monitor-web/drizzle/0006_late_wasp.sql` without applying it remotely.

Phase 2C2A does not add an external provider, production template, verified recipient, browser notification API, notification dispatcher, Worker integration, or Cron. It leaves the Phase 2C1 Worker and schedule unchanged. Authentication/tenant isolation, remote D1 behavior, and deployed delivery remain unverified.

## Phase 2C2B — exact next step

Build delivery only behind the completed outbox boundary:

1. Add authenticated verified recipients and explicit per-channel consent, revocation, and unsubscribe semantics; never invent an address, token, or URL from profile data.
2. Add bounded informational templates that consume only the persisted versioned notification payload and cannot turn journal facts into trading advice.
3. Implement one explicitly configured provider adapter with sanitized results and provider idempotency keys; do not accept arbitrary webhook destinations.
4. Recheck current consent immediately before every provider call so revocation suppresses unsent pending work, while later opt-in never releases an old suppressed decision.
5. Add a separately configured, default-disabled dispatcher with bounded claims, lease renewal/takeover, retry execution, dead-letter inspection, structured observability, and a kill switch. Do not send from the Phase 2C1 coordinator loop.
6. Define and test reconciliation for the external ambiguity where a provider accepts a message but the local success write fails. Do not claim exactly-once delivery without provider evidence.
7. Verify migration `0006`, provider credentials, remote D1 concurrency, deployed runtime limits, alerting, rollback, and consent behavior in staging before any production enablement.

Phase 2C2B must preserve Phase 2A evidence, Phase 2B coordination safety, Phase 2C1 replay semantics, and Phase 2C2A intent identity. Additional channels, an in-app notification center, unread state, global analytics, authentication beyond the recipient boundary, and public multi-user operation remain later work unless separately designed and authorized.

## Later sequence

1. **Production coordination and delivery**
   - Complete Phase 2C2B verified delivery and the remaining authentication/remote-runtime verification above.
   - Preserve bounded execution, replay safety, and duplicate-delivery protection.

2. **Accuracy and calibration analytics**
   - Compute results by direction, setup tag, horizon, confidence bucket, and analysis-scenario type.
   - Show sample sizes and unresolved/cancelled forecasts so the interface does not overstate performance.

3. **Interactive chart context**
   - Add candlesticks and saved drawings linked to forecast/review timestamps.
   - Preserve the original activation snapshot rather than redrawing historical intent from current data.

## Phase 2 completion boundary

Phase 2 is complete when evaluation is deterministic, versioned, idempotent, reviewable, and backed by completed market data; outcome records never rewrite activation snapshots; users can see what was evaluated and why; and accuracy/calibration views faithfully include uncertainty and sample size.

Broker connections, order execution, AI-authored forecasts, social features, mentor mode, full backtesting, and bar replay remain outside this roadmap.
