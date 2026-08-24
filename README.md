# Stock Forecast Journal

Stock Forecast Journal contains Northstar, the primary D1-backed portfolio and structured-forecast workspace, and the original local-first Streamlit journal. Northstar now treats a measurable `Forecast` as a first-class product object while preserving portfolio, watchlist, alert, market-data, journal, and completed-bar technical-analysis workflows.

This app is for personal journaling and reflection only. It is not financial advice, trading advice, or an automated trading system.

## Features

- Structured Northstar forecast drafts for tracked position and watchlist symbols
- Explicit forecast activation that captures a fresh server-verified quote and freezes the original prediction
- Point or range targets, invalidation, confidence, horizon, supporting evidence, and counter-evidence
- Append-only forecast events, amendments, and review notes
- Immutable technical-analysis snapshots linked at activation
- Forecast status and symbol filters with draft, active, and historical detail views
- Date-aware forecast sheet that reloads previously saved entries
- Per-date drafts that do not leak into another selected date
- Atomic replace-by-date saving without silently removing historical symbols that left the watchlist
- Editable local watchlist with symbol search
- Latest price, previous close, daily move, price charts, RSI, moving averages, and 52-week context
- Recent Google News RSS headlines
- Price and daily-move review reminders
- Filterable historical logs
- Formula-safe CSV and Excel exports
- Optional OpenAI daily summaries and forecast-habit reviews
- Local SQLite persistence with no account or hosted database
- Versioned technical-analysis foundations for normalized OHLCV, ATR, relative volume, confirmed pivots, structure, and price zones

## Requirements

- Python 3.11 or newer; Python 3.12 is the verified local runtime
- Internet access for Yahoo Finance, Google News, and optional OpenAI features
- An OpenAI API key only if AI summaries are used

## Setup

For a new environment:

```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m pip check
```

This workspace also contains a verified Python 3.12 environment named `.venv312`, created without replacing the older local `.venv`.

Create private local configuration:

```bash
cp .env.example .env
chmod 600 .env
```

Set the key in `.env` if AI summaries are needed:

```env
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-5.4-mini
```

`OPENAI_MODEL` is optional; the app defaults to `gpt-5.4-mini`. Change it to another model available to your OpenAI Platform project without editing source code.

## Run Northstar

Northstar is the current portfolio and market-monitoring frontend. Its local launcher starts the Python analysis service on loopback port 8502 and the Northstar web app on port 8501:

```bash
./scripts/run-northstar-local.sh
```

Then open [http://localhost:8501](http://localhost:8501). Use **Forecasts** to create a structured draft for a tracked symbol, review it, and explicitly activate it. Activation requires a fresh server-side market quote and freezes the prediction for honest later review. Use **Markets** to run completed-bar analysis for a tracked stock; when a qualifying scenario exists, **Create forecast from this scenario** prefills defensible fields for the user to review. Analysis still runs only after an explicit click, and a failed refresh leaves the last good browser report visible.

The local Vite server proxies `/api/analysis` to the loopback service without exposing its address to browser code. A hosted deployment requires `ANALYSIS_API_URL` to point to a separately deployed HTTPS analysis service; `127.0.0.1` is local-only.

Northstar does not seed or display demo holdings, watchlists, prices, or chart histories. Portfolio and forecast records come from its D1 database; quote and chart values are requested from the configured real-market provider only for tracked symbols. A forecast may reference only a position or watchlist symbol owned by the resolved profile. The watchlist ticker field searches the live provider directory after two characters and supports keyboard selection; save requests revalidate the exact symbol and use the provider's canonical company name instead of trusting browser-supplied metadata. Stock and ETF market values are accepted only when the provider currency matches the profile currency, so raw prices in different currencies are never silently added together. The local and hosted analysis boundaries likewise reject untracked symbols. A new database starts with an empty portfolio and zero cash. If the database or provider is unavailable, the interface shows an explicit unavailable state instead of substituting sample data, average cost, or a synthetic chart. The one-time `legacy-demo-cleanup-v1` migration runs only after matching the complete legacy seed fingerprint and removes only the exact demo rows created by older Northstar builds.

Northstar currently uses a centralized fixed-profile resolver, not user authentication. This is a migration seam for future authenticated IDs, but the application is not multi-user safe and must not be exposed as a public multi-tenant service until authentication and tenant isolation are implemented. See [`docs/forecast-phase-1.md`](docs/forecast-phase-1.md) for the lifecycle, API, integrity rules, local workflow, and deployment boundary.

## Run the legacy journal

With the environment activated:

```bash
streamlit run app.py
```

For the verified environment in this workspace:

```bash
.venv312/bin/streamlit run app.py
```

The SQLite database is created automatically as `stock_forecast_journal.db` in this folder.

## Technical Analysis

The analysis backend evaluates completed daily and weekly bars, returns machine-readable evidence, and implements a versioned rectangle/range-breakout lifecycle. It distinguishes candidate, confirmed, retest, failed-breakout, invalidated, target-reached, and expired states. These are descriptive scenarios, not personalized recommendations.

Run a live prototype report from the project folder:

```bash
.venv312/bin/python -m analysis AAPL
```

Optional hypothetical risk arithmetic can be requested explicitly:

```bash
.venv312/bin/python -m analysis AAPL \
  --account-risk 1000 \
  --commission-per-unit 0.02 \
  --slippage-per-unit 0.05 \
  --execution-stop 190
```

Or use it from Python:

```python
from datetime import datetime, timezone

from analysis import analyze_symbol

report = analyze_symbol("AAPL", datetime.now(timezone.utc))
print(report.to_dict())
```

The frozen assumptions and limitations are documented in [`docs/technical-analysis-ruleset-v1.md`](docs/technical-analysis-ruleset-v1.md). In Northstar, select a stock under **Markets**, provide optional risk assumptions in **Completed-bar analysis**, and click **Analyze completed bars**. Position sizing appears only for an active confirmed/retest scenario when risk budget, execution stop, commission, and slippage are all explicitly supplied; zero cost is allowed. Reports are retained in the current browser session per symbol. Creating a forecast from a valid scenario persists the bounded source report with its draft so the link survives a reload; activation validates it again and materializes the immutable forecast analysis snapshot. Later analysis refreshes cannot rewrite it. The legacy Streamlit journal retains a separate Scenario Analysis tab.

## Structured Forecasts

A Northstar forecast moves through `draft`, `active`, and, when explicitly cancelled with a reason, `cancelled`. The schema also reserves `target_hit`, `invalidated`, and `expired`, but Phase 1 does not automatically evaluate or grade forecasts. Drafts are editable and deletable. Activation captures fresh server market data and locks the thesis, evidence, confidence, target, horizon, invalidation, quote, and any technical-analysis snapshot. Later amendments and review notes are append-only and do not alter that original record.

The complete domain, REST API, lifecycle, local test flow, and current limitations are documented in [`docs/forecast-phase-1.md`](docs/forecast-phase-1.md). The intentionally deferred evaluator and follow-up sequence are in [`docs/phase-2-roadmap.md`](docs/phase-2-roadmap.md).

## How Saving Works

Select a date before editing. Existing forecasts for that date populate the sheet. Unsaved edits remain isolated to the selected date for the current Streamlit session.

`Save Daily Log` validates all visible rows and replaces that date in one transaction. Rows explicitly marked for deletion are excluded. Previously saved rows whose symbols are no longer in the current watchlist are preserved, preventing an old journal date from losing data merely because the watchlist changed later.

The recorded price of an existing entry is preserved when the entry is edited. A new entry uses the latest price currently loaded in the app, if one is available.

## Privacy and External Services

- Journal data is stored locally in `stock_forecast_journal.db`.
- The database, `.env`, virtual environments, and SQLite sidecar files are ignored by Git.
- Price/chart/symbol requests send stock symbols or search text to Yahoo Finance.
- Headline requests send the selected symbol or company name to Google News.
- Journal text is sent to OpenAI only after `Generate AI Summary` or `Review Forecast Habits` is clicked. Requests are capped at 60 entries and 30,000 characters, delimit journal content as untrusted data, and ask only for reflection—not trading instructions.
- Automated tests never make a live OpenAI request.

## Backup

Stop the app before copying the database, then keep a backup outside this project folder:

```bash
cp stock_forecast_journal.db ../stock_forecast_journal-backup.db
```

Restore only while the app is stopped, and keep the existing database until the restored copy has been verified.

## Tests

Run the full suite from the project folder:

```bash
python -m unittest discover -v
```

The suite uses temporary databases and mocked network providers. It covers persistence transactions, date-aware Streamlit behavior, journal validation, trigger evaluation, export safety, AI request construction, market/news adapters, technical indicators, normalized OHLCV contracts, no-look-ahead pivots, structural trend classification, and deterministic analysis reports. Northstar tests additionally cover forecast migrations and repeatable initialization, validation, lifecycle transitions, ownership, activation quote capture, immutable analysis snapshots, API errors, filtering, and presentation helpers. Tests do not require live Yahoo Finance or OpenAI access.

Northstar frontend checks run from its project directory:

```bash
cd market-monitor-web
npm test
npm run lint
npm run build
```

Static compilation check:

```bash
python -m compileall -q app.py ai.py analysis db.py finance.py indicators.py journal.py models.py news.py tests
```

## Troubleshooting

- **Prices or charts are unavailable:** Yahoo Finance can be temporarily unavailable. Refresh later; journal saving still works.
- **No headlines appear:** Google News RSS may be unavailable or may return no matching items.
- **AI summary reports a missing key:** confirm `.env` contains `OPENAI_API_KEY` and restart Streamlit.
- **AI summary is unavailable:** verify the configured model is available to the selected OpenAI project and retry. See the [official OpenAI model catalog](https://developers.openai.com/api/docs/models/all).
- **`urllib3` reports LibreSSL on macOS:** use Python 3.11+ from a current distribution rather than Apple’s legacy system Python. The `.venv312` environment in this workspace avoids that warning.

Review reminders, market data, technical indicators, headlines, and AI summaries are context for the user’s own journal. They are not buy, sell, hold, or trade recommendations.

Forecasts follow the same boundary: Northstar records and later reviews the user's prediction; it does not generate a forecast or recommend a position.
