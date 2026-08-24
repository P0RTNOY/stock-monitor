'use client';

import { evaluationPresentation, readableEvaluationReason } from '../lib/evaluation';
import type { EvaluationRun, Forecast } from '../lib/types';
import AccessibleDialog from './AccessibleDialog';

export type EvaluationFeedback = {
  state: 'loading' | 'idle' | 'running' | 'complete' | 'error' | 'history-error';
  run?: EvaluationRun;
  duplicate?: boolean;
  message?: string;
  providerUnavailable?: boolean;
};

export function ForecastEvaluationState({ feedback }: { feedback: EvaluationFeedback | null }) {
  if (!feedback || feedback.state === 'loading') return <div className="evaluation-state pending" role="status"><strong>Loading evaluation history…</strong><p>Northstar is checking for the latest durable evaluation run.</p></div>;
  if (feedback.state === 'idle') return <div className="evaluation-state pending"><strong>Pending evaluation</strong><p>No durable evaluation run exists yet. Evaluation is manual in this phase.</p></div>;
  if (feedback.state === 'running') return <div className="evaluation-state running" role="status" aria-live="polite"><strong>Evaluating completed bars…</strong><p>The trusted provider history is being normalized and checked against the frozen forecast.</p></div>;
  if (feedback.state === 'history-error') return <div className="evaluation-state error" role="alert"><strong>Evaluation history unavailable</strong><p>{feedback.message}</p><small>Northstar cannot confirm whether a durable latest run exists, so no pending-state claim is shown.</small></div>;
  if (feedback.state === 'error') return <div className={`evaluation-state ${feedback.providerUnavailable ? 'provider-unavailable' : 'error'}`} role="alert"><strong>{feedback.providerUnavailable ? 'Evaluation provider unavailable' : 'Evaluation could not be completed'}</strong><p>{feedback.message}</p><small>The forecast remains unchanged. No result was fabricated or stored.</small></div>;
  const presentation = evaluationPresentation(feedback.run?.resultKind ?? 'no_change', feedback.run?.reasonCode);
  return <div className={`evaluation-state ${presentation.tone}`} role="status" aria-live="polite"><strong>{presentation.eyebrow}: {presentation.heading}</strong><p>{feedback.run?.explanation ?? presentation.description}</p><small>{feedback.duplicate ? 'This identical evaluation was already stored.' : `Reason: ${readableEvaluationReason(feedback.run?.reasonCode ?? '')}`}</small></div>;
}

export default function ForecastEvaluationDialog({ forecast, busy, error, onClose, onConfirm }: {
  forecast: Forecast;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  return <AccessibleDialog eyebrow="Deterministic evaluation" title={`Evaluate ${forecast.symbol} now?`} className="small evaluation-dialog" onClose={busy ? () => undefined : onClose}>
    <div className="freeze-callout"><span>◎</span><div><strong>This may create a terminal lifecycle event.</strong><p>Northstar will fetch trusted completed bars and apply the frozen ruleset. Proven outcomes may close the forecast; ambiguous evidence will leave it active and create a review item.</p></div></div>
    <p className="dialog-copy">No browser quote or editable data will be used. Provider failure leaves the forecast unchanged.</p>
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="modal-actions"><button className="secondary-button" onClick={onClose} disabled={busy}>Back</button><button className="primary-button" data-autofocus onClick={() => void onConfirm()} disabled={busy}>{busy ? 'Evaluating completed bars…' : 'Confirm evaluation'}</button></div>
  </AccessibleDialog>;
}
