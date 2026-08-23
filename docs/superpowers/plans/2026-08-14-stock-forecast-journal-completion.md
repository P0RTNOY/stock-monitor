# Stock Forecast Journal Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local-first stock forecast journal safe against accidental data loss, testable without live services, secure by default, and reproducibly runnable.

**Architecture:** Keep Streamlit as the presentation layer and SQLite as local persistence. Extract deterministic journal rules into `journal.py`, enforce the same rules at persistence boundaries, and keep external adapters independently mockable. Date-specific drafts live in Streamlit session state while durable entries remain transactionally stored in SQLite.

**Tech Stack:** Python 3.11, Streamlit, SQLite, pandas, yfinance, OpenAI Responses API, `unittest`/`unittest.mock`.

## Global Constraints

- Preserve the existing `stock_forecast_journal.db`; never reset or use it in tests.
- Keep the application local-first and reflection-only; do not add trading or hosted features.
- Add no production dependencies.
- Never make a live OpenAI request from automated tests.
- Treat journal text, RSS content, and symbol-search results as untrusted input.
- Do not stage or commit: the project is untracked inside a Git repository rooted at the user's home directory.

---

### Task 1: Secure Local Configuration and Reproducible Test Discovery

**Files:**
- Create: `.gitignore`
- Create: `tests/__init__.py`
- Modify: `.env.example`
- Modify: `requirements.txt`

**Interfaces:**
- Consumes: the existing README convention of `.env` and `OPENAI_API_KEY`.
- Produces: ignored private runtime state, default unittest discovery, `OPENAI_MODEL` configuration, and local secret-file security.

- [ ] **Step 1: Add ignore rules and test-package marker**

```text
.env
.env.*
!.env.example
.venv/
__pycache__/
*.py[cod]
.DS_Store
stock_forecast_journal.db
*.db-journal
*.db-shm
*.db-wal
```

Create an empty `tests/__init__.py` so `python -m unittest discover` sees the suite under Python 3.9 and 3.11.

- [ ] **Step 2: Add safe model configuration and dependency bounds**

Add `OPENAI_MODEL=gpt-5.4-mini` to `.env.example`. Express the already-used packages as compatible major-version ranges, including `streamlit>=1.50,<2`, `pandas>=2.3,<3`, `openai>=2.44,<3`, `yfinance>=1.2,<2`, `python-dotenv>=1.2,<2`, and `openpyxl>=3.1,<4`.

- [ ] **Step 3: Restrict the existing secret file and verify hygiene**

Run:

```bash
chmod 600 .env
python -m unittest discover -v
git check-ignore -v .env
```

Expected: the three baseline database tests pass and `.env` is matched by `.gitignore`.

### Task 2: Pure Journal Domain Rules

**Files:**
- Create: `journal.py`
- Create: `tests/test_journal.py`
- Modify: `models.py`

**Interfaces:**
- Consumes: `DIRECTIONS` and new `TRIGGER_CONDITIONS` from `models.py`.
- Produces: `clean_text(value)`, `build_sheet_rows(stocks, saved_entries, quote_snapshots, draft_rows=None)`, `sheet_rows_to_entries(rows, log_date, quote_snapshots)`, `retain_historical_entries(saved_entries, visible_symbols, deleted_symbols, log_date)`, `trigger_status(trigger, quote_snapshots)`, `sanitize_spreadsheet_frame(frame)`, and `editor_key(log_date, revision)`.

- [ ] **Step 1: Write failing date-merge and normalization tests**

Cover these exact cases in `JournalSheetTests`:

```python
def test_saved_entry_prefills_matching_watchlist_symbol(self):
    rows = build_sheet_rows(
        [{"id": 1, "stock_name": "Apple", "symbol": "AAPL"}],
        [{"symbol": "AAPL", "direction": "Bullish", "target": "220",
          "thesis": "Demand", "confidence": 70}],
        {"AAPL": {"latest_price": 210.0, "previous_close": 208.0,
                  "change": 2.0, "change_pct": 0.96}},
    )
    self.assertEqual(rows[0]["Direction"], "Bullish")
    self.assertEqual(rows[0]["Confidence"], 70)
```

The same class must assert neutral defaults for an unsaved symbol, draft precedence over a saved entry, isolation between two supplied date datasets, symbol uppercasing, and rejection of unsupported direction, out-of-range confidence, and blank symbol values.

Run `python -m unittest tests.test_journal.JournalSheetTests -v` and expect failures because `journal.py` does not exist.

- [ ] **Step 2: Implement deterministic sheet construction and normalization**

Use symbol-keyed saved rows and ID-keyed drafts. Each visible row keeps the current watchlist `ID`, `Stock`, and `Symbol`, while its `Direction`, `Target / Expectation`, `Thesis`, and `Confidence` come from draft, then saved entry, then defaults. `sheet_rows_to_entries` returns `(entries, visible_symbols, deleted_symbols)` and raises `ValueError` instead of coercing invalid values.

- [ ] **Step 3: Write failing orphan-preservation, trigger, and export tests**

```python
def test_removed_watchlist_symbol_is_retained_on_replace(self):
    saved = [{"log_date": "2026-08-14", "stock_name": "Old", "symbol": "OLD",
              "price": 10.0, "direction": "Neutral", "target": "",
              "thesis": "Historical", "confidence": 50}]
    retained = retain_historical_entries(saved, {"AAPL"}, set(), "2026-08-14")
    self.assertEqual([entry["symbol"] for entry in retained], ["OLD"])
```

Additional tests must assert that explicit deletion suppresses retention, all four supported trigger comparisons work, missing prices report a waiting state, invalid conditions/non-finite thresholds raise `ValueError`, and formula-prefixed cells receive a leading apostrophe in an exported copy.

Run `python -m unittest tests.test_journal -v`; expect the new tests to fail.

- [ ] **Step 4: Implement retention, trigger evaluation, and export sanitization**

Historical-only rows are copied unchanged except for the requested `log_date`; visible or explicitly deleted symbols are excluded. Formula-like strings whose left-trimmed form starts with `=`, `+`, `-`, or `@` receive a leading apostrophe in exported frames. Trigger thresholds must satisfy `math.isfinite`.

- [ ] **Step 5: Run the focused suite**

Run `python -m unittest tests.test_journal -v` and expect all domain tests to pass.

### Task 3: Persistence Boundary Validation

**Files:**
- Modify: `db.py`
- Expand: `tests/test_db.py`

**Interfaces:**
- Consumes: normalized log dictionaries and `TRIGGER_CONDITIONS`/`DIRECTIONS`.
- Produces: atomic validated `replace_logs_by_date`, validated watchlist CRUD, and validated trigger CRUD.

- [ ] **Step 1: Write failing boundary tests**

Add tests that assert:

```python
def test_rejects_invalid_direction_without_replacing_existing_rows(self):
    db.insert_log_entry(self._entry("AAPL"))
    invalid = self._entry("MSFT", direction="Trade now")
    with self.assertRaises(ValueError):
        db.replace_logs_by_date("2026-07-14", [invalid])
    self.assertEqual([row["symbol"] for row in db.get_logs_by_date("2026-07-14")],
                     ["AAPL"])
```

The suite must also reject non-finite confidence/threshold values, prove watchlist symbol normalization and uniqueness, reject unsupported trigger conditions, and require update/delete operations to affect exactly one identifier.

Run `python -m unittest tests.test_db -v`; expect the new tests to fail.

- [ ] **Step 2: Validate before opening destructive transactions**

Validate every replacement entry into a new list before executing `DELETE`. Required keys still use dictionary indexing so missing fields retain the established `KeyError` behavior. Raise `ValueError` for blank names/symbols, unsupported directions/conditions, non-finite numbers, confidence outside `0..100`, and updates/deletes whose `rowcount` is not one.

- [ ] **Step 3: Run persistence tests and integrity check**

Run:

```bash
python -m unittest tests.test_db -v
python -c 'import sqlite3; c=sqlite3.connect("file:stock_forecast_journal.db?mode=ro", uri=True); print(c.execute("PRAGMA integrity_check").fetchone()[0])'
```

Expected: all tests pass and the real database prints `ok` without modification.

### Task 4: Date-Aware Streamlit Workflow

**Files:**
- Modify: `app.py`
- Create: `tests/test_app_helpers.py`

**Interfaces:**
- Consumes: all `journal.py` functions and `db.get_logs_by_date(log_date)`.
- Produces: date-isolated editor keys, session drafts under `forecast_drafts`, historical-row preservation on save, and safe exports.

- [ ] **Step 1: Write failing UI-helper contract tests**

Test the pure helper `editor_key(log_date, revision)` without importing the full app script:

```python
self.assertEqual(editor_key("2026-08-14", 3), "forecast_sheet_2026-08-14_3")
self.assertNotEqual(editor_key("2026-08-14", 3), editor_key("2026-08-15", 3))
```

Place the helper in `journal.py` if importing `app.py` would execute Streamlit. Run the focused test and expect failure first.

- [ ] **Step 2: Replace duplicated app rules with domain calls**

Import `get_logs_by_date` and the journal functions. Build the editor from current stocks, selected-date saved entries, quote snapshots, and `st.session_state.forecast_drafts.get(log_date)`. Store the returned editor records back under that date after every completed render. Include `log_date` in the widget key.

- [ ] **Step 3: Preserve drafts and historical-only rows through actions**

Before watchlist changes rerun, retain the current date's editor records. On save, combine normalized visible entries with `retain_historical_entries(saved_entries, visible_symbols, deleted_symbols, log_date)`, then call `replace_logs_by_date`. Apply `sanitize_spreadsheet_frame` only to download data, never to persisted journal text.

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
python -m unittest tests.test_app_helpers -v
python -m unittest discover -v
```

Expected: all tests pass and default discovery reports more than the original three tests.

### Task 5: External Adapter Hardening

**Files:**
- Modify: `ai.py`
- Modify: `finance.py`
- Modify: `news.py`
- Create: `tests/test_ai.py`
- Create: `tests/test_finance.py`
- Create: `tests/test_indicators.py`
- Create: `tests/test_news.py`

**Interfaces:**
- Consumes: environment variables `OPENAI_API_KEY` and `OPENAI_MODEL`.
- Produces: `JournalAIError`, bounded/delimited prompts, mockable `OpenAI` creation, and deterministic adapter fallbacks.

- [ ] **Step 1: Write failing AI adapter tests**

Mock `ai.OpenAI` and cover empty rows, missing key, `OPENAI_MODEL` override, default `gpt-5.4-mini`, response text, provider exception wrapping, the 60-entry cap, and explicit `<journal_entries>` delimiters. No test may call the network.

- [ ] **Step 2: Implement safe AI calls**

Create `_summarize(rows, task, *, max_rows)` and call `client.responses.create(model=os.getenv("OPENAI_MODEL", "gpt-5.4-mini"), instructions=REFLECTION_INSTRUCTIONS, input=bounded_payload)`. Wrap provider exceptions as `JournalAIError("The AI summary service is unavailable. Please try again later.")` without embedding user text, credentials, or raw provider responses.

- [ ] **Step 3: Write and implement mocked finance/news/indicator cases**

Finance tests patch `finance.yf.Ticker` and `finance.urlopen`; news tests patch `news.urlopen`; indicator tests patch `indicators.get_price_history`. Cover malformed JSON/XML, empty histories, one-close snapshots, symbol result filtering, RSS parsing, RSI flat/rising/falling behavior, and 52-week distances. Assert concise warning logs name only the failed operation and exception type; they must not contain URLs, response bodies, journal text, or credentials.

- [ ] **Step 4: Run adapter tests**

Run:

```bash
python -m unittest tests.test_ai tests.test_finance tests.test_indicators tests.test_news -v
```

Expected: all adapter tests pass with no live OpenAI request.

### Task 6: Documentation and Release Verification

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: the final validated commands and configuration.
- Produces: reproducible setup, privacy/backup guidance, troubleshooting, and a verified local release.

- [ ] **Step 1: Update operating documentation**

Document Python 3.11 setup, dependency installation, `.env` permissions, optional `OPENAI_MODEL`, run command, full test command, local database backup, external-service degradation, and the fact that AI inputs leave the machine only when the user clicks an AI action.

- [ ] **Step 2: Run all static and automated validation**

```bash
.venv/bin/python -m unittest discover -v
.venv/bin/python -m compileall -q app.py ai.py db.py finance.py indicators.py journal.py models.py news.py tests
```

Expected: all tests pass and compileall exits zero.

- [ ] **Step 3: Run a bounded headless startup check**

Start Streamlit on an unused local port with telemetry disabled, poll `/_stcore/health` until it returns `ok`, then stop the exact process. Inspect captured output for tracebacks.

- [ ] **Step 4: Review scope and data safety**

Inspect every changed path, confirm `.env` and `stock_forecast_journal.db` are ignored, confirm the database integrity check still returns `ok`, and ensure no credential value or personal journal content appears in diffs or test output.
