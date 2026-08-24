'use client';

import { type FormEvent, useMemo, useState } from 'react';
import { defaultEvaluationDate, forecastTargetBounds, normalizeFieldErrors, todayLocalDate } from '../lib/forecasts';
import type { Forecast, ForecastDirection, ForecastDraftInput, ForecastSeed, WorkspaceData } from '../lib/types';
import AccessibleDialog from './AccessibleDialog';
import TickerAutocomplete from './TickerAutocomplete';

type Props = {
  forecast?: Forecast;
  seed?: ForecastSeed | null;
  workspace: WorkspaceData;
  busy: boolean;
  error?: string | null;
  fieldErrors?: unknown;
  onClose: () => void;
  onSave: (input: ForecastDraftInput, seed: ForecastSeed | null) => Promise<void>;
};

function valueOrEmpty(value: number | null | undefined) {
  return value === null || value === undefined ? '' : String(value);
}

export default function ForecastComposer({ forecast, seed, workspace, busy, error, fieldErrors, onClose, onSave }: Props) {
  const initialTarget = forecast?.target ?? seed?.target ?? { kind: 'price' as const, price: 0 };
  const bounds = forecastTargetBounds(initialTarget);
  const tracked = useMemo(() => [...new Set([
    ...workspace.positions.map(({ symbol }) => symbol),
    ...workspace.watchlist.map(({ symbol }) => symbol),
  ])], [workspace.positions, workspace.watchlist]);
  const [symbol, setSymbol] = useState(forecast?.symbol ?? seed?.symbol ?? '');
  const [direction, setDirection] = useState<ForecastDirection>(forecast?.direction ?? seed?.direction ?? 'bullish');
  const [targetKind, setTargetKind] = useState<'price' | 'range'>(initialTarget.kind);
  const [targetLow, setTargetLow] = useState(valueOrEmpty(bounds.lower || null));
  const [targetHigh, setTargetHigh] = useState(valueOrEmpty(bounds.upper));
  const errors = normalizeFieldErrors(fieldErrors);
  const isTracked = tracked.includes(symbol);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (!isTracked) return;
    const lower = Number(targetLow);
    const upper = Number(targetHigh);
    const invalidation = String(form.get('invalidationPrice') ?? '').trim();
    void onSave({
      symbol,
      direction,
      confidence: Number(form.get('confidence')),
      thesis: String(form.get('thesis') ?? '').trim(),
      supportingEvidence: String(form.get('supportingEvidence') ?? '').trim(),
      counterEvidence: String(form.get('counterEvidence') ?? '').trim(),
      setupTag: String(form.get('setupTag') ?? '').trim(),
      evaluationDate: String(form.get('evaluationDate') ?? ''),
      target: targetKind === 'price'
        ? { kind: 'price', price: lower }
        : { kind: 'range', lower, upper },
      invalidationPrice: invalidation ? Number(invalidation) : null,
    }, seed ?? null);
  };

  return <AccessibleDialog eyebrow={forecast ? 'Editable draft' : 'Forecast journal'} title={forecast ? `Edit ${forecast.symbol} forecast` : 'Create a structured forecast'} className="forecast-composer" onClose={onClose}>
    <form onSubmit={submit}>
      {seed && <div className="forecast-seed-callout"><span>◎</span><div><strong>Seeded from completed-bar analysis</strong><p>Northstar prefilled only the scenario’s symbol, direction, setup, and measured target. Review every field. The complete report is saved with this draft and becomes an immutable snapshot only when activated.</p></div></div>}
      <div className="form-grid two">
        <label><span>Tracked ticker</span><TickerAutocomplete
          value={symbol}
          allowedSymbols={tracked}
          emptyMessage="No matching tracked stock. Add it to Portfolio or Watchlist first."
          disabled={busy || Boolean(forecast)}
          onChange={setSymbol}
          onSelect={(suggestion) => setSymbol(suggestion.symbol)}
        />{symbol && !isTracked && <small className="field-error">Enter a ticker already saved as a position or watchlist item.</small>}{errors.symbol && <small className="field-error">{errors.symbol}</small>}</label>
        <label><span>Direction</span><select name="direction" value={direction} onChange={(event) => { const next = event.target.value as ForecastDirection; setDirection(next); if (next === 'neutral') setTargetKind('range'); }} disabled={busy}><option value="bullish">Bullish</option><option value="bearish">Bearish</option><option value="neutral">Neutral</option></select>{errors.direction && <small className="field-error">{errors.direction}</small>}</label>
      </div>
      <div className="form-grid two">
        <label><span>Confidence</span><div className="confidence-input"><input name="confidence" type="number" min="0" max="100" step="1" defaultValue={forecast?.confidence ?? 60} required disabled={busy} /><b>%</b></div>{errors.confidence && <small className="field-error">{errors.confidence}</small>}</label>
        <label><span>Setup / strategy tag</span><input name="setupTag" defaultValue={forecast?.setupTag ?? seed?.setupTag ?? ''} placeholder="e.g. Rectangle, earnings, valuation" maxLength={80} required disabled={busy} />{errors.setupTag && <small className="field-error">{errors.setupTag}</small>}</label>
      </div>
      <label><span>Thesis</span><textarea name="thesis" defaultValue={forecast?.thesis ?? ''} placeholder="What do you predict, and why?" rows={4} maxLength={4000} required disabled={busy} />{errors.thesis && <small className="field-error">{errors.thesis}</small>}</label>
      <div className="form-grid two evidence-grid">
        <label><span>Supporting evidence</span><textarea name="supportingEvidence" defaultValue={forecast?.supportingEvidence ?? ''} placeholder="Facts or observations that support the thesis" rows={4} maxLength={6000} required disabled={busy} />{errors.supportingEvidence && <small className="field-error">{errors.supportingEvidence}</small>}</label>
        <label><span>Counter-evidence</span><textarea name="counterEvidence" defaultValue={forecast?.counterEvidence ?? ''} placeholder="What argues against it or could make it wrong?" rows={4} maxLength={6000} required disabled={busy} />{errors.counterEvidence && <small className="field-error">{errors.counterEvidence}</small>}</label>
      </div>
      <div className="forecast-target-editor">
        <div className="target-kind" role="group" aria-label="Target type"><button type="button" className={targetKind === 'price' ? 'selected' : ''} aria-pressed={targetKind === 'price'} onClick={() => setTargetKind('price')}>Single price</button><button type="button" className={targetKind === 'range' ? 'selected' : ''} aria-pressed={targetKind === 'range'} onClick={() => setTargetKind('range')}>Price range</button></div>
        <div className={`form-grid ${targetKind === 'range' ? 'three' : 'two'}`}>
          <label><span>{targetKind === 'range' ? 'Target lower bound' : 'Target price'}</span><input value={targetLow} onChange={(event) => setTargetLow(event.target.value)} type="number" min="0.000001" step="any" required disabled={busy} /></label>
          {targetKind === 'range' && <label><span>Target upper bound</span><input value={targetHigh} onChange={(event) => setTargetHigh(event.target.value)} type="number" min="0.000001" step="any" required disabled={busy} /></label>}
          <label><span>Invalidation price <small>optional</small></span><input name="invalidationPrice" defaultValue={valueOrEmpty(forecast?.invalidationPrice)} type="number" min="0.000001" step="any" placeholder="Price that disproves the thesis" disabled={busy} /></label>
        </div>
        {(errors.target || errors.invalidationPrice) && <p className="field-error">{errors.target ?? errors.invalidationPrice}</p>}
      </div>
      <label><span>Evaluate on</span><input name="evaluationDate" type="date" min={todayLocalDate()} defaultValue={forecast?.evaluationDate ?? defaultEvaluationDate()} required disabled={busy} />{errors.evaluationDate && <small className="field-error">{errors.evaluationDate}</small>}</label>
      <p className="form-help">Drafts remain editable. Activation later captures a fresh server-side quote and freezes the forecast for honest review.</p>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button data-autofocus={!symbol || !isTracked ? undefined : true} className="primary-button" disabled={busy || !isTracked}>{busy ? 'Saving draft…' : forecast ? 'Save draft changes' : 'Create draft'}</button></div>
    </form>
  </AccessibleDialog>;
}
