'use client';

import {
  forecastStatusLabel,
  forecastTargetLabel,
  formatForecastMoney,
  formatInstant,
  formatLocalDate,
} from '../lib/forecasts';
import type { Forecast } from '../lib/types';
import { ForecastEvaluationState, type EvaluationFeedback } from './ForecastEvaluationDialog';

type Props = {
  forecast: Forecast;
  currency: string;
  onEdit: () => void;
  onDelete: () => void;
  onActivate: () => void;
  onCancel: () => void;
  onNote: () => void;
  onEvaluate: () => void;
  evaluationFeedback: EvaluationFeedback | null;
};

function readable(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function ForecastDetail({ forecast, currency, onEdit, onDelete, onActivate, onCancel, onNote, onEvaluate, evaluationFeedback }: Props) {
  const displayCurrency = forecast.activationCurrency ?? currency;
  const draft = forecast.status === 'draft';
  const active = forecast.status === 'active';
  const snapshot = forecast.analysisSnapshot;
  const report = snapshot?.report;
  return <article id={`forecast-detail-${forecast.id}`} className="panel forecast-detail" aria-label={`${forecast.symbol} forecast detail`}>
    <div className="forecast-detail-heading">
      <div><span className={`forecast-status ${forecast.status}`}>{forecastStatusLabel(forecast.status)}</span><div className="forecast-symbol-line"><span className={`direction ${forecast.direction}`}>{forecast.direction}</span><h2>{forecast.symbol}</h2><small>{forecast.confidence}% confidence</small></div><p>{forecast.setupTag}</p></div>
      <div className="forecast-detail-actions">
        {draft && <><button className="secondary-button" onClick={onEdit}>Edit draft</button><button className="primary-button" onClick={onActivate}>Activate</button></>}
        {active && <><button className="primary-button" onClick={onEvaluate} disabled={evaluationFeedback?.state === 'running'}>{evaluationFeedback?.state === 'running' ? 'Evaluating…' : 'Evaluate now'}</button><button className="secondary-button" onClick={onNote}>Add note</button><button className="danger-ghost" onClick={onCancel}>Cancel</button></>}
        {!draft && !active && <button className="secondary-button" onClick={onNote}>Add review note</button>}
      </div>
    </div>

    {active && <ForecastEvaluationState feedback={evaluationFeedback} />}

    <div className={`forecast-lock-state ${draft ? 'editable' : 'locked'}`}><span>{draft ? '✎' : '⌁'}</span><div><strong>{draft ? 'Editable draft' : 'Activated snapshot locked'}</strong><p>{draft ? 'Revise this forecast until you are ready to capture a real market snapshot.' : 'The original thesis and measurable conditions are preserved. Later notes appear only in the event history.'}</p></div></div>

    {draft && forecast.pendingAnalysis && <div className="forecast-pending-analysis"><span>◎</span><div><strong>Completed-bar report saved with this draft</strong><p>{readable(forecast.pendingAnalysis.lifecycleState)} · {forecast.pendingAnalysis.provider} · generated {formatInstant(forecast.pendingAnalysis.generatedAt)}. It becomes immutable when this forecast is activated.</p></div></div>}

    <dl className="forecast-metric-grid">
      <div><dt>Activation price</dt><dd>{draft ? 'Captured on activation' : formatForecastMoney(forecast.activationPrice, displayCurrency)}</dd></div>
      <div><dt>Target</dt><dd>{forecastTargetLabel(forecast.target, displayCurrency)}</dd></div>
      <div><dt>Invalidation</dt><dd>{formatForecastMoney(forecast.invalidationPrice, displayCurrency)}</dd></div>
      <div><dt>Evaluation date</dt><dd>{formatLocalDate(forecast.evaluationDate)}</dd></div>
    </dl>

    {!draft && <dl className="forecast-time-grid">
      <div><dt>Activated — local display time</dt><dd>{formatInstant(forecast.activatedAt)}</dd></div>
      <div><dt>Provider market data as of</dt><dd>{formatInstant(forecast.marketDataAsOf)}</dd></div>
      {forecast.marketProvider && <div><dt>Market provider</dt><dd>{forecast.marketProvider}</dd></div>}
      {forecast.resolvedAt && <div><dt>Resolved</dt><dd>{formatInstant(forecast.resolvedAt)}</dd></div>}
    </dl>}

    <section className="forecast-narrative"><div><span>Thesis</span><p>{forecast.thesis}</p></div><div><span>Supporting evidence</span><p>{forecast.supportingEvidence}</p></div><div className="counter"><span>Counter-evidence</span><p>{forecast.counterEvidence}</p></div></section>

    {forecast.resolutionReason && <div className="forecast-resolution"><strong>Resolution reason</strong><p>{forecast.resolutionReason}</p></div>}

    {snapshot && <section id={`forecast-snapshot-${forecast.id}`} className="forecast-analysis-snapshot">
      <div className="snapshot-heading"><div><p className="section-label">Immutable analysis snapshot</p><h3>{readable(snapshot.lifecycleState)} {readable(snapshot.setup)} scenario</h3></div><span>{snapshot.scenarioId}</span></div>
      <dl className="analysis-meta">
        <div><dt>Report generated — local time</dt><dd>{formatInstant(snapshot.generatedAt)}</dd></div>
        <div><dt>Analysis data as of</dt><dd>{formatInstant(snapshot.analysisAsOf)}</dd></div>
        <div><dt>Completed bar as of</dt><dd>{formatInstant(snapshot.completedBarAsOf || snapshot.analysisAsOf)}</dd></div>
        <div><dt>Provider / prices</dt><dd>{snapshot.provider} · {readable(snapshot.adjustmentMode)}</dd></div>
        <div><dt>Versions</dt><dd>{snapshot.rulesetVersion} · engine {snapshot.engineVersion}</dd></div>
        <div><dt>Timeframe / data hash</dt><dd>{snapshot.timeframe} · {snapshot.dataHash.slice(0, 10)}…</dd></div>
      </dl>
      <dl className="snapshot-geometry"><div><dt>Direction</dt><dd>{readable(snapshot.direction)}</dd></div><div><dt>Frozen range</dt><dd>{formatForecastMoney(snapshot.rangeLower, displayCurrency)}–{formatForecastMoney(snapshot.rangeUpper, displayCurrency)}</dd></div><div><dt>Range height</dt><dd>{formatForecastMoney(snapshot.rangeHeight, displayCurrency)}</dd></div><div><dt>Measured target</dt><dd>{formatForecastMoney(snapshot.measuredTarget, displayCurrency)}</dd></div></dl>
      {snapshot.warnings.map((warning) => <div className="analysis-callout" key={warning}>{warning}</div>)}
      {snapshot.evidence.length > 0 && <details className="analysis-evidence"><summary>Saved machine-readable evidence ({snapshot.evidence.length})</summary><ul>{snapshot.evidence.map((item) => <li key={item.rule_id}><strong>{readable(item.status)} · {item.rule_id}</strong><span>{item.explanation}</span></li>)}</ul></details>}
      {report && <details className="snapshot-raw"><summary>Original analysis report</summary><pre>{JSON.stringify(report, null, 2)}</pre></details>}
    </section>}

    <section id={`forecast-audit-${forecast.id}`} className="forecast-events"><div className="feed-heading"><div><p className="section-label">Audit trail</p><h3>Forecast history</h3></div><span>{forecast.events.length} events</span></div>{forecast.events.length ? <ol>{forecast.events.map((event) => <li key={event.id}><span className="event-mark" /><div><div><strong>{readable(event.eventType)}</strong><time dateTime={event.createdAt}>{formatInstant(event.createdAt)}</time></div>{event.note && <p>{event.note}</p>}<small>Revision {event.revision}</small></div></li>)}</ol> : <p className="events-empty">The creation event will appear here when history is available.</p>}</section>

    {draft && <div className="forecast-delete-row"><button onClick={onDelete}>Delete draft</button><span>Only editable drafts can be deleted.</span></div>}
  </article>;
}
