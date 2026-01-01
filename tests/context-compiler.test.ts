import { describe, expect, it } from 'vitest';
import { compileRuntimeInput } from '../src/core/context-compiler.js';
import type { TranscriptMessage } from '../src/core/types.js';

describe('compileRuntimeInput', () => {
  it('truncates oldest messages when exceeding maxChars', () => {
    const messages: TranscriptMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'aaaa' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'bbbb' }] },
      { role: 'user', content: [{ type: 'text', text: 'cccc' }] }
    ];

    const compiled = compileRuntimeInput(messages, { maxChars: 6 });
    expect(compiled.messages.length).toBe(1);
    expect(compiled.context_window.strategy).toBe('truncate_oldest');
    expect(compiled.context_window.omitted_indices?.length).toBeGreaterThan(0);
  });

  it('marks overflow when a single message exceeds maxChars', () => {
    const messages: TranscriptMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'this-is-long' }] }
    ];

    const compiled = compileRuntimeInput(messages, { maxChars: 4 });
    expect(compiled.context_window.overflow).toBe(true);
    expect(compiled.messages.length).toBe(1);
  });
});
