import type {
  AuthStatus,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEnv,
  RuntimeName
} from '../core/types.js';

export interface RuntimeHealth {
  ok: boolean;
  runtime: RuntimeName;
  time: string;
  capabilities: RuntimeCapabilities;
  auth?: AuthStatus;
  error?: string;
}

export function getRuntimeCapabilities(runtime: RuntimeAdapter): RuntimeCapabilities {
  return runtime.getCapabilities();
}

export async function getRuntimeAuthStatus(
  runtime: RuntimeAdapter,
  env: RuntimeEnv
): Promise<AuthStatus> {
  return runtime.getAuthStatus(env);
}

export async function getRuntimeHealth(
  runtime: RuntimeAdapter,
  env: RuntimeEnv,
  options?: { includeAuth?: boolean }
): Promise<RuntimeHealth> {
  const capabilities = runtime.getCapabilities();
  const health: RuntimeHealth = {
    ok: true,
    runtime: runtime.name,
    time: new Date().toISOString(),
    capabilities
  };

  if (options?.includeAuth === false) {
    return health;
  }

  try {
    health.auth = await runtime.getAuthStatus(env);
  } catch (error) {
    health.ok = false;
    health.error = error instanceof Error ? error.message : String(error);
  }

  return health;
}
