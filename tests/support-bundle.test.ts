import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSupportBundle } from '../src/support/bundle.js';
import { InMemoryArtifactStore } from '../src/executor/artifact-store.js';
import { InMemoryEventStore } from '../src/executor/event-store.js';
import type { RuntimeAdapter, RuntimeEnv } from '../src/core/types.js';
import { x as untar } from 'tar';

describe('support bundle', () => {
  it('exports a tarball with expected files', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'codesdk-bundle-'));
    const outputPath = path.join(tmpDir, 'bundle.tgz');
    const extractDir = path.join(tmpDir, 'extract');
    mkdirSync(extractDir, { recursive: true });

    const env: RuntimeEnv = {
      cwd: process.cwd(),
      env: {},
      credentialNamespace: 'test',
      isolation: { mode: 'in_process' }
    };

    const runtime: RuntimeAdapter = {
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
      startTask: async () => {
        throw new Error('not used');
      }
    };

    const eventStore = new InMemoryEventStore();
    const artifactStore = new InMemoryArtifactStore();
    const artifactRef = artifactStore.put(Buffer.from('bundle-data', 'utf8'), {
      contentType: 'text/plain',
      name: 'data.txt'
    });

    eventStore.append('s1', {
      type: 'model.input',
      trace: { session_id: 's1', task_id: 't1' },
      runtime: { name: 'codex-sdk' },
      payload: { input_ref: artifactRef }
    });

    await createSupportBundle({
      outputPath,
      sessionId: 's1',
      runtime,
      env,
      eventStore,
      artifactStore
    });

    await untar({ file: outputPath, cwd: extractDir });

    const manifest = JSON.parse(
      readFileSync(path.join(extractDir, 'manifest.json'), 'utf8')
    ) as { session_id: string };
    expect(manifest.session_id).toBe('s1');
    expect(readFileSync(path.join(extractDir, 'events.jsonl'), 'utf8')).toContain('model.input');
    expect(readFileSync(path.join(extractDir, 'health.json'), 'utf8')).toContain('codex-sdk');
    expect(readFileSync(path.join(extractDir, 'runtime-config.json'), 'utf8')).toContain('implicit_sources');
    expect(readFileSync(path.join(extractDir, 'artifacts', 'manifest.json'), 'utf8')).toContain(
      artifactRef.artifact_id
    );
  });
});
