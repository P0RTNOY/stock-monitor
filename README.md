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
- Manual deterministic evaluation against trusted completed daily bars
- Durable outcome evidence and a Review Queue with append-only acknowledgement
- Bounded, replay-safe due-forecast coordination through a non-public operator CLI
- A durable notification outbox plus verified-recipient, consent-gated Resend email delivery foundation
- A durable in-app Notification Center with immutable evidence, stable pagination, and explicit read state
- Deny-by-default tenant authorization with explicit human, scheduler, operator, provider, and capability principals
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

The local Vite server proxies `/api/analysis`, and the Northstar server sends forecast-evaluation requests to the same loopback service without exposing its address to browser code. A hosted deployment requires `ANALYSIS_API_URL` to point to a separately deployed HTTPS analysis service; `127.0.0.1` is local-only.

Phase 2B also provides the non-public `npm run forecast:coordinate` operator command under `market-monitor-web`. It resolves the fixed local profile internally, requires an explicit cutoff and mode, and can produce human-readable or machine-readable reports. It is not an application route or browser control. Execute mode uses the same trusted Python evaluation service as **Evaluate now**, so the local Python service must be running; consult the [Phase 2B coordinator contract](docs/forecast-coordinator-phase-2b.md) before invoking it.

```bash
cd market-monitor-web
npm run forecast:coordinate -- --help
npm run forecast:coordinate -- --cutoff 2026-08-24T12:00:00.000Z --mode dry_run --limit 25
```

Use `npm run --silent forecast:coordinate -- ... --json` when stdout must contain only JSON. Execute and cursor/replay examples, local D1 persistence details, and the `ANALYSIS_API_URL` requirement are documented in the Phase 2B contract.

Phase 2C1 adds a default-disabled Cloudflare scheduled callback to the existing Vinext Worker. It derives its fixed UTC cutoff only from the trusted scheduled event and delegates bounded pages to Phase 2B; it is not exposed as an HTTP route. The initial configurable cadence is 06:30 UTC daily and does not claim immediate coverage for every exchange. Local simulation and read-only inspection are available without impersonating a public request:

```bash
cd market-monitor-web
npm run forecast:schedule:simulate -- --help
npm run forecast:schedule:simulate -- --scheduled-at 2026-08-25T06:30:00.000Z --enabled true
npm run forecast:schedule:status -- --limit 20
```

The scheduler contract, bounds, replay/recovery model, remote migration checklist, kill switch, and truthful readiness limits are documented in [`docs/forecast-scheduled-operations-phase-2c1.md`](docs/forecast-scheduled-operations-phase-2c1.md). No remote migration, deployment, or Cron activation is performed by these local commands.

Phase 2C2A adds a separate local notification projector and read-only status boundary. Projection consumes only persisted Phase 2A evaluation runs and review items; it never calls market data, reevaluates a forecast, or sends a message. Dry-run is the safe default, while forward mutation requires an explicit commit flag:

```bash
cd market-monitor-web
npm run forecast:notifications:project -- --cutoff 2026-08-25T06:30:00.000Z --limit 25 --dry-run
npm run forecast:notifications:project -- --cutoff 2026-08-25T06:30:00.000Z --limit 25 --commit
npm run forecast:notifications:status -- --limit 20
```

The projector establishes a profile-scoped historical baseline before processing new results, so existing evaluations and unresolved review items are not silently backfilled. Preferences default to no consent, no recipient or external channel is stored, and historical inspection is dry-run-only. See [`docs/forecast-notification-outbox-phase-2c2a.md`](docs/forecast-notification-outbox-phase-2c2a.md) for the source, deduplication, payload, preference, quiet-hours, retry, lease, operator, and Phase 2C2B contracts.

Phase 2C2B adds a separate, manually invoked email-delivery boundary. Recipient registration and consent remain operator-controlled, verification is separate from consent, and dispatch is disabled and dry-run by default. Human output masks the recipient and machine output omits the address, capabilities, bodies, claims, and secrets:

```bash
cd market-monitor-web
npm run forecast:email:recipient -- --help
npm run forecast:email:verification:send -- --help
npm run forecast:email:consent -- --status
npm run forecast:email:dispatch -- --help
npm run forecast:email:status -- --limit 20
```

A real Resend request additionally requires complete server-side configuration, `FORECAST_EMAIL_DISPATCH_ENABLED=true`, explicit `--send-live`, a verified unsuppressed recipient, active notification and email consent, a valid claim, and a passing final policy recheck. No live email, remote migration, deployment, Resend configuration, DNS change, or dispatcher Cron activation was performed. See [`docs/forecast-email-delivery-phase-2c2b.md`](docs/forecast-email-delivery-phase-2c2b.md).

Phase 2C2C adds the in-app Notification Center at `/notifications`. It projects only existing trusted intents into immutable presentation snapshots; browser list/count/detail requests never evaluate forecasts, initialize schema, request market data, or call an email provider. Projection and historical backfill remain operator-controlled and dry-run by default:

```bash
cd market-monitor-web
npm run forecast:notifications:in-app:project -- --cutoff 2026-08-26T12:00:00.000Z --dry-run
npm run forecast:notifications:in-app:project -- --cutoff 2026-08-26T12:00:00.000Z --commit
npm run forecast:notifications:in-app:backfill -- --from-id 1 --through-id 100 --cutoff 2026-08-26T12:00:00.000Z --confirm-historical-preview
npm run forecast:notifications:in-app:status
```

Read/unread state is append-audited, first-read time is permanent, mark-all is bounded by a server-issued entry-sequence high water, and email status is only independent secondary evidence. No remote migration or deployment was performed. See [`docs/forecast-in-app-notification-center-phase-2c2c.md`](docs/forecast-in-app-notification-center-phase-2c2c.md).

Phase 3A1 replaces the historical fixed-profile trust assumption with an explicit tenant authorization foundation. Normal local development remains available only through the launcher’s visible local-bootstrap mode; missing or production-shaped configuration denies every human-protected page and API. Scheduler, operator, signed Resend, verification, and unsubscribe flows use distinct narrow principals. Before migration, inspect migration readiness and source coverage:

```bash
cd market-monitor-web
npm run auth:bootstrap:status
npm run auth:route-audit
```

After applying `0009`, run `npm run auth:tenant-audit`; unlike the preflight status command, it intentionally blocks until the complete authorization schema and valid bootstrap owner are present. All three commands are local and read-only. Phase 3A1 does not add login, sessions, an authentication provider, or public deployment. See [`docs/authz-tenancy-phase-3a1.md`](docs/authz-tenancy-phase-3a1.md).

Northstar does not seed or display demo holdings, watchlists, prices, or chart histories. Portfolio and forecast records come from its D1 database; quote and chart values are requested from the configured real-market provider only for tracked symbols. A forecast may reference only a position or watchlist symbol owned by the resolved profile. The watchlist ticker field searches the live provider directory after two characters and supports keyboard selection; save requests revalidate the exact symbol and use the provider's canonical company name instead of trusting browser-supplied metadata. Stock and ETF market values are accepted only when the provider currency matches the profile currency, so raw prices in different currencies are never silently added together. The local and hosted analysis boundaries likewise reject untracked symbols. A new database starts with an empty portfolio and zero cash. If the database or provider is unavailable, the interface shows an explicit unavailable state instead of substituting sample data, average cost, or a synthetic chart. The one-time `legacy-demo-cleanup-v1` migration runs only after matching the complete legacy seed fingerprint and removes only the exact demo rows created by older Northstar builds.

Northstar now enforces tenant ownership and authorization, but it still does not have real authentication. Production-shaped environments fail closed, and local bootstrap is explicitly development-only. The application must not be exposed as a public multi-user service until Phase 3A2 adds a real provider, secure sessions, and an authenticated bootstrap-owner claim. See [`docs/authz-tenancy-phase-3a1.md`](docs/authz-tenancy-phase-3a1.md) and [`docs/forecast-phase-1.md`](docs/forecast-phase-1.md).

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

A Northstar forecast moves through `draft`, `active`, and a terminal state. Drafts are editable and deletable. Activation captures fresh server market data and locks the thesis, evidence, confidence, target, horizon, invalidation, quote, and any technical-analysis snapshot. Later amendments and review notes are append-only and do not alter that original record. A user may explicitly cancel an active forecast with a reason.

Phase 2A adds an explicit **Evaluate now** action for one active forecast. Northstar fetches trusted completed daily bars on the server, applies a frozen versioned ruleset, and stores the evidence-backed result. Proven `target_hit`, `invalidated`, or `expired` outcomes close the forecast atomically. `no_change` leaves it active, while ambiguous or insufficient evidence produces `needs_review` and a durable Review Queue item. Acknowledgement records review only; it cannot override the evaluator.

Phase 2B adds bounded operator coordination for active forecasts that may have new completed information. It uses stable keyset pagination, frozen cutoffs, per-forecast claims, persisted progress, and isolated outcome reports while continuing to delegate every forecast decision and lifecycle mutation to Phase 2A. Dry-run previews the same due set without provider calls or forecast-domain mutations. Phase 2C1 adds default-disabled scheduled invocation, bounded multi-page operation, durable scheduler history, structured logs, and local inspection while preserving the same internal coordinator boundary.

Phase 2C2A projects the persisted `target_hit`, `invalidated`, `expired`, and `needs_review` facts into deterministic intents, immutable policy decisions, and a channel-neutral outbox. Database uniqueness, a profile baseline, explicit consent/category settings, Temporal-based quiet hours, bounded retry policy, fenced leases, and append-preserved attempts establish the safety boundary for delivery. `no_change` and operational failures do not become notifications.

Phase 2C2B consumes only that outbox. It adds profile-owned verified recipients, a separate recipient-bound email-consent history, deterministic informational templates, a fixed Resend adapter, persisted idempotency/request evidence, a bounded manual dispatcher, verified webhook reconciliation, bounce/complaint suppression, and unsubscribe. Provider acceptance remains distinct from final delivery. There is still no public dispatch endpoint, browser recipient/settings UI, email Cron, live sending, or production authentication.

Phase 2C2C consumes the same trusted intents as a sibling in-app channel. It adds immutable presentation projection, independent read-state events, filter-bound keyset cursors, sequence-bound mark-all, a dedicated responsive Center/evidence route, and dry-run/commit operator controls. Entries do not depend on email consent, recipient, quiet hours, or provider success, and opening evidence never marks an entry read.

Phase 3A1 adds internal users, role-bearing profile memberships, typed human/system/provider/capability principals, centralized deny-by-default policy, branded request service scopes, query-level ownership hardening, deterministic bootstrap migration, route/table manifests, and local read-only authorization audits. Authentication itself remains Phase 3A2.

The Phase 1 domain and activation contract are documented in [`docs/forecast-phase-1.md`](docs/forecast-phase-1.md). Phase 2A architecture, rules, API, Review Queue, and limitations are in [`docs/forecast-evaluation-phase-2a.md`](docs/forecast-evaluation-phase-2a.md); the normative decision policy is [`docs/forecast-evaluation-ruleset-v1.md`](docs/forecast-evaluation-ruleset-v1.md). The frozen Phase 2B coordinator contract is [`docs/forecast-coordinator-phase-2b.md`](docs/forecast-coordinator-phase-2b.md), Phase 2C1 scheduled operations are in [`docs/forecast-scheduled-operations-phase-2c1.md`](docs/forecast-scheduled-operations-phase-2c1.md), the Phase 2C2A outbox foundation is in [`docs/forecast-notification-outbox-phase-2c2a.md`](docs/forecast-notification-outbox-phase-2c2a.md), verified email delivery is in [`docs/forecast-email-delivery-phase-2c2b.md`](docs/forecast-email-delivery-phase-2c2b.md), the in-app Center is in [`docs/forecast-in-app-notification-center-phase-2c2c.md`](docs/forecast-in-app-notification-center-phase-2c2c.md), tenant authorization is in [`docs/authz-tenancy-phase-3a1.md`](docs/authz-tenancy-phase-3a1.md), and follow-up work is sequenced in [`docs/phase-2-roadmap.md`](docs/phase-2-roadmap.md).

## How Saving Works

Select a date before editing. Existing forecasts for that date populate the sheet. Unsaved edits remain isolated to the selected date for the current Streamlit session.

`Save Daily Log` validates all visible rows and replaces that date in one transaction. Rows explicitly marked for deletion are excluded. Previously saved rows whose symbols are no longer in the current watchlist are preserved, preventing an old journal date from losing data merely because the watchlist changed later.

The recorded price of an existing entry is preserved when the entry is edited. A new entry uses the latest price currently loaded in the app, if one is available.

## Privacy and External Services

- Journal data is stored locally in `stock_forecast_journal.db`.
- The database, `.env`, virtual environments, and SQLite sidecar files are ignored by Git.
- Price, chart, symbol-search, technical-analysis, and forecast-evaluation requests send stock symbols or search text to Yahoo Finance. Manual and operator-coordinated evaluation additionally request a bounded raw daily-history range and market metadata.
- Headline requests send the selected symbol or company name to Google News.
- Journal text is sent to OpenAI only after `Generate AI Summary` or `Review Forecast Habits` is clicked. Requests are capped at 60 entries and 30,000 characters, delimit journal content as untrusted data, and ask only for reflection—not trading instructions.
- Phase 2C2A notification records contain bounded persisted forecast-result facts and internal references only. They contain no email address, telephone number, push token, webhook URL, raw provider response, or external delivery credential, and this phase sends nothing externally.
- Phase 2C2B stores the canonical address only in the profile-owned recipient record and sends it to Resend only after the live gates pass. Outbox rows, ordinary logs, operator JSON, and provider-event evidence omit the raw address and secrets; operator display is masked.
- Phase 2C2C stores bounded immutable presentation snapshots and append-only read-state evidence. Entries contain no address, capability, provider ID, secret, arbitrary URL, or raw provider payload.
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

The suite uses temporary databases, frozen evaluator fixtures, and mocked network providers. It covers persistence transactions, date-aware Streamlit behavior, journal validation, trigger evaluation, export safety, AI request construction, market/news adapters, technical indicators, normalized OHLCV contracts, no-look-ahead pivots, structural trend classification, deterministic analysis reports, completed-bar availability, exchange-session coverage, touch/collision/gap precedence, corporate actions, currency handling, fingerprints, and evaluation service errors. Northstar tests additionally cover forecast migrations and repeatable initialization, validation, lifecycle transitions, ownership, activation quote capture, immutable analysis snapshots, evaluation atomicity/idempotency, Review Queue acknowledgement, coordinator due selection, cursors, dry-run, claims, replay and resume, scheduler bounds/identity/overlap/recovery, notification source/payload/deduplication contracts, consent policy, quiet-hour daylight-saving boundaries, recipient/capability safety, deterministic email templates, Resend request identity and sanitized outcomes, signed webhook fixtures, retry fixtures, operator reports, API errors, filtering, and presentation helpers. Tests do not require live Yahoo Finance, Resend, or OpenAI access.

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
- **Forecast evaluation is unavailable:** confirm the local Python service is running, then retry. Provider failure leaves the forecast unchanged and stores no fabricated result.
- **`urllib3` reports LibreSSL on macOS:** use Python 3.11+ from a current distribution rather than Apple’s legacy system Python. The `.venv312` environment in this workspace avoids that warning.

Review reminders, market data, technical indicators, headlines, and AI summaries are context for the user’s own journal. They are not buy, sell, hold, or trade recommendations.

Forecasts follow the same boundary: Northstar records and later reviews the user's prediction; it does not generate a forecast or recommend a position.

Phase 2A remains the manual browser workflow, Phase 2B coordination is available through the local operator CLI, Phase 2C1 provides a default-disabled scheduled Worker callback plus local simulation/status commands, Phase 2C2A provides the durable notification outbox, Phase 2C2B provides a disabled-by-default manual Resend foundation, and Phase 2C2C provides the in-app Notification Center. Phase 3A1 now provides deny-by-default authorization and tenant isolation, but not real authentication or production multi-user exposure. No live email was sent, and there is no email dispatcher Cron, push, SMS, arbitrary webhook channel, global accuracy dashboard, authentication provider, or secure user session. Automated verification does not establish remote D1 migration, deployed Cron, operating-system process-kill recovery, live provider coordination, Resend delivery, deployed webhook behavior, or a browser end-to-end flow. The exact next phase is Phase 3A2 authentication and secure session integration.
