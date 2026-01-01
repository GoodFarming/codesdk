import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import type { RuntimeEnv, RuntimeIsolationLevel, RuntimeIsolationMode } from '../core/types.js';

export interface RuntimeEnvOptions {
  credentialNamespace: string;
  cwd?: string;
  env?: Record<string, string>;
  isolationLevel?: RuntimeIsolationLevel;
  isolationMode?: RuntimeIsolationMode;
  baseDir?: string;
  sessionId?: string;
  createDirs?: boolean;
}

export interface RuntimeEnvPaths {
  baseDir: string;
  namespaceDir: string;
  rootDir: string;
  homeDir: string;
  xdgConfigHome: string;
  xdgStateHome: string;
  xdgCacheHome: string;
}

export function buildRuntimeEnv(options: RuntimeEnvOptions): RuntimeEnv {
  const cwd = options.cwd ?? process.cwd();
  const isolationLevel = options.isolationLevel ?? 'namespaced';
  const isolationMode = options.isolationMode ?? 'in_process';
  const env = mergeEnv(process.env, options.env);

  if (isolationLevel !== 'shared') {
    const paths = resolveRuntimeEnvPaths({
      baseDir: options.baseDir,
      credentialNamespace: options.credentialNamespace,
      isolationLevel,
      sessionId: options.sessionId
    });

    env.HOME = paths.homeDir;
    env.XDG_CONFIG_HOME = paths.xdgConfigHome;
    env.XDG_STATE_HOME = paths.xdgStateHome;
    env.XDG_CACHE_HOME = paths.xdgCacheHome;

    if (options.createDirs ?? true) {
      mkdirSync(paths.homeDir, { recursive: true });
      mkdirSync(paths.xdgConfigHome, { recursive: true });
      mkdirSync(paths.xdgStateHome, { recursive: true });
      mkdirSync(paths.xdgCacheHome, { recursive: true });
    }

    return {
      cwd,
      env,
      credentialNamespace: options.credentialNamespace,
      isolation: {
        level: isolationLevel,
        mode: isolationMode,
        homeDir: paths.homeDir,
        xdgConfigHome: paths.xdgConfigHome,
        xdgStateHome: paths.xdgStateHome,
        xdgCacheHome: paths.xdgCacheHome
      }
    };
  }

  return {
    cwd,
    env,
    credentialNamespace: options.credentialNamespace,
    isolation: {
      level: isolationLevel,
      mode: isolationMode,
      homeDir: env.HOME,
      xdgConfigHome: env.XDG_CONFIG_HOME,
      xdgStateHome: env.XDG_STATE_HOME,
      xdgCacheHome: env.XDG_CACHE_HOME
    }
  };
}

export function resolveRuntimeEnvPaths(options: {
  credentialNamespace: string;
  isolationLevel: Exclude<RuntimeIsolationLevel, 'shared'>;
  baseDir?: string;
  sessionId?: string;
}): RuntimeEnvPaths {
  const baseDir = options.baseDir ?? path.join(os.homedir(), '.codesdk', 'runtime-env');
  const namespaceDir = path.join(baseDir, sanitizeNamespace(options.credentialNamespace));
  const sessionId = options.sessionId ?? randomUUID();
  const rootDir =
    options.isolationLevel === 'ephemeral' ? path.join(namespaceDir, `session-${sessionId}`) : namespaceDir;

  return {
    baseDir,
    namespaceDir,
    rootDir,
    homeDir: path.join(rootDir, 'home'),
    xdgConfigHome: path.join(rootDir, 'config'),
    xdgStateHome: path.join(rootDir, 'state'),
    xdgCacheHome: path.join(rootDir, 'cache')
  };
}

function sanitizeNamespace(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function mergeEnv(
  base: NodeJS.ProcessEnv,
  overrides?: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      env[key] = value;
    }
  }
  return env;
}
