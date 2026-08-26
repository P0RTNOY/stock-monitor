import { authorize } from './policy.ts';
import type {
  AuthorizationAction,
  AuthorizationReason,
  AuthorizedProfileScope as PublicAuthorizedProfileScope,
  Principal,
  ResourceScope,
} from './types.ts';

const authorizedScopeBrand: unique symbol = Symbol('AuthorizedProfileScope');

export type AuthorizedProfileScope<A extends AuthorizationAction = AuthorizationAction> =
  PublicAuthorizedProfileScope & {
    readonly action: A;
    readonly [authorizedScopeBrand]: true;
  };

export class AuthorizationBoundaryError extends Error {
  readonly reason: AuthorizationReason | 'configuration_invalid';
  readonly status: 401 | 403 | 503;

  constructor(reason: AuthorizationBoundaryError['reason']) {
    const status = reason === 'unauthenticated' ? 401 : reason === 'configuration_invalid' ? 503 : 403;
    super(status === 401
      ? 'Authentication is required.'
      : status === 403
        ? 'This action is not permitted.'
        : 'Authorization is unavailable.');
    this.name = 'AuthorizationBoundaryError';
    this.reason = reason;
    this.status = status;
  }
}

export function authorizeProfileScope<A extends AuthorizationAction>(
  principal: Principal,
  action: A,
  resource: ResourceScope & { profileId: number },
): AuthorizedProfileScope<A> {
  const decision = authorize(principal, action, resource);
  if (!decision.allowed) throw new AuthorizationBoundaryError(decision.reason);
  return {
    profileId: resource.profileId,
    action,
    principal,
    [authorizedScopeBrand]: true,
  };
}

export function profileIdFromScope(
  scope: AuthorizedProfileScope,
  expectedAction: AuthorizationAction,
) {
  if (scope.action !== expectedAction || scope.profileId < 1 || !Number.isSafeInteger(scope.profileId)) {
    throw new AuthorizationBoundaryError('resource_unavailable');
  }
  return scope.profileId;
}

export function exactActionScope<A extends AuthorizationAction>(
  scope: AuthorizedProfileScope,
  expectedAction: A,
): AuthorizedProfileScope<A> {
  profileIdFromScope(scope, expectedAction);
  return scope as AuthorizedProfileScope<A>;
}
