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

The Phase 2A browser workflow remains manual. Batch coordination is implemented separately in Phase 2B, controlled scheduling in Phase 2C1, the durable notification outbox in Phase 2C2A, and verified email delivery in Phase 2C2B. Global accuracy analytics, authentication, and multi-user isolation remain absent. Remote Cloudflare D1 execution, live delivery, and browser end-to-end behavior have not been verified.

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

There is no public batch endpoint or browser automation control. Phase 2C1 attaches the coordinator to a scheduled Worker boundary, while Phase 2C2A/2C2B remain downstream and never send from the coordinator loop. Automated verification uses deterministic fixtures and local SQLite/D1-compatible boundaries; it does not establish remote D1 behavior, deployed operator security, live provider behavior, or operating-system process recovery.

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

Phase 2C2A itself does not add an external provider, production template, verified recipient, browser notification API, notification dispatcher, Worker integration, or Cron. Phase 2C2B consumes it without changing its authoritative source identities. Authentication/tenant isolation, remote D1 behavior, and deployed delivery remain unverified.

## Phase 2C2B — complete

Phase 2C2B implements the verified email delivery foundation defined in [`forecast-email-delivery-phase-2c2b.md`](forecast-email-delivery-phase-2c2b.md):

- profile-owned pending, verified, revoked, replaced, and provider-suppressed recipient states with conservative address normalization and masked output;
- expiring single-use verification capabilities stored hash-only, with scanner-safe `GET` and explicit confirmation `POST` semantics;
- append-preserved recipient-bound email master/category consent separate from Phase 2C2A notification consent;
- deterministic bounded `en-US` verification and forecast templates with escaped HTML, safe links, informational language, content hashes, and unsubscribe headers;
- a fixed-endpoint Resend adapter with strict configuration, bounded requests/responses, sanitized classifications, and persisted deterministic idempotency/request identity;
- a final authoritative recipient, consent, preference, quiet-hours, claim, configuration, template, and prior-acceptance check immediately before provider access;
- a sequential bounded manual dispatcher with dry-run default, explicit live-send gates, fenced claims, per-item isolation, retry/dead-letter handling, and no Cron registration;
- explicit separation between provider acceptance and final delivery, including ambiguous acceptance recovery without an exactly-once claim;
- raw-body Resend/Svix webhook verification, provider-event deduplication, deterministic status precedence, and bounce/complaint suppression;
- visible and one-click unsubscribe that appends consent revocation without deleting historical evidence; and
- additive migration `market-monitor-web/drizzle/0007_late_amphibian.sql` without applying it remotely.

No live Resend call, remote D1 migration, Worker deployment, webhook registration, sender-domain/DNS change, or email dispatcher Cron activation was performed. Resend acceptance/delivery, remote concurrency, production operator security, and process-kill recovery remain unverified. Recipient verification is not user authentication, and the fixed profile remains unsuitable for public multi-user operation.

## Phase 2C2C — complete

Phase 2C2C implements the durable in-app Notification Center defined in [`forecast-in-app-notification-center-phase-2c2c.md`](forecast-in-app-notification-center-phase-2c2c.md):

- deterministic profile-scoped projection from existing trusted intents with no reevaluation, provider access, or email-policy dependency;
- first-run baseline, explicit cutoff, bounded pages, fenced lease, durable poison-row classification, replay-safe identity, and a separately confirmed bounded historical action;
- immutable presentation snapshots and server-derived evidence links with exact evaluation/review identity;
- append-preserved read/unread/mark-all history, permanent first-read timestamps, and sequence-bound mark-all snapshots;
- checksummed profile/filter-bound descending keyset pagination, exact unread counts, and strict fixed-profile APIs;
- a dedicated responsive `/notifications` Center, accessible bell, filters, load-more, explicit state controls, confirmation dialog, and read-only evidence route; and
- honest independent email evidence for not-configured, queued/in-progress, provider-accepted, delivered, delayed, ambiguous, failed, bounced, complained, and suppressed states.

No remote migration, deployment, live email, Cron activation, recipient UI, public profile selection, or external channel was added. Browser notification reads do not initialize schema or call providers. The fixed profile remains unsuitable for public multi-user operation.

## Phase 3A — exact next step

Add authenticated identity, authorization, and tenant isolation before any public multi-user exposure, recipient-management UI, channel-preference UI, or production dispatcher scheduling. Phase 3A must replace the fixed-profile resolver with a verified session/tenant boundary and prove same-tenant ownership through forecast, evaluation, notification, email, webhook, and operator paths. Phase 3A has not started.

## Later sequence

1. **Authentication and authorized production delivery**
   - Complete Phase 3A identity/tenant isolation and the remaining remote-runtime/provider verification above.
   - Preserve bounded execution, replay safety, consent, redaction, and duplicate-delivery protection.

2. **Accuracy and calibration analytics**
   - Compute results by direction, setup tag, horizon, confidence bucket, and analysis-scenario type.
   - Show sample sizes and unresolved/cancelled forecasts so the interface does not overstate performance.

3. **Interactive chart context**
   - Add candlesticks and saved drawings linked to forecast/review timestamps.
   - Preserve the original activation snapshot rather than redrawing historical intent from current data.

## Phase 2 completion boundary

Phase 2 is complete when evaluation is deterministic, versioned, idempotent, reviewable, and backed by completed market data; outcome records never rewrite activation snapshots; users can see what was evaluated and why; and accuracy/calibration views faithfully include uncertainty and sample size.

Broker connections, order execution, AI-authored forecasts, social features, mentor mode, full backtesting, and bar replay remain outside this roadmap.
