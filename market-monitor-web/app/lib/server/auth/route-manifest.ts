import type { AuthorizationAction } from './types.ts';

export type RouteBoundary =
  | 'human_protected'
  | 'provider_signed'
  | 'capability_authorized'
  | 'public_read_only'
  | 'build_static';

export type RouteAuthorizationEntry = {
  source: string;
  enforcementSource?: string;
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  boundary: RouteBoundary;
  action?: AuthorizationAction;
  additionalActions?: readonly AuthorizationAction[];
  rationale: string;
};

const human = (
  source: string,
  path: string,
  method: RouteAuthorizationEntry['method'],
  action: AuthorizationAction,
): RouteAuthorizationEntry => ({
  source, path, method, action, boundary: 'human_protected',
  rationale: 'Profile-owned data requires a verified active membership and profile-scoped policy decision.',
});

export const ROUTE_AUTHORIZATION_MANIFEST: readonly RouteAuthorizationEntry[] = [
  human('app/page.tsx', '/', 'GET', 'workspace_read'),
  human('app/notifications/page.tsx', '/notifications', 'GET', 'in_app_notification_list'),
  human('app/notifications/[id]/page.tsx', '/notifications/:id', 'GET', 'in_app_notification_read'),
  {
    ...human('app/api/workspace/route.ts', '/api/workspace', 'GET', 'workspace_read'),
    enforcementSource: 'app/lib/server/direct-sql-human-routes.ts',
  },
  {
    ...human('app/api/workspace/route.ts', '/api/workspace', 'POST', 'portfolio_write'),
    enforcementSource: 'app/lib/server/direct-sql-human-routes.ts',
    additionalActions: ['profile_update'],
    rationale: 'Workspace mutations require owner-only portfolio-write or profile-update authority by payload action.',
  },
  {
    ...human('app/api/market/route.ts', '/api/market', 'GET', 'market_read'),
    enforcementSource: 'app/lib/server/direct-sql-human-routes.ts',
  },
  human('app/api/market/search/route.ts', '/api/market/search', 'GET', 'market_search'),
  {
    ...human('app/api/analysis/route.ts', '/api/analysis', 'POST', 'analysis_run'),
    enforcementSource: 'app/lib/server/direct-sql-human-routes.ts',
  },
  human('app/api/forecasts/route.ts', '/api/forecasts', 'GET', 'forecast_list'),
  human('app/api/forecasts/route.ts', '/api/forecasts', 'POST', 'forecast_create'),
  human('app/api/forecasts/[id]/route.ts', '/api/forecasts/:id', 'GET', 'forecast_read'),
  human('app/api/forecasts/[id]/route.ts', '/api/forecasts/:id', 'PATCH', 'forecast_edit'),
  human('app/api/forecasts/[id]/route.ts', '/api/forecasts/:id', 'DELETE', 'forecast_delete'),
  human('app/api/forecasts/[id]/activate/route.ts', '/api/forecasts/:id/activate', 'POST', 'forecast_activate'),
  human('app/api/forecasts/[id]/cancel/route.ts', '/api/forecasts/:id/cancel', 'POST', 'forecast_cancel'),
  human('app/api/forecasts/[id]/notes/route.ts', '/api/forecasts/:id/notes', 'POST', 'forecast_note'),
  human('app/api/forecasts/[id]/evaluate/route.ts', '/api/forecasts/:id/evaluate', 'POST', 'forecast_evaluate'),
  human('app/api/forecasts/[id]/evaluations/latest/route.ts', '/api/forecasts/:id/evaluations/latest', 'GET', 'evaluation_read'),
  human('app/api/forecast-reviews/route.ts', '/api/forecast-reviews', 'GET', 'review_list'),
  human('app/api/forecast-reviews/[id]/acknowledge/route.ts', '/api/forecast-reviews/:id/acknowledge', 'POST', 'review_acknowledge'),
  {
    ...human('app/api/notifications/route.ts', '/api/notifications', 'GET', 'in_app_notification_list'),
    enforcementSource: 'app/lib/server/in-app-notifications/http.ts',
  },
  {
    ...human('app/api/notifications/unread-count/route.ts', '/api/notifications/unread-count', 'GET', 'in_app_notification_list'),
    enforcementSource: 'app/lib/server/in-app-notifications/http.ts',
  },
  {
    ...human('app/api/notifications/[id]/route.ts', '/api/notifications/:id', 'GET', 'in_app_notification_read'),
    enforcementSource: 'app/lib/server/in-app-notifications/http.ts',
  },
  {
    ...human('app/api/notifications/[id]/read/route.ts', '/api/notifications/:id/read', 'POST', 'in_app_notification_state_update'),
    enforcementSource: 'app/lib/server/in-app-notifications/http.ts',
  },
  {
    ...human('app/api/notifications/[id]/unread/route.ts', '/api/notifications/:id/unread', 'POST', 'in_app_notification_state_update'),
    enforcementSource: 'app/lib/server/in-app-notifications/http.ts',
  },
  {
    ...human('app/api/notifications/mark-all-read/route.ts', '/api/notifications/mark-all-read', 'POST', 'in_app_notification_state_update'),
    enforcementSource: 'app/lib/server/in-app-notifications/http.ts',
  },
  {
    source: 'app/api/webhooks/resend/route.ts', path: '/api/webhooks/resend', method: 'POST',
    enforcementSource: 'app/lib/server/email/webhook-http.ts',
    boundary: 'provider_signed', action: 'resend_webhook_reconcile',
    rationale: 'Public transport endpoint; raw bytes are authenticated before a restricted Resend principal is created.',
  },
  {
    source: 'app/email/verify/route.ts', path: '/email/verify', method: 'GET',
    boundary: 'public_read_only',
    rationale: 'Scanner-safe confirmation HTML performs no storage lookup and no mutation.',
  },
  {
    source: 'app/email/verify/route.ts', path: '/email/verify', method: 'POST',
    enforcementSource: 'app/lib/server/email/recipient-service.ts',
    boundary: 'capability_authorized', action: 'email_verification_consume',
    rationale: 'Exact-purpose opaque verification capability; never creates a human session.',
  },
  {
    source: 'app/email/unsubscribe/route.ts', path: '/email/unsubscribe', method: 'GET',
    boundary: 'public_read_only',
    rationale: 'Scanner-safe confirmation HTML performs no storage lookup and no mutation.',
  },
  {
    source: 'app/email/unsubscribe/route.ts', path: '/email/unsubscribe', method: 'POST',
    enforcementSource: 'app/lib/server/email/recipient-service.ts',
    boundary: 'capability_authorized', action: 'email_unsubscribe_consume',
    rationale: 'Exact recipient and consent-revision capability; never creates a human session.',
  },
] as const;

export const NON_ROUTE_EXECUTION_BOUNDARIES = [
  {
    source: 'worker/index.ts', name: 'scheduled', boundary: 'system_only',
    evidence: 'async scheduled(controller, env)',
  },
  {
    source: 'worker/index.ts', name: 'fetch', boundary: 'framework_router',
    evidence: 'fetch(request, env, ctx)',
  },
  { source: 'public/og.png', name: 'open_graph_image', boundary: 'build_static' },
] as const;
