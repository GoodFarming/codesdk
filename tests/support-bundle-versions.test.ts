import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('support bundle version resolution', () => {
  it('does not depend on process.cwd() (child process)', () => {
    const repoRoot = process.cwd();
    const tmpCwd = mkdtempSync(path.join(os.tmpdir(), 'codesdk-cwd-'));
    const distUrl = pathToFileURL(path.join(repoRoot, 'dist', 'index.js')).href;

    const script = `
      import { createSupportBundle, InMemoryEventStore, InMemoryArtifactStore } from ${JSON.stringify(distUrl)};
      import { createRequire } from 'node:module';
      import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
      import os from 'node:os';
      import path from 'node:path';

      const require = createRequire(${JSON.stringify(distUrl)});
      const { x: untar } = require('tar');

      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'codesdk-bundle-child-'));
      const outputPath = path.join(tmpDir, 'bundle.tgz');
      const extractDir = path.join(tmpDir, 'extract');
      mkdirSync(extractDir, { recursive: true });

      const env = { cwd: process.cwd(), env: {}, credentialNamespace: 'test', isolation: { mode: 'in_process' } };
      const runtime = {
        name: 'codex-sdk',
        getCapabilities: () => ({
          supportsStreaming: true,
          supportsToolCalls: true,
          supportsParallelToolCalls: false,
          supportsStop: true,
          supportsArtifacts: true,
          supportsSessionCreate: false,
          supportsSessionResume: false,
          supportsUsageReporting: false,
          supportsNonInteractive: true,
          authModel: 'unknown',
          toolExecutionModel: 'runtime_internal',
          permissionModel: 'runtime',
          stateModel: 'in_process',
          resumeModel: 'none',
          toolReplaySafety: 'unknown',
          mcpSupport: 'none',
          cancellationModel: 'best_effort',
          supportedIsolationModes: ['in_process'],
          recommendedIsolationMode: 'in_process'
        }),
        getAuthStatus: async () => ({ ok: true, loggedIn: true, authModel: 'unknown' }),
        startTask: async () => { throw new Error('not used'); }
      };

      const eventStore = new InMemoryEventStore();
      const artifactStore = new InMemoryArtifactStore();

      await createSupportBundle({ outputPath, sessionId: 's1', runtime, env, eventStore, artifactStore });
      await untar({ file: outputPath, cwd: extractDir });
      const versions = JSON.parse(readFileSync(path.join(extractDir, 'versions.json'), 'utf8'));
      process.stdout.write(JSON.stringify(versions));
    `;

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: tmpCwd,
      encoding: 'utf8'
    });

    expect(child.status).toBe(0);
    if (child.status !== 0) {
      throw new Error(child.stderr || 'child process failed');
    }

    const versions = JSON.parse(child.stdout) as Record<string, unknown>;
    const selfPackage = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };

    expect(versions.codesdk).toBe(selfPackage.version);
    expect(versions['@openai/codex-sdk']).not.toBe('unknown');
  });
});
