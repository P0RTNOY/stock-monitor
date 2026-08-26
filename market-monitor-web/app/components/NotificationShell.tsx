import Link from 'next/link';
import type { ReactNode } from 'react';

export default function NotificationShell({ children, detail = false }: { children: ReactNode; detail?: boolean }) {
  return <div className="app-shell notification-shell">
    <aside className="sidebar">
      <Link className="brand-mark" href="/" aria-label="Northstar overview">N</Link>
      <nav aria-label="Primary navigation">
        <Link className="nav-item" href="/"><span className="nav-icon" aria-hidden="true">⌂</span><span>Workspace</span></Link>
        <Link className="nav-item active" href="/notifications" aria-current="page"><span className="nav-icon" aria-hidden="true">♢</span><span>Notifications</span></Link>
      </nav>
    </aside>
    <main className="workspace">
      <header className="topbar">
        <div><p className="eyebrow">Northstar / notifications{detail ? ' / evidence' : ''}</p>
          <h1>{detail ? 'Notification evidence.' : 'Notification Center.'}</h1></div>
        <Link className="secondary-button notification-back-link" href={detail ? '/notifications' : '/'}>
          {detail ? '← Notification Center' : '← Workspace'}
        </Link>
      </header>
      {children}
    </main>
  </div>;
}
