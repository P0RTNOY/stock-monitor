'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { notificationBadge, notificationCountLabel } from '../lib/in-app-notifications';

export default function NotificationBell() {
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/notifications/unread-count', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => response.ok ? await response.json() as unknown : null)
      .then((value) => {
        if (value && typeof value === 'object' && Number.isSafeInteger((value as { unreadCount?: unknown }).unreadCount)) {
          setCount((value as { unreadCount: number }).unreadCount);
        }
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  return <Link className="notification-bell" href="/notifications"
    aria-label={notificationCountLabel(count, loading)}>
    <span aria-hidden="true">♢</span>
    <b aria-hidden="true">{loading ? '…' : count === null ? '—' : notificationBadge(count)}</b>
  </Link>;
}
