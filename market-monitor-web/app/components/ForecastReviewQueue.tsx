'use client';

import { useMemo, useState } from 'react';
import {
  evaluationCurrency,
  evaluationPresentation,
  filterReviewItems,
  readableEvaluationReason,
  type ReviewVisibility,
} from '../lib/evaluation';
import {
  forecastStatusLabel,
  forecastTargetLabel,
  formatForecastMoney,
  formatInstant,
  formatLocalDate,
} from '../lib/forecasts';
import type { ForecastReviewItem } from '../lib/types';
import AccessibleDialog from './AccessibleDialog';

type InspectSection = 'forecast' | 'snapshot' | 'audit';

type Props = {
  items: ForecastReviewItem[];
  visibility: ReviewVisibility;
  loading: boolean;
  error: string | null;
  onVisibilityChange: (visibility: ReviewVisibility) => void;
  onRefresh: () => void;
  onInspect: (forecastId: number, section: InspectSection) => void;
  onAcknowledge: (item: ForecastReviewItem) => Promise<void>;
};

function ReviewCard({ item, onInspect, onRequestAcknowledge }: {
  item: ForecastReviewItem;
  onInspect: (forecastId: number, section: InspectSection) => void;
  onRequestAcknowledge: (item: ForecastReviewItem) => void;
}) {
  const presentation = evaluationPresentation(item.run.resultKind, item.run.reasonCode);
  const currency = evaluationCurrency(item.run);
  const trigger = item.run.evidence.triggering_observation;
  const warnings = [...new Set([...item.run.warnings, ...item.run.evidence.warnings])];
  return <article className={`review-card ${presentation.tone}`} aria-label={`${item.symbol} ${presentation.eyebrow}`}>
    <header>
      <div><span className={`review-result ${presentation.tone}`}>{presentation.eyebrow}</span><h4>{item.symbol} · {presentation.heading}</h4><p>{presentation.description}</p></div>
      <span className={`forecast-status ${item.forecastStatus}`}>{forecastStatusLabel(item.forecastStatus)}</span>
    </header>
    <div className="review-explanation"><strong>{readableEvaluationReason(item.run.reasonCode)}</strong><p>{item.run.explanation}</p></div>
    <dl className="review-facts">
      <div><dt>Result</dt><dd>{readableEvaluationReason(item.run.resultKind)}</dd></div>
      <div><dt>Previous status</dt><dd>{forecastStatusLabel('active')}</dd></div>
      <div><dt>Current status</dt><dd>{forecastStatusLabel(item.forecastStatus)}</dd></div>
      <div><dt>Target</dt><dd>{forecastTargetLabel(item.target, currency)}</dd></div>
      <div><dt>Invalidation</dt><dd>{formatForecastMoney(item.invalidationPrice, currency)}</dd></div>
      <div><dt>Evaluated through</dt><dd>{formatLocalDate(item.run.evaluatedThrough)}</dd></div>
      <div><dt>Evaluation cutoff</dt><dd>{formatInstant(item.run.evaluationCutoff)}</dd></div>
      <div><dt>Evaluator</dt><dd>{item.run.evaluatorVersion}</dd></div>
      <div><dt>Ruleset</dt><dd>{item.run.rulesetVersion}</dd></div>
    </dl>
    {trigger && <section className="review-trigger" aria-label="Triggering completed bar">
      <div><strong>Triggering completed bar</strong><span>{formatLocalDate(trigger.market_date)} · {trigger.provider} · {readableEvaluationReason(item.run.evidence.detected_at ?? 'time_unknown')}</span></div>
      <dl><div><dt>Open</dt><dd>{formatForecastMoney(trigger.open, currency)}</dd></div><div><dt>High</dt><dd>{formatForecastMoney(trigger.high, currency)}</dd></div><div><dt>Low</dt><dd>{formatForecastMoney(trigger.low, currency)}</dd></div><div><dt>Close</dt><dd>{formatForecastMoney(trigger.close, currency)}</dd></div></dl>
    </section>}
    {warnings.length > 0 && <details className="review-warnings"><summary>{warnings.length} evaluation {warnings.length === 1 ? 'warning' : 'warnings'}</summary><ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
    <footer>
      <div><button className="link-button" onClick={() => onInspect(item.forecastId, 'forecast')}>Immutable forecast</button>{item.analysisSnapshotId && <button className="link-button" onClick={() => onInspect(item.forecastId, 'snapshot')}>Analysis snapshot</button>}<button className="link-button" onClick={() => onInspect(item.forecastId, 'audit')}>Audit history</button></div>
      {item.acknowledgedAt
        ? <span className="review-acknowledged">Acknowledged {formatInstant(item.acknowledgedAt)}</span>
        : <button className="secondary-button" onClick={() => onRequestAcknowledge(item)}>Acknowledge review</button>}
    </footer>
  </article>;
}

function ReviewSection({ title, copy, items, onInspect, onRequestAcknowledge }: {
  title: string;
  copy: string;
  items: ForecastReviewItem[];
  onInspect: (forecastId: number, section: InspectSection) => void;
  onRequestAcknowledge: (item: ForecastReviewItem) => void;
}) {
  if (!items.length) return null;
  return <section className="review-section"><div className="review-section-heading"><div><h3>{title}</h3><p>{copy}</p></div><span>{items.length}</span></div><div className="review-card-grid">{items.map((item) => <ReviewCard key={item.id} item={item} onInspect={onInspect} onRequestAcknowledge={onRequestAcknowledge} />)}</div></section>;
}

export default function ForecastReviewQueue({ items, visibility, loading, error, onVisibilityChange, onRefresh, onInspect, onAcknowledge }: Props) {
  const [confirmation, setConfirmation] = useState<ForecastReviewItem | null>(null);
  const [acknowledging, setAcknowledging] = useState(false);
  const [acknowledgeError, setAcknowledgeError] = useState<string | null>(null);
  const visible = useMemo(() => filterReviewItems(items, visibility), [items, visibility]);
  const open = visible.filter((item) => !item.acknowledgedAt);
  const acknowledged = visible.filter((item) => Boolean(item.acknowledgedAt));

  const confirmAcknowledgement = async () => {
    if (!confirmation) return;
    setAcknowledging(true);
    setAcknowledgeError(null);
    try {
      await onAcknowledge(confirmation);
      setConfirmation(null);
    } catch (requestError) {
      setAcknowledgeError(requestError instanceof Error ? requestError.message : 'The review could not be acknowledged.');
    } finally {
      setAcknowledging(false);
    }
  };

  return <>
    <section className="panel forecast-review-queue" aria-labelledby="forecast-review-heading" aria-busy={loading}>
      <div className="review-queue-heading"><div><p className="section-label">Manual evaluation</p><h2 id="forecast-review-heading">Review Queue</h2><p>Inspect proven resolutions and evidence that Northstar deliberately left for human review. Acknowledgement records that you saw the result; it never changes the evaluator output.</p></div><div><label><span>Show</span><select value={visibility} onChange={(event) => onVisibilityChange(event.target.value as ReviewVisibility)}><option value="unacknowledged">Needs acknowledgement</option><option value="acknowledged">Acknowledged</option><option value="all">All review items</option></select></label><button className="secondary-button" onClick={onRefresh} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh queue'}</button></div></div>
      {error && <div className="forecast-inline-error" role="alert"><strong>Review Queue unavailable.</strong> {error} <button className="link-button" onClick={onRefresh}>Try again</button></div>}
      {loading && !items.length ? <div className="review-queue-state" role="status">Loading durable evaluation history…</div>
        : !visible.length ? <div className="review-queue-state"><strong>{visibility === 'unacknowledged' ? 'Nothing needs acknowledgement.' : 'No review items in this view.'}</strong><span>Manual evaluations that resolve a forecast or require evidence review will appear here.</span></div>
          : <div className="review-sections"><ReviewSection title="Needs acknowledgement" copy="Newly resolved or deliberately ambiguous evaluations" items={open} onInspect={onInspect} onRequestAcknowledge={(item) => { setAcknowledgeError(null); setConfirmation(item); }} /><ReviewSection title="Acknowledged history" copy="Preserved evaluator results you have reviewed" items={acknowledged} onInspect={onInspect} onRequestAcknowledge={(item) => { setAcknowledgeError(null); setConfirmation(item); }} /></div>}
    </section>
    {confirmation && <AccessibleDialog eyebrow="Append-only acknowledgement" title={`Acknowledge ${confirmation.symbol} evaluation?`} className="small review-ack-dialog" onClose={acknowledging ? () => undefined : () => setConfirmation(null)}>
      <div className="freeze-callout"><span>✓</span><div><strong>This confirms review only.</strong><p>The automated result and evidence remain immutable. This action does not resolve, override, or reclassify the forecast.</p></div></div>
      <dl className="activation-summary"><div><dt>Evaluation</dt><dd>{evaluationPresentation(confirmation.run.resultKind, confirmation.run.reasonCode).eyebrow}</dd></div><div><dt>Reason</dt><dd>{readableEvaluationReason(confirmation.run.reasonCode)}</dd></div></dl>
      {acknowledgeError && <div className="form-error" role="alert">{acknowledgeError}</div>}
      <div className="modal-actions"><button className="secondary-button" onClick={() => setConfirmation(null)} disabled={acknowledging}>Back</button><button className="primary-button" data-autofocus onClick={() => void confirmAcknowledgement()} disabled={acknowledging}>{acknowledging ? 'Recording acknowledgement…' : 'Confirm acknowledgement'}</button></div>
    </AccessibleDialog>}
  </>;
}
