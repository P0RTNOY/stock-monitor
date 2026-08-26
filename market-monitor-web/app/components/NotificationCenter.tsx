'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import AccessibleDialog from './AccessibleDialog';
import {
  IN_APP_CATEGORY_LABELS,
  notificationTimestamp,
  parseClientNotificationList,
  type ClientNotification,
  type ClientNotificationCategory,
  type ClientNotificationList,
  type ClientNotificationState,
} from '../lib/in-app-notifications';

type StateFilter = ClientNotificationState | 'all';
type CategoryFilter = ClientNotificationCategory | 'all';

export default function NotificationCenter() {
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [data, setData] = useState<ClientNotificationList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const requestSequence = useRef(0);

  const load = useCallback(async (cursor?: string) => {
    const sequence = ++requestSequence.current;
    if (cursor) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    const query = new URLSearchParams({ state: stateFilter, category: categoryFilter, limit: '20' });
    if (cursor) query.set('cursor', cursor);
    try {
      const response = await fetch(`/api/notifications?${query}`, { cache: 'no-store' });
      const parsed = parseClientNotificationList(await response.json() as unknown);
      if (!response.ok || !parsed) throw new Error('Notification list unavailable.');
      if (sequence !== requestSequence.current) return;
      setData((current) => cursor && current
        ? { ...parsed, items: [...current.items, ...parsed.items] }
        : parsed);
    } catch {
      if (sequence === requestSequence.current) setError('The Notification Center could not be loaded.');
    } finally {
      if (sequence === requestSequence.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [categoryFilter, stateFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const mutate = async (entry: ClientNotification) => {
    setBusyId(entry.id);
    setError(null);
    const next = entry.state === 'unread' ? 'read' : 'unread';
    try {
      const response = await fetch(`/api/notifications/${entry.id}/${next}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!response.ok) throw new Error('mutation');
      setAnnouncement(`Notification marked ${next}.`);
      await load();
    } catch { setError(`The notification could not be marked ${next}.`); }
    finally { setBusyId(null); }
  };

  const markAll = async () => {
    if (!data) return;
    setBusyId('all');
    setConfirmAll(false);
    setError(null);
    try {
      const response = await fetch('/api/notifications/mark-all-read', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ highWaterToken: data.markAllReadToken }),
      });
      if (!response.ok) throw new Error('mutation');
      setAnnouncement('All notifications in the captured list snapshot were marked read.');
      await load();
    } catch { setError('Notifications could not be marked read.'); }
    finally { setBusyId(null); }
  };

  const filteredEmpty = data && data.items.length === 0 && (stateFilter !== 'all' || categoryFilter !== 'all');

  return <>
    <p className="sr-only" aria-live="polite">{announcement}</p>
    <section className="notification-toolbar" aria-label="Notification filters">
      <label><span>Read state</span><select value={stateFilter} onChange={(event) => setStateFilter(event.target.value as StateFilter)}>
        <option value="all">All</option><option value="unread">Unread</option><option value="read">Read</option>
      </select></label>
      <label><span>Category</span><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value as CategoryFilter)}>
        <option value="all">All categories</option>
        {Object.entries(IN_APP_CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <div className="notification-count"><span>Unread</span><strong>{data?.unreadCount ?? '—'}</strong></div>
      <button className="secondary-button" disabled={!data?.unreadCount || busyId !== null}
        onClick={() => setConfirmAll(true)}>Mark all as read</button>
    </section>

    {error && <div className="notification-message error" role="alert"><p>{error}</p><button onClick={() => void load()}>Try again</button></div>}
    {loading && !data && <div className="notification-message" role="status" aria-live="polite">Loading notifications…</div>}
    {!loading && data?.items.length === 0 && <div className="notification-empty">
      <span aria-hidden="true">✦</span><h2>{filteredEmpty ? 'No notifications match these filters' : 'No notifications yet'}</h2>
      <p>{filteredEmpty ? 'Change a filter to see other persisted entries.' : 'New trusted forecast outcomes and review items will appear here after projection.'}</p>
    </div>}

    <section className="notification-list" aria-label="Notifications" aria-busy={loading || loadingMore}>
      {data?.items.map((entry) => <article className={`notification-card ${entry.state}`} key={entry.id}>
        <div className={`notification-category ${entry.category}`} aria-hidden="true">{entry.category === 'needs_review' ? '!' : '✓'}</div>
        <div className="notification-card-body">
          <div className="notification-card-meta"><strong>{entry.symbol}</strong><span>{IN_APP_CATEGORY_LABELS[entry.category]}</span><b>{entry.state === 'unread' ? 'Unread' : 'Read'}</b></div>
          <h2>{entry.presentation.title}</h2><p>{entry.presentation.summary}</p>
          <dl><div><dt>Forecast outcome</dt><dd>{IN_APP_CATEGORY_LABELS[entry.category]}</dd></div>
            <div><dt>Email channel</dt><dd className={entry.email.tone}>{entry.email.label}</dd></div></dl>
          <time dateTime={entry.occurredAt}>{notificationTimestamp(entry.occurredAt)}</time>
        </div>
        <div className="notification-card-actions">
          <Link href={entry.deepLink}>Inspect evidence</Link>
          <button disabled={busyId !== null} onClick={() => void mutate(entry)}>
            {busyId === entry.id ? 'Saving…' : entry.state === 'unread' ? 'Mark as read' : 'Mark as unread'}
          </button>
        </div>
      </article>)}
    </section>
    {data?.nextCursor && <button className="notification-load-more" disabled={loadingMore || busyId !== null}
      onClick={() => void load(data.nextCursor ?? undefined)}>{loadingMore ? 'Loading…' : 'Load more'}</button>}

    {confirmAll && <AccessibleDialog eyebrow="Read state" title="Mark captured notifications as read?" onClose={() => setConfirmAll(false)} className="notification-confirm-dialog">
      <p>Only notifications that existed when this list snapshot was issued will change. Newer entries remain unread.</p>
      <div className="notification-dialog-actions"><button data-autofocus className="secondary-button" onClick={() => setConfirmAll(false)}>Keep unread</button>
        <button className="primary-button" onClick={() => void markAll()}>Mark as read</button></div>
    </AccessibleDialog>}
  </>;
}
