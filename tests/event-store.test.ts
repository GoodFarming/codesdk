import { describe, expect, it } from 'vitest';
import { InMemoryEventStore } from '../src/executor/event-store.js';
import type { NormalizedEvent } from '../src/core/types.js';

describe('InMemoryEventStore', () => {
  it('assigns monotonic seq per session', () => {
    const store = new InMemoryEventStore();
    const base = {
      type: 'task.started',
      trace: { session_id: 's1', task_id: 't1' },
      runtime: { name: 'codex-sdk' },
      payload: {}
    } as Omit<NormalizedEvent, 'seq' | 'time' | 'schema_version'>;

    const e1 = store.append('s1', base);
    const e2 = store.append('s1', base);
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
  });

  it('supports paging with afterSeq + limit', () => {
    const store = new InMemoryEventStore();
    const base = {
      type: 'task.started',
      trace: { session_id: 's1', task_id: 't1' },
      runtime: { name: 'codex-sdk' },
      payload: {}
    } as Omit<NormalizedEvent, 'seq' | 'time' | 'schema_version'>;

    store.append('s1', base);
    store.append('s1', base);
    store.append('s1', base);

    const page = store.list('s1', { afterSeq: 1, limit: 1 });
    expect(page).toHaveLength(1);
    expect(page[0]?.seq).toBe(2);
  });

  it('streams appended events to subscribers', async () => {
    const store = new InMemoryEventStore();
    const events: NormalizedEvent[] = [];
    const iter = store.subscribe('s1')[Symbol.asyncIterator]();

    const base = {
      type: 'task.started',
      trace: { session_id: 's1', task_id: 't1' },
      runtime: { name: 'codex-sdk' },
      payload: {}
    } as Omit<NormalizedEvent, 'seq' | 'time' | 'schema_version'>;

    store.append('s1', base);
    const next = await iter.next();
    if (!next.done && next.value) events.push(next.value);

    expect(events).toHaveLength(1);
    expect(events[0]?.seq).toBe(1);
  });
});
