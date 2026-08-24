# Forecast Evaluation Ruleset v1

Status: frozen for Northstar Phase 2A
Ruleset version: `forecast-evaluation-ruleset-v1`
Evaluator version: `forecast-evaluator-1.0.0`

This document is the normative forecast-outcome policy. The machine-readable companion is `analysis/config/forecast-evaluation-ruleset-v1.json`. Changes that alter a decision, eligibility rule, precedence rule, or fingerprint input require a new ruleset version. An evaluator run always records both versions.

## Architecture and trust boundary

The pure evaluator belongs to the Python `analysis` domain because that domain already owns the frozen `Bar` contract, Yahoo OHLCV normalization, corporate-action flags, and completed-bar availability semantics. The evaluator has no clock, network, database, or HTTP access. It receives an immutable forecast input, normalized ordered daily observations, an explicit cutoff, and an explicit coverage proof.

The internal Python evaluation service fetches provider data and builds the coverage proof. The TypeScript web service loads the saved profile-owned forecast, sends only those server-loaded immutable terms to the internal service, validates the returned contract, and atomically persists it in D1. The public browser endpoint accepts a forecast ID only; browser-supplied OHLC data is never evaluated.

## Immutable forecast input

Evaluation uses only these saved activation fields:

- forecast ID, symbol, status, and direction;
- `activated_at` and activation market-data `as of`;
- activation price and currency;
- the original point target or complete target range;
- the original optional invalidation price;
- the original date-only evaluation horizon.

The activation cutoff is the later of `activated_at` and the activation market-data timestamp. This prevents information already available at commitment time from being scored as a later outcome. Drafts, cancelled forecasts, and existing terminal forecasts are rejected by lifecycle orchestration and are not evaluator inputs.

## Observation and availability contract

Ruleset v1 evaluates normalized `1d` bars only. Each observation contains symbol, market date/timestamp, `completed_at`, market timezone, OHLC, non-negative volume, provider, adjustment mode, completion flag, and corporate-action flags. The trusted provider batch also declares its verified currency when available. Prices must be finite and positive, `low <= open <= high`, `low <= close <= high`, and observations must be strictly increasing and unique. Symbol, timeframe, provider, timezone, and adjustment mode must be consistent across the sequence.

Northstar retains the analysis engine's conservative completion rule: a Yahoo daily candle becomes available at the next local midnight in the market timezone, not at the nominal exchange close. An observation is eligible only when all of the following hold:

1. it is marked complete;
2. `completed_at` is later than the activation cutoff;
3. `completed_at` is at or before the explicit evaluation cutoff;
4. its market date is at or before the saved evaluation date.

A candle labelled before activation may therefore be eligible if it did not become available until afterward. Bars unavailable at the evaluation cutoff and future bars are ignored and are not included in the decision fingerprint. No browser quote, sparkline point, or live candle can substitute for normalized completed OHLC.

The evaluator input contains normalized completed bars only. Explicitly incomplete bars are rejected rather than silently filtered, `completed_at` values must be strictly increasing, and each daily `completed_at` must equal the next local midnight in the declared market timezone. Malformed domain input raises a typed contract error. Provider absence or an inability to prove coverage is not converted into fabricated terminal certainty.

## Touch and boundary rules

Touches use inclusive wick comparisons. Equality counts. Northstar does not silently switch to close-only triggers.

- Bullish point target: `high >= target`.
- Bullish target range: entry occurs at the stored lower edge; the full range remains in evidence.
- Bullish invalidation: `low <= invalidation`.
- Bearish point target: `low <= target`.
- Bearish target range: entry occurs at the stored upper edge; the full range remains in evidence.
- Bearish invalidation: `high >= invalidation`.

If the forecast has no invalidation price, no invalidation decision is inferred.

The first terminal event in chronological bar order wins. Target followed by invalidation on a later bar remains `target_hit`; invalidation followed by target remains `invalidated`.

Before accepting a candidate target, invalidation, or collision on a later bar, the evaluator proves that every expected exchange session whose conservative availability time has passed from activation through that candidate session has a corresponding completed observation. An unsupported calendar, partial provider response, missing earlier session, or candidate bar outside the expected calendar path returns `needs_review` with `insufficient_observation_path_coverage`. Expected sessions after the candidate bar do not block the already proven event.

## Intrabar ambiguity and gaps

OHLC does not reveal intrabar path. If target and invalidation are both touched in one bar and neither is proven at the open, the result is `needs_review` with `same_bar_target_invalidation_collision`. The complete bar is retained as triggering evidence. The same rule applies on the final horizon bar.

If a bar opens beyond exactly one terminal boundary, that boundary is proven at the open and wins even if the opposite boundary is touched later in the same bar. Evidence records the observed open, the crossed boundary, and `detected_at: open`; it never claims execution at the boundary price. A boundary first detected by high or low records `detected_at: within_bar`.

Phase 2A does not fetch finer-resolution data to resolve collisions and does not support human overrides. Acknowledgement preserves the automated result without rewriting it.

## Expiry and coverage

On the last eligible horizon observation, Northstar applies this precedence:

1. same-bar ambiguity;
2. target;
3. invalidation;
4. expiry only when neither boundary was touched.

Passing a calendar date is not proof of expiry. Expiry requires a deterministic coverage proof containing the exchange calendar identity/version, all expected sessions after activation through the horizon, the final expected session and its conservative availability time, and any missing sessions. The cutoff must be at or after the final expected session's availability time, and every expected session must have a corresponding completed observation. Weekends and holidays are handled by the calendar, not a hand-maintained holiday list.

Coverage findings distinguish expected sessions already available at the explicit cutoff from future sessions whose conservative availability time has not arrived. Only missing available sessions count as coverage gaps. If the exchange calendar is unsupported, history is truncated, an available session is missing, the provider is partial, or the final bar is not yet available, the evaluator returns `needs_review` with `insufficient_horizon_coverage` once the horizon should be reviewable. Before that point it returns `no_change` with `horizon_not_complete`.

Ruleset v1's live adapter supports only exchanges that can be mapped explicitly to its installed calendar. It never assumes a US calendar merely from a ticker spelling. A boundary touch can be accepted without complete future horizon coverage, but only after the observation path through its own session is proven complete.

## Corporate actions and adjustment modes

Activation values and evaluated bars must remain comparable. Ruleset v1 supports raw prices because Phase 1 activation snapshots are raw. Any adjustment-mode mismatch returns `needs_review` with `adjustment_mode_mismatch`.

The trusted observation currency must equal the saved activation currency before price scoring. A verified mismatch returns `needs_review` with `currency_mismatch`; unavailable currency metadata returns `needs_review` with `currency_unverified`. Both remain durable evaluator decisions rather than being represented as transient provider failures. Activation and observed currencies are included in result evidence and the fingerprint.

Corporate actions are processed chronologically with price evidence. A split flag or an explicit `corporate_action_metadata_incomplete` flag on the current bar returns `needs_review` with `corporate_action_price_discontinuity` before that bar's price touches are interpreted. A terminal event proven on an earlier bar therefore remains terminal even if a later bar contains a split. Northstar does not have a frozen split ratio and cannot safely restate the activation price or forecast levels. A split-like move with no metadata is not guessed from price magnitude, while explicitly incomplete metadata blocks scoring rather than being reduced to a warning. Ordinary dividend flags are recorded as warnings but do not by themselves make raw prices incomparable.

## Neutral forecasts

Phase 1 requires a neutral target range containing the activation price and permits only one optional invalidation price outside that range. It does not store a two-sided expected-range breach policy or define whether ending inside the range constitutes `target_hit`. Phase 2A therefore returns `needs_review` with `neutral_policy_unsupported` for every active neutral forecast. It does not reinterpret range entry as success or assign a directional meaning.

## Result contract and fingerprint

Every valid evaluation returns exactly one of `no_change`, `target_hit`, `invalidated`, `expired`, or `needs_review`, plus a stable reason code and explanation. Evidence includes evaluator/ruleset versions, forecast ID, cutoff, observation count, first and last eligible observations, evaluated-through market date, triggering observation when applicable, target and invalidation boundaries, detection mode, corporate-action and coverage findings, and warnings.

The evaluator computes SHA-256 over canonical JSON containing the normalized immutable forecast terms, eligible observations, and decision-relevant coverage state. The raw cutoff is preserved in result evidence but is not hashed directly. Instead, the hash records the latest eligible `completed_at`, available expected sessions, missing available sessions, and whether the horizon is reviewable. Advancing the cutoff without crossing one of those milestones therefore preserves idempotency. The hash excludes secrets, HTTP metadata, current time, unavailable/future observations, and provider response blobs. Replaying the same valid logical input produces the same result and fingerprint.

## Lifecycle mapping

- `target_hit`, `invalidated`, and `expired` may atomically transition an active forecast to the matching status.
- `no_change` stores an append-only run and leaves the forecast active.
- `needs_review` stores an append-only run, creates or refreshes an explicit review item, and leaves the forecast active.
- Proven terminal outcomes also create review items so the user can inspect and acknowledge them.
- Provider failure stores no fake evaluator run and makes no lifecycle change.

Evaluation runs are append-only and unique by forecast, evaluator version, ruleset version, and input fingerprint. A terminal transition, its lifecycle event, its evaluation run, and its review item are one D1 transaction. Concurrent stale or conflicting terminal decisions cannot both persist.
