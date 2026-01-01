import { describe, expect, it } from 'vitest';
import { deriveTranscript } from '../src/core/transcript.js';
import type { NormalizedEvent } from '../src/core/types.js';

const baseRuntime = { name: 'codex-sdk' as const };

function event(seq: number, type: NormalizedEvent['type'], payload: Record<string, unknown>): NormalizedEvent {
  return {
    schema_version: 1,
    seq,
    time: new Date().toISOString(),
    type,
    trace: { session_id: 's1', task_id: 't1' },
    runtime: baseRuntime,
    payload
  };
}

describe('deriveTranscript', () => {
  it('derives transcript from tool and output events', () => {
    const events: NormalizedEvent[] = [
      event(1, 'task.started', { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
      event(2, 'tool.call.requested', { tool_call_id: 'tc1', name: 'workspace.read', input: { path: 'a' } }),
      event(3, 'tool.call.completed', { tool_call_id: 'tc1', result_preview: 'ok' }),
      event(4, 'model.output.completed', { content: [{ type: 'text', text: 'done' }] })
    ];

    const transcript = deriveTranscript(events).messages;
    expect(transcript).toHaveLength(4);
    expect(transcript[0]?.role).toBe('user');
    expect(transcript[1]?.role).toBe('assistant');
    expect(transcript[2]?.role).toBe('tool');
    expect(transcript[3]?.role).toBe('assistant');
  });

  it('includes artifact refs for large tool results', () => {
    const events: NormalizedEvent[] = [
      event(1, 'tool.call.completed', {
        tool_call_id: 'tc2',
        result_ref: { artifact_id: 'a1', content_hash: 'sha256:abc', size_bytes: 10 },
        result_preview: 'short preview'
      })
    ];

    const transcript = deriveTranscript(events).messages;
    const toolMessage = transcript[0];
    expect(toolMessage?.role).toBe('tool');
    const block = toolMessage?.content[0] as { type: string; result?: any };
    expect(block?.type).toBe('tool_result');
    expect(block?.result?.artifact_ref?.artifact_id).toBe('a1');
  });
});
