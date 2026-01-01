import { describe, expect, it } from 'vitest';
import { upcastEvent } from '../src/core/upcast.js';
import type { NormalizedEvent } from '../src/core/types.js';

describe('upcastEvent', () => {
  it('returns unchanged event when schema version matches', () => {
    const event: NormalizedEvent = {
      schema_version: 1,
      seq: 1,
      time: new Date().toISOString(),
      type: 'task.started',
      trace: { session_id: 's1', task_id: 't1' },
      runtime: { name: 'codex-sdk' },
      payload: {}
    };

    const result = upcastEvent(event, 1);
    expect(result.upgraded).toBe(false);
    expect(result.event.schema_version).toBe(1);
  });
});
