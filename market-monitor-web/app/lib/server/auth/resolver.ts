import { authConfigurationFromEnv, AuthConfigurationError, type AuthEnvironmentBindings } from './config.ts';
import { AuthorizationBoundaryError } from './enforcement.ts';
import type { HumanPrincipalRepository } from './repository.ts';
import type { Principal } from './types.ts';

export type RequestPrincipalDependencies = {
  bindings: AuthEnvironmentBindings;
  repository: HumanPrincipalRepository;
  prepareLocalBootstrap?(): Promise<void>;
};

export async function resolveRequestPrincipal(
  request: Request,
  dependencies: RequestPrincipalDependencies,
): Promise<Principal> {
  // Phase 3A1 intentionally ignores every browser header and cookie. Phase 3A2
  // will replace this resolver with a cryptographically verified session.
  void request;
  let configuration;
  try {
    configuration = authConfigurationFromEnv(dependencies.bindings);
  } catch (error) {
    if (error instanceof AuthConfigurationError) throw new AuthorizationBoundaryError('configuration_invalid');
    throw error;
  }
  if (configuration.mode === 'deny_all') return { kind: 'anonymous' };
  await dependencies.prepareLocalBootstrap?.();
  return await dependencies.repository.loadLocalBootstrapPrincipal() ?? { kind: 'anonymous' };
}
