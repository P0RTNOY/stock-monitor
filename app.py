from __future__ import annotations

import logging
from io import BytesIO
from datetime import date, datetime, timezone
from typing import Any

import pandas as pd
import streamlit as st
from dotenv import load_dotenv

from analysis import AnalysisEngine, AnalysisRequest
from analysis.contracts import ContractError
from analysis.providers import ProviderError, YahooFinanceProvider
from ai import summarize_daily_log, summarize_journal_habits
from db import (
    add_watchlist_stock,
    add_review_trigger,
    get_all_logs,
    get_logs_by_date,
    get_review_triggers,
    get_watchlist_stocks,
    init_db,
    replace_logs_by_date,
    replace_review_triggers,
    replace_watchlist_stocks,
)
from finance import (
    get_price_history,
    get_quote_snapshots_for_symbols,
    search_symbols,
)
from indicators import get_technical_context
from journal import (
    build_sheet_rows,
    clean_text,
    editor_key,
    retain_historical_entries,
    sanitize_spreadsheet_frame,
    sheet_rows_to_entries,
    trigger_status,
)
from models import DIRECTIONS, TRIGGER_CONDITIONS
from news import get_stock_headlines


LOGGER = logging.getLogger(__name__)
load_dotenv()
init_db()

st.set_page_config(page_title="Stock Forecast Journal", page_icon="📈", layout="wide")

st.markdown(
    """
    <style>
        :root {
            --sheet-border: #d8dee9;
            --sheet-grid: #e7ebf2;
            --sheet-header: #f3f6fb;
            --sheet-text: #111827;
            --sheet-muted: #667085;
            --sheet-blue: #1d4ed8;
        }

        .stApp {
            background: #f7f9fc;
            color: var(--sheet-text);
        }

        .block-container {
            padding-top: 1.25rem;
            padding-bottom: 2rem;
            max-width: 1400px;
        }

        h1 {
            font-size: 1.65rem !important;
            line-height: 1.2 !important;
            margin-bottom: 0.15rem !important;
            color: #0f172a;
            letter-spacing: 0 !important;
        }

        h2, h3 {
            color: #111827;
            letter-spacing: 0 !important;
        }

        [data-testid="stCaptionContainer"] {
            color: var(--sheet-muted);
        }

        [data-testid="stMetric"] {
            background: #ffffff;
            border: 1px solid var(--sheet-border);
            border-radius: 6px;
            padding: 0.55rem 0.7rem;
        }

        [data-testid="stMetricLabel"] {
            color: var(--sheet-muted);
            font-size: 0.75rem;
        }

        [data-testid="stMetricValue"] {
            font-size: 1rem;
            font-variant-numeric: tabular-nums;
        }

        div[data-testid="stDataFrame"],
        div[data-testid="stDataEditor"] {
            border: 1px solid var(--sheet-border);
            border-radius: 6px;
            overflow: hidden;
            background: #ffffff;
        }

        div[data-testid="stDataFrame"] [role="columnheader"],
        div[data-testid="stDataEditor"] [role="columnheader"] {
            background: var(--sheet-header);
            color: #344054;
            font-weight: 650;
        }

        div[data-testid="stDataFrame"] [role="gridcell"],
        div[data-testid="stDataEditor"] [role="gridcell"] {
            border-color: var(--sheet-grid);
        }

        .stButton > button {
            border-radius: 6px;
            min-height: 2.35rem;
            font-weight: 650;
        }

        .stButton > button[kind="primary"] {
            background: var(--sheet-blue);
            border-color: var(--sheet-blue);
        }

        .stSelectbox, .stDateInput {
            background: transparent;
        }

        .sheet-note {
            color: var(--sheet-muted);
            font-size: 0.86rem;
            margin: -0.4rem 0 0.65rem;
        }
    </style>
    """,
    unsafe_allow_html=True,
)

st.title("📈 Stock Forecast Journal")
st.caption("Personal forecast journal. Local-first, reflection-only, not financial advice.")


def _default_prices() -> dict[str, float | None]:
    return {stock["symbol"]: None for stock in get_watchlist_stocks()}


def _default_quote_snapshots() -> dict[str, dict[str, float | None]]:
    return {
        stock["symbol"]: {
            "latest_price": None,
            "previous_close": None,
            "change": None,
            "change_pct": None,
        }
        for stock in get_watchlist_stocks()
    }


def _format_price(price: float | None) -> str:
    return "Unavailable" if price is None else f"${price:,.2f}"


def _format_signed(value: float | None, suffix: str = "") -> str:
    if value is None:
        return ""
    sign = "+" if value > 0 else ""
    return f"{sign}{value:,.2f}{suffix}"


def _build_sheet_df(
    stocks: list[dict[str, Any]],
    saved_entries: list[dict[str, Any]],
    draft_rows: list[dict[str, Any]] | None,
) -> pd.DataFrame:
    return pd.DataFrame(
        build_sheet_rows(
            stocks,
            saved_entries,
            st.session_state.quote_snapshots,
            draft_rows,
        )
    )


def _save_daily_log(rows: list[dict[str, Any]], log_date: str) -> None:
    replace_logs_by_date(log_date, rows)


def _validate_stock_sheet_edits(stock_sheet_df: pd.DataFrame) -> tuple[bool, str]:
    kept_rows = stock_sheet_df[~stock_sheet_df["Delete"]].copy()
    kept_rows["Stock"] = kept_rows["Stock"].map(clean_text)
    kept_rows["Symbol"] = kept_rows["Symbol"].map(lambda value: clean_text(value).upper())

    if kept_rows.empty:
        return False, "Keep at least one stock in the watchlist."
    if (kept_rows["Stock"] == "").any() or (kept_rows["Symbol"] == "").any():
        return False, "Every kept row needs both a stock name and a symbol."
    if kept_rows["Symbol"].duplicated().any():
        return False, "Symbols must be unique."
    return True, ""


def _apply_stock_sheet_edits(stock_sheet_df: pd.DataFrame) -> None:
    valid, message = _validate_stock_sheet_edits(stock_sheet_df)
    if not valid:
        st.error(message)
        return

    replace_watchlist_stocks(stock_sheet_df.to_dict("records"))

    kept_symbols = {
        clean_text(row["Symbol"]).upper()
        for _, row in stock_sheet_df.iterrows()
        if not bool(row["Delete"])
    }
    st.session_state.prices = {
        symbol: price
        for symbol, price in st.session_state.prices.items()
        if symbol in kept_symbols
    }
    st.session_state.quote_snapshots = {
        symbol: snapshot
        for symbol, snapshot in st.session_state.quote_snapshots.items()
        if symbol in kept_symbols
    }
    st.session_state.price_refresh_count += 1
    st.session_state.forecast_revision += 1
    st.success("Watchlist updated.")
    st.rerun()


def _build_triggers_df(triggers: list[dict[str, Any]]) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "ID": trigger["id"],
                "Delete": False,
                "Active": bool(trigger["active"]),
                "Symbol": trigger["symbol"],
                "Condition": trigger["condition_type"],
                "Threshold": trigger["threshold"],
                "Note": trigger.get("note") or "",
            }
            for trigger in triggers
        ]
    )


def _apply_trigger_edits(triggers_df: pd.DataFrame) -> None:
    replace_review_triggers(triggers_df.to_dict("records"))

    st.success("Review triggers updated.")
    st.rerun()


def _trigger_status_df(
    triggers: list[dict[str, Any]],
    quote_snapshots: dict[str, dict[str, float | None]],
) -> pd.DataFrame:
    rows = []
    for trigger in triggers:
        if not bool(trigger.get("active")):
            continue
        status = trigger_status(trigger, quote_snapshots)
        if status != "Triggered now":
            continue

        rows.append(
            {
                "Symbol": trigger["symbol"],
                "Condition": trigger["condition_type"],
                "Threshold": trigger["threshold"],
                "Status": status,
                "Note": trigger.get("note") or "",
            }
        )

    return pd.DataFrame(rows)


def _sheet_export_df(sheet_df: pd.DataFrame) -> pd.DataFrame:
    export_df = sheet_df.copy()
    private_columns = [column for column in ("ID", "_Saved Price") if column in export_df]
    if private_columns:
        export_df = export_df.drop(columns=private_columns)
    return sanitize_spreadsheet_frame(export_df)


def _to_xlsx_bytes(dataframes: dict[str, pd.DataFrame]) -> bytes:
    output = BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        for sheet_name, dataframe in dataframes.items():
            sanitize_spreadsheet_frame(dataframe).to_excel(
                writer,
                sheet_name=sheet_name[:31],
                index=False,
            )
    return output.getvalue()


@st.cache_data(ttl=900)
def _cached_price_history(symbol: str, period: str) -> pd.DataFrame:
    return get_price_history(symbol, period)


@st.cache_data(ttl=900)
def _cached_technical_context(symbol: str) -> dict[str, float | None]:
    return get_technical_context(symbol)


@st.cache_data(ttl=900)
def _cached_stock_headlines(
    symbol: str,
    company_name: str,
) -> list[dict[str, str]]:
    return get_stock_headlines(symbol, company_name)


@st.cache_data(ttl=900, max_entries=64, show_spinner=False)
def _cached_analysis_bars(symbol: str):
    return YahooFinanceProvider().fetch_daily_bars(
        symbol,
        datetime.now(timezone.utc),
    )


if "prices" not in st.session_state:
    st.session_state.prices = _default_prices()
if "quote_snapshots" not in st.session_state:
    st.session_state.quote_snapshots = _default_quote_snapshots()
if "price_refresh_count" not in st.session_state:
    st.session_state.price_refresh_count = 0
if "forecast_revision" not in st.session_state:
    st.session_state.forecast_revision = 0
if "forecast_drafts" not in st.session_state:
    st.session_state.forecast_drafts = {}
if "symbol_search_results" not in st.session_state:
    st.session_state.symbol_search_results = []
if "analysis_reports" not in st.session_state:
    st.session_state.analysis_reports = {}
if "journal_notice" in st.session_state:
    st.success(st.session_state.pop("journal_notice"))

stocks = get_watchlist_stocks()
for stock in stocks:
    st.session_state.prices.setdefault(stock["symbol"], None)
    st.session_state.quote_snapshots.setdefault(
        stock["symbol"],
        {
            "latest_price": None,
            "previous_close": None,
            "change": None,
            "change_pct": None,
        },
    )

stocks = get_watchlist_stocks()

header_left, header_right = st.columns([2.4, 1])
with header_left:
    selected_date = st.date_input("Log date", value=date.today())
    log_date = selected_date.isoformat()

with header_right:
    st.write("")
    if st.button("Refresh Prices", width="stretch"):
        with st.spinner("Refreshing prices..."):
            symbols = [stock["symbol"] for stock in stocks]
            st.session_state.quote_snapshots = get_quote_snapshots_for_symbols(symbols)
            st.session_state.prices = {
                symbol: snapshot.get("latest_price")
                for symbol, snapshot in st.session_state.quote_snapshots.items()
            }
            _cached_price_history.clear()
        st.session_state.price_refresh_count += 1
        st.session_state.forecast_revision += 1

price_values = [
    snapshot.get("latest_price")
    for snapshot in st.session_state.quote_snapshots.values()
    if snapshot.get("latest_price") is not None
]
change_values = [
    snapshot.get("change_pct")
    for snapshot in st.session_state.quote_snapshots.values()
    if snapshot.get("change_pct") is not None
]
average_change = round(sum(change_values) / len(change_values), 2) if change_values else None
metric_col_1, metric_col_2, metric_col_3, metric_col_4 = st.columns(4)
metric_col_1.metric("Stocks", f"{len(stocks)} symbols")
metric_col_2.metric("Prices loaded", f"{len(price_values)} / {len(stocks)}")
metric_col_3.metric(
    "Avg daily move",
    "Unavailable" if average_change is None else _format_signed(average_change, "%"),
)
metric_col_4.metric("Log date", log_date)

st.markdown("### Daily Forecast Sheet")
st.markdown(
    '<div class="sheet-note">Search to add stocks, edit stock cells directly, or mark rows for deletion. Saving the log excludes deleted rows.</div>',
    unsafe_allow_html=True,
)

with st.form("stock_search_form", clear_on_submit=False):
    search_col, search_button_col = st.columns([3, 1])
    with search_col:
        symbol_query = st.text_input(
            "Find stock to add",
            placeholder="Search by company name or ticker, e.g. Netflix or NFLX",
        )
    with search_button_col:
        st.write("")
        search_submitted = st.form_submit_button("Search Stocks", width="stretch")

    if search_submitted:
        with st.spinner("Searching symbols..."):
            st.session_state.symbol_search_results = search_symbols(symbol_query)
        if not st.session_state.symbol_search_results:
            st.warning("No matching stocks found.")

if st.session_state.symbol_search_results:
    existing_symbols = {stock["symbol"] for stock in stocks}
    result_options = {
        f"{result['symbol']} - {result['name']} ({result['exchange'] or result['type']})": result
        for result in st.session_state.symbol_search_results
    }
    pick_col, add_col = st.columns([3, 1])
    with pick_col:
        selected_result_label = st.selectbox("Available matches", list(result_options))
    with add_col:
        st.write("")
        if st.button("Add Selected Stock", width="stretch"):
            selected_result = result_options[selected_result_label]
            if selected_result["symbol"] in existing_symbols:
                st.info(f"{selected_result['symbol']} is already in the sheet.")
            else:
                try:
                    add_watchlist_stock(selected_result["name"], selected_result["symbol"])
                    st.session_state.prices[selected_result["symbol"]] = None
                    st.session_state.quote_snapshots[selected_result["symbol"]] = {
                        "latest_price": None,
                        "previous_close": None,
                        "change": None,
                        "change_pct": None,
                    }
                    st.session_state.symbol_search_results = []
                    st.session_state.price_refresh_count += 1
                    st.session_state.forecast_revision += 1
                    st.success(f"Added {selected_result['symbol']}.")
                    st.rerun()
                except Exception as exc:
                    st.error(f"Could not add stock: {exc}")

saved_entries = get_logs_by_date(log_date)
draft_rows = st.session_state.forecast_drafts.get(log_date)
forecast_sheet = st.data_editor(
    _build_sheet_df(stocks, saved_entries, draft_rows),
    key=editor_key(log_date, st.session_state.forecast_revision),
    width="stretch",
    hide_index=True,
    height=310,
    disabled=[
        "ID",
        "_Saved Price",
        "Latest Price",
        "Previous Close",
        "Change $",
        "Change %",
    ],
    column_order=[
        "Delete",
        "Stock",
        "Symbol",
        "Latest Price",
        "Previous Close",
        "Change $",
        "Change %",
        "Direction",
        "Confidence",
        "Target / Expectation",
        "Thesis",
    ],
    column_config={
        "ID": st.column_config.NumberColumn("ID", width="small"),
        "Delete": st.column_config.CheckboxColumn("Delete", width="small"),
        "Stock": st.column_config.TextColumn("Stock", width="small"),
        "Symbol": st.column_config.TextColumn("Symbol", width="small"),
        "Latest Price": st.column_config.TextColumn("Latest Price", width="small"),
        "Previous Close": st.column_config.TextColumn("Prev Close", width="small"),
        "Change $": st.column_config.TextColumn("Chg $", width="small"),
        "Change %": st.column_config.TextColumn("Chg %", width="small"),
        "Direction": st.column_config.SelectboxColumn(
            "Direction",
            options=list(DIRECTIONS),
            required=True,
            width="medium",
        ),
        "Target / Expectation": st.column_config.TextColumn(
            "Target / Expectation",
            width="medium",
        ),
        "Thesis": st.column_config.TextColumn("Thesis", width="medium"),
        "Confidence": st.column_config.NumberColumn(
            "Conf",
            min_value=0,
            max_value=100,
            step=5,
            format="%d",
            width="small",
        ),
    },
)
st.session_state.forecast_drafts[log_date] = forecast_sheet.to_dict("records")

export_df = _sheet_export_df(forecast_sheet)
export_col_1, export_col_2, export_col_3 = st.columns([1, 1, 2])
with export_col_1:
    st.download_button(
        "Download Sheet CSV",
        data=export_df.to_csv(index=False).encode("utf-8"),
        file_name=f"forecast-sheet-{log_date}.csv",
        mime="text/csv",
        width="stretch",
    )
with export_col_2:
    st.download_button(
        "Download Sheet XLSX",
        data=_to_xlsx_bytes({"Forecast": export_df}),
        file_name=f"forecast-sheet-{log_date}.xlsx",
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        width="stretch",
    )

apply_col, action_col, summary_col = st.columns(3)
with apply_col:
    if st.button("Apply Stock Changes", width="stretch"):
        try:
            _apply_stock_sheet_edits(forecast_sheet)
        except Exception as exc:
            st.error(f"Could not update stocks: {exc}")

with action_col:
    if st.button("Save Daily Log", type="primary", width="stretch"):
        try:
            rows, visible_symbols, deleted_symbols = sheet_rows_to_entries(
                forecast_sheet.to_dict("records"),
                log_date,
                st.session_state.quote_snapshots,
            )
            rows.extend(
                retain_historical_entries(
                    saved_entries,
                    visible_symbols,
                    deleted_symbols,
                    log_date,
                )
            )
            if not rows:
                st.error("There are no rows to save.")
            else:
                _save_daily_log(rows, log_date)
                st.session_state.forecast_drafts.pop(log_date, None)
                st.session_state.forecast_revision += 1
                st.session_state.journal_notice = f"Saved daily log for {log_date}."
                st.rerun()
        except ValueError as exc:
            st.error(str(exc))
        except Exception:
            st.error(
                "Could not save the daily log. Your existing entries were kept; "
                "please try again."
            )

with summary_col:
    if st.button("Generate AI Summary", width="stretch"):
        try:
            rows, _, _ = sheet_rows_to_entries(
                forecast_sheet.to_dict("records"),
                log_date,
                st.session_state.quote_snapshots,
            )
            with st.spinner("Generating summary..."):
                summary = summarize_daily_log(rows)
            st.markdown("### AI Summary")
            st.write(summary)
        except Exception as exc:
            st.error(f"AI summary failed: {exc}")

st.markdown("### Price Context")
st.markdown(
    '<div class="sheet-note">Read-only context for writing your own thesis. Not signals or advice.</div>',
    unsafe_allow_html=True,
)

stock_options = {
    f"{stock['symbol']} - {stock['stock_name']}": stock for stock in stocks
}
context_control_col_1, context_control_col_2 = st.columns([2, 1])
with context_control_col_1:
    selected_context_label = st.selectbox("Stock", list(stock_options))
with context_control_col_2:
    selected_period = st.selectbox("Chart period", ["1mo", "3mo", "6mo", "1y"], index=0)

selected_stock = stock_options[selected_context_label]
selected_symbol = selected_stock["symbol"]

chart_tab, indicators_tab, scenario_tab, headlines_tab = st.tabs(
    ["Price Chart", "Technical Context", "Scenario Analysis", "Headlines"]
)

with chart_tab:
    history_df = _cached_price_history(selected_symbol, selected_period)
    if history_df.empty:
        st.info("No chart data available for this symbol yet.")
    else:
        chart_df = history_df.copy()
        chart_df["Date"] = pd.to_datetime(chart_df["Date"]).dt.date
        st.line_chart(chart_df.set_index("Date")["Close"], height=260)

with indicators_tab:
    technical_context = _cached_technical_context(selected_symbol)
    indicator_df = pd.DataFrame(
        [
            {"Metric": "Latest close", "Value": _format_price(technical_context["latest_close"])},
            {"Metric": "20-day average", "Value": _format_price(technical_context["sma_20"])},
            {"Metric": "50-day average", "Value": _format_price(technical_context["sma_50"])},
            {
                "Metric": "RSI 14",
                "Value": ""
                if technical_context["rsi_14"] is None
                else f"{technical_context['rsi_14']:.2f}",
            },
            {"Metric": "52-week high", "Value": _format_price(technical_context["week_52_high"])},
            {"Metric": "52-week low", "Value": _format_price(technical_context["week_52_low"])},
            {
                "Metric": "Distance from 52w high",
                "Value": _format_signed(
                    technical_context["distance_from_52w_high_pct"],
                    "%",
                ),
            },
            {
                "Metric": "Distance from 52w low",
                "Value": _format_signed(
                    technical_context["distance_from_52w_low_pct"],
                    "%",
                ),
            },
        ]
    )
    st.dataframe(indicator_df, width="stretch", hide_index=True)

with scenario_tab:
    st.caption(
        "Descriptive completed-bar scenario evidence only. This is not a signal, "
        "recommendation, or prediction."
    )
    st.caption(
        "Ruleset v1 is a prototype for US-listed liquid large-cap stocks and broad/sector ETFs."
    )
    risk_col, commission_col, slippage_col, stop_col = st.columns(4)
    with risk_col:
        analysis_risk_budget = st.number_input(
            "Account risk amount (optional)",
            min_value=0.0,
            value=0.0,
            step=100.0,
            key=f"analysis_risk_{selected_symbol}",
            help="Maximum hypothetical monetary loss used only for position-size arithmetic.",
        )
    with commission_col:
        analysis_commission = st.number_input(
            "Commission per unit",
            min_value=0.0,
            value=0.0,
            step=0.01,
            key=f"analysis_commission_{selected_symbol}",
        )
    with slippage_col:
        analysis_slippage = st.number_input(
            "Expected slippage per unit",
            min_value=0.0,
            value=0.0,
            step=0.01,
            key=f"analysis_slippage_{selected_symbol}",
        )
    with stop_col:
        analysis_stop_override = st.number_input(
            "Execution-stop assumption (optional)",
            min_value=0.0,
            value=0.0,
            step=0.1,
            key=f"analysis_stop_{selected_symbol}",
            help=(
                "Zero shows only the ruleset's research stop geometry. Enter an explicit "
                "positive stop to enable position sizing when all other inputs are supplied."
            ),
        )

    if st.button(
        "Analyze completed bars",
        type="primary",
        width="stretch",
        key=f"run_analysis_{selected_symbol}",
    ):
        try:
            with st.spinner("Analyzing completed daily and weekly bars..."):
                analysis_as_of = datetime.now(timezone.utc)
                analysis_bars = _cached_analysis_bars(selected_symbol)
                analysis_request = AnalysisRequest(
                    symbol=selected_symbol,
                    as_of=analysis_as_of,
                    account_risk=(analysis_risk_budget or None),
                    commission_per_unit=analysis_commission,
                    expected_slippage_per_unit=analysis_slippage,
                    execution_stop_price=(analysis_stop_override or None),
                )
                analysis_report = AnalysisEngine().analyze(
                    analysis_request,
                    analysis_bars,
                )
            st.session_state.analysis_reports[selected_symbol] = analysis_report.to_dict()
        except ProviderError:
            st.warning("Completed OHLCV data is not available for this symbol right now.")
        except ContractError:
            st.warning("Market data did not pass the scenario-analysis validation checks.")
        except Exception as exc:
            LOGGER.warning("Scenario analysis failed (%s)", type(exc).__name__)
            st.warning("Scenario analysis is temporarily unavailable.")

    report_data = st.session_state.analysis_reports.get(selected_symbol)
    if report_data is None:
        st.info("Select the button above to evaluate the current completed-bar context.")
    else:
        status_labels = {
            "no_setup": "No rectangle setup detected",
            "scenario_detected": "Rectangle scenario available",
            "insufficient_data": "Insufficient completed data",
        }
        st.markdown(f"#### {status_labels.get(report_data['status'], 'Analysis result')}")
        st.write(report_data["summary"])
        st.caption(
            f"Ruleset {report_data['ruleset_version']} · Engine {report_data['engine_version']} · "
            f"Provider {report_data['provider']} · {report_data['adjustment_mode']} prices · "
            f"Generated {report_data['generated_at']}"
        )
        for warning in report_data.get("warnings", []):
            st.warning(warning)

        timeframe_rows = []
        level_rows = []
        for timeframe, context in report_data.get("timeframes", {}).items():
            timeframe_rows.append(
                {
                    "Timeframe": timeframe,
                    "Structure": context["structure"]["trend"],
                    "Reason": context["structure"]["reason"],
                    "Completed bars": context["bar_count"],
                    "Data through": context["last_bar"],
                    "ATR": context["atr"],
                    "Relative volume": context["relative_volume"],
                    "SMA 20": context["moving_averages"].get("sma_20"),
                    "SMA 50": context["moving_averages"].get("sma_50"),
                    "SMA 200": context["moving_averages"].get("sma_200"),
                }
            )
            for level in context.get("levels", []):
                level_rows.append(
                    {
                        "Timeframe": timeframe,
                        "Role": level["role"],
                        "Lower": level["lower"],
                        "Upper": level["upper"],
                        "Touches": level["touch_count"],
                        "Distance % (absolute)": level["distance_from_close_pct"],
                        "Last touch": level["last_touch"],
                    }
                )
        st.markdown("##### Structure and context")
        st.dataframe(pd.DataFrame(timeframe_rows), width="stretch", hide_index=True)
        if level_rows:
            st.markdown("##### Confirmed price zones")
            st.dataframe(pd.DataFrame(level_rows), width="stretch", hide_index=True)

        scenarios = report_data.get("scenarios", [])
        if not scenarios:
            st.info("The configured rectangle rules did not identify a current lifecycle record.")
        for scenario in scenarios:
            st.markdown("##### Rectangle lifecycle")
            scenario_metrics = st.columns(4)
            scenario_metrics[0].metric("Lifecycle", scenario["lifecycle_state"])
            scenario_metrics[1].metric("Direction", scenario["direction"])
            scenario_metrics[2].metric(
                "Range",
                f"${scenario['range_lower']:,.2f}–${scenario['range_upper']:,.2f}",
            )
            scenario_metrics[3].metric(
                "Measured target",
                _format_price(scenario["measured_target"]),
            )
            st.caption(
                f"Established {scenario['established_at']} · "
                f"Last event {scenario['last_event_at']}"
                + (
                    f" · Retested {scenario['retested_at']}"
                    if scenario.get("retested_at")
                    else ""
                )
                + (
                    f" · Terminal {scenario['terminal_at']}"
                    if scenario.get("terminal_at")
                    else ""
                )
            )
            st.write(f"**Confirmation:** {scenario['confirmation_condition']}")
            st.write(f"**Entry assumption:** {scenario['entry_trigger']}")
            st.write(f"**Analytical invalidation:** {scenario['analytical_invalidation']}")
            risk = scenario.get("risk")
            if risk:
                risk_rows = [
                    {"Metric": "Entry price assumption", "Value": _format_price(risk["entry_price"])},
                    {"Metric": "Execution-stop assumption", "Value": _format_price(risk["execution_stop_price"])},
                    {"Metric": "Risk per unit including costs", "Value": _format_price(risk["risk_per_unit"])},
                    {
                        "Metric": "Measured reward per unit",
                        "Value": _format_price(risk["reward_per_unit"]),
                    },
                    {
                        "Metric": "Measured reward/risk",
                        "Value": (
                            "Unavailable"
                            if risk["reward_risk_ratio"] is None
                            else f"{risk['reward_risk_ratio']:.2f}"
                        ),
                    },
                    {
                        "Metric": "Hypothetical position size",
                        "Value": "Unavailable" if risk["position_size"] is None else str(risk["position_size"]),
                    },
                ]
                st.markdown("##### Hypothetical risk arithmetic")
                st.dataframe(pd.DataFrame(risk_rows), width="stretch", hide_index=True)
            for warning in scenario.get("warnings", []):
                st.warning(warning)

        quality_evidence = [
            {
                "Rule": item["rule_id"],
                "Category": item["category"],
                "Status": item["status"],
                "Explanation": item["explanation"],
            }
            for item in report_data.get("evidence", [])
            if item["status"] in {"failed", "warning", "unknown"}
        ]
        if quality_evidence:
            with st.expander("Evidence requiring attention"):
                st.dataframe(
                    pd.DataFrame(quality_evidence),
                    width="stretch",
                    hide_index=True,
                )

with headlines_tab:
    headlines = _cached_stock_headlines(
        selected_symbol,
        selected_stock["stock_name"],
    )
    if not headlines:
        st.info("No recent headlines available right now.")
    else:
        for headline in headlines:
            source_text = headline["source"] or "News"
            published_text = f" · {headline['published']}" if headline["published"] else ""
            st.markdown(
                f"- [{headline['title']}]({headline['link']})  \n"
                f"  `{source_text}{published_text}`"
            )

st.markdown("### Review Triggers")
st.markdown(
    '<div class="sheet-note">Use triggers as reminders to revisit your journal, not as trade signals.</div>',
    unsafe_allow_html=True,
)

triggers = get_review_triggers()
current_symbols = [stock["symbol"] for stock in stocks]
trigger_symbols = sorted(
    set(current_symbols) | {trigger["symbol"] for trigger in triggers}
)
with st.form("trigger_form", clear_on_submit=True):
    trigger_col_1, trigger_col_2, trigger_col_3, trigger_col_4 = st.columns([1, 1.3, 1, 2])
    with trigger_col_1:
        trigger_symbol = st.selectbox("Symbol", current_symbols)
    with trigger_col_2:
        trigger_condition = st.selectbox("Condition", TRIGGER_CONDITIONS)
    with trigger_col_3:
        trigger_threshold = st.number_input("Threshold", value=0.0, step=1.0)
    with trigger_col_4:
        trigger_note = st.text_input("Review note", placeholder="What should I revisit?")

    trigger_submitted = st.form_submit_button("Add Review Trigger", width="stretch")
    if trigger_submitted:
        try:
            add_review_trigger(
                trigger_symbol,
                trigger_condition,
                trigger_threshold,
                trigger_note,
            )
            st.success("Review trigger added.")
            st.rerun()
        except Exception as exc:
            st.error(f"Could not add trigger: {exc}")

triggered_df = _trigger_status_df(triggers, st.session_state.quote_snapshots)
if not triggered_df.empty:
    st.markdown("#### Triggered Now")
    st.dataframe(triggered_df, width="stretch", hide_index=True)

if triggers:
    triggers_df = st.data_editor(
        _build_triggers_df(triggers),
        key=f"trigger_sheet_{st.session_state.price_refresh_count}_{len(triggers)}",
        width="stretch",
        hide_index=True,
        height=220,
        disabled=["ID"],
        column_order=[
            "Delete",
            "Active",
            "Symbol",
            "Condition",
            "Threshold",
            "Note",
            "ID",
        ],
        column_config={
            "ID": st.column_config.NumberColumn("ID", width="small"),
            "Delete": st.column_config.CheckboxColumn("Delete", width="small"),
            "Active": st.column_config.CheckboxColumn("Active", width="small"),
            "Symbol": st.column_config.SelectboxColumn(
                "Symbol",
                options=trigger_symbols,
                required=True,
                width="small",
            ),
            "Condition": st.column_config.SelectboxColumn(
                "Condition",
                options=list(TRIGGER_CONDITIONS),
                required=True,
                width="medium",
            ),
            "Threshold": st.column_config.NumberColumn(
                "Threshold",
                step=1.0,
                width="small",
            ),
            "Note": st.column_config.TextColumn("Note", width="large"),
        },
    )
    trigger_action_col, _trigger_spacer = st.columns([1, 3])
    with trigger_action_col:
        if st.button("Apply Trigger Changes", width="stretch"):
            try:
                _apply_trigger_edits(triggers_df)
            except Exception as exc:
                st.error(f"Could not update triggers: {exc}")
else:
    st.info("No review triggers yet.")

st.markdown("## 📚 Historical Logs")

logs = get_all_logs()
if not logs:
    st.info("No logs saved yet.")
else:
    logs_df = pd.DataFrame(logs)
    filter_col_1, filter_col_2, filter_col_3 = st.columns(3)

    with filter_col_1:
        date_options = ["All"] + sorted(logs_df["log_date"].dropna().unique(), reverse=True)
        selected_log_date = st.selectbox("Date filter", date_options)

    with filter_col_2:
        symbol_options = ["All"] + sorted(logs_df["symbol"].dropna().unique())
        selected_symbol = st.selectbox("Symbol filter", symbol_options)

    with filter_col_3:
        direction_options = ["All"] + sorted(logs_df["direction"].dropna().unique())
        selected_direction = st.selectbox("Direction filter", direction_options)

    filtered_df = logs_df.copy()
    if selected_log_date != "All":
        filtered_df = filtered_df[filtered_df["log_date"] == selected_log_date]
    if selected_symbol != "All":
        filtered_df = filtered_df[filtered_df["symbol"] == selected_symbol]
    if selected_direction != "All":
        filtered_df = filtered_df[filtered_df["direction"] == selected_direction]

    display_columns = [
        "log_date",
        "stock_name",
        "symbol",
        "price",
        "direction",
        "target",
        "thesis",
        "confidence",
        "created_at",
    ]
    history_display_df = filtered_df[display_columns]
    history_export_df = sanitize_spreadsheet_frame(history_display_df)
    history_export_col_1, history_export_col_2, _history_spacer = st.columns([1, 1, 2])
    with history_export_col_1:
        st.download_button(
            "Download Logs CSV",
            data=history_export_df.to_csv(index=False).encode("utf-8"),
            file_name="historical-logs.csv",
            mime="text/csv",
            width="stretch",
        )
    with history_export_col_2:
        st.download_button(
            "Download Logs XLSX",
            data=_to_xlsx_bytes({"Historical Logs": history_export_df}),
            file_name="historical-logs.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            width="stretch",
        )
    review_col, _review_spacer = st.columns([1, 3])
    with review_col:
        if st.button("Review Forecast Habits", width="stretch"):
            try:
                review_rows = filtered_df.sort_values(
                    ["log_date", "stock_name"],
                    ascending=[False, True],
                ).head(60)
                with st.spinner("Reviewing journal habits..."):
                    habit_review = summarize_journal_habits(review_rows.to_dict("records"))
                st.markdown("### Forecast Habit Review")
                st.write(habit_review)
            except Exception as exc:
                st.error(f"Habit review failed: {exc}")
    st.dataframe(history_display_df, width="stretch", hide_index=True)
