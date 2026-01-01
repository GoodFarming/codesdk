import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRuntimeEnv, resolveRuntimeEnvPaths } from '../src/runtime-env/index.js';

describe('runtime env builder', () => {
  it('builds namespaced env with HOME/XDG overrides', () => {
    const baseDir = path.join(process.cwd(), '.tmp', 'runtime-env-test');
    const env = buildRuntimeEnv({
      credentialNamespace: 'user:abc/def',
      isolationLevel: 'namespaced',
      isolationMode: 'in_process',
      baseDir
    });

    const expectedNamespace = path.join(baseDir, 'user_abc_def');
    expect(env.isolation?.level).toBe('namespaced');
    expect(env.isolation?.homeDir).toBe(path.join(expectedNamespace, 'home'));
    expect(env.env.HOME).toBe(path.join(expectedNamespace, 'home'));
    expect(env.env.XDG_CONFIG_HOME).toBe(path.join(expectedNamespace, 'config'));
  });

  it('builds ephemeral env with session id', () => {
    const baseDir = path.join(process.cwd(), '.tmp', 'runtime-env-test');
    const env = buildRuntimeEnv({
      credentialNamespace: 'default',
      isolationLevel: 'ephemeral',
      isolationMode: 'subprocess',
      baseDir,
      sessionId: 'session-123'
    });

    const expectedRoot = path.join(baseDir, 'default', 'session-session-123');
    expect(env.isolation?.level).toBe('ephemeral');
    expect(env.env.HOME).toBe(path.join(expectedRoot, 'home'));
    expect(env.env.XDG_STATE_HOME).toBe(path.join(expectedRoot, 'state'));
  });

  it('resolves paths deterministically', () => {
    const paths = resolveRuntimeEnvPaths({
      credentialNamespace: 'user:abc/def',
      isolationLevel: 'namespaced',
      baseDir: '/tmp/codesdk',
      sessionId: 'session-1'
    });

    expect(paths.namespaceDir).toBe(path.join('/tmp/codesdk', 'user_abc_def'));
  });
});
