# Forecasts Phase 1

Northstar Forecasts turns a free-text market note into a structured prediction that can eventually be evaluated. A forecast records what the user expected, the evidence available at the time, what would invalidate the idea, and when it should be reviewed. It remains a journaling and accountability tool: Northstar does not create forecasts, recommend trades, or execute orders.

This document describes the immutable Phase 1 foundation. Phase 2A now adds explicit, manual completed-bar evaluation without changing that activation contract. See [`forecast-evaluation-phase-2a.md`](forecast-evaluation-phase-2a.md).

## Domain model

Every forecast belongs to the current investment profile and may use only a symbol already saved as a position or watchlist item for that profile. The core record contains:

- a stable ID, profile owner, symbol, and optional saved technical-analysis snapshot;
- direction: `bullish`, `bearish`, or `neutral`;
- confidence from 0 through 100;
- thesis, supporting evidence, counter-evidence, and a setup or strategy tag;
- a date-only evaluation date;
- either a point target or an ordered target range;
- an optional invalidation price;
- status and creation, update, activation, market-data `as of`, and resolution timestamps;
- the server-verified activation price, currency, provider timestamp, and resolution reason when applicable.

The browser treats the evaluation date as a local calendar date. It does not convert a `YYYY-MM-DD` value through UTC before displaying it. On activation the browser supplies its IANA time-zone name, and the server derives the current calendar date for that zone before checking the evaluation horizon; it does not trust a client-supplied date string. Activation and provider `as of` values are absolute timestamps displayed in the user's local time and labeled as provider data. A completed-bar analysis `as of` value remains a separate timestamp inside the immutable analysis snapshot; it is not presented as the quote time.

Forecast values must be finite and within their documented bounds. Point and range targets are validated structurally while editing, target and invalidation must be coherent, and neutral forecasts require a range rather than a point target. Activation then validates the committed geometry against the newly captured market price:

- a bullish target's minimum must be above the activation price, with any invalidation below it;
- a bearish target's maximum must be below the activation price, with any invalidation above it;
- a neutral target range must contain the activation price inclusively, with any invalidation strictly outside the range.

The server repeats all validation and ownership checks; browser validation is only a convenience.

## Lifecycle

The persisted lifecycle is:

```text
draft -> active -> cancelled
                  target_hit    (written by the Phase 2A evaluator)
                  invalidated   (written by the Phase 2A evaluator)
                  expired       (written by the Phase 2A evaluator)
```

Phase 1 implements these user-driven transitions:

- **Create draft:** save a forecast for a tracked symbol.
- **Edit draft:** change the structured fields before making a commitment.
- **Delete draft:** permanently remove an unactivated draft.
- **Activate:** explicitly confirm the forecast, capture a fresh server-side quote, and freeze the committed forecast.
- **Cancel active forecast:** close an active forecast with a required reason. Cancellation is not a correctness judgment.
- **Add amendment or review note:** add context without changing the activated forecast.

No Phase 1 process marks a forecast `target_hit`, `invalidated`, or `expired`. The manual Phase 2A evaluator can now write those terminal states from trusted completed-bar evidence. It preserves the same immutable activated record and appends a versioned evaluation run and audit event.

Unsupported transitions fail on the server. An active forecast cannot return to draft, be deleted, or have its original fields replaced.

## Immutability and audit history

Drafts are working records. Activation is the accountability boundary.

When a user activates a forecast, Northstar fetches a fresh, non-cached quote on the server. Activation stores the exact forecast fields, market price, quote currency, and provider timestamp that were present at that moment. The activated record is then immutable. A later quote, analysis refresh, form submission, or note cannot silently rewrite it.

Meaningful actions also create append-only events:

- `draft_created`
- `draft_updated`
- `activated`
- `cancelled`
- `amendment`
- `review_note`
- `evaluated` (Phase 2A)
- `evaluation_review_acknowledged` (Phase 2A)

Draft update events preserve the change history leading up to activation. Amendments and review notes after activation preserve later reasoning separately from the original commitment. They are not edits to the thesis, confidence, target, horizon, invalidation, activation quote, or analysis snapshot.

## Persistence and migrations

Northstar uses three profile-owned D1 tables for the Phase 1 domain:

- `forecasts` stores the structured draft and its immutable activation/resolution fields;
- `forecast_events` stores ordered append-only revisions;
- `analysis_snapshots` stores at most one complete activation-time technical-analysis snapshot per forecast.

The Drizzle schema, generated migration, and idempotent runtime database initialization describe the same columns, constraints, foreign keys, and indexes. Runtime initialization uses additive `IF NOT EXISTS` operations and may be called repeatedly without replacing an existing forecast or duplicating an event or snapshot. Draft deletion cascades to its events; after activation the API does not expose deletion.

## Technical-analysis snapshots

A completed-bar technical-analysis scenario can seed the create form. Prefill is assistance, not endorsement: the user must review and confirm every forecast field, and a manual forecast remains available when there is no qualifying scenario. The bounded source report and selected scenario are stored with the draft so the link survives a reload; they remain pending evidence until activation.

When a linked draft is activated, Northstar validates the pending report again and materializes an immutable snapshot owned by the same profile. It retains normalized fields for display and filtering and the complete machine-readable report, including its generation time, market-data `as of` time, provider, adjustment mode, engine and ruleset versions, scenario ID, lifecycle state, direction, range geometry, measured target, evidence, and warnings.

The snapshot represents information available at activation. Refreshing the analysis later creates new browser state; it does not rewrite a snapshot linked to an active forecast.

## HTTP API

Forecasts use a dedicated API rather than the general workspace action endpoint. All record lookups and mutations are scoped to the resolved profile.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/forecasts` | List forecasts with optional status and symbol filters. |
| `POST` | `/api/forecasts` | Create a draft. |
| `GET` | `/api/forecasts/:id` | Read forecast details and audit history. |
| `PATCH` | `/api/forecasts/:id` | Update a draft. |
| `DELETE` | `/api/forecasts/:id` | Delete a draft. |
| `POST` | `/api/forecasts/:id/activate` | Confirm and activate with a fresh server quote. |
| `POST` | `/api/forecasts/:id/cancel` | Cancel an active forecast with a required reason. |
| `POST` | `/api/forecasts/:id/notes` | Append an amendment or review note. |

List filters use exact normalized values, for example `/api/forecasts?status=active&symbol=NVDA`. A note request identifies its kind as `amendment` or `review_note`; both are append-only.

Requests with invalid values, untracked symbols, wrong-profile records, or illegal transitions are rejected. Provider and database failures return safe messages; internal logs retain diagnostic context without returning provider payloads, credentials, or unnecessary implementation details.

## Run locally

Requirements and initial installation are documented in the repository [README](../README.md). From the repository root, start the Python completed-bar analysis service and Northstar together:

```bash
./scripts/run-northstar-local.sh
```

Open [http://localhost:8501](http://localhost:8501), add a real position or watchlist symbol if the portfolio is empty, and select **Forecasts**. A practical Phase 1 check is:

1. Create a draft for the tracked symbol.
2. Leave and return to Forecasts, then edit the draft.
3. Activate it after reading the freeze confirmation.
4. Confirm that the activation price and provider time are visible and the original fields are locked.
5. Add a review note and confirm that the original forecast remains unchanged.
6. Cancel the forecast with a reason and inspect its event history.

Creating and editing drafts does not require live market data. Activation does: if the provider cannot supply a valid fresh quote, Northstar reports that activation is unavailable and leaves the draft intact.

## Verification

Use the verified Python environment or activate an equivalent Python 3.11+ environment. From the repository root:

```bash
.venv312/bin/python -m unittest discover -v
.venv312/bin/python -m compileall -q app.py ai.py analysis db.py finance.py indicators.py journal.py models.py news.py tests
cd market-monitor-web
npm test
npm run lint
npm run build
```

Tests mock Yahoo Finance and OpenAI. They must not depend on a live provider or create production data.

## Authentication and deployment boundary

Northstar currently resolves a single fixed local profile through a centralized profile resolver. This removes scattered profile constants and gives forecast repositories and services a clear seam for future authenticated profile IDs, but it is not authentication.

The current application is not safe for public multi-user deployment. Before exposing Northstar to multiple users, every request must be tied to an authenticated principal, profiles must be provisioned per user, and tenant isolation must be verified across reads, writes, market access, forecast events, and analysis snapshots. A hosted analysis service must also be deployed separately over HTTPS; loopback addresses are local-only.

## Current limitations

The Phase 1 foundation itself does not include:

- automatic target-hit, invalidation, expiry, or correctness evaluation;
- outcome records, accuracy statistics, confidence calibration, or a review queue;
- background quote polling or alert delivery;
- broker integration, order execution, personalized financial advice, or AI-generated forecasts;
- full authentication, billing, collaboration, backtesting, or a replacement charting system.

Those evaluation contracts now exist in Phase 2A, but evaluation remains an explicit one-forecast action. Background scheduling, delivery, global analytics, authentication, and multi-user isolation remain absent. See the [Phase 2A evaluation guide](forecast-evaluation-phase-2a.md) and [Phase 2 roadmap](phase-2-roadmap.md).
