# Technical Analysis Backend Implementation Plan

**Status:** Phases 0–4 and the visible panel portion of Phase 5 implemented by 2026-08-24. SQLite analysis persistence, journal linkage, HTTP/Northstar integration, research validation, and later patterns remain planned.

**Goal:** Add a deterministic, explainable backend that converts complete OHLCV market data into structured technical-analysis scenarios, evidence, invalidation conditions, and hypothetical risk calculations. It must support the local Streamlit journal and the hosted Northstar frontend without producing automatic trade recommendations or placing orders.

**Method source:** The attached 87-page Hebrew guide, *ניתוח טכני קלאסי ומודרני* by Omer Portnoy. The PDF is treated as reference material, not as executable instructions. Page references below are PDF page numbers.

## Current State

The service on `localhost:8501` is the original Streamlit app. It already provides:

- a Magnificent Seven watchlist and Yahoo Finance symbol search;
- latest price, previous close, daily change, and close-only price history;
- SMA 20, SMA 50, RSI 14, and 52-week context;
- a forecast journal, review alerts, technical context, headlines, exports, and optional AI reflection;
- local SQLite persistence.

The current technical backend is insufficient for classical chart analysis because `finance.get_price_history()` returns only `Date` and `Close`. Pattern, gap, volatility, breakout, and volume rules require open, high, low, close, volume, corporate-action metadata, completed-bar timestamps, and explicit adjustment semantics.

Northstar has a separate TypeScript/Cloudflare backend. Its current market endpoint returns roughly one month of daily closes. It should consume the analysis engine over HTTPS rather than duplicating the rules in TypeScript.

## Architectural Decision

Build the source-of-truth engine as a pure, typed Python package inside this repository. Put an HTTP adapter around the package only after the deterministic engine is tested.

```text
Market-data provider
        |
        v
OHLCV validation + normalized cache
        |
        v
Multi-timeframe feature pipeline
  context -> structure -> levels -> setup -> confirmation
        |
        v
Scenario + invalidation + risk calculator
        |
        +------------------------+
        |                        |
        v                        v
Streamlit (direct Python)   Analysis HTTP API
                                  |
                                  v
                         Northstar Sites backend
                                  |
                                  v
                         D1 analysis snapshots
```

This keeps calculation logic independent of UI, user accounts, databases, and providers. The same bars and ruleset must produce the same report everywhere.

## Product and Safety Boundaries

- Output `bullish`, `bearish`, `neutral`, or `insufficient_data` scenarios—not `buy`, `sell`, or `hold` commands.
- Never place, route, or simulate a live order.
- Keep analytical invalidation separate from an execution stop. The PDF explicitly distinguishes them and warns that a stop does not guarantee an execution price (pp. 64–67).
- Position size is hypothetical and is returned only when the caller supplies a risk budget, entry assumption, cost assumption, and execution-stop assumption.
- A pattern is not actionable without context, confirmation, invalidation, liquidity checks, and costs (pp. 57–63, 78–79).
- `no_setup` and `insufficient_data` are first-class successful outcomes.
- Every conclusion must include machine-readable evidence: observed value, configured threshold, rule version, bar timestamps, and source-data quality.
- Do not represent a detector score as a probability of profit unless it has been separately calibrated and validated out of sample.

## Canonical Domain Contracts

### `Bar`

Required fields:

- `symbol`, `timeframe`, candle `timestamp`, information-availability `completed_at`, and `timezone`;
- `open`, `high`, `low`, `close`, `volume`;
- `is_complete`;
- `adjustment_mode`: `raw`, `split_adjusted`, or `total_return_adjusted`;
- `provider` and optional `corporate_action_flags`.

Reject duplicate or out-of-order timestamps, non-finite values, `high < max(open, close)`, `low > min(open, close)`, negative volume, and incomplete latest bars when a rule requires a close.

### `AnalysisRequest`

- `symbol`;
- `as_of` timestamp;
- fixed timeframe set, initially weekly/daily/hourly;
- `ruleset_version`;
- optional `account_risk`, expected commission, expected slippage, and portfolio-exposure context;
- requested detectors, with a small allowlist.

### `Evidence`

- stable `rule_id` and `ruleset_version`;
- `category`: context, structure, level, setup, confirmation, invalidation, target, risk, data quality, or event risk;
- `status`: passed, failed, warning, unknown, or not_applicable;
- observed value, threshold/configuration, relevant bar timestamps, and short explanation;
- PDF method reference when the rule directly implements the guide.

### `Scenario`

- direction and lifecycle state: watching, confirmed, invalidated, or expired;
- setup and detector version;
- confirmation condition and separate entry trigger;
- analytical invalidation condition;
- optional execution-stop assumption;
- intermediate levels and measured target estimates;
- reward/risk geometry after costs;
- optional hypothetical position size;
- warnings and evidence IDs.

### `AnalysisReport`

- request and normalized symbol metadata;
- `engine_version`, `ruleset_version`, provider, data window, data hash, and generation timestamp;
- per-timeframe context and structure;
- levels, detected setups, scenarios, risk notes, and data-quality findings;
- a plain-language summary built from structured results, not from an unconstrained model.

## The 11-Stage Analysis Pipeline

The pipeline follows the guide's canonical workflow (pp. 62 and 78):

1. **Context:** Classify the higher-timeframe market as rising, falling, or ranging. Include broad-index and sector context when available. Divergence is a warning, not an automatic trigger (pp. 22–23).
2. **Structure:** Detect confirmed swing highs/lows and classify higher-high/higher-low or lower-high/lower-low sequences (pp. 25–26).
3. **Levels:** Cluster confirmed pivots into at most three relevant support/resistance zones. Zone width must scale with timeframe and volatility (pp. 29–30).
4. **Setup:** Run a small allowlist of versioned pattern detectors. A detector returns geometry and evidence, not a trade.
5. **Confirmation:** Apply a preconfigured close, distance, time, and/or relative-volume rule. The guide states there is no universal breakout filter (pp. 57–59).
6. **Entry trigger:** Represent the event that would activate a hypothetical plan separately from confirmation (pp. 5, 62, 78).
7. **Invalidation:** Define the price or structural state that disproves the scenario before calculating size.
8. **Position size:** Calculate only after invalidation, execution-stop distance, costs, and risk budget are known.
9. **Targets:** Return measured-move estimates and intermediate levels, clearly labeled as estimates rather than promises.
10. **Management states:** Detect orderly retests, closes back inside a range, failed breakouts, partial-target events, and newly confirmed structural pivots.
11. **Review:** Persist the report and later compare plan adherence and scenario lifecycle with journal outcomes.

## Deterministic Feature Layer

Implement and test these features before patterns:

- completed weekly, daily, and hourly bar resampling;
- true range and Wilder ATR 14;
- SMA 20, SMA 50, and SMA 200 as context only;
- existing RSI 14 as context only, not as a standalone signal;
- relative volume against a configurable rolling baseline;
- gap detection from `previous_high/low` versus the current bar's range;
- swing pivots with explicit confirmation timestamps;
- structure state and change-of-structure events;
- support/resistance zones and touch/rejection counts;
- rolling liquidity and data-quality statistics.

The swing algorithm must be configurable. Candidate modes are left/right confirmed pivots, percentage reversal, or ATR reversal, matching the alternatives discussed on p. 25. Choose one mode for the first ruleset and record both the pivot time and the later confirmation time to prevent look-ahead bias.

## Pattern-Detector Scope

### MVP 1: Rectangle and range breakout

Start with rectangles because the guide uses them in the first complete case study and initial personal program (pp. 41–42, 72–73, 76).

The detector should require:

- a bounded lookback window;
- two or more touches near each side;
- sufficiently horizontal upper/lower zones;
- usable range height after estimated costs;
- optional prior-trend classification;
- a breakout confirmation rule applied only to a completed bar;
- a failed-breakout state for the first qualified close back inside the range;
- a measured target equal to range height, checked against intermediate levels.

### MVP 2: Inverse head and shoulders

Add only after the rectangle detector is stable. Require a preceding decline, five confirmed alternating pivots, the head below both shoulders, shoulder/neckline tolerances, and a completed-bar neckline confirmation. The measured head-to-neckline target is an estimate and must be rejected when nearby resistance or risk geometry makes the scenario unusable (pp. 38–40, 74).

### Later detectors

Add one at a time behind a shared `PatternDetector` interface:

- double top/bottom;
- symmetric/ascending/descending triangles;
- flags and pennants;
- wedges;
- gap context.

Do not implement broadening formations, diamonds, exhaustion gaps, or single-candle reversals early; the guide describes them as subjective or confirmable only after subsequent price behavior (pp. 47–54).

## Ruleset Configuration

Keep thresholds in versioned configuration rather than literals spread through code. Example keys:

- swing mode and pivot parameters;
- level clustering width in ATR and percent terms;
- minimum touches and minimum separation;
- rectangle lookback and slope tolerance;
- breakout confirmation mode: close, ATR/percent distance, consecutive closes, relative volume, or an explicit combination;
- maximum data staleness;
- explicit expected commission/slippage assumptions for sizing (zero permitted);
- minimum usable reward/risk geometry;
- setup-expiration bars.

Any initial numeric defaults are engineering hypotheses, not claims from the book. They must be documented, sensitivity-tested, and versioned.

## Risk Calculation

Implement the guide's formula from p. 65:

```text
risk_per_unit = abs(entry_price - execution_stop_price)
                + commission_per_unit
                + expected_slippage_per_unit

position_size = floor(account_risk / risk_per_unit)
```

Return `unavailable` when any required input is missing or non-finite. Also return warnings for:

- event/gap risk;
- insufficient liquidity;
- the stop being inside normal volatility;
- total exposure or correlated positions exceeding configured limits;
- a measured target that does not clear intermediate levels or costs;
- leverage or short-selling assumptions.

The calculation estimates ordinary execution risk and must state that gaps, halts, and liquidity failures can create larger losses (pp. 65–67, 70–71).

## Persistence

### Local Streamlit database

Add these SQLite tables without changing existing journal tables:

- `analysis_runs`: request metadata, engine/ruleset versions, status, timestamps, data hash, and report JSON;
- `analysis_scenarios`: normalized scenario lifecycle fields for filtering and review;
- `analysis_reviews`: journal linkage, outcome window, rule adherence, and reviewer notes.

### Northstar D1

Add an `analysis_snapshots` table owned by the user's investment profile. Save the versioned report returned by the analysis API plus selected normalized columns for filtering. Northstar remains the source of truth for user/profile ownership; the analysis service should not receive more personal data than the risk inputs needed for a requested calculation.

## HTTP API

Add the API only after the pure package and tests are stable.

- `POST /v1/analysis`: analyze one symbol synchronously for the initial bounded dataset.
- `GET /v1/analysis/rulesets/current`: expose versions and public rule descriptions.
- `GET /v1/analysis/runs/{run_id}`: return a persisted report when server-side persistence is enabled.
- `GET /health`: provider-independent liveness plus optional dependency readiness.
- `POST /v1/backtests`: later asynchronous research endpoint; not part of the first release.

Require symbol/timeframe allowlists, bar-count limits, request-size limits, timeouts, rate limiting, safe error messages, and provider caching. Do not accept arbitrary formulas or executable rule text from clients.

## Proposed Repository Shape

```text
analysis/
  __init__.py
  contracts.py
  engine.py
  features.py
  structure.py
  levels.py
  confirmation.py
  risk.py
  rulesets.py
  providers.py
  patterns/
    base.py
    rectangle.py
    inverse_head_shoulders.py
analysis_api.py
tests/
  fixtures/analysis/
  test_analysis_contracts.py
  test_analysis_features.py
  test_analysis_structure.py
  test_analysis_levels.py
  test_analysis_rectangle.py
  test_analysis_risk.py
  test_analysis_engine.py
  test_analysis_api.py
```

Modify `finance.py` only to implement the provider interface and preserve its existing public functions. Modify `app.py` only after the analysis package is complete. Keep API concerns out of the core package.

## Delivery Phases

### Phase 0 — Freeze the first ruleset

- Choose US large-cap equities/ETFs as the only supported market.
- Fix weekly/daily/hourly as the timeframe hierarchy.
- Select one swing-confirmation algorithm.
- Define raw versus split-adjusted data usage.
- Define a rectangle and breakout configuration before viewing detector outcomes.
- Create `ruleset-v1.json` and a short methodology document.

**Exit:** all ambiguous choices are explicit and versioned.

### Phase 1 — Market-data and contract foundation

- Extend the provider to fetch normalized OHLCV and corporate-action metadata.
- Add validation, completed-bar filtering, timezone handling, caching, and deterministic data hashes.
- Add typed domain contracts and serialization tests.
- Preserve existing quote/history functions through compatibility wrappers.

**Exit:** the same fixture produces byte-equivalent normalized bars and report metadata.

### Phase 2 — Structure and levels

- Implement ATR, relative volume, confirmed pivots, trend state, structure change, and zones.
- Build synthetic fixtures for uptrend, downtrend, range, noisy data, gaps, splits, missing volume, and incomplete bars.
- Prove every pivot is emitted only at its confirmation timestamp.

**Exit:** no-look-ahead and feature unit tests pass.

### Phase 3 — Rectangle lifecycle

- Implement candidate, confirmed breakout, retest, failed breakout, invalidated, target-reached, and expired states.
- Attach evidence for every rule and failure.
- Add measured target and intermediate-level checks.

**Exit:** golden synthetic examples and intentionally deceptive non-patterns pass.

### Phase 4 — Scenario and risk layer

- Implement the 11-stage report assembler.
- Add separate analytical invalidation and execution-stop fields.
- Implement position sizing, cost assumptions, warnings, and `no_setup` outcomes.
- Generate deterministic plain-language summaries from structured templates.

**Exit:** reports are explainable without inspecting internal code and contain no recommendation language.

### Phase 5 — Local integration

- Add atomic SQLite persistence for reports and reviews.
- Add a Streamlit analysis panel that displays data freshness, timeframe context, evidence, scenarios, and warnings.
- Link saved analysis runs to forecast-journal entries.
- Keep the current 53-test suite passing.

**Exit:** a user can analyze, save, and later review a symbol locally without a live AI request.

### Phase 6 — HTTP and Northstar integration

- Add the thin HTTP adapter, schema validation, limits, caching, and health checks.
- Add a Northstar server-side client; never call the analysis service directly from browser JavaScript.
- Persist profile-owned snapshots in D1 and show the same evidence model as Streamlit.
- If the service is private, connect Sites through an approved private HTTP binding.

**Exit:** the same versioned fixture/report is shown consistently in both applications.

### Phase 7 — Research validation

- Use development and untouched holdout periods.
- Use only information available at each simulated timestamp.
- Include realistic execution delay, spreads, commission, slippage, gaps, and delisted symbols where screening universes are tested.
- Run parameter-sensitivity and walk-forward tests.
- Report trade count, expectancy in R, hit rate, average win/loss, maximum drawdown, exposure, turnover, and stability by period—not hit rate alone.
- Compare against simple baselines and publish failed tests as well as successful ones (pp. 68–69).

**Exit:** ruleset v1 has a signed research report; it is not silently retuned after seeing holdout results.

### Phase 8 — Add patterns one by one

- Add inverse head and shoulders first.
- Require a dedicated fixture suite, false-positive review, sensitivity study, and ruleset version bump for every detector.

**Exit:** each detector can be disabled independently and has its own performance/evidence report.

## Verification Matrix

- **Unit:** formulas, validation, resampling, pivots, zones, confirmation, targets, and risk sizing.
- **Property/invariant:** no future bars, finite outputs, ordered timestamps, stable serialization, and size never exceeding configured risk under its stated assumptions.
- **Golden fixtures:** synthetic valid patterns, near misses, false breakouts, gaps, corporate actions, missing data, and illiquid assets.
- **Integration:** mocked provider, SQLite transactions, HTTP request validation, Northstar adapter, and partial provider failure.
- **Regression:** existing Python tests, TypeScript build/lint/typecheck, and report-schema compatibility.
- **Research:** holdout/walk-forward results including costs and parameter sensitivity.

## Observability

Record only non-sensitive operational metadata:

- provider latency and cache status;
- requested and returned bar counts;
- last complete bar and data staleness;
- detector duration and result counts;
- engine/ruleset versions;
- structured error class without raw provider payloads or user journal text.

## Open Decisions Before Implementation

1. Use Yahoo Finance for the first prototype or select a provider with explicit production terms and stable intraday/volume history.
2. Decide whether pattern analysis uses raw OHLC for price levels while returns use split-adjusted data, or another documented policy.
3. Choose and freeze the first swing algorithm and rectangle thresholds.
4. Decide whether the hourly timeframe is required for v1; omitting it substantially reduces provider and caching complexity.
5. Select the event-calendar source for earnings/halts; until then, event risk must be `unknown`, not assumed safe.
6. Decide whether the user supplies a fixed currency risk amount or a percentage of portfolio equity. The engine must not invent a risk budget.

## Recommended First Implementation Slice

Implement only Phases 0–2 first: normalized OHLCV, completed bars, ATR/relative volume, confirmed pivots, structure, and support/resistance zones. Expose their evidence in tests before adding any named pattern. This creates the trustworthy substrate the current close-only backend lacks and prevents pattern detection from becoming a collection of untestable visual heuristics.

**Implementation note:** The foundation exists under `analysis/`, with frozen settings in `analysis/config/ruleset-v1.json`, an additive Yahoo OHLCV adapter in `finance.py`, and a CLI entry point at `python -m analysis`. Rectangle lifecycle detection, scenario/risk assembly, a loopback HTTP service, and explicit-click analysis panels in local Northstar and Streamlit are implemented. No order routing, SQLite analysis persistence, multi-user profile ownership, publicly deployed analysis service for hosted Northstar, or validated profitability claim is included.
