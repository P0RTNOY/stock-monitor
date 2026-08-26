import { AuthorizationBoundaryError } from './enforcement.ts';

export function authorizationErrorResponse(error: unknown): Response | null {
  if (!(error instanceof AuthorizationBoundaryError)) return null;
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  };
  if (error.status === 401) {
    return Response.json(
      { error: 'Authentication is required.', code: 'unauthenticated' },
      { status: 401, headers },
    );
  }
  if (error.status === 403) {
    return Response.json(
      { error: 'This action is not permitted.', code: 'forbidden' },
      { status: 403, headers },
    );
  }
  return Response.json(
    { error: 'Authorization is unavailable.', code: 'authorization_unavailable' },
    { status: 503, headers },
  );
}
