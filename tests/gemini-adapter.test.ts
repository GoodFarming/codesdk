import { describe, expect, it } from 'vitest';
import type { ServerGeminiStreamEvent } from '@google/gemini-cli-core';
import { Config, GeminiEventType } from '@google/gemini-cli-core';
import { GeminiCliCoreAdapter } from '../src/adapters/gemini-cli-core.js';
import type { RuntimeEnv, RuntimeSessionHandle } from '../src/core/types.js';

const env: RuntimeEnv = { cwd: '/tmp', env: {}, credentialNamespace: 'default' };
const runtimeSession: RuntimeSessionHandle = { sessionId: 's1' };

function makeStream(events: ServerGeminiStreamEvent[]) {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

describe('GeminiCliCoreAdapter (mock)', () => {
  it('emits model/input output/tool events and usage', async () => {
    const streams: ServerGeminiStreamEvent[][] = [
      [
        { type: GeminiEventType.Content, value: 'Hello' },
        {
          type: GeminiEventType.ToolCallRequest,
          value: {
            callId: 'call-1',
            name: 'workspace.read',
            args: { path: 'README.md' },
            isClientInitiated: false,
            prompt_id: 'p1'
          }
        },
        {
          type: GeminiEventType.Finished,
          value: {
            reason: undefined,
            usageMetadata: {
              promptTokenCount: 1,
              cachedContentTokenCount: 0,
              candidatesTokenCount: 2
            } as any
          }
        }
      ],
      [
        { type: GeminiEventType.Content, value: 'Done' },
        {
          type: GeminiEventType.Finished,
          value: {
            reason: undefined,
            usageMetadata: {
              promptTokenCount: 1,
              cachedContentTokenCount: 0,
              candidatesTokenCount: 1
            } as any
          }
        }
      ]
    ];

    let callIndex = 0;
    const streamFactory = () => makeStream(streams[callIndex++] ?? []);

    const adapter = new GeminiCliCoreAdapter({
      streamFactory,
      initializeConfig: false,
      configFactory: (params) => new Config(params),
      clientFactory: () => ({}) as any
    });

    const handle = await adapter.startTask(env, runtimeSession, {
      taskId: 't1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      toolManifest: { tools: [] }
    });

    const seen: string[] = [];
    for await (const event of handle.events()) {
      seen.push(event.type);
      if (event.type === 'tool.call.requested') {
        const toolCallId = (event.payload as any).tool_call_id as string;
        await handle.sendToolResult(toolCallId, { ok: true });
      }
    }

    expect(seen).toContain('model.input');
    expect(seen).toContain('model.output.delta');
    expect(seen).toContain('model.output.completed');
    expect(seen).toContain('tool.call.requested');
    expect(seen).toContain('usage.reported');
  });

  it('uses non-interactive config defaults', async () => {
    let captured: any;
    const adapter = new GeminiCliCoreAdapter({
      initializeConfig: false,
      configFactory: (params) => {
        captured = params;
        return new Config(params);
      },
      clientFactory: () => ({}) as any,
      streamFactory: () =>
        makeStream([
          {
            type: GeminiEventType.Finished,
            value: {
              reason: undefined,
              usageMetadata: {
                promptTokenCount: 0,
                cachedContentTokenCount: 0,
                candidatesTokenCount: 0
              } as any
            }
          }
        ])
    });

    const handle = await adapter.startTask(env, runtimeSession, {
      taskId: 't2',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    });

    for await (const _event of handle.events()) {
      // drain
    }

    expect(captured?.interactive).toBe(false);
    expect(captured?.coreTools).toEqual([]);
    expect(captured?.usageStatisticsEnabled).toBe(false);
    expect(captured?.telemetry?.enabled).toBe(false);
  });
});
