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

The Phase 2A browser workflow remains manual. Batch coordination is implemented separately in Phase 2B; scheduling, delivery, global accuracy analytics, authentication, and multi-user isolation remain absent. Remote Cloudflare D1 execution and browser end-to-end behavior have not been verified.

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

There is no public batch endpoint, browser automation control, Cron trigger, Scheduled Worker, email, push, webhook, or SMS delivery. Automated verification uses deterministic fixtures and local SQLite/D1-compatible boundaries; it does not establish remote D1 behavior, deployed operator security, live provider behavior, or operating-system process recovery.

## Phase 2C — exact next step

Prepare the proven internal coordinator for controlled production invocation before attaching automation:

1. Replace the fixed profile with an authenticated and authorized operator identity, and verify tenant isolation.
2. Verify migrations, transactions, claims, leases, replay, and resume against remote Cloudflare D1 and the deployed analysis service.
3. Add production-safe observability, secret handling, operational runbooks, and alerting for coordinator health without exposing forecast contents unnecessarily.
4. Define retry cadence, scheduler ownership, overlap behavior, and failure escalation; then attach a bounded scheduler to the unchanged internal coordinator contract.
5. Define notification ownership, consent, deduplication, and delivery policy before adding email, push, webhook, or SMS channels.

Phase 2C must preserve the frozen cutoff, cursor, claim, replay, and per-item honesty guarantees or introduce a new coordinator version. It must not expose the batch coordinator as an unauthenticated browser endpoint.

## Later sequence

1. **Production coordination and delivery**
   - Complete the Phase 2C authentication, remote-runtime, observability, scheduling, and notification boundaries above.
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
