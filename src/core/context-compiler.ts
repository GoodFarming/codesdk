import type { ContextWindowMeta, ToolManifest, TranscriptMessage } from './types.js';

export interface CompiledRuntimeInput {
  messages: TranscriptMessage[];
  tool_manifest?: ToolManifest;
  runtime_config?: Record<string, unknown>;
  context_window: ContextWindowMeta;
}

export interface ContextCompileOptions {
  toolManifest?: ToolManifest;
  runtimeConfig?: Record<string, unknown>;
  maxChars?: number;
}

export function compileRuntimeInput(
  messages: TranscriptMessage[],
  options: ContextCompileOptions
): CompiledRuntimeInput {
  const maxChars = options.maxChars;
  if (!maxChars) {
    return {
      messages,
      tool_manifest: options.toolManifest,
      runtime_config: options.runtimeConfig,
      context_window: { strategy: 'none' }
    };
  }

  let total = messages.reduce((acc, msg) => acc + messageSize(msg), 0);
  if (total <= maxChars) {
    return {
      messages,
      tool_manifest: options.toolManifest,
      runtime_config: options.runtimeConfig,
      context_window: { strategy: 'none', max_chars: maxChars }
    };
  }

  const omitted: number[] = [];
  const kept: TranscriptMessage[] = [];
  // Drop oldest messages until we fit.
  for (let i = 0; i < messages.length; i += 1) {
    const remaining = messages.slice(i + 1);
    const remainingSize = remaining.reduce((acc, msg) => acc + messageSize(msg), 0);
    if (remainingSize <= maxChars) {
      kept.push(...remaining);
      omitted.push(...Array.from({ length: i + 1 }, (_, idx) => idx));
      break;
    }
  }

  if (kept.length === 0) {
    // If even the last message is too large, keep it but mark overflow.
    const last = messages.slice(-1);
    return {
      messages: last,
      tool_manifest: options.toolManifest,
      runtime_config: options.runtimeConfig,
      context_window: {
        strategy: 'truncate_oldest',
        max_chars: maxChars,
        omitted_indices: messages.length > 1 ? messages.slice(0, -1).map((_, idx) => idx) : [],
        overflow: true
      }
    };
  }

  return {
    messages: kept,
    tool_manifest: options.toolManifest,
    runtime_config: options.runtimeConfig,
    context_window: {
      strategy: 'truncate_oldest',
      max_chars: maxChars,
      omitted_indices: omitted,
      overflow: false
    }
  };
}

function messageSize(message: TranscriptMessage): number {
  let size = 0;
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        size += block.text.length;
        break;
      case 'code':
        size += block.code.length;
        break;
      case 'tool_use':
        size += JSON.stringify(block.input ?? {}).length;
        break;
      case 'tool_result':
        size += JSON.stringify(block.result ?? {}).length;
        break;
      case 'artifact_ref':
        size += 0;
        break;
    }
  }
  return size;
}
