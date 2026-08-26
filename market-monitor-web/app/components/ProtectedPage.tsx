import type { ReactNode } from 'react';
import { protectedPageState } from '@/app/lib/server/auth/runtime-resolver';
import type { ProtectedPageState } from '@/app/lib/server/auth/runtime-resolver';
import type { AuthorizationAction } from '@/app/lib/server/auth/types';

function AuthenticationNotConfigured({ unavailable = false }: { unavailable?: boolean }) {
  return (
    <main className="auth-gate" aria-labelledby="auth-gate-title">
      <section>
        <p className="eyebrow">Northstar access</p>
        <h1 id="auth-gate-title">
          {unavailable ? 'Authorization is unavailable' : 'Authentication is not configured'}
        </h1>
        <p>
          {unavailable
            ? 'Northstar could not validate its authorization configuration. Protected data remains unavailable.'
            : 'Protected portfolio and forecast data is unavailable until secure authentication is added in Phase 3A2.'}
        </p>
        <p>No login form is available in this phase.</p>
      </section>
    </main>
  );
}

function AccessForbidden() {
  return (
    <main className="auth-gate" aria-labelledby="auth-gate-title">
      <section>
        <p className="eyebrow">Northstar access</p>
        <h1 id="auth-gate-title">Access is not permitted</h1>
        <p>This identity does not have permission to view this protected page.</p>
      </section>
    </main>
  );
}

export default async function ProtectedPage({ children, action }: {
  children: ReactNode;
  action: AuthorizationAction;
}) {
  let state: ProtectedPageState | null = null;
  try {
    state = await protectedPageState(action);
  } catch {
    // The rendered state is selected outside the catch boundary.
  }
  if (!state) return <AuthenticationNotConfigured unavailable />;
  if (state.kind === 'authentication_not_configured') return <AuthenticationNotConfigured />;
  if (state.kind === 'access_forbidden') return <AccessForbidden />;
  return (
    <>
      <aside className="local-bootstrap-banner" role="status">
        Authentication is not active. Access is using the local bootstrap owner. Do not deploy this mode.
      </aside>
      {children}
    </>
  );
}
