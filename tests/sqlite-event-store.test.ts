import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryEventStore, SqliteEventStore } from '../src/executor/event-store.js';

describe('SqliteEventStore', () => {
  it('persists events across instances', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'codesdk-events-'));
    const dbPath = path.join(dir, 'events.db');
    const sessionId = 's1';

    const store = new SqliteEventStore(dbPath);
    store.append(sessionId, {
      type: 'task.completed',
      trace: { session_id: sessionId, task_id: 't1' },
      runtime: { name: 'codex-sdk' },
      payload: { reason: 'done' },
      seq: 1,
      time: '2026-01-01T00:00:00.000Z'
    });
    store.close();

    const reopened = new SqliteEventStore(dbPath);
    const events = reopened.list(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('task.completed');
    expect(events[0]?.seq).toBe(1);
    reopened.close();
  });

  it('matches in-memory ordering with fixed seq/time', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'codesdk-events-'));
    const dbPath = path.join(dir, 'events.db');
    const sessionId = 's1';
    const inputs = [
      {
        type: 'model.input' as const,
        trace: { session_id: sessionId, task_id: 't1' },
        runtime: { name: 'codex-sdk' as const },
        payload: { input_hash: 'hash' },
        seq: 1,
        time: '2026-01-01T00:00:00.000Z'
      },
      {
        type: 'task.completed' as const,
        trace: { session_id: sessionId, task_id: 't1' },
        runtime: { name: 'codex-sdk' as const },
        payload: { reason: 'done' },
        seq: 2,
        time: '2026-01-01T00:00:01.000Z'
      }
    ];

    const memory = new InMemoryEventStore();
    const sqlite = new SqliteEventStore(dbPath);
    for (const input of inputs) {
      memory.append(sessionId, input);
      sqlite.append(sessionId, input);
    }

    expect(sqlite.list(sessionId)).toEqual(memory.list(sessionId));
    sqlite.close();
  });
});
