import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ThreadEvent } from '@openai/codex-sdk';
import { CodexSdkAdapter } from '../src/adapters/codex-sdk.js';
import type { RuntimeEnv, RuntimeSessionHandle } from '../src/core/types.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createWorkspaceReadTool } from '../src/tools/workspace.js';

class FakeThread {
  constructor(private readonly events: ThreadEvent[]) {}
  async runStreamed(_input: string) {
    return {
      events: (async function* (events: ThreadEvent[]) {
        for (const event of events) yield event;
      })(this.events)
    };
  }
}

class FakeCodex {
  constructor(private readonly events: ThreadEvent[]) {}
  startThread() {
    return new FakeThread(this.events);
  }
  resumeThread() {
    return new FakeThread(this.events);
  }
}

describe('CodexSdkAdapter MCP injection', () => {
  it('writes CODEX_HOME/config.toml with codesdk-mcp server when toolManifest is provided', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'codesdk-codex-home-'));
    const codexHome = path.join(tmp, 'codex-home');

    const env: RuntimeEnv = {
      cwd: tmp,
      env: { CODEX_HOME: codexHome },
      credentialNamespace: 'test'
    };
    const runtimeSession: RuntimeSessionHandle = { sessionId: 's1' };

    const registry = new ToolRegistry();
    registry.register(createWorkspaceReadTool());

    const adapter = new CodexSdkAdapter({
      captureImplicitSources: false,
      codexFactory: () =>
        new FakeCodex([
          { type: 'thread.started', thread_id: 'thread-1' },
          { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }
        ]) as any
    });

    const handle = await adapter.startTask(env, runtimeSession, {
      taskId: 't1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      toolManifest: registry.toManifest(),
      permissionMode: 'auto'
    });

    for await (const _event of handle.events()) {
      // drain
    }

    const configPath = path.join(codexHome, 'config.toml');
    const toml = readFileSync(configPath, 'utf8');
    expect(toml).toContain('[mcp_servers.codesdk]');
    expect(toml).toContain('codesdk-mcp.js');
    expect(toml).toContain('enabled_tools');
    expect(toml).toContain('workspace_read');
    expect(toml).toContain('--tool-name-style');
    expect(toml).toContain('codex');
  });
});
