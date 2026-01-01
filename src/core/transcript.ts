import type {
  AssistantContentBlock,
  ArtifactRef,
  NormalizedEvent,
  TranscriptContentBlock,
  TranscriptMessage
} from './types.js';

export interface TranscriptDerivationResult {
  messages: TranscriptMessage[];
}

export function deriveTranscript(events: NormalizedEvent[]): TranscriptDerivationResult {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const messages: TranscriptMessage[] = [];

  for (const event of ordered) {
    switch (event.type) {
      case 'task.started': {
        const payload = event.payload as Record<string, unknown>;
        const seeded = payload.messages as TranscriptMessage[] | undefined;
        if (Array.isArray(seeded)) {
          messages.push(...seeded);
        }
        break;
      }
      case 'tool.call.requested': {
        const payload = event.payload as Record<string, unknown>;
        const toolCallId = payload.tool_call_id as string | undefined;
        const name = payload.name as string | undefined;
        if (toolCallId && name) {
          const input = payload.input as unknown;
          messages.push({
            role: 'assistant',
            content: [{ type: 'tool_use', tool_call_id: toolCallId, name, input }]
          });
        }
        break;
      }
      case 'tool.call.completed': {
        const payload = event.payload as Record<string, unknown>;
        const toolCallId = payload.tool_call_id as string | undefined;
        if (toolCallId) {
          const resultRef = payload.result_ref as ArtifactRef | undefined;
          const result =
            resultRef !== undefined
              ? { artifact_ref: resultRef, preview: payload.result_preview }
              : payload.result_preview ?? payload.result;
          const isError = Boolean(payload.is_error);
          messages.push({
            role: 'tool',
            content: [{ type: 'tool_result', tool_call_id: toolCallId, result, is_error: isError }]
          });
        }
        break;
      }
      case 'tool.call.denied': {
        const payload = event.payload as Record<string, unknown>;
        const toolCallId = payload.tool_call_id as string | undefined;
        if (toolCallId) {
          const reason = payload.reason ?? 'tool denied';
          messages.push({
            role: 'tool',
            content: [{ type: 'tool_result', tool_call_id: toolCallId, result: reason, is_error: true }]
          });
        }
        break;
      }
      case 'model.output.completed': {
        const payload = event.payload as { content?: AssistantContentBlock[] };
        if (payload?.content) {
          const blocks: TranscriptContentBlock[] = payload.content.map((block) => {
            if (block.type === 'text') return { type: 'text', text: block.text };
            if (block.type === 'code') return { type: 'code', code: block.code, language: block.language };
            return { type: 'artifact_ref', artifact_id: block.artifact_id, name: block.name, content_type: block.content_type };
          });
          messages.push({ role: 'assistant', content: blocks });
        }
        break;
      }
      default:
        break;
    }
  }

  return { messages };
}
