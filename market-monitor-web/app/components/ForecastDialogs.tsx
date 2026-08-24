'use client';

import { type FormEvent, useState } from 'react';
import { forecastTargetLabel, formatLocalDate } from '../lib/forecasts';
import type { Forecast } from '../lib/types';
import AccessibleDialog from './AccessibleDialog';

type ActivationProps = {
  forecast: Forecast;
  currency: string;
  analysisScenarioId?: string | null;
  busy: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
};

export function ForecastActivationDialog({ forecast, currency, analysisScenarioId, busy, error, onClose, onConfirm }: ActivationProps) {
  return <AccessibleDialog eyebrow="Integrity checkpoint" title={`Activate ${forecast.symbol} forecast?`} className="small activation-dialog" onClose={busy ? () => undefined : onClose}>
    <div className="freeze-callout"><span>⌁</span><div><strong>Activation freezes this forecast.</strong><p>Your thesis, evidence, confidence, target, invalidation, evaluation date, fresh market snapshot, and linked analysis cannot be silently overwritten afterward.</p></div></div>
    <dl className="activation-summary">
      <div><dt>Direction</dt><dd>{forecast.direction}</dd></div>
      <div><dt>Confidence</dt><dd>{forecast.confidence}%</dd></div>
      <div><dt>Target</dt><dd>{forecastTargetLabel(forecast.target, currency)}</dd></div>
      <div><dt>Evaluate on</dt><dd>{formatLocalDate(forecast.evaluationDate)}</dd></div>
    </dl>
    <p className="activation-market-copy">Northstar will request a fresh server-verified quote now. Activation will fail visibly if real market data is unavailable.</p>
    {analysisScenarioId && <p className="activation-snapshot-copy">The completed-bar report saved with scenario <strong>{analysisScenarioId}</strong> will be stored as an immutable analysis snapshot.</p>}
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Keep as draft</button><button type="button" className="primary-button" onClick={() => void onConfirm()} disabled={busy} data-autofocus>{busy ? 'Capturing market snapshot…' : 'Freeze and activate'}</button></div>
  </AccessibleDialog>;
}

type TextActionProps = {
  forecast: Forecast;
  mode: 'cancel' | 'note';
  busy: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (value: string, kind?: 'amendment' | 'review_note') => Promise<void>;
};

export function ForecastTextActionDialog({ forecast, mode, busy, error, onClose, onSubmit }: TextActionProps) {
  const [kind, setKind] = useState<'amendment' | 'review_note'>('review_note');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void onSubmit(String(form.get('text') ?? '').trim(), mode === 'note' ? kind : undefined);
  };
  const isCancel = mode === 'cancel';
  return <AccessibleDialog eyebrow={isCancel ? 'Lifecycle change' : 'Append-only history'} title={isCancel ? `Cancel ${forecast.symbol} forecast` : `Add a note to ${forecast.symbol}`} className="small" onClose={busy ? () => undefined : onClose}>
    <form onSubmit={submit}>
      {isCancel
        ? <p className="dialog-copy">Cancellation closes this active forecast without grading it. The reason becomes part of its permanent event history.</p>
        : <><p className="dialog-copy">Notes and amendments add context without changing the frozen activated forecast.</p><label><span>Entry type</span><select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} disabled={busy}><option value="review_note">Review note</option><option value="amendment">Amendment</option></select></label></>}
      <label><span>{isCancel ? 'Cancellation reason' : 'Note'}</span><textarea data-autofocus name="text" rows={5} minLength={3} maxLength={isCancel ? 1000 : 2000} placeholder={isCancel ? 'Why should this forecast no longer remain active?' : 'What changed, or what do you want your future self to remember?'} required disabled={busy} /></label>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Back</button><button className={isCancel ? 'danger-button' : 'primary-button'} disabled={busy}>{busy ? 'Saving…' : isCancel ? 'Cancel forecast' : 'Append note'}</button></div>
    </form>
  </AccessibleDialog>;
}
