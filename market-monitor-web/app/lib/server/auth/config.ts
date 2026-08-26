export type NorthstarEnvironment = 'local' | 'test' | 'preview' | 'staging' | 'production';
export type NorthstarAuthMode = 'deny_all' | 'local_bootstrap';

export type AuthEnvironmentBindings = {
  NORTHSTAR_ENVIRONMENT?: string;
  NORTHSTAR_AUTH_MODE?: string;
  NORTHSTAR_SYSTEM_PROFILE_ID?: string;
};

export type AuthConfiguration = {
  environment: NorthstarEnvironment;
  mode: NorthstarAuthMode;
  systemProfileId: number | null;
};

export class AuthConfigurationError extends Error {
  constructor() {
    super('Northstar authorization configuration is invalid.');
    this.name = 'AuthConfigurationError';
  }
}

const ENVIRONMENTS = new Set<NorthstarEnvironment>(['local', 'test', 'preview', 'staging', 'production']);
const MODES = new Set<NorthstarAuthMode>(['deny_all', 'local_bootstrap']);

export function authConfigurationFromEnv(bindings: AuthEnvironmentBindings): AuthConfiguration {
  const environment = bindings.NORTHSTAR_ENVIRONMENT ?? 'production';
  const mode = bindings.NORTHSTAR_AUTH_MODE ?? 'deny_all';
  if (!ENVIRONMENTS.has(environment as NorthstarEnvironment) || !MODES.has(mode as NorthstarAuthMode)) {
    throw new AuthConfigurationError();
  }
  if (mode === 'local_bootstrap' && environment !== 'local' && environment !== 'test') {
    throw new AuthConfigurationError();
  }
  const rawProfileId = bindings.NORTHSTAR_SYSTEM_PROFILE_ID;
  const systemProfileId = rawProfileId === undefined ? null : Number(rawProfileId);
  if (rawProfileId !== undefined
    && (!/^[1-9][0-9]*$/u.test(rawProfileId) || !Number.isSafeInteger(systemProfileId))) {
    throw new AuthConfigurationError();
  }
  return {
    environment: environment as NorthstarEnvironment,
    mode: mode as NorthstarAuthMode,
    systemProfileId,
  };
}
