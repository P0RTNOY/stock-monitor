# Technical Analysis Ruleset v1

Ruleset v1 is the frozen foundation and first rectangle/range-breakout implementation. Its thresholds are engineering hypotheses to test, not universal rules from the attached guide and not claims of profitability.

## Supported scope

- US-listed liquid large-cap equities and broad/sector ETFs.
- Yahoo Finance is a prototype data provider, not a production data entitlement.
- Raw daily OHLCV is the provider input; completed weekly bars are built locally.
- Daily and weekly analysis only. Hourly bars are deferred until an exchange-calendar and cache policy are selected.
- Output is descriptive scenario evidence. It does not place orders or produce `buy`, `sell`, or `hold` commands.

## Completion and corporate actions

Without an exchange-calendar dependency, a daily candle is conservatively considered complete only after its market date has passed. A weekly candle is exposed beginning in the next ISO week. Each bar carries a separate `completed_at` availability timestamp, and pivot confirmation uses that timestamp rather than the candle's earlier label. The first weekly group in a provider or post-split window is dropped because it may begin midweek. This intentionally delays some information rather than risk analyzing a partial candle.

The first ruleset keeps raw prices so displayed levels match quoted prices. Dividends and splits are retained as flags. When a split appears in the input window, analysis is truncated at the latest split so the raw discontinuity cannot become a false swing or breakout. If too little post-split history remains, the valid result is `insufficient_data`.

## Frozen feature definitions

- ATR: 14 periods, using true range and Wilder's arithmetic seed plus recurrence.
- Relative volume: current volume divided by the mean of the previous 20 completed bars; the current bar is excluded from its own baseline.
- Moving averages: SMA 20, 50, and 200, used only as context.
- Swing pivots: strict high/low comparison against two completed bars on each side. A pivot at time `t` is not exposed until the second right-side bar completes.
- Structure: the two latest confirmed highs and lows classify higher-high/higher-low, lower-high/lower-low, or range. Missing confirmed swings remain indeterminate.
- Zones: confirmed pivots are clustered using the larger of `0.35 × latest ATR` and `0.5% × latest close`; that value is a hard maximum zone span. A zone requires at least two touches, and at most three relevant zones are returned.

The machine-readable source of truth is [`analysis/config/ruleset-v1.json`](../analysis/config/ruleset-v1.json).

## Rectangle lifecycle

The detector replays completed daily bars in order and freezes its geometry when the range first qualifies. Future pivots and ATR values cannot redraw an existing scenario.

A candidate requires:

- two confirmed pivot touches on each side;
- at least five bars between same-side touches and three chronological side alternations;
- a 15–60 bar formation window;
- boundary touch span no larger than `max(0.35 × formation ATR, 0.5% × price)`;
- range height at least `max(2 × formation ATR, 3% × price)` and no more than 12 ATR;
- boundary drift no greater than 10% of range height;
- at least 90% contained closes and no more than one consecutive outside close.

Breakout confirmation requires one completed close beyond the frozen boundary by `max(0.25 × frozen ATR, 0.5% × boundary)` and relative volume of at least 1.25. The breakout bar is excluded from its own volume baseline. A price break without volume confirmation invalidates the frozen candidate rather than moving its boundaries. A corporate-action breakout bar is also rejected.

Candidate expiry is 20 completed bars. After confirmation, the detector records the first valid retest, close back inside the range, opposite-boundary invalidation, measured target touch, or 30-bar expiry. The first retest time is preserved if a later terminal event occurs. A confirmation close already at or beyond the measured target is immediately `target_reached`; a confirmation-bar wick alone is not. On a later bar where target and failure both occur, target touch has deterministic precedence. Measured targets are boundary plus or minus range height and remain estimates. Terminal lifecycle records age out of the current report after the 60-bar detector lookback, preventing an old expired range from appearing as current context.

## Hypothetical risk arithmetic

Risk calculations appear only while a confirmed breakout is active or in its first recorded retest. Terminal states do not expose current risk arithmetic. Analytical invalidation remains a descriptive condition; it is not treated as an execution order. The default research execution-stop geometry is beyond the far side of the range by 0.25 formation ATR, unless the caller supplies a different positive price on the correct side of entry. A non-positive derived stop is rejected.

```text
risk_per_unit = abs(entry_assumption - execution_stop_assumption)
                + commission_per_unit
                + expected_slippage_per_unit

position_size = floor(account_risk / risk_per_unit)
```

Position size remains unavailable until the caller supplies an explicit positive account-risk amount, a positive execution-stop assumption, and explicit commission and slippage assumptions (zero is allowed). Reward is directional; if the measured target is not ahead of entry after costs, reward, reward/risk, and size remain unavailable. Intermediate zones are checked by zone-edge overlap with a frozen-ATR clearance rather than center price alone. Targets, stops, reward/risk, and size are hypothetical; gaps, halts, and liquidity conditions can produce larger losses.

## Current boundary

The current implementation includes the rectangle lifecycle, scenario/risk assembly, CLI output, a loopback HTTP service, and explicit-click panels in local Northstar and the legacy Streamlit app. Northstar keeps refreshed reports in browser state; when the user activates a structured forecast from a valid scenario, it also stores the complete report and selected scenario as an immutable, profile-owned activation snapshot. That snapshot is linked to the forecast and cannot be replaced by a later refresh. The legacy Streamlit journal does not persist analysis reports to SQLite. The implementation does not backtest performance, provide event-calendar risk, schedule forecast evaluation, deploy a publicly reachable analysis service for hosted Northstar, place orders, or make personalized suitability claims. Manual forecast evaluation is documented separately in [`forecast-evaluation-phase-2a.md`](forecast-evaluation-phase-2a.md).
