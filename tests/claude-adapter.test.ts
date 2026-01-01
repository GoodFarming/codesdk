import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentSdkAdapter } from '../src/adapters/claude-agent-sdk.js';
import type { RuntimeEnv, RuntimeSessionHandle } from '../src/core/types.js';

describe('ClaudeAgentSdkAdapter (mock query)', () => {
  it('emits model.input and output events', async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const queryFn = ((params: { options?: Record<string, unknown> }) => {
      capturedOptions = params.options;
      return (async function* streamOut(): AsyncGenerator<SDKMessage> {
        yield ({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'hi' }
          },
          parent_tool_use_id: null,
          uuid: 'uuid-1',
          session_id: 'session-1'
        } as unknown) as SDKMessage;

        yield ({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'done' }] },
          parent_tool_use_id: null,
          uuid: 'uuid-2',
          session_id: 'session-1'
        } as unknown) as SDKMessage;

        yield ({
          type: 'result',
          subtype: 'success',
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          result: 'ok',
          total_cost_usd: 0,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0
          },
          modelUsage: {},
          permission_denials: [],
          uuid: 'uuid-3',
          session_id: 'session-1'
        } as unknown) as SDKMessage;
      })();
    }) as any;

    const adapter = new ClaudeAgentSdkAdapter({ queryFn });
    const env: RuntimeEnv = { cwd: '/tmp', env: {}, credentialNamespace: 'default' };
    const runtimeSession: RuntimeSessionHandle = { sessionId: 's1' };

    const handle = await adapter.startTask(env, runtimeSession, {
      taskId: 't1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      toolManifest: { tools: [] },
      interactionMode: 'non_interactive'
    });

    const events = [];
    for await (const event of handle.events()) {
      events.push(event);
    }

    const types = events.map((event) => event.type);
    expect(types).toContain('model.input');
    expect(types).toContain('model.output.delta');
    expect(types).toContain('model.output.completed');
    expect(types).toContain('usage.reported');

    const modelInput = events.find((event) => event.type === 'model.input');
    expect(modelInput?.payload && 'implicit_sources_ref' in (modelInput.payload as Record<string, unknown>)).toBe(
      true
    );

    expect(capturedOptions?.permissionMode).toBe('dontAsk');
    expect(capturedOptions?.tools).toEqual([]);
  });
});
