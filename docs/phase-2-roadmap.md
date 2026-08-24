# Forecasts Phase 2 Roadmap

Phase 2 should make active forecasts measurable without weakening the immutable Phase 1 record. It should not broaden Northstar into trading automation, personalized advice, or AI-generated predictions.

## Exact starting point

Start with a pure, deterministic outcome-decision module and its fixture-based tests. Do not start with a scheduler or database mutation.

The first change should define an input contract containing one immutable active-forecast snapshot plus ordered, completed market observations, and an output contract containing exactly one of:

- `no_change`
- `target_hit`
- `invalidated`
- `expired`

The result must include the decisive observation, evaluation `as of` time, provider, rule version, and human-readable reason. Freeze and test rules for point targets, ranges, price gaps, evaluation-date boundaries, exchange calendars, missing data, and bars that touch both target and invalidation. Replaying the same input must always produce the same output.

This decision layer is the prerequisite for every other Phase 2 feature. It makes evaluation reviewable before background execution or persistence can hide mistakes.

## Recommended sequence

1. **Outcome decision contract and tests**
   - Implement the pure evaluator described above.
   - Use completed provider data and injected clocks only.
   - Add bullish, bearish, neutral, gap, missing-data, and same-bar precedence fixtures.

2. **Append-only outcome records**
   - Persist proposed and accepted evaluation results separately from the original forecast.
   - Record engine/rule version and the exact observation that caused the transition.
   - Make repeated evaluation idempotent and preserve an administrative correction trail.

3. **Evaluation runner and review queue**
   - Select due active forecasts in bounded batches.
   - Separate provider-unavailable results from genuine `no_change` decisions.
   - Let the user inspect the evidence and outcome reason before broader automation is enabled.

4. **Background scheduling and real alerts**
   - Add retries, leases, observability, and duplicate-delivery protection.
   - Deliver outcome/review notifications only after the evaluator and persistence layer are proven idempotent.

5. **Accuracy and calibration analytics**
   - Compute results by direction, setup tag, horizon, confidence bucket, and analysis-scenario type.
   - Show sample sizes and unresolved/cancelled forecasts so the interface does not overstate performance.

6. **Interactive chart context**
   - Add candlesticks and saved drawings linked to forecast/review timestamps.
   - Preserve the original activation snapshot rather than redrawing historical intent from current data.

## Phase 2 completion boundary

Phase 2 is complete when evaluation is deterministic, versioned, idempotent, reviewable, and backed by completed market data; outcome records never rewrite activation snapshots; users can see what was evaluated and why; and accuracy/calibration views faithfully include uncertainty and sample size.

Broker connections, order execution, AI-authored forecasts, social features, mentor mode, full backtesting, and bar replay remain outside this roadmap.
