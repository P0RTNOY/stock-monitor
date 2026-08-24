'use client';

import { FormEvent } from 'react';
import { forecastSeedFromScenario } from '../lib/forecasts';
import type {
  AnalysisAssumptions,
  AnalysisLevel,
  AnalysisTimeframe,
  ForecastSeed,
  TechnicalAnalysisReport,
} from '../lib/types';

type Props = {
  symbol: string;
  report?: TechnicalAnalysisReport;
  error?: string;
  analyzing: boolean;
  currency: string;
  onAnalyze: (assumptions: AnalysisAssumptions) => Promise<void>;
  onCreateForecast: (seed: ForecastSeed) => void;
};

const statusLabels: Record<TechnicalAnalysisReport['status'], string> = {
  no_setup: 'No current rectangle setup detected',
  scenario_detected: 'Rectangle lifecycle detected',
  insufficient_data: 'Insufficient completed data',
};

function money(value: number | null | undefined, currency: string) {
  if (value === null || value === undefined) return 'Unavailable';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function number(value: number | null | undefined, digits = 2) {
  return value === null || value === undefined ? 'Unavailable' : value.toFixed(digits);
}

function readableState(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortDate(value: string | null | undefined) {
  if (!value) return 'Unavailable';
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formNumber(form: FormData, field: string, optional: true): number | null;
function formNumber(form: FormData, field: string, optional?: false): number;
function formNumber(form: FormData, field: string, optional = false) {
  const raw = String(form.get(field) ?? '').trim();
  if (!raw && optional) return null;
  return Number(raw);
}

function ZoneTable({ levels, label, currency }: { levels: AnalysisLevel[]; label: string; currency: string }) {
  if (!levels.length) return <p className="analysis-empty-copy">No confirmed zones in this view.</p>;
  return <div className="analysis-table-scroll"><table className="analysis-table"><caption>{label}</caption><thead><tr><th>Role</th><th>Zone</th><th>Touches</th><th>Last touch</th></tr></thead><tbody>{levels.slice(0, 3).map((level, index) => <tr key={`${level.role}-${level.lower}-${index}`}><td>{readableState(level.role)}</td><td>{money(level.lower, currency)}–{money(level.upper, currency)}</td><td>{level.touch_count}</td><td>{shortDate(level.last_touch)}</td></tr>)}</tbody></table></div>;
}

function TimeframeCard({ context, currency }: { context: AnalysisTimeframe; currency: string }) {
  return <article className="analysis-timeframe-card">
    <div className="analysis-card-heading"><div><span>{context.timeframe === '1wk' ? 'Weekly' : 'Daily'}</span><strong>{readableState(context.structure.trend)}</strong></div><small>{context.bar_count} completed bars</small></div>
    <p>{context.structure.reason}</p>
    <dl className="analysis-fact-grid">
      <div><dt>Data through</dt><dd>{shortDate(context.last_bar)}</dd></div>
      <div><dt>ATR</dt><dd>{number(context.atr)}</dd></div>
      <div><dt>Relative volume</dt><dd>{number(context.relative_volume)}</dd></div>
      <div><dt>SMA 20 / 50 / 200</dt><dd>{number(context.moving_averages.sma_20)} / {number(context.moving_averages.sma_50)} / {number(context.moving_averages.sma_200)}</dd></div>
    </dl>
    <ZoneTable levels={context.levels} label={`${context.timeframe} confirmed price zones`} currency={currency} />
  </article>;
}

export default function TechnicalAnalysisPanel({
  symbol,
  report,
  error,
  analyzing,
  currency,
  onAnalyze,
  onCreateForecast,
}: Props) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void onAnalyze({
      accountRisk: formNumber(form, 'accountRisk', true),
      commissionPerUnit: formNumber(form, 'commissionPerUnit'),
      expectedSlippagePerUnit: formNumber(form, 'expectedSlippagePerUnit'),
      executionStopPrice: formNumber(form, 'executionStopPrice', true),
    });
  };
  const contexts = ['1wk', '1d']
    .map((timeframe) => report?.timeframes[timeframe])
    .filter((context): context is AnalysisTimeframe => Boolean(context));
  const scenario = report?.scenarios[0];
  const forecastSeed = report && scenario ? forecastSeedFromScenario(report, scenario) : null;
  const attentionEvidence = report?.evidence.filter((item) => item.status !== 'passed' && item.status !== 'not_applicable') ?? [];

  return <section className="panel full-panel analysis-panel" aria-busy={analyzing}>
    <div className="analysis-heading">
      <div><p className="section-label">Completed-bar analysis</p><h3>{symbol} structure and scenarios</h3></div>
      <span className="analysis-scope">Ruleset v1 · liquid US large caps and broad/sector ETFs</span>
    </div>
    <p className="analysis-disclaimer">Descriptive scenario evidence only—not a signal, recommendation, or prediction.</p>
    <form className="analysis-form" onSubmit={submit}>
      <label><span>Account risk amount <small>optional</small></span><input name="accountRisk" type="number" min="0.01" step="0.01" placeholder="1000" /></label>
      <label><span>Commission / unit</span><input name="commissionPerUnit" type="number" min="0" step="0.01" defaultValue="0" required /></label>
      <label><span>Slippage / unit</span><input name="expectedSlippagePerUnit" type="number" min="0" step="0.01" defaultValue="0" required /></label>
      <label><span>Execution-stop assumption <small>optional</small></span><input name="executionStopPrice" type="number" min="0.01" step="0.01" placeholder="Price" /></label>
      <button className="primary-small" disabled={analyzing}>{analyzing ? 'Analyzing…' : report ? 'Refresh completed-bar report' : 'Analyze completed bars'}</button>
    </form>
    <p className="analysis-input-help">Hypothetical position size is shown only for an active confirmed/retest scenario when all four assumptions are explicit. Zero costs are allowed.</p>

    <div aria-live="polite">
      {error && <div className="analysis-error" role="alert">{report ? `Refresh failed. Showing the report generated ${shortDate(report.generated_at)}.` : error}</div>}
      {!report && !error && !analyzing && <div className="analysis-empty"><span>◎</span><div><strong>No report requested</strong><p>Run the explicit completed-bar analysis for {symbol}. Reports stay in this browser session as you move through Northstar.</p></div></div>}
      {!report && analyzing && <div className="analysis-empty"><span>…</span><div><strong>Analyzing completed bars</strong><p>Building daily and weekly structure, levels, and rectangle evidence.</p></div></div>}
    </div>

    {report && <div className="analysis-report">
      <div className="analysis-status"><div><span>{statusLabels[report.status]}</span><p>{report.summary}</p></div><strong>{report.symbol}</strong></div>
      <dl className="analysis-meta">
        <div><dt>Generated — local time</dt><dd>{shortDate(report.generated_at)}</dd></div>
        <div><dt>Analysis as of</dt><dd>{shortDate(report.as_of)}</dd></div>
        <div><dt>Provider</dt><dd>{report.provider}</dd></div>
        <div><dt>Prices</dt><dd>{readableState(report.adjustment_mode)}</dd></div>
        <div><dt>Versions</dt><dd>{report.ruleset_version} · engine {report.engine_version}</dd></div>
      </dl>
      {report.warnings.map((warning) => <div className="analysis-callout" key={warning}>{warning}</div>)}

      <div className="analysis-timeframes">{contexts.map((context) => <TimeframeCard context={context} currency={currency} key={context.timeframe} />)}</div>

      {scenario && <article className="analysis-scenario">
        <div className="analysis-scenario-title"><div><p className="section-label">Rectangle lifecycle</p><h4>{readableState(scenario.lifecycle_state)}</h4></div><div className="analysis-scenario-actions"><span>{readableState(scenario.direction)} direction</span>{forecastSeed && <button className="primary-small" onClick={() => onCreateForecast(forecastSeed)}>Create forecast from this scenario</button>}</div></div>
        <dl className="analysis-scenario-grid">
          <div><dt>Frozen range</dt><dd>{money(scenario.range_lower, currency)}–{money(scenario.range_upper, currency)}</dd></div>
          <div><dt>Measured-move estimate</dt><dd>{money(scenario.measured_target, currency)}</dd></div>
          <div><dt>Established</dt><dd>{shortDate(scenario.established_at)}</dd></div>
          <div><dt>Last lifecycle event</dt><dd>{shortDate(scenario.last_event_at)}</dd></div>
          {scenario.retested_at && <div><dt>First retest</dt><dd>{shortDate(scenario.retested_at)}</dd></div>}
          {scenario.terminal_at && <div><dt>Terminal event</dt><dd>{shortDate(scenario.terminal_at)}</dd></div>}
        </dl>
        <div className="analysis-copy-grid"><div><span>Confirmation condition</span><p>{scenario.confirmation_condition}</p></div><div><span>Research entry assumption</span><p>{scenario.entry_trigger}</p></div><div><span>Analytical invalidation</span><p>{scenario.analytical_invalidation}</p></div></div>
        {scenario.intermediate_levels.length > 0 && <ZoneTable levels={scenario.intermediate_levels} label="Intermediate zones between entry and measured move" currency={currency} />}
        {scenario.risk && <div className="analysis-risk"><div><p className="section-label">Hypothetical research arithmetic</p><h4>Risk geometry</h4></div><dl><div><dt>Entry assumption</dt><dd>{money(scenario.risk.entry_price, currency)}</dd></div><div><dt>Execution-stop assumption</dt><dd>{money(scenario.risk.execution_stop_price, currency)}</dd></div><div><dt>Risk per unit</dt><dd>{money(scenario.risk.risk_per_unit, currency)}</dd></div><div><dt>Reward per unit</dt><dd>{money(scenario.risk.reward_per_unit, currency)}</dd></div><div><dt>Reward / risk</dt><dd>{number(scenario.risk.reward_risk_ratio)}</dd></div><div><dt>Hypothetical position size</dt><dd>{scenario.risk.position_size === null ? 'Unavailable' : scenario.risk.position_size.toLocaleString()}</dd></div></dl></div>}
        {scenario.warnings.map((warning) => <div className="analysis-callout" key={warning}>{warning}</div>)}
      </article>}

      {attentionEvidence.length > 0 && <details className="analysis-evidence"><summary>Evidence requiring attention ({attentionEvidence.length})</summary><ul>{attentionEvidence.map((item) => <li key={item.rule_id}><strong>{readableState(item.status)} · {item.rule_id}</strong><span>{item.explanation}</span></li>)}</ul></details>}
    </div>}
  </section>;
}
