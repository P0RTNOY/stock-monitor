'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { isTechnicalAnalysisReport } from '../lib/analysis';
import { todayLocalDate } from '../lib/forecasts';
import { alertIsTriggered, portfolioHistory, portfolioMetrics, positionValue, rsiFromHistory } from '../lib/portfolio';
import ForecastWorkspace, { type ForecastComposeRequest } from './ForecastWorkspace';
import TechnicalAnalysisPanel from './TechnicalAnalysisPanel';
import TickerAutocomplete from './TickerAutocomplete';
import type {
  AnalysisAssumptions,
  ForecastSeed,
  JournalEntry,
  Position,
  Quote,
  QuoteMap,
  ReviewAlert,
  TechnicalAnalysisReport,
  WatchlistItem,
  WorkspaceData,
} from '../lib/types';

type Section = 'overview' | 'portfolio' | 'markets' | 'forecasts' | 'journal' | 'alerts';
type Modal = 'position' | 'profile' | null;

const navItems: Array<{ id: Section; label: string; icon: string }> = [
  { id: 'overview', label: 'Overview', icon: '⌂' },
  { id: 'portfolio', label: 'Portfolio', icon: '▤' },
  { id: 'markets', label: 'Markets', icon: '↗' },
  { id: 'forecasts', label: 'Forecasts', icon: '✦' },
  { id: 'journal', label: 'Journal', icon: '✎' },
  { id: 'alerts', label: 'Alerts', icon: '◉' },
];

const sectionTitles: Record<Section, string> = {
  overview: 'Your market workspace.',
  portfolio: 'Portfolio positions.',
  markets: 'Market monitor.',
  forecasts: 'Accountable forecasts.',
  journal: 'Decision journal.',
  alerts: 'Review alerts.',
};

function money(value: number | null | undefined, currency = 'USD') {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
}

function signedMoney(value: number | null | undefined, currency = 'USD') {
  if (value === null || value === undefined) return '—';
  return `${value >= 0 ? '+' : '−'}${money(Math.abs(value), currency)}`;
}

function signedPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return '—';
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}%`;
}

function chartHeights(values: number[]) {
  if (!values.length) return [];
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const spread = maximum - minimum || 1;
  return values.map((value) => 24 + ((value - minimum) / spread) * 76);
}

function tone(value: number | null | undefined) {
  if (value === null || value === undefined) return 'neutral-text';
  return value >= 0 ? 'positive-text' : 'negative-text';
}

function assetInitial(symbol: string) {
  return symbol.replace(/[^A-Z]/g, '').slice(0, 1) || '•';
}

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return <div className="empty-state"><span>✦</span><strong>{title}</strong><p>{copy}</p></div>;
}

function QuoteBars({ values, compact = false }: { values: number[]; compact?: boolean }) {
  if (!values.length) return <div className={compact ? 'spark-empty' : 'chart-empty'}>No price history</div>;
  return <div className={compact ? 'spark-bars' : 'chart-bars'} aria-label="Price trend chart">{chartHeights(values).map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div>;
}

function HoldingRow({ position, quote, total, currency, onDelete }: { position: Position; quote?: Quote; total: number | null; currency: string; onDelete?: () => void }) {
  const value = quote?.price === null || quote?.price === undefined ? null : position.shares * quote.price;
  const totalGain = value === null ? null : value - position.shares * position.averageCost;
  const weight = value !== null && total ? (value / total) * 100 : null;
  return <div className={`holding-row ${onDelete ? 'portfolio-row' : ''}`}>
    <div className="asset-cell"><span className="asset-logo">{assetInitial(position.symbol)}</span><div><strong>{position.symbol}</strong><span>{position.companyName}</span></div></div>
    <div><strong>{money(value, currency)}</strong><span className="sub-value">{value === null ? 'Quote unavailable' : `${position.shares.toLocaleString()} shares`}</span></div>
    <span className={tone(quote?.changePct)}>{signedPercent(quote?.changePct)}</span>
    <div className="weight-cell"><span className="weight-bar">{weight !== null && <i style={{ width: `${Math.min(weight, 100)}%` }} />}</span><strong>{weight === null ? '—' : `${weight.toFixed(1)}%`}</strong></div>
    {onDelete && <><span className={tone(totalGain)}>{signedMoney(totalGain, currency)}</span><button className="row-action" onClick={onDelete} aria-label={`Remove ${position.symbol}`}>×</button></>}
  </div>;
}

export default function MarketWorkspace() {
  const [section, setSection] = useState<Section>('overview');
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<QuoteMap>({});
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [dataMode, setDataMode] = useState<'loading' | 'live' | 'partial' | 'unavailable'>('loading');
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [analysisReports, setAnalysisReports] = useState<Record<string, TechnicalAnalysisReport>>({});
  const [analysisErrors, setAnalysisErrors] = useState<Record<string, string>>({});
  const [analysisLoading, setAnalysisLoading] = useState<Record<string, boolean>>({});
  const [forecastComposeRequest, setForecastComposeRequest] = useState<ForecastComposeRequest | null>(null);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 3200);
  }, []);

  const allSymbols = useMemo(() => workspace
    ? [...new Set([...workspace.positions.map((item) => item.symbol), ...workspace.watchlist.map((item) => item.symbol), ...workspace.alerts.map((item) => item.symbol)])]
    : [], [workspace]);

  const refreshQuotes = useCallback(async (symbols: string[]) => {
    setRefreshing(true);
    setMarketError(null);
    try {
      if (!symbols.length) {
        setQuotes({});
        setFetchedAt(null);
        setDataMode('unavailable');
        return;
      }
      const response = await fetch(`/api/market?symbols=${encodeURIComponent(symbols.join(','))}`);
      if (!response.ok) throw new Error('Market refresh failed.');
      const payload = await response.json() as { quotes: QuoteMap; fetchedAt: string; unavailable?: string[] };
      setQuotes(payload.quotes);
      setFetchedAt(payload.fetchedAt);
      setDataMode(Object.keys(payload.quotes).length === 0 ? 'unavailable' : payload.unavailable?.length ? 'partial' : 'live');
      if (payload.unavailable?.length) setMarketError(`No current quote for ${payload.unavailable.join(', ')}.`);
    } catch {
      setDataMode('unavailable');
      setMarketError('Real market refresh failed. Any displayed quotes are from the last successful provider response.');
    }
    finally { setRefreshing(false); }
  }, []);

  useEffect(() => {
    let active = true;
    fetch('/api/workspace')
      .then(async (response) => {
        if (!response.ok) throw new Error('Workspace request failed.');
        return await response.json() as WorkspaceData;
      })
      .then((data) => {
        if (!active) return;
        setWorkspace(data);
        setWorkspaceError(null);
        const trackedSymbols = [...new Set([...data.positions.map((item) => item.symbol), ...data.watchlist.map((item) => item.symbol)])];
        setSelectedSymbol((current) => trackedSymbols.includes(current) ? current : trackedSymbols[0] ?? '');
        const symbols = [...new Set([...trackedSymbols, ...data.alerts.map((item) => item.symbol)])];
        void refreshQuotes(symbols);
      })
      .catch(() => {
        if (!active) return;
        setWorkspace(null);
        setQuotes({});
        setDataMode('unavailable');
        setWorkspaceError('Your saved investment data could not be loaded. Northstar will not substitute demo data.');
      });
    return () => { active = false; };
  }, [refreshQuotes]);

  const mutate = async (action: string, fields: Record<string, unknown>, successMessage: string) => {
    setBusy(true);
    try {
      const response = await fetch('/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...fields }) });
      const payload = await response.json() as WorkspaceData & { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Could not save your change.');
      setWorkspace(payload);
      const trackedSymbols = [...new Set([...payload.positions.map((item) => item.symbol), ...payload.watchlist.map((item) => item.symbol)])];
      setSelectedSymbol((current) => trackedSymbols.includes(current) ? current : trackedSymbols[0] ?? '');
      const symbols = [...new Set([...trackedSymbols, ...payload.alerts.map((item) => item.symbol)])];
      void refreshQuotes(symbols);
      showNotice(successMessage);
      return true;
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Could not save your change.');
      return false;
    } finally { setBusy(false); }
  };

  const analyze = async (symbol: string, assumptions: AnalysisAssumptions) => {
    setAnalysisLoading((current) => ({ ...current, [symbol]: true }));
    setAnalysisErrors((current) => ({ ...current, [symbol]: '' }));
    try {
      const response = await fetch('/api/analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, ...assumptions }),
      });
      const payload = await response.json() as { report?: TechnicalAnalysisReport; error?: string };
      if (!response.ok || !isTechnicalAnalysisReport(payload.report, symbol)) {
        throw new Error(
          response.status === 400 || response.status === 422
            ? 'Check the symbol and risk assumptions.'
            : response.status === 503
              ? 'Completed market data is unavailable for this symbol.'
              : 'Technical analysis is temporarily unavailable.',
        );
      }
      const report = payload.report;
      setAnalysisReports((current) => ({ ...current, [symbol]: report }));
      showNotice(`${symbol} completed-bar analysis updated.`);
    } catch (error) {
      setAnalysisErrors((current) => ({
        ...current,
        [symbol]: error instanceof Error ? error.message : 'Technical analysis is unavailable.',
      }));
    } finally {
      setAnalysisLoading((current) => ({ ...current, [symbol]: false }));
    }
  };

  const currency = workspace?.profile.baseCurrency || 'USD';
  const metrics = useMemo(() => workspace ? portfolioMetrics(workspace.positions, quotes, workspace.profile.cashBalance) : null, [workspace, quotes]);
  const history = useMemo(() => workspace ? portfolioHistory(workspace.positions, quotes, workspace.profile.cashBalance) : [], [workspace, quotes]);
  const triggeredAlerts = workspace?.alerts.filter((alert) => alertIsTriggered(alert, quotes)) ?? [];
  const openSection = (next: Section) => { if (next !== 'forecasts') setForecastComposeRequest(null); setSection(next); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const createForecast = (seed: ForecastSeed | null = null) => {
    setForecastComposeRequest({ id: Date.now(), seed });
    openSection('forecasts');
  };

  if (!workspace) {
    return <main className="workspace-gate">
      <div className="workspace-gate-card" role={workspaceError ? 'alert' : 'status'}>
        <span>{workspaceError ? '!' : '…'}</span>
        <h1>{workspaceError ? 'Saved data unavailable' : 'Loading your investment data'}</h1>
        <p>{workspaceError ?? 'Northstar is reading your portfolio, watchlist, journal, and alerts from the database.'}</p>
        {workspaceError && <button className="primary-button" onClick={() => window.location.reload()}>Try again</button>}
      </div>
    </main>;
  }

  if (!metrics) return null;

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand-mark" onClick={() => openSection('overview')} aria-label="Northstar overview">N</button>
      <nav aria-label="Primary navigation">{navItems.map((item) => <button key={item.id} className={`nav-item ${section === item.id ? 'active' : ''}`} onClick={() => openSection(item.id)} aria-current={section === item.id ? 'page' : undefined}><span className="nav-icon">{item.icon}</span><span>{item.label}</span>{item.id === 'alerts' && triggeredAlerts.length > 0 && <b className="nav-badge">{triggeredAlerts.length}</b>}</button>)}</nav>
      <button className="sidebar-footer" onClick={() => setModal('profile')}><span className="profile-avatar">{workspace.profile.name.split(/\s+/).map((word) => word[0]).join('').slice(0, 2).toUpperCase()}</span><span><strong>{workspace.profile.name}</strong><small>Personal workspace</small></span></button>
    </aside>

    <main className="workspace">
      <header className="topbar"><div><p className="eyebrow">Northstar / {section}</p><h1>{sectionTitles[section]}</h1></div><div className="topbar-actions"><button className="icon-button" onClick={() => openSection('markets')} aria-label="Open market search">⌕</button>{section === 'forecasts' ? <button className="secondary-button" onClick={() => createForecast()}>＋ Create forecast</button> : <button className="secondary-button" onClick={() => setModal('position')}>＋ Add position</button>}</div></header>
      <section className={`market-status ${dataMode}`} aria-label="Market data status"><span className="status-dot" /><strong>{dataMode === 'live' ? 'Real market snapshot' : dataMode === 'partial' ? 'Partial market snapshot' : dataMode === 'loading' ? 'Loading market data' : 'Market data unavailable'}</strong><span>{marketError ?? (fetchedAt ? `Provider response ${new Date(fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : allSymbols.length ? 'Waiting for the market provider' : 'Add a position or watchlist symbol to request real quotes')}</span><button onClick={() => void refreshQuotes(allSymbols)} disabled={refreshing || !allSymbols.length}>{refreshing ? 'Refreshing…' : 'Refresh data ↻'}</button></section>

      {section === 'overview' && <Overview workspace={workspace} quotes={quotes} metrics={metrics} history={history} currency={currency} openSection={openSection} />}
      {section === 'portfolio' && <Portfolio workspace={workspace} quotes={quotes} metrics={metrics} currency={currency} onAdd={() => setModal('position')} onDelete={(id, symbol) => { if (window.confirm(`Remove ${symbol} from this portfolio?`)) void mutate('deletePosition', { id }, `${symbol} removed.`); }} />}
      {section === 'markets' && <Markets workspace={workspace} quotes={quotes} selectedSymbol={selectedSymbol} setSelectedSymbol={setSelectedSymbol} busy={busy} analysisReport={analysisReports[selectedSymbol]} analysisError={analysisErrors[selectedSymbol]} analyzing={Boolean(analysisLoading[selectedSymbol])} onAnalyze={(assumptions) => analyze(selectedSymbol, assumptions)} onCreateForecast={(seed) => createForecast(seed)} onAdd={async (fields) => mutate('addWatchlist', fields, `${fields.symbol} added to your watchlist.`)} onDelete={(item) => { if (window.confirm(`Remove ${item.symbol} from your watchlist?`)) void mutate('deleteWatchlist', { id: item.id }, `${item.symbol} removed.`); }} />}
      {section === 'forecasts' && <ForecastWorkspace key={forecastComposeRequest?.id ?? 'forecasts'} workspace={workspace} composeRequest={forecastComposeRequest} onNotice={showNotice} onOpenMarkets={() => openSection('markets')} />}
      {section === 'journal' && <Journal entries={workspace.journalEntries} symbols={[...new Set([...workspace.positions.map((item) => item.symbol), ...workspace.watchlist.map((item) => item.symbol)])]} busy={busy} onAdd={async (fields) => mutate('addJournal', fields, 'Journal entry saved.')} onDelete={(entry) => { if (window.confirm('Delete this journal entry?')) void mutate('deleteJournal', { id: entry.id }, 'Journal entry deleted.'); }} />}
      {section === 'alerts' && <Alerts alerts={workspace.alerts} quotes={quotes} symbols={[...new Set([...workspace.positions.map((item) => item.symbol), ...workspace.watchlist.map((item) => item.symbol)])]} busy={busy} onAdd={async (fields) => mutate('addAlert', fields, 'Review alert created.')} onToggle={(alert) => void mutate('toggleAlert', { id: alert.id, active: !alert.active }, alert.active ? 'Alert paused.' : 'Alert activated.')} onDelete={(alert) => { if (window.confirm('Delete this review alert?')) void mutate('deleteAlert', { id: alert.id }, 'Alert deleted.'); }} />}
      <p className="data-note">Market information is for monitoring and reflection—not financial advice. Verify prices with your broker before making decisions.</p>
    </main>

    {modal === 'position' && <PositionModal busy={busy} onClose={() => setModal(null)} onSave={async (fields) => { const saved = await mutate('addPosition', fields, `${fields.symbol} added to your portfolio.`); if (saved) setModal(null); }} />}
    {modal === 'profile' && <ProfileModal profile={workspace.profile} busy={busy} onClose={() => setModal(null)} onSave={async (fields) => { const saved = await mutate('updateProfile', fields, 'Portfolio details updated.'); if (saved) setModal(null); }} />}
    {notice && <div className="toast" role="status">{notice}</div>}
  </div>;
}

function Overview({ workspace, quotes, metrics, history, currency, openSection }: { workspace: WorkspaceData; quotes: QuoteMap; metrics: ReturnType<typeof portfolioMetrics>; history: number[]; currency: string; openSection: (section: Section) => void }) {
  const topPositions = [...workspace.positions]
    .sort((a, b) => (positionValue(b, quotes) ?? -1) - (positionValue(a, quotes) ?? -1))
    .slice(0, 4);
  const dailyDirection = metrics.dailyChange === null ? null : metrics.dailyChange >= 0 ? '↗' : '↘';
  return <>
    <section className="hero-grid">
      <article className="portfolio-hero">
        <div className="hero-heading"><div><p className="section-label">Total portfolio value</p><div className="value-line"><h2>{money(metrics.totalValue, currency)}</h2>{metrics.dailyChangePct !== null && <span className="trend-pill">{dailyDirection} {Math.abs(metrics.dailyChangePct).toFixed(2)}%</span>}</div><p className="gain-copy"><strong>{signedMoney(metrics.totalReturn, currency)}</strong> total return</p>{metrics.unpricedSymbols.length > 0 && <p className="valuation-warning">Waiting for real quotes: {metrics.unpricedSymbols.join(', ')}</p>}</div><span className="range-label">Recent 1M provider history</span></div>
        <div className="chart">{history.length > 0 && <><div className="chart-guide top"><span>{money(Math.max(...history), currency)}</span></div><div className="chart-guide middle"><span>{money(Math.min(...history), currency)}</span></div></>}<QuoteBars values={history} />{history.length > 0 && <div className="chart-axis"><span>4 weeks ago</span><span>3 weeks</span><span>2 weeks</span><span>Latest</span></div>}</div>
        <p className="chart-disclosure">Recent valuation of today’s holdings and cash—not actual historical portfolio performance.</p>
      </article>
      <aside className="daily-card"><div className="card-title-row"><p className="section-label">Latest change</p><span>Portfolio</span></div><h3 className={tone(metrics.dailyChange)}>{signedMoney(metrics.dailyChange, currency)}</h3><p className="daily-percent">{metrics.dailyChangePct === null ? 'Quote coverage incomplete' : `${dailyDirection} ${Math.abs(metrics.dailyChangePct).toFixed(2)}%`}</p><div className="mini-rule" /><div className="fact-row"><span>Invested</span><strong>{money(metrics.investedValue, currency)}</strong></div><div className="fact-row"><span>Cash</span><strong>{money(workspace.profile.cashBalance, currency)}</strong></div><div className="fact-row"><span>Total return</span><strong className={tone(metrics.totalReturn)}>{signedPercent(metrics.totalReturnPct)}</strong></div></aside>
    </section>
    <section className="lower-grid"><article className="panel holdings-panel"><div className="panel-heading"><div><p className="section-label">Portfolio pulse</p><h3>Top positions</h3></div><button className="link-button" onClick={() => openSection('portfolio')}>View portfolio →</button></div><div className="holdings-header"><span>Asset</span><span>Value</span><span>Today</span><span>Weight</span></div>{topPositions.length ? topPositions.map((position) => <HoldingRow key={position.id} position={position} quote={quotes[position.symbol]} total={metrics.investedValue} currency={currency} />) : <EmptyState title="No positions yet" copy="Add a position to begin tracking your portfolio." />}</article><article className="panel watchlist-panel"><div className="panel-heading"><div><p className="section-label">Market monitor</p><h3>Watchlist</h3></div><button aria-label="Open watchlist" onClick={() => openSection('markets')}>＋</button></div>{workspace.watchlist.slice(0, 5).map((stock) => <div className="watch-row" key={stock.id}><div><strong>{stock.symbol}</strong><small>{stock.companyName}</small></div><span>{money(quotes[stock.symbol]?.price, quotes[stock.symbol]?.currency ?? currency)}</span><span className={tone(quotes[stock.symbol]?.changePct)}>{signedPercent(quotes[stock.symbol]?.changePct)}</span></div>)}{!workspace.watchlist.length && <EmptyState title="Watchlist is empty" copy="Follow stocks without adding them to your portfolio." />}<button className="text-button" onClick={() => openSection('markets')}>Open market workspace →</button></article></section>
  </>;
}

function Portfolio({ workspace, quotes, metrics, currency, onAdd, onDelete }: { workspace: WorkspaceData; quotes: QuoteMap; metrics: ReturnType<typeof portfolioMetrics>; currency: string; onAdd: () => void; onDelete: (id: number, symbol: string) => void }) {
  const cashWeight = metrics.totalValue ? (workspace.profile.cashBalance / metrics.totalValue * 100).toFixed(1) : null;
  return <><section className="stat-grid"><div className="stat-card"><span>Market value</span><strong>{money(metrics.investedValue, currency)}</strong><small>{metrics.unpricedSymbols.length ? `Missing quotes: ${metrics.unpricedSymbols.join(', ')}` : `${workspace.positions.length} open positions`}</small></div><div className="stat-card"><span>Cost basis</span><strong>{money(metrics.costBasis, currency)}</strong><small>Saved purchase data</small></div><div className="stat-card"><span>Unrealized return</span><strong className={tone(metrics.totalReturn)}>{signedMoney(metrics.totalReturn, currency)}</strong><small>{signedPercent(metrics.totalReturnPct)}</small></div><div className="stat-card"><span>Cash balance</span><strong>{money(workspace.profile.cashBalance, currency)}</strong><small>{cashWeight === null ? 'Allocation unavailable' : `${cashWeight}% of portfolio`}</small></div></section><section className="panel full-panel"><div className="panel-heading"><div><p className="section-label">Holdings</p><h3>All positions</h3></div><button className="primary-small" onClick={onAdd}>＋ Add position</button></div><div className="holdings-header portfolio-header"><span>Asset</span><span>Market value</span><span>Today</span><span>Weight</span><span>Total gain</span><span /></div>{workspace.positions.length ? workspace.positions.map((position) => <HoldingRow key={position.id} position={position} quote={quotes[position.symbol]} total={metrics.investedValue} currency={currency} onDelete={() => onDelete(position.id, position.symbol)} />) : <EmptyState title="Build your portfolio" copy="Add your first real position. Northstar will request current market data after it is saved." />}</section></>;
}

function Markets({ workspace, quotes, selectedSymbol, setSelectedSymbol, busy, analysisReport, analysisError, analyzing, onAnalyze, onCreateForecast, onAdd, onDelete }: { workspace: WorkspaceData; quotes: QuoteMap; selectedSymbol: string; setSelectedSymbol: (symbol: string) => void; busy: boolean; analysisReport?: TechnicalAnalysisReport; analysisError?: string; analyzing: boolean; onAnalyze: (assumptions: AnalysisAssumptions) => Promise<void>; onCreateForecast: (seed: ForecastSeed) => void; onAdd: (fields: Record<string, unknown>) => Promise<boolean>; onDelete: (item: WatchlistItem) => void }) {
  const [watchSymbol, setWatchSymbol] = useState('');
  const [watchCompany, setWatchCompany] = useState('');
  const selected = quotes[selectedSymbol];
  const universe = [...workspace.positions.map(({ symbol, companyName }) => ({ symbol, companyName, source: 'Position' })), ...workspace.watchlist.map(({ symbol, companyName }) => ({ symbol, companyName, source: 'Watchlist' }))].filter((item, index, items) => items.findIndex((candidate) => candidate.symbol === item.symbol) === index);
  const rsi = rsiFromHistory(selected?.history ?? []);
  const history = selected?.history ?? [];
  const high = history.length ? Math.max(...history) : null;
  const low = history.length ? Math.min(...history) : null;
  const addWatchlist = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await onAdd({ symbol: watchSymbol, companyName: watchCompany || watchSymbol })) {
      setWatchSymbol('');
      setWatchCompany('');
    }
  };
  return <>
    <section className="market-layout"><article className="panel market-list-panel"><div className="panel-heading"><div><p className="section-label">Database universe</p><h3>Your tracked stocks</h3></div></div>{universe.length > 0 && <div className="market-table-header"><span>Symbol</span><span>Price</span><span>Move</span><span>Trend</span></div>}{universe.length ? universe.map((item) => <button className={`market-row ${selectedSymbol === item.symbol ? 'selected' : ''}`} key={item.symbol} onClick={() => setSelectedSymbol(item.symbol)}><div className="asset-cell"><span className="asset-logo">{assetInitial(item.symbol)}</span><div><strong>{item.symbol}</strong><span>{item.companyName} · {item.source}</span></div></div><strong>{money(quotes[item.symbol]?.price, quotes[item.symbol]?.currency ?? workspace.profile.baseCurrency)}</strong><span className={tone(quotes[item.symbol]?.changePct)}>{signedPercent(quotes[item.symbol]?.changePct)}</span><QuoteBars values={quotes[item.symbol]?.history ?? []} compact /></button>) : <EmptyState title="No saved market symbols" copy="Add a real position or watchlist item. Northstar does not preload a demo universe." />}</article><aside className="panel research-panel">{selectedSymbol ? <><div className="research-heading"><div><p className="section-label">Real-data snapshot</p><h2>{selectedSymbol}</h2></div><span className={tone(selected?.changePct)}>{signedPercent(selected?.changePct)}</span></div><strong className="research-price">{selected?.price !== null && selected?.price !== undefined ? money(selected.price, selected.currency ?? workspace.profile.baseCurrency) : 'Quote unavailable'}</strong><div className="research-chart"><QuoteBars values={history} /></div><div className="research-facts"><div><span>Previous close</span><strong>{money(selected?.previousClose, selected?.currency ?? workspace.profile.baseCurrency)}</strong></div><div><span>1M range</span><strong>{low !== null && high !== null ? `${money(low, selected?.currency ?? workspace.profile.baseCurrency)}–${money(high, selected?.currency ?? workspace.profile.baseCurrency)}` : '—'}</strong></div><div><span>RSI (14)</span><strong>{rsi === null ? '—' : rsi.toFixed(1)}</strong></div><div><span>Provider time</span><strong>{selected?.updatedAt ? new Date(selected.updatedAt).toLocaleString() : 'Unavailable'}</strong></div></div><p className="context-copy">Only saved symbols are shown. Prices and history come from the configured market-data provider in your portfolio currency; unavailable or mismatched-currency values remain blank.</p></> : <EmptyState title="Nothing selected" copy="Save a position or watchlist symbol to begin monitoring real market data." />}</aside></section>
    {selectedSymbol && <TechnicalAnalysisPanel symbol={selectedSymbol} report={analysisReport} error={analysisError} analyzing={analyzing} currency={selected?.currency ?? workspace.profile.baseCurrency} onAnalyze={onAnalyze} onCreateForecast={onCreateForecast} />}
    <section className="panel full-panel manage-watchlist"><div className="panel-heading"><div><p className="section-label">Manage</p><h3>Watchlist</h3></div></div><form className="inline-form" onSubmit={addWatchlist}><label><span>Ticker</span><TickerAutocomplete value={watchSymbol} disabled={busy} onChange={(value) => { setWatchSymbol(value); setWatchCompany(''); }} onSelect={(suggestion) => setWatchCompany(suggestion.companyName)} /></label><label><span>Company</span><input name="companyName" value={watchCompany} placeholder="Filled when you select a ticker" readOnly required maxLength={80} /></label><button className="primary-small" disabled={busy || !watchSymbol || !watchCompany}>{busy ? 'Saving…' : 'Add stock'}</button></form><p className="ticker-search-note">Suggestions are fetched from the live market directory. Select a result to fill the official company name.</p><div className="chip-list">{workspace.watchlist.map((item) => <span className="watch-chip" key={item.id}><strong>{item.symbol}</strong>{item.companyName}<button onClick={() => onDelete(item)} aria-label={`Remove ${item.symbol}`}>×</button></span>)}</div></section>
  </>;
}

function Journal({ entries, symbols, busy, onAdd, onDelete }: { entries: JournalEntry[]; symbols: string[]; busy: boolean; onAdd: (fields: Record<string, unknown>) => Promise<boolean>; onDelete: (entry: JournalEntry) => void }) {
  const addEntry = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const fields = Object.fromEntries(new FormData(event.currentTarget).entries()); if (await onAdd(fields)) event.currentTarget.reset(); };
  const canCreate = symbols.length > 0;
  return <section className="journal-layout"><form className="panel journal-form" onSubmit={addEntry}><div className="panel-heading"><div><p className="section-label">New reflection</p><h3>Record your thesis</h3></div></div><div className="form-grid two"><label><span>Date</span><input name="entryDate" type="date" defaultValue={todayLocalDate()} required /></label><label><span>Symbol</span><select name="symbol" defaultValue={symbols[0] ?? ''} required disabled={!canCreate}>{canCreate ? symbols.map((symbol) => <option key={symbol}>{symbol}</option>) : <option value="">Track a symbol first</option>}</select></label></div><div className="form-grid two"><label><span>Direction</span><select name="direction" defaultValue="Watching"><option>Bullish</option><option>Bearish</option><option>Neutral</option><option>Watching</option></select></label><label><span>Confidence</span><input name="confidence" type="number" min="0" max="100" step="5" defaultValue="60" /></label></div><label><span>Target / expectation</span><input name="target" placeholder="What outcome would confirm or challenge the thesis?" maxLength={120} /></label><label><span>Thesis</span><textarea name="thesis" placeholder="Write the evidence, risks, and what could change your mind…" rows={6} required maxLength={2000} /></label>{!canCreate && <p className="form-help">Add a position or watchlist item before creating a symbol-linked journal entry.</p>}<button className="primary-button" disabled={busy || !canCreate}>{busy ? 'Saving…' : 'Save journal entry'}</button></form><div className="journal-feed"><div className="feed-heading"><div><p className="section-label">History</p><h3>Recent entries</h3></div><span>{entries.length} notes</span></div>{entries.length ? entries.map((entry) => <article className="journal-entry" key={entry.id}><div className="entry-top"><div><span className={`direction ${entry.direction.toLowerCase()}`}>{entry.direction}</span><strong>{entry.symbol}</strong></div><button onClick={() => onDelete(entry)} aria-label="Delete journal entry">×</button></div><p>{entry.thesis}</p>{entry.target && <div className="entry-target"><span>Expectation</span>{entry.target}</div>}<footer><span>{new Date(`${entry.entryDate}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span><span>Confidence {entry.confidence}%</span></footer></article>) : <EmptyState title="Your journal is ready" copy="Capture a thesis after you save a real symbol to your workspace." />}</div></section>;
}

function Alerts({ alerts, quotes, symbols, busy, onAdd, onToggle, onDelete }: { alerts: ReviewAlert[]; quotes: QuoteMap; symbols: string[]; busy: boolean; onAdd: (fields: Record<string, unknown>) => Promise<boolean>; onToggle: (alert: ReviewAlert) => void; onDelete: (alert: ReviewAlert) => void }) {
  const addAlert = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (await onAdd(Object.fromEntries(new FormData(event.currentTarget).entries()))) event.currentTarget.reset(); };
  const triggered = alerts.filter((alert) => alertIsTriggered(alert, quotes));
  const canCreate = symbols.length > 0;
  return <>{triggered.length > 0 && <section className="trigger-banner"><span>!</span><div><strong>{triggered.length} {triggered.length === 1 ? 'alert needs' : 'alerts need'} review</strong><p>Conditions are met based on the latest available real quote. Revisit your thesis before taking action.</p></div></section>}<section className="alerts-layout"><form className="panel alert-form" onSubmit={addAlert}><div className="panel-heading"><div><p className="section-label">New reminder</p><h3>Create review alert</h3></div></div><label><span>Symbol</span><select name="symbol" defaultValue={symbols[0] ?? ''} required disabled={!canCreate}>{canCreate ? symbols.map((symbol) => <option key={symbol}>{symbol}</option>) : <option value="">Track a symbol first</option>}</select></label><label><span>Condition</span><select name="conditionType"><option>Price above</option><option>Price below</option><option>Daily move above %</option><option>Daily move below %</option></select></label><label><span>Threshold</span><input name="threshold" type="number" step="0.01" required placeholder="0.00" /></label><label><span>Review note</span><textarea name="note" rows={3} placeholder="What should you revisit when this happens?" maxLength={240} /></label>{!canCreate && <p className="form-help">Add a position or watchlist item before creating a market alert.</p>}<button className="primary-button" disabled={busy || !canCreate}>{busy ? 'Saving…' : 'Create alert'}</button></form><div className="alert-list"><div className="feed-heading"><div><p className="section-label">Rules</p><h3>Active review alerts</h3></div><span>{alerts.filter((item) => item.active).length} active</span></div>{alerts.length ? alerts.map((alert) => { const isTriggered = alertIsTriggered(alert, quotes); return <article className={`alert-row ${isTriggered ? 'triggered' : ''}`} key={alert.id}><span className="alert-symbol">{assetInitial(alert.symbol)}</span><div><div className="alert-title"><strong>{alert.symbol}</strong><span>{alert.conditionType} {alert.threshold.toLocaleString()}</span>{isTriggered && <b>Review now</b>}</div><p>{alert.note || 'No review note added.'}</p></div><div className="alert-actions"><button onClick={() => onToggle(alert)}>{alert.active ? 'Pause' : 'Activate'}</button><button onClick={() => onDelete(alert)} aria-label="Delete alert">×</button></div></article>; }) : <EmptyState title="No alerts yet" copy="Create alerts only after saving a real tracked symbol." />}</div></section></>;
}

function PositionModal({ busy, onClose, onSave }: { busy: boolean; onClose: () => void; onSave: (fields: Record<string, unknown>) => Promise<void> }) {
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void onSave(Object.fromEntries(new FormData(event.currentTarget).entries())); };
  return <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="position-title"><div className="modal-heading"><div><p className="section-label">Portfolio</p><h2 id="position-title">Add a position</h2></div><button onClick={onClose} aria-label="Close">×</button></div><form onSubmit={submit}><div className="form-grid two"><label><span>Ticker</span><input name="symbol" placeholder="Ticker symbol" required maxLength={10} autoFocus /></label><label><span>Company name</span><input name="companyName" placeholder="Company name" required maxLength={80} /></label></div><div className="form-grid two"><label><span>Shares</span><input name="shares" type="number" min="0.000001" step="any" placeholder="Number of shares" required /></label><label><span>Average cost</span><input name="averageCost" type="number" min="0" step="0.01" placeholder="Average purchase cost" required /></label></div><p className="form-help">Adding the same ticker again combines the shares and recalculates the weighted average cost.</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Add position'}</button></div></form></div></div>;
}

function ProfileModal({ profile, busy, onClose, onSave }: { profile: WorkspaceData['profile']; busy: boolean; onClose: () => void; onSave: (fields: Record<string, unknown>) => Promise<void> }) {
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void onSave(Object.fromEntries(new FormData(event.currentTarget).entries())); };
  return <div className="modal-backdrop" role="presentation"><div className="modal small" role="dialog" aria-modal="true" aria-labelledby="profile-title"><div className="modal-heading"><div><p className="section-label">Workspace</p><h2 id="profile-title">Portfolio details</h2></div><button onClick={onClose} aria-label="Close">×</button></div><form onSubmit={submit}><label><span>Portfolio name</span><input name="name" defaultValue={profile.name} maxLength={80} required autoFocus /></label><label><span>Cash balance</span><input name="cashBalance" type="number" min="0" step="0.01" defaultValue={profile.cashBalance} required /></label><p className="form-help">Cash is included in total portfolio value and allocation calculations.</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button></div></form></div></div>;
}
