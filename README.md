# Stock Forecast Journal

Stock Forecast Journal is a local-first Streamlit app for recording and reviewing personal daily stock forecasts. It starts with the Magnificent 7, supports an editable watchlist, adds market/news context, and stores journal data in a local SQLite file.

This app is for personal journaling and reflection only. It is not financial advice, trading advice, or an automated trading system.

## Features

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

## Run

With the environment activated:

```bash
streamlit run app.py
```

For the verified environment in this workspace:

```bash
.venv312/bin/streamlit run app.py
```

The SQLite database is created automatically as `stock_forecast_journal.db` in this folder.

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

The suite uses temporary databases and mocked network providers. It covers persistence transactions, date-aware Streamlit behavior, journal validation, trigger evaluation, export safety, AI request construction, market/news adapters, and technical indicators.

Static compilation check:

```bash
python -m compileall -q app.py ai.py db.py finance.py indicators.py journal.py models.py news.py tests
```

## Troubleshooting

- **Prices or charts are unavailable:** Yahoo Finance can be temporarily unavailable. Refresh later; journal saving still works.
- **No headlines appear:** Google News RSS may be unavailable or may return no matching items.
- **AI summary reports a missing key:** confirm `.env` contains `OPENAI_API_KEY` and restart Streamlit.
- **AI summary is unavailable:** verify the configured model is available to the selected OpenAI project and retry. See the [official OpenAI model catalog](https://developers.openai.com/api/docs/models/all).
- **`urllib3` reports LibreSSL on macOS:** use Python 3.11+ from a current distribution rather than Apple’s legacy system Python. The `.venv312` environment in this workspace avoids that warning.

Review reminders, market data, technical indicators, headlines, and AI summaries are context for the user’s own journal. They are not buy, sell, hold, or trade recommendations.
