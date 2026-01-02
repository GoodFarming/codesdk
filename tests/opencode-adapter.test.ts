import { describe, expect, it, vi } from 'vitest';
import type { Event } from '@opencode-ai/sdk';
import { OpencodeServerAdapter } from '../src/adapters/opencode-server.js';
import type { RuntimeEnv, RuntimeSessionHandle } from '../src/core/types.js';

const env: RuntimeEnv = { cwd: '/tmp', env: {}, credentialNamespace: 'default' };
const runtimeSession: RuntimeSessionHandle = { sessionId: 's1', runtimeSessionId: 'session-1' };

function makeStream(events: Event[]) {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

describe('OpencodeServerAdapter (mock)', () => {
  it('emits model/output/tool events from SSE stream', async () => {
    const events: Event[] = [
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-1',
            sessionID: 'session-1',
            messageID: 'msg-1',
            type: 'text',
            text: 'Hello'
          },
          delta: 'Hello'
        }
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-1',
            sessionID: 'session-1',
            messageID: 'msg-1',
            type: 'tool',
            callID: 'call-1',
            tool: 'workspace.read',
            state: {
              status: 'pending',
              input: { path: 'README.md' },
              raw: '{}'
            }
          }
        }
      },
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-1',
            sessionID: 'session-1',
            messageID: 'msg-1',
            type: 'tool',
            callID: 'call-1',
            tool: 'workspace.read',
            state: {
              status: 'completed',
              input: { path: 'README.md' },
              output: 'ok',
              title: 'workspace.read',
              metadata: {},
              time: { start: 1, end: 2 }
            }
          }
        }
      },
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg-1',
            sessionID: 'session-1',
            role: 'assistant',
            time: { created: 1, completed: 2 },
            parentID: 'msg-0',
            modelID: 'model',
            providerID: 'provider',
            mode: 'default',
            path: { cwd: '/tmp', root: '/tmp' },
            summary: false,
            cost: 0,
            tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: 'stop'
          }
        }
      }
    ];

    const fakeClient = {
      event: {
        subscribe: async () => ({ stream: makeStream(events) })
      },
      session: {
        promptAsync: async () => undefined,
        abort: async () => undefined
      },
      config: {
        get: async () => ({})
      },
      mcp: {
        status: async () => ({})
      }
    } as any;

    const adapter = new OpencodeServerAdapter({
      client: fakeClient,
      captureImplicitSources: false
    });

    const handle = await adapter.startTask(env, runtimeSession, {
      taskId: 't1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
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

  it('registers CodeSDK MCP server when toolManifest is provided', async () => {
    const events: Event[] = [
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg-1',
            sessionID: 'session-1',
            role: 'assistant',
            time: { created: 1, completed: 2 },
            parentID: 'msg-0',
            modelID: 'model',
            providerID: 'provider',
            mode: 'default',
            path: { cwd: '/tmp', root: '/tmp' },
            summary: false,
            cost: 0,
            tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: 'stop'
          }
        }
      }
    ];

    const statusMock = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ codesdk: { status: 'disabled' } });
    const addMock = vi.fn().mockResolvedValue({});
    const connectMock = vi.fn().mockResolvedValue(true);

    const fakeClient = {
      event: {
        subscribe: async () => ({ stream: makeStream(events) })
      },
      session: {
        promptAsync: async () => undefined,
        abort: async () => undefined
      },
      config: {
        get: async () => ({})
      },
      mcp: {
        status: statusMock,
        add: addMock,
        connect: connectMock
      }
    } as any;

    const adapter = new OpencodeServerAdapter({
      client: fakeClient,
      captureImplicitSources: false
    });

    const handle = await adapter.startTask(env, runtimeSession, {
      taskId: 't1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      permissionMode: 'auto',
      toolManifest: { tools: [{ name: 'workspace.read' }] }
    });

    for await (const _event of handle.events()) {
      // drain
    }

    expect(addMock).toHaveBeenCalledTimes(1);
    const addCall = addMock.mock.calls[0]?.[0];
    expect(addCall?.body?.name).toBe('codesdk');
    expect(addCall?.body?.config?.type).toBe('local');
    expect(addCall?.body?.config?.command).toContain('--workspace-root');
    expect(addCall?.body?.config?.command).toContain('/tmp');
    expect(addCall?.body?.config?.command).toContain('--tools');
    expect(addCall?.body?.config?.command).toContain('workspace.read');

    expect(connectMock).toHaveBeenCalledTimes(1);
    const connectCall = connectMock.mock.calls[0]?.[0];
    expect(connectCall?.path?.name).toBe('codesdk');
    expect(connectCall?.query?.directory).toBe('/tmp');
  });
});
