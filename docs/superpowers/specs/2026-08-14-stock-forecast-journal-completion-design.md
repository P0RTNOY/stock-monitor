# Stock Forecast Journal Completion Design

## Objective

Finish the existing local-first Streamlit journal as a dependable personal application without changing its product category. The completed app must preserve journal data, make saved entries reliably editable by date, keep secrets and personal data local, degrade safely when external services fail, and have a repeatable validation path.

## Scope

This completion pass includes:

- date-aware loading and editing of saved forecasts;
- preservation of historical entries when the current watchlist changes;
- centralized validation and normalization for forecasts, watchlist rows, and review triggers;
- transactional SQLite writes and regression coverage for persistence behavior;
- safer, configurable OpenAI usage with journal text explicitly treated as untrusted data;
- secure local-file defaults and repository hygiene;
- tests for domain logic, persistence, market-data adapters, indicators, news parsing, and AI behavior;
- a clean Streamlit startup check and updated operating documentation.

It intentionally excludes hosted deployment, accounts, remote databases, automated trading, portfolio execution, forecast-performance scoring, and new analytics dashboards.

## Architecture

The existing boundaries remain:

- `app.py` owns Streamlit rendering and session state.
- `db.py` owns SQLite schema and persistence.
- `finance.py`, `news.py`, and `ai.py` own external integrations.
- `indicators.py` owns deterministic market calculations.
- `models.py` owns shared constants and typed records.

A small pure domain module will own normalization, validation, date-sheet merging, trigger evaluation, and export sanitization. Moving these rules out of `app.py` makes them testable without executing Streamlit or making network calls. The UI will delegate to that module and keep only presentation/session concerns.

## Daily Journal Data Flow

1. The selected date is read from the date control.
2. Current watchlist rows and saved rows for that date are loaded.
3. Saved values are merged into matching watchlist symbols; unsaved symbols receive neutral defaults.
4. Saved entries for symbols no longer in the watchlist are retained separately so replacing the date cannot silently delete them.
5. The editor identity includes the selected date and an explicit revision counter, preventing one date's widget state from leaking into another.
6. Saving validates and normalizes visible rows, merges retained historical-only rows, and replaces that date in one SQLite transaction.

Watchlist edits remain distinct from saving a journal entry. A watchlist update may rerender the sheet, but the current in-memory forecast draft must be carried across that rerender.

## Validation and Failure Behavior

- Stock names and symbols are trimmed; symbols are uppercased and must be unique.
- Directions must belong to the supported direction list.
- Confidence must be a finite integer from 0 through 100.
- Trigger symbols and condition types must be valid; thresholds must be finite numbers.
- Database entry points enforce these rules even when called outside the UI.
- External market/news failures return an unavailable state and emit concise diagnostics without exposing journal text or credentials.
- OpenAI calls use a configurable model, bounded input, explicit data delimiters, and a reflection-only system instruction. Missing credentials and provider failures become actionable application errors.
- CSV and Excel text fields that begin with spreadsheet formula markers are neutralized on export.

## Local Security and Privacy

- `.env`, virtual environments, SQLite journals, caches, generated exports, and OS metadata are ignored.
- The local `.env` file is restricted to its owner.
- No test performs a live OpenAI request.
- Tests use temporary databases and synthetic journal entries.
- The existing user database is never reset, migrated destructively, or included in test fixtures.

## Testing Strategy

- Persistence tests cover atomic date replacement, watchlist CRUD/uniqueness, trigger CRUD, validation rejection, and database integrity.
- Domain tests cover date merging, orphan preservation, normalization, trigger evaluation, and formula-safe exports.
- Adapter tests mock Yahoo Finance, HTTP responses, RSS payloads, and OpenAI responses.
- Indicator tests cover short histories, flat/rising/falling RSI behavior, and 52-week calculations.
- A compile check and a bounded headless Streamlit health check verify startup.

The supported validation command will be documented as:

```bash
python -m unittest discover -s tests -v
```

## Completion Criteria

The work is complete when:

- selecting a date displays its previously saved forecasts;
- switching dates does not leak unsaved editor state across dates;
- saving cannot erase entries solely because their symbols left the watchlist;
- invalid domain values are rejected before persistence;
- the `.env` file is private and ignored;
- all automated tests, syntax compilation, database integrity checks, and the headless startup check pass;
- README instructions match the validated setup and commands.

## Delivery Constraint

`stock-forecast-journal` is not an independent Git repository. Its parent Git root is the user's home directory and the project is untracked there. This pass will not stage or commit files into that broad parent repository. Git initialization or publication requires a separate explicit request.
