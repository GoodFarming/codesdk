import type { AuthStatus, RuntimeAdapter, RuntimeEnv } from '../core/types.js';

export async function getAuthStatus(
  runtime: RuntimeAdapter,
  env: RuntimeEnv
): Promise<AuthStatus> {
  return runtime.getAuthStatus(env);
}

export async function ensureLogin(
  runtime: RuntimeAdapter,
  env: RuntimeEnv
): Promise<{ ok: boolean; instructions?: string }> {
  if (!runtime.ensureLogin) {
    return { ok: false, instructions: 'Runtime adapter does not support ensureLogin().' };
  }
  return runtime.ensureLogin(env);
}
