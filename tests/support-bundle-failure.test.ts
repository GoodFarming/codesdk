import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExecutorEngine } from '../src/executor/engine.js';
import { InMemoryArtifactStore } from '../src/executor/artifact-store.js';
import { InMemoryEventStore } from '../src/executor/event-store.js';
import { createSupportBundle } from '../src/support/bundle.js';
import type { NormalizedEvent, RuntimeAdapter, RuntimeEnv } from '../src/core/types.js';
import { x as untar } from 'tar';

class FailingRuntimeHandle {
  async *events() {
    yield {
      schema_version: 1,
      seq: 1,
      time: new Date().toISOString(),
      type: 'model.output.delta',
      trace: { session_id: 's1', task_id: 't1' },
      runtime: { name: 'codex-sdk' },
      payload: { kind: 'text_delta', block_id: 'b1', delta: 'oops' }
    } satisfies NormalizedEvent;
    throw new Error('boom');
  }

  async sendToolResult(): Promise<void> {}
  async sendToolDenied(): Promise<void> {}
  async stop(): Promise<void> {}
}

describe('support bundle on failing run', () => {
  it('captures task.failed events', async () => {
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
        supportsToolCalls: false,
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
      startTask: async () => new FailingRuntimeHandle() as any
    };

    const eventStore = new InMemoryEventStore();
    const artifactStore = new InMemoryArtifactStore();
    const engine = new ExecutorEngine({ eventStore, artifactStore });

    const handle = engine.startTask({
      sessionId: 's1',
      taskId: 't1',
      env,
      runtime,
      runtimeSession: { sessionId: 's1' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    });
    await handle.completion.catch(() => undefined);

    await createSupportBundle({
      outputPath,
      sessionId: 's1',
      runtime,
      env,
      eventStore,
      artifactStore
    });

    await untar({ file: outputPath, cwd: extractDir });
    const eventsJsonl = readFileSync(path.join(extractDir, 'events.jsonl'), 'utf8');
    expect(eventsJsonl).toContain('task.failed');
  });
});
