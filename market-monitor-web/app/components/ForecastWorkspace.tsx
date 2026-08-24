'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  filterForecasts,
  FORECAST_STATUSES,
  forecastStatusLabel,
  forecastTargetLabel,
  formatForecastMoney,
  formatLocalDate,
  groupForecasts,
  isForecast,
  type ForecastStatusFilter,
} from '../lib/forecasts';
import type { Forecast, ForecastDraftInput, ForecastSeed, WorkspaceData } from '../lib/types';
import ForecastComposer from './ForecastComposer';
import ForecastDetail from './ForecastDetail';
import { ForecastActivationDialog, ForecastTextActionDialog } from './ForecastDialogs';

export type ForecastComposeRequest = {
  id: number;
  seed: ForecastSeed | null;
};

type Props = {
  workspace: WorkspaceData;
  composeRequest: ForecastComposeRequest | null;
  onNotice: (message: string) => void;
  onOpenMarkets: () => void;
};

type ComposerState = { forecast?: Forecast; seed: ForecastSeed | null } | null;
type TextAction = { forecast: Forecast; mode: 'cancel' | 'note' } | null;

class ForecastApiError extends Error {
  fieldErrors: unknown;

  constructor(message: string, fieldErrors?: unknown) {
    super(message);
    this.fieldErrors = fieldErrors;
  }
}

async function responsePayload(response: Response) {
  if (response.status === 204) return null;
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    throw new ForecastApiError('Northstar received an unreadable forecast response.');
  }
}

async function forecastRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new ForecastApiError(
      typeof payload?.error === 'string' ? payload.error : 'The forecast request could not be completed.',
      payload?.fieldErrors,
    );
  }
  return payload;
}

function newestFirst(first: Forecast, second: Forecast) {
  return Date.parse(second.updatedAt) - Date.parse(first.updatedAt);
}

function ForecastCard({ forecast, currency, selected, onSelect }: { forecast: Forecast; currency: string; selected: boolean; onSelect: () => void }) {
  const displayCurrency = forecast.activationCurrency ?? currency;
  return <button className={`forecast-card ${selected ? 'selected' : ''}`} onClick={onSelect} aria-pressed={selected}>
    <div className="forecast-card-top"><div><span className={`direction ${forecast.direction}`}>{forecast.direction}</span><strong>{forecast.symbol}</strong></div><span className={`forecast-status ${forecast.status}`}>{forecastStatusLabel(forecast.status)}</span></div>
    <p>{forecast.thesis}</p>
    <dl><div><dt>Confidence</dt><dd>{forecast.confidence}%</dd></div><div><dt>Activation</dt><dd>{forecast.status === 'draft' ? 'Not captured' : formatForecastMoney(forecast.activationPrice, displayCurrency)}</dd></div><div><dt>Target</dt><dd>{forecastTargetLabel(forecast.target, displayCurrency)}</dd></div><div><dt>Invalidation</dt><dd>{formatForecastMoney(forecast.invalidationPrice, displayCurrency)}</dd></div><div><dt>Evaluate</dt><dd>{formatLocalDate(forecast.evaluationDate)}</dd></div></dl>
    <footer><span>{forecast.setupTag}</span><span>{forecast.status === 'draft' ? 'Editable' : 'Locked'} →</span></footer>
  </button>;
}

function ForecastGroup({ title, copy, forecasts, currency, selectedId, onSelect }: { title: string; copy: string; forecasts: Forecast[]; currency: string; selectedId: number | null; onSelect: (forecast: Forecast) => void }) {
  if (!forecasts.length) return null;
  return <section className="forecast-group"><div className="forecast-group-heading"><div><h3>{title}</h3><p>{copy}</p></div><span>{forecasts.length}</span></div>{forecasts.map((forecast) => <ForecastCard key={forecast.id} forecast={forecast} currency={currency} selected={forecast.id === selectedId} onSelect={() => onSelect(forecast)} />)}</section>;
}

export default function ForecastWorkspace({ workspace, composeRequest, onNotice, onOpenMarkets }: Props) {
  const [forecasts, setForecasts] = useState<Forecast[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<ForecastStatusFilter>('all');
  const [symbolFilter, setSymbolFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerState>(composeRequest ? { seed: composeRequest.seed } : null);
  const [activation, setActivation] = useState<Forecast | null>(null);
  const [textAction, setTextAction] = useState<TextAction>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<unknown>(null);
  const [pendingSeeds, setPendingSeeds] = useState<Record<number, ForecastSeed>>({});
  const automaticDetailAttempts = useRef(new Set<number>());

  const trackedSymbols = useMemo(() => [...new Set([
    ...workspace.positions.map(({ symbol }) => symbol),
    ...workspace.watchlist.map(({ symbol }) => symbol),
  ])].sort(), [workspace.positions, workspace.watchlist]);
  const filterSymbols = useMemo(() => [...new Set([
    ...trackedSymbols,
    ...forecasts.map(({ symbol }) => symbol),
  ])].sort(), [forecasts, trackedSymbols]);

  const loadForecasts = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const payload = await forecastRequest('/api/forecasts', { cache: 'no-store' });
      const values = Array.isArray(payload?.forecasts) ? payload.forecasts.filter(isForecast).sort(newestFirst) : [];
      if (!Array.isArray(payload?.forecasts) || values.length !== payload.forecasts.length) {
        throw new ForecastApiError('Northstar received forecast data in an unexpected format.');
      }
      setForecasts(values);
      setSelectedId((current) => current && values.some(({ id }) => id === current) ? current : values[0]?.id ?? null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Forecasts could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    forecastRequest('/api/forecasts', { cache: 'no-store' })
      .then((payload) => {
        if (!active) return;
        const values = Array.isArray(payload?.forecasts) ? payload.forecasts.filter(isForecast).sort(newestFirst) : [];
        if (!Array.isArray(payload?.forecasts) || values.length !== payload.forecasts.length) {
          throw new ForecastApiError('Northstar received forecast data in an unexpected format.');
        }
        setForecasts(values);
        setSelectedId(values[0]?.id ?? null);
      })
      .catch((error) => {
        if (active) setLoadError(error instanceof Error ? error.message : 'Forecasts could not be loaded.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const filtered = useMemo(() => filterForecasts(forecasts, statusFilter, symbolFilter), [forecasts, statusFilter, symbolFilter]);
  const groups = useMemo(() => groupForecasts(filtered), [filtered]);
  const selected = filtered.find(({ id }) => id === selectedId) ?? filtered[0] ?? null;
  const currency = workspace.profile.baseCurrency;

  const upsert = useCallback((forecast: Forecast) => {
    setForecasts((current) => [forecast, ...current.filter(({ id }) => id !== forecast.id)].sort(newestFirst));
    setSelectedId(forecast.id);
  }, []);

  const selectForecast = useCallback(async (forecast: Forecast) => {
    setSelectedId(forecast.id);
    setDetailLoading(true);
    setDetailError(null);
    try {
      const payload = await forecastRequest(`/api/forecasts/${forecast.id}`, { cache: 'no-store' });
      if (!isForecast(payload?.forecast)) throw new ForecastApiError('Forecast details were incomplete.');
      upsert(payload.forecast);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : 'Forecast details could not be loaded.');
    } finally {
      setDetailLoading(false);
    }
  }, [upsert]);

  useEffect(() => {
    if (!selected || selected.events.length > 0 || automaticDetailAttempts.current.has(selected.id)) return;
    const forecastId = selected.id;
    let active = true;
    automaticDetailAttempts.current.add(forecastId);
    Promise.resolve()
      .then(() => {
        if (active) setDetailLoading(true);
        return forecastRequest(`/api/forecasts/${forecastId}`, { cache: 'no-store' });
      })
      .then((payload) => {
        if (!active) return;
        if (!isForecast(payload?.forecast)) throw new ForecastApiError('Forecast details were incomplete.');
        upsert(payload.forecast);
      })
      .catch((error) => {
        if (active) setDetailError(error instanceof Error ? error.message : 'Forecast details could not be loaded.');
      })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [selected, upsert]);

  const saveDraft = async (input: ForecastDraftInput, seed: ForecastSeed | null) => {
    setBusy(true);
    setActionError(null);
    setFieldErrors(null);
    try {
      const editing = composer?.forecast;
      const body = editing ? input : {
        ...input,
        ...(seed ? { analysisSeed: { report: seed.analysisReport, scenarioId: seed.analysisScenarioId } } : {}),
      };
      const payload = await forecastRequest(editing ? `/api/forecasts/${editing.id}` : '/api/forecasts', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!isForecast(payload?.forecast)) throw new ForecastApiError('The saved forecast response was incomplete.');
      const savedForecast = payload.forecast;
      upsert(savedForecast);
      if (seed) setPendingSeeds((current) => ({ ...current, [savedForecast.id]: seed }));
      setComposer(null);
      onNotice(editing ? `${savedForecast.symbol} draft updated.` : `${savedForecast.symbol} draft created.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The draft could not be saved.');
      setFieldErrors(error instanceof ForecastApiError ? error.fieldErrors : null);
    } finally {
      setBusy(false);
    }
  };

  const deleteDraft = async (forecast: Forecast) => {
    if (!window.confirm(`Delete the ${forecast.symbol} draft? This cannot be undone.`)) return;
    setBusy(true);
    setDetailError(null);
    try {
      await forecastRequest(`/api/forecasts/${forecast.id}`, { method: 'DELETE' });
      setForecasts((current) => current.filter(({ id }) => id !== forecast.id));
      setSelectedId((current) => current === forecast.id ? null : current);
      setPendingSeeds((current) => { const next = { ...current }; delete next[forecast.id]; return next; });
      onNotice(`${forecast.symbol} draft deleted.`);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : 'The draft could not be deleted.');
    } finally {
      setBusy(false);
    }
  };

  const activateForecast = async () => {
    if (!activation) return;
    setBusy(true);
    setActionError(null);
    try {
      const payload = await forecastRequest(`/api/forecasts/${activation.id}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      if (!isForecast(payload?.forecast)) throw new ForecastApiError('The activated forecast response was incomplete.');
      const activatedForecast = payload.forecast;
      upsert(activatedForecast);
      setActivation(null);
      setPendingSeeds((current) => { const next = { ...current }; delete next[activatedForecast.id]; return next; });
      onNotice(`${activatedForecast.symbol} forecast activated and locked.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Activation could not be completed.');
    } finally {
      setBusy(false);
    }
  };

  const submitTextAction = async (value: string, kind?: 'amendment' | 'review_note') => {
    if (!textAction) return;
    setBusy(true);
    setActionError(null);
    try {
      const payload = await forecastRequest(`/api/forecasts/${textAction.forecast.id}/${textAction.mode === 'cancel' ? 'cancel' : 'notes'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(textAction.mode === 'cancel' ? { reason: value } : { kind: kind ?? 'review_note', note: value }),
      });
      if (!isForecast(payload?.forecast)) throw new ForecastApiError('The updated forecast response was incomplete.');
      upsert(payload.forecast);
      setTextAction(null);
      onNotice(textAction.mode === 'cancel' ? `${payload.forecast.symbol} forecast cancelled.` : 'Forecast note appended.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The forecast could not be updated.');
    } finally {
      setBusy(false);
    }
  };

  const openComposer = (state: ComposerState) => { setActionError(null); setFieldErrors(null); setComposer(state); };
  const openActivation = (forecast: Forecast) => { setActionError(null); setActivation(forecast); };
  const openTextAction = (forecast: Forecast, mode: 'cancel' | 'note') => { setActionError(null); setTextAction({ forecast, mode }); };

  if (loading) return <section className="panel forecast-loading" role="status" aria-busy="true"><span>…</span><div><strong>Loading your forecasts</strong><p>Northstar is reading the accountable record from the database.</p></div></section>;
  if (loadError) return <section className="panel forecast-loading error" role="alert"><span>!</span><div><strong>Forecasts unavailable</strong><p>{loadError}</p><button className="primary-small" onClick={() => void loadForecasts()}>Try again</button></div></section>;

  return <>
    <section className="panel forecast-toolbar" aria-label="Forecast filters">
      <div><p className="section-label">Accountable record</p><strong>{forecasts.length} {forecasts.length === 1 ? 'forecast' : 'forecasts'}</strong></div>
      <label><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as ForecastStatusFilter)}><option value="all">All statuses</option>{FORECAST_STATUSES.map((status) => <option value={status} key={status}>{forecastStatusLabel(status)}</option>)}</select></label>
      <label><span>Symbol</span><select value={symbolFilter} onChange={(event) => setSymbolFilter(event.target.value)}><option value="">All forecast symbols</option>{filterSymbols.map((symbol) => <option key={symbol}>{symbol}</option>)}</select></label>
      <button className="primary-small" onClick={() => openComposer({ seed: null })} disabled={!trackedSymbols.length}>＋ Create forecast</button>
    </section>

    {!forecasts.length ? <section className="panel forecast-empty"><span>✦</span><h2>Turn a market view into a measurable forecast.</h2><p>Record what you expect, the evidence on both sides, a numeric target, invalidation, confidence, and a date for honest review.</p>{trackedSymbols.length ? <button className="primary-button" onClick={() => openComposer({ seed: null })}>Create your first forecast</button> : <><p className="empty-caveat">Start by saving a real position or watchlist symbol. Northstar never substitutes a demo stock.</p><button className="secondary-button" onClick={onOpenMarkets}>Open Markets</button></>}</section>
      : !filtered.length ? <section className="panel forecast-empty compact"><span>⌕</span><h2>No forecasts match these filters.</h2><p>Adjust status or symbol to return to the full accountable record.</p><button className="secondary-button" onClick={() => { setStatusFilter('all'); setSymbolFilter(''); }}>Clear filters</button></section>
        : <section className="forecast-master-detail"><div className="forecast-list" aria-label="Forecast list"><ForecastGroup title="Drafts" copy="Editable until activation" forecasts={groups.drafts} currency={currency} selectedId={selected?.id ?? null} onSelect={(forecast) => void selectForecast(forecast)} /><ForecastGroup title="Active" copy="Frozen and awaiting review" forecasts={groups.active} currency={currency} selectedId={selected?.id ?? null} onSelect={(forecast) => void selectForecast(forecast)} /><ForecastGroup title="Closed" copy="Preserved lifecycle outcomes" forecasts={groups.closed} currency={currency} selectedId={selected?.id ?? null} onSelect={(forecast) => void selectForecast(forecast)} /></div><div className="forecast-detail-column">{detailError && <div className="forecast-inline-error" role="alert">{detailError}</div>}{detailLoading && <div className="detail-loading" role="status">Refreshing details…</div>}{selected ? <ForecastDetail forecast={selected} currency={currency} onEdit={() => openComposer({ forecast: selected, seed: pendingSeeds[selected.id] ?? null })} onDelete={() => void deleteDraft(selected)} onActivate={() => openActivation(selected)} onCancel={() => openTextAction(selected, 'cancel')} onNote={() => openTextAction(selected, 'note')} /> : <section className="panel forecast-detail-placeholder"><strong>Select a forecast</strong><p>Choose a record to inspect its frozen fields and audit history.</p></section>}</div></section>}

    {composer && <ForecastComposer forecast={composer.forecast} seed={composer.seed} workspace={workspace} busy={busy} error={actionError} fieldErrors={fieldErrors} onClose={() => !busy && setComposer(null)} onSave={saveDraft} />}
    {activation && <ForecastActivationDialog forecast={activation} currency={currency} analysisScenarioId={pendingSeeds[activation.id]?.analysisScenarioId ?? activation.pendingAnalysis?.scenarioId} busy={busy} error={actionError} onClose={() => !busy && setActivation(null)} onConfirm={activateForecast} />}
    {textAction && <ForecastTextActionDialog forecast={textAction.forecast} mode={textAction.mode} busy={busy} error={actionError} onClose={() => !busy && setTextAction(null)} onSubmit={submitTextAction} />}
  </>;
}
