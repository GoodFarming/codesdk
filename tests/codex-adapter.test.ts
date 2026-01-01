import { describe, expect, it } from 'vitest';
import type { ThreadEvent } from '@openai/codex-sdk';
import { CodexSdkAdapter } from '../src/adapters/codex-sdk.js';
import type { RuntimeEnv, RuntimeSessionHandle } from '../src/core/types.js';

class FakeThread {
  private readonly events: ThreadEvent[];

  constructor(events: ThreadEvent[]) {
    this.events = events;
  }

  async runStreamed(_input: string, options?: { signal?: AbortSignal }) {
    const signal = options?.signal;
    return {
      events: (async function* (events: ThreadEvent[]) {
        for (const event of events) {
          if (signal?.aborted) break;
          yield event;
        }
      })(this.events)
    };
  }
}

class FakeCodex {
  private readonly events: ThreadEvent[];
  private readonly onThreadOptions?: (options: unknown) => void;

  constructor(events: ThreadEvent[], onThreadOptions?: (options: unknown) => void) {
    this.events = events;
    this.onThreadOptions = onThreadOptions;
  }

  startThread(options?: unknown) {
    this.onThreadOptions?.(options);
    return new FakeThread(this.events);
  }

  resumeThread(_id?: string, options?: unknown) {
    this.onThreadOptions?.(options);
    return new FakeThread(this.events);
  }
}

const env: RuntimeEnv = { cwd: '/tmp', env: {}, credentialNamespace: 'default' };
const runtimeSession: RuntimeSessionHandle = { sessionId: 's1' };

describe('CodexSdkAdapter (mock thread)', () => {
  it('emits model.input, output, tool events, and usage', async () => {
    const events: ThreadEvent[] = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: { id: 'msg-1', type: 'agent_message', text: 'Hel' }
      },
      {
        type: 'item.updated',
        item: { id: 'msg-1', type: 'agent_message', text: 'Hello' }
      },
      {
        type: 'item.started',
        item: {
          id: 'tool-1',
          type: 'mcp_tool_call',
          server: 'codesdk',
          tool: 'workspace.read',
          arguments: { path: 'README.md' },
          status: 'in_progress'
        }
      },
      {
        type: 'item.completed',
        item: {
          id: 'tool-1',
          type: 'mcp_tool_call',
          server: 'codesdk',
          tool: 'workspace.read',
          arguments: { path: 'README.md' },
          status: 'completed',
          result: { content: [{ type: 'text', text: 'ok' }], structured_content: { ok: true } }
        }
      },
      {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: 'Hello' }
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2 }
      }
    ];

    const adapter = new CodexSdkAdapter({
      captureImplicitSources: false,
      codexFactory: () => new FakeCodex(events) as any
    });

    const handle = await adapter.startTask(env, runtimeSession, {
      taskId: 't1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      toolManifest: { tools: [] }
    });

    const seen: string[] = [];
    for await (const event of handle.events()) {
      seen.push(event.type);
    }

    expect(seen).toContain('model.input');
    expect(seen).toContain('model.output.delta');
    expect(seen).toContain('model.output.completed');
    expect(seen).toContain('tool.call.requested');
    expect(seen).toContain('tool.call.completed');
    expect(seen).toContain('usage.reported');
  });

  it('uses non-interactive defaults in thread options', async () => {
    const events: ThreadEvent[] = [
      { type: 'thread.started', thread_id: 'thread-2' },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }
    ];

    let capturedOptions: any;
    const adapter = new CodexSdkAdapter({
      captureImplicitSources: false,
      codexFactory: () =>
        new FakeCodex(events, (options) => {
          capturedOptions = options;
        }) as any
    });

    const handle = await adapter.startTask(env, runtimeSession, {
      taskId: 't2',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    });

    for await (const _event of handle.events()) {
      // drain
    }

    expect(capturedOptions?.approvalPolicy).toBe('never');
    expect(capturedOptions?.sandboxMode).toBe('read-only');
    expect(capturedOptions?.networkAccessEnabled).toBe(false);
  });

  it('emits tool events for multiple MCP calls', async () => {
    const events: ThreadEvent[] = [
      { type: 'thread.started', thread_id: 'thread-3' },
      {
        type: 'item.started',
        item: {
          id: 'tool-1',
          type: 'mcp_tool_call',
          server: 'codesdk',
          tool: 'workspace.read',
          arguments: { path: 'README.md' },
          status: 'in_progress'
        }
      },
      {
        type: 'item.started',
        item: {
          id: 'tool-2',
          type: 'mcp_tool_call',
          server: 'codesdk',
          tool: 'workspace.read',
          arguments: { path: 'docs/plan.md' },
          status: 'in_progress'
        }
      },
      {
        type: 'item.completed',
        item: {
          id: 'tool-1',
          type: 'mcp_tool_call',
          server: 'codesdk',
          tool: 'workspace.read',
          arguments: { path: 'README.md' },
          status: 'completed',
          result: { content: [{ type: 'text', text: 'ok' }], structured_content: { ok: true } }
        }
      },
      {
        type: 'item.completed',
        item: {
          id: 'tool-2',
          type: 'mcp_tool_call',
          server: 'codesdk',
          tool: 'workspace.read',
          arguments: { path: 'docs/plan.md' },
          status: 'completed',
          result: { content: [{ type: 'text', text: 'ok' }], structured_content: { ok: true } }
        }
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2 }
      }
    ];

    const adapter = new CodexSdkAdapter({
      captureImplicitSources: false,
      codexFactory: () => new FakeCodex(events) as any
    });

    const handle = await adapter.startTask(env, runtimeSession, {
      taskId: 't3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    });

    const seen: string[] = [];
    for await (const event of handle.events()) {
      seen.push(event.type);
    }

    const completed = seen.filter((type) => type === 'tool.call.completed');
    expect(completed).toHaveLength(2);
  });
});
