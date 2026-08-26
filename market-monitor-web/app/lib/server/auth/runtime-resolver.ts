import { env } from 'cloudflare:workers';
import { ensureDatabase, getD1 } from '@/db';
import { authConfigurationFromEnv, AuthConfigurationError, type AuthEnvironmentBindings } from './config.ts';
import { authorizeProfileScope, AuthorizationBoundaryError, type AuthorizedProfileScope } from './enforcement.ts';
import { D1HumanPrincipalRepository } from './repository.ts';
import { resolveRequestPrincipal } from './resolver.ts';
import type { AuthorizationAction, HumanPrincipal, Principal, ResourceScope } from './types.ts';

export async function runtimeRequestPrincipal(request: Request): Promise<Principal> {
  const bindings = env as unknown as AuthEnvironmentBindings;
  let configuration;
  try {
    configuration = authConfigurationFromEnv(bindings);
  } catch (error) {
    if (error instanceof AuthConfigurationError) throw new AuthorizationBoundaryError('configuration_invalid');
    throw error;
  }
  if (configuration.mode === 'deny_all') return { kind: 'anonymous' };
  await ensureDatabase();
  return resolveRequestPrincipal(request, {
    bindings,
    repository: new D1HumanPrincipalRepository(getD1()),
  });
}

export async function authorizeHumanRequest<A extends AuthorizationAction>(
  request: Request,
  action: A,
  resource: Omit<ResourceScope, 'profileId'> = {},
): Promise<AuthorizedProfileScope<A>> {
  const principal = await runtimeRequestPrincipal(request);
  if (principal.kind !== 'human') throw new AuthorizationBoundaryError('unauthenticated');
  return authorizeProfileScope(principal, action, { ...resource, profileId: principal.profileId });
}

export type ProtectedPageState =
  | { kind: 'authentication_not_configured' }
  | { kind: 'access_forbidden' }
  | { kind: 'local_bootstrap'; principal: HumanPrincipal };

export async function protectedPageState(
  action: AuthorizationAction,
  request: Request = new Request('http://northstar.invalid/'),
):
Promise<ProtectedPageState> {
  const principal = await runtimeRequestPrincipal(request);
  if (principal.kind !== 'human') return { kind: 'authentication_not_configured' };
  try {
    authorizeProfileScope(principal, action, { profileId: principal.profileId });
    return { kind: 'local_bootstrap', principal };
  } catch (error) {
    if (error instanceof AuthorizationBoundaryError) return { kind: 'access_forbidden' };
    throw error;
  }
}
