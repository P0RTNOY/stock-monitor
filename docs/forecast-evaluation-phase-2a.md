# Forecast Evaluation Phase 2A

Phase 2A adds deterministic, evidence-backed evaluation to Northstar's immutable forecasts. Evaluation is deliberately manual: a user chooses an active forecast, confirms **Evaluate now**, and reviews the durable result. Northstar does not poll forecasts in the background, infer results from browser quotes, or let a reviewer rewrite an automated decision.

The normative decision policy is [`forecast-evaluation-ruleset-v1.md`](forecast-evaluation-ruleset-v1.md). Its machine-readable companion is `analysis/config/forecast-evaluation-ruleset-v1.json`.

| Contract | Version |
| --- | --- |
| Evaluator | `forecast-evaluator-1.0.0` |
| Ruleset | `forecast-evaluation-ruleset-v1` |
| Timeframe | Completed raw `1d` bars |

## Architecture and language decision

The evaluator is implemented in Python inside the existing `analysis` domain. That domain already owns normalized OHLCV bars, corporate-action flags, Yahoo provider normalization, and the conservative completed-bar availability rule. Keeping the decision engine there avoids creating a second market-data interpretation in TypeScript.

The pure Python evaluator has no network, clock, HTTP, or database access. It accepts immutable forecast terms, ordered normalized observations, an explicit evaluation cutoff, a versioned ruleset, and an exchange-session coverage proof. The surrounding Python service fetches provider data and constructs that proof.

Northstar's TypeScript server remains the owner of profile isolation, lifecycle orchestration, public HTTP contracts, strict validation of the Python response, and D1 persistence.

```text
Browser: forecast ID only
        |
        v
Northstar TypeScript server
  loads the profile-owned immutable activation terms
        |
        v
Internal Python /v1/evaluate
  fetches trusted data -> proves coverage -> runs pure evaluator
        |
        v
Northstar validates the exact versioned result
        |
        v
D1 atomic batch -> forecast lifecycle + run + event + review item
```

Browser-supplied OHLC, targets, cutoffs, currencies, or evaluator results are never trusted. The public evaluation request cannot replace the frozen activation snapshot.

## Provider boundary

The live adapter requests a bounded activation-to-current-cutoff raw daily-history range from Yahoo Finance with actions and metadata enabled. It uses a 10-second provider timeout. The 740-day provider bound applies to elapsed history through the earlier of the current cutoff and evaluation date; a distant future evaluation date is not rejected merely because the full forecast horizon is long. The adapter requires valid market timezone and exchange metadata, preserves missing currency as unverified rather than guessing it, and maps only known exchange identifiers to a supported calendar.

Phase 2A explicitly supports the XASE, XNAS, and XNYS exchange calendars. An unknown Yahoo exchange remains explicitly named and unsupported; Northstar does not silently assign it a US calendar. When a decision depends on that unsupported coverage, the evaluator returns `needs_review` rather than a terminal claim. Provider absence, malformed OHLC or metadata, an empty completed history, or an unreachable Python service returns a safe unavailable error. No evaluator run, review item, lifecycle event, or forecast transition is fabricated for a transient provider failure.

The provider is a market-data source, not the decision authority. Its response is normalized into the frozen bar and coverage contracts before the pure evaluator sees it.

## Ruleset and completed-bar availability

An evaluation uses only fields frozen at activation: forecast ID and symbol, direction, activation and market-data timestamps, activation price and currency, point target or complete target range, optional invalidation, and evaluation date. The activation cutoff is the later of the activation timestamp and quote-provider `as of` timestamp.

A daily observation is eligible only when it is marked complete, became available after the activation cutoff, became available no later than the explicit evaluation cutoff, and has a market date no later than the saved evaluation date. For Yahoo daily data, Phase 2A conservatively treats a candle as available at the next midnight in the market timezone. A bar with an earlier market label may therefore be eligible if it did not become available until after activation.

Incomplete bars are rejected rather than silently scored. Eligible observations must be positive, finite, internally valid OHLC, strictly ordered and unique, and consistent in symbol, timeframe, provider, timezone, and adjustment mode. A live candle, current quote, sparkline point, or browser history cannot substitute for a completed observation.

Any change that affects eligibility, precedence, fingerprint inputs, or a decision requires a new ruleset version. Every stored run records both evaluator and ruleset versions.

## Targets, ranges, and touches

Equality counts as a touch, and Phase 2A uses inclusive wicks rather than close-only triggers:

- bullish point target: `high >= target`;
- bullish range: target entry is the saved lower edge, while the full range remains in evidence;
- bullish invalidation: `low <= invalidation`;
- bearish point target: `low <= target`;
- bearish range: target entry is the saved upper edge, while the full range remains in evidence;
- bearish invalidation: `high >= invalidation`.

No invalidation result is invented when the forecast has no invalidation price. Bars are processed chronologically, and the first proven terminal event wins.

### Gaps and same-bar collisions

OHLC does not prove the path taken inside a bar. If target and invalidation are both touched in one bar and neither is already proven by the open, the result is `needs_review` with `same_bar_target_invalidation_collision`. The triggering bar is preserved, but Northstar does not guess which boundary came first.

If the bar opens beyond exactly one terminal boundary, that boundary is proven at the open and wins even if the opposite boundary is touched later in the bar. Evidence records the observed open, crossed boundary, and detection mode; it does not claim that an order executed at the boundary price. Phase 2A does not fetch intraday data to resolve a collision.

## Prefix coverage, expiry, and calendars

A later boundary touch is trusted only if Northstar can prove completed-observation coverage for every expected exchange session available from activation through that candidate session. Missing earlier sessions, a partial provider response, an unsupported calendar, or a candidate outside the expected session path produces `needs_review` with `insufficient_observation_path_coverage`. Missing sessions after an already proven candidate do not undo that event.

Expiry requires stronger, full-horizon proof. Merely passing the evaluation date is insufficient. Northstar records the calendar identity and installed version, expected sessions through the horizon, final session and availability time, future sessions, missing available sessions, and provider completeness. Weekends and holidays come from the versioned exchange calendar.

Before the final expected session is available, a forecast with no terminal touch returns `no_change` with `horizon_not_complete`. Once the horizon should be reviewable, incomplete or unsupported coverage returns `needs_review` with `insufficient_horizon_coverage`. Only complete coverage through the horizon with no target or invalidation touch returns `expired`.

On the final eligible bar the precedence is:

1. unresolved same-bar collision;
2. target touch;
3. invalidation touch;
4. expiry.

## Corporate actions, currency, and neutral forecasts

Activation prices and Phase 2A observations are raw. An adjustment-mode mismatch produces `needs_review`; Northstar does not compare adjusted observations with raw saved levels.

The observation currency must be verified and equal the activation currency before price scoring. A verified difference produces `currency_mismatch`; missing currency metadata produces `currency_unverified`. Both are durable `needs_review` results with no fabricated trigger.

A split or explicitly incomplete corporate-action metadata blocks interpretation of that bar and returns `corporate_action_price_discontinuity`. Northstar does not have a frozen split ratio with which to restate the forecast. A terminal event proven on an earlier bar still wins before a later split is encountered. Dividend flags are retained as warnings but do not alone block raw-price comparison, and unflagged split-like movement is not guessed from price magnitude.

Phase 1 neutral forecasts do not store enough two-sided policy to define deterministic success or breach semantics. Every active neutral forecast therefore returns `needs_review` with `neutral_policy_unsupported`. Phase 2A does not reinterpret range entry as `target_hit`.

## Results, reasons, and evidence

Every successful evaluator call returns exactly one durable kind:

| Kind | Stable reasons | Lifecycle effect |
| --- | --- | --- |
| `no_change` | `no_terminal_boundary_touched`, `horizon_not_complete` | Store the run; leave active. |
| `target_hit` | `target_boundary_touched` | Transition to `target_hit`. |
| `invalidated` | `invalidation_boundary_touched` | Transition to `invalidated`. |
| `expired` | `horizon_complete_without_terminal_touch` | Transition to `expired`. |
| `needs_review` | collision, insufficient path/horizon coverage, corporate action, adjustment mode, currency, or neutral-policy reasons | Store the run and review item; leave active. |

Evidence records the versions, activation cutoff and currencies, first and last eligible observations, evaluated-through date, triggering bar when one exists, saved boundaries, detection mode, observed gap open, corporate-action findings, calendar/coverage proof, and warnings. The TypeScript boundary rejects unknown fields, wrong versions, contradictory reason/kind pairs, a mismatched forecast ID or cutoff, inconsistent currency evidence, invalid triggering bars, or evidence that differs from the saved forecast terms.

### Logical-input fingerprint

The evaluator computes SHA-256 over canonical JSON containing the immutable forecast terms, eligible observations, ruleset version, and decision-relevant coverage state. Secrets, HTTP metadata, current time, raw provider blobs, unavailable bars, and future bars are excluded.

The raw cutoff is recorded as evidence but is not directly hashed. Instead the fingerprint includes decision milestones: latest eligible completion, available and missing expected sessions, and whether the horizon is reviewable. Re-evaluating after wall-clock time passes but before new information becomes available therefore returns the same logical fingerprint and the stored run rather than creating duplicate history.

## Persistence, atomicity, and idempotency

Phase 2A adds two profile-owned D1 tables:

- `evaluation_runs` stores append-only versioned results, evidence, warnings, cutoff, evaluated-through date, and fingerprint;
- `forecast_review_items` links terminal or ambiguous runs into the Review Queue and records acknowledgement time.

The forecast event type constraint also adds `evaluated` and `evaluation_review_acknowledged`.

Runs are unique by forecast, evaluator version, ruleset version, and input fingerprint. An identical replay returns the existing run with `duplicate: true`. A different result for the same fingerprint is rejected as a conflict.

For a proven terminal result, the run insert, status/resolution update, `evaluated` event, and review item are one D1 batch. `needs_review` atomically stores its run and review item while leaving the forecast active. `no_change` stores only the run and leaves the forecast active. Optimistic checks against forecast update time and audit revision reject stale concurrent evaluation. Acknowledgement and its audit event are also atomic.

## API

All public reads and writes use the centralized profile resolver and preserve the fixed-profile limitation described below.

| Method | Path | Contract |
| --- | --- | --- |
| `POST` | `/api/forecasts/:id/evaluate` | Evaluate one active forecast. The body is empty or `{}`; bars, terms, cutoff, and result cannot be supplied by the browser. Returns the current forecast, stored evaluation run, and `duplicate` flag. |
| `GET` | `/api/forecasts/:id/evaluations/latest` | Load the latest persisted run for a profile-owned forecast, or `null` when it has never been evaluated. Query parameters are not accepted. |
| `GET` | `/api/forecast-reviews` | List unacknowledged review items by default. `includeAcknowledged=true` includes durable history. |
| `POST` | `/api/forecast-reviews/:id/acknowledge` | Requires `{ "confirmed": true }`; records acknowledgement only. |
| `POST` | internal `/v1/evaluate` | Versioned server-to-server Python contract containing server-loaded immutable terms and an explicit cutoff. Not a browser API. |

Only active forecasts are eligible. Wrong-profile and missing records are unavailable, non-active states return a conflict, invalid request fields fail safely, and provider unavailability returns a temporary-unavailable response without a stored result.

## Manual Review Queue

An active forecast exposes **Evaluate now** with a confirmation explaining that a proven result may create a terminal lifecycle event. The interface distinguishes pending evaluation, provider failure, a proven terminal result, ambiguous or insufficient evidence, and an already-stored duplicate. Active-forecast detail loads the latest persisted run, so `no_change` and active-state `needs_review` results remain visible after a reload rather than existing only as temporary button feedback. Terminal runs remain available through their Review Queue items and audit-linked forecast records.

The Review Queue contains every proven terminal result and every `needs_review` result. It does not contain `no_change` runs. Users can filter unacknowledged, acknowledged, or all items; inspect the triggering completed bar and warnings; and navigate to the immutable forecast, linked analysis snapshot, and audit history.

Acknowledgement means only “I reviewed this durable result.” It adds an append-only timestamp and event. It does not resolve an active forecast, change a result kind or reason, override evidence, reclassify a terminal forecast, or edit the original activation snapshot. Phase 2A has no manual override mechanism.

## Run and verify locally

The normal launcher starts both the Python service and Northstar:

```bash
./scripts/run-northstar-local.sh
```

Open [http://localhost:8501](http://localhost:8501), select **Forecasts**, open an active directional forecast, and choose **Evaluate now**. Provider access is required for a real evaluation. The Review Queue is on the same Forecasts workspace.

From the repository root, verification is:

```bash
.venv312/bin/python -m unittest discover -v
.venv312/bin/python -m compileall -q app.py ai.py analysis db.py finance.py indicators.py journal.py models.py news.py tests
cd market-monitor-web
npm test
npm run lint
npm run build
```

The automated evaluator tests use fixtures and mocked provider boundaries. TypeScript persistence tests use an in-memory SQLite D1-compatible adapter. They do not call live Yahoo Finance, mutate a remote Cloudflare D1 database, or perform a browser-level end-to-end test.

## Manual-only boundary and limitations

Phase 2A includes no scheduler, recurring monitor, background evaluator, due-forecast batch, email, push notification, webhook delivery, or alert delivery. Evaluation occurs only after explicit user confirmation for one active forecast.

It also does not include global accuracy dashboards, confidence-calibration analytics, a human outcome override, intraday collision resolution, split-level restatement, broad exchange-calendar coverage, broker integration, execution, personalized advice, AI-generated forecasts, full authentication, or multi-user isolation.

Northstar still uses a fixed local profile resolver and is not safe for public multi-user deployment. The implementation and automated suites have not verified a remote Cloudflare D1 migration/runtime or browser end-to-end behavior. Local builds and in-memory contract tests are meaningful verification, but they are not substitutes for those deployment checks.

The exact next slice is Phase 2B: a bounded, idempotent, operator-invoked due-forecast coordinator with injected time/provider dependencies and per-item failure isolation. It must be proven before adding any scheduler or delivery channel. See the [Phase 2 roadmap](phase-2-roadmap.md).
