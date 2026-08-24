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

Phase 2A remains manual. It has no due-forecast batch, scheduler, email, push, webhook delivery, global accuracy dashboard, authentication, or multi-user isolation. Remote Cloudflare D1 execution and browser end-to-end behavior have not been verified.

## Phase 2B — exact next step

Start with a bounded, idempotent, operator-invoked due-forecast coordinator. Do not start with a cron trigger, email, push notification, or analytics dashboard.

The first Phase 2B change should define and test:

- a profile-scoped query that selects active forecasts due at or before an injected cutoff in a stable order;
- an explicit batch limit and continuation cursor so work is bounded;
- a coordinator that invokes the existing single-forecast evaluation service without bypassing its fingerprint, concurrency, provider, or atomic-persistence protections;
- per-item success, duplicate, `needs_review`, provider-unavailable, stale-state, and unexpected-error results so one forecast cannot abort the batch;
- replay tests proving that the same cutoff and logical market inputs do not duplicate runs, events, review items, or terminal transitions;
- structured diagnostics containing identifiers and error classes but no secrets or provider response bodies.

The first invocation should remain operator-controlled. A scheduler may be considered only after the coordinator is bounded, observable, restartable, and idempotent under partial failure. Email, push, webhooks, and global analytics remain outside Phase 2B's first slice.

## Later sequence

1. **Scheduling and delivery**
   - Add retries, leases, observability, and duplicate-delivery protection.
   - Attach a scheduler only after the Phase 2B coordinator is proven.
   - Deliver outcome/review notifications only after scheduling is reliable and authenticated ownership exists.

2. **Accuracy and calibration analytics**
   - Compute results by direction, setup tag, horizon, confidence bucket, and analysis-scenario type.
   - Show sample sizes and unresolved/cancelled forecasts so the interface does not overstate performance.

3. **Interactive chart context**
   - Add candlesticks and saved drawings linked to forecast/review timestamps.
   - Preserve the original activation snapshot rather than redrawing historical intent from current data.

## Phase 2 completion boundary

Phase 2 is complete when evaluation is deterministic, versioned, idempotent, reviewable, and backed by completed market data; outcome records never rewrite activation snapshots; users can see what was evaluated and why; and accuracy/calibration views faithfully include uncertainty and sample size.

Broker connections, order execution, AI-authored forecasts, social features, mentor mode, full backtesting, and bar replay remain outside this roadmap.
