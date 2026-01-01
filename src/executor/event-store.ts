import type { NormalizedEvent } from '../core/types.js';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export interface EventStore {
  append(sessionId: string, event: EventInput): NormalizedEvent;
  list(sessionId: string, options?: { afterSeq?: number; limit?: number }): NormalizedEvent[];
  subscribe(sessionId: string, options?: { fromSeq?: number }): AsyncIterable<NormalizedEvent>;
}

export type EventInput = Omit<NormalizedEvent, 'seq' | 'time' | 'schema_version'> & {
  seq?: number;
  time?: string;
  schema_version?: number;
};

export const EVENT_SCHEMA_VERSION = 1;

export class InMemoryEventStore implements EventStore {
  private readonly eventsBySession = new Map<string, NormalizedEvent[]>();
  private readonly subscribers = new Map<string, Set<AsyncQueue<NormalizedEvent>>>();

  append(sessionId: string, event: EventInput): NormalizedEvent {
    const events = this.eventsBySession.get(sessionId) ?? [];
    const last = events.length > 0 ? events[events.length - 1] : undefined;
    const seq = last ? last.seq + 1 : 1;

    if (event.trace?.session_id && event.trace.session_id !== sessionId) {
      throw new Error(`trace.session_id mismatch: ${event.trace.session_id} != ${sessionId}`);
    }

    const normalized: NormalizedEvent = {
      schema_version: event.schema_version ?? EVENT_SCHEMA_VERSION,
      seq: event.seq ?? seq,
      time: event.time ?? new Date().toISOString(),
      type: event.type,
      trace: { ...event.trace, session_id: sessionId },
      runtime: event.runtime,
      payload: event.payload ?? {}
    };

    // Persist before emit.
    events.push(normalized);
    this.eventsBySession.set(sessionId, events);

    const queues = this.subscribers.get(sessionId);
    if (queues) {
      for (const queue of queues) {
        queue.push(normalized);
      }
    }

    return normalized;
  }

  list(sessionId: string, options?: { afterSeq?: number; limit?: number }): NormalizedEvent[] {
    const events = this.eventsBySession.get(sessionId) ?? [];
    const afterSeq = options?.afterSeq;
    const startIndex = afterSeq !== undefined ? events.findIndex((e) => e.seq > afterSeq) : 0;
    const sliceStart = startIndex === -1 ? events.length : startIndex;
    const limit = options?.limit ?? events.length;
    return events.slice(sliceStart, sliceStart + limit);
  }

  subscribe(sessionId: string, options?: { fromSeq?: number }): AsyncIterable<NormalizedEvent> {
    const queue = new AsyncQueue<NormalizedEvent>();
    const existing = this.list(sessionId, { afterSeq: options?.fromSeq });
    for (const event of existing) {
      queue.push(event);
    }

    const set = this.subscribers.get(sessionId) ?? new Set();
    set.add(queue);
    this.subscribers.set(sessionId, set);

    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const value = await queue.shift();
            if (value === undefined) return { done: true, value: undefined };
            return { done: false, value };
          },
          async return() {
            queue.close();
            const queues = self.subscribers.get(sessionId);
            if (queues) {
              queues.delete(queue);
              if (queues.size === 0) self.subscribers.delete(sessionId);
            }
            return { done: true, value: undefined };
          }
        };
      }
    };
  }
}

export class SqliteEventStore implements EventStore {
  private readonly db: Database.Database;
  private readonly subscribers = new Map<string, Set<AsyncQueue<NormalizedEvent>>>();
  private readonly maxSeqStmt;
  private readonly insertStmt;
  private readonly listStmt;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();

    this.maxSeqStmt = this.db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?'
    );
    this.insertStmt = this.db.prepare(
      `INSERT INTO events (session_id, seq, time, schema_version, type, task_id, runtime_name, trace_json, runtime_json, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.listStmt = this.db.prepare(
      `SELECT session_id, seq, time, schema_version, type, task_id, runtime_name, trace_json, runtime_json, payload_json
       FROM events
       WHERE session_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`
    );
  }

  append(sessionId: string, event: EventInput): NormalizedEvent {
    if (event.trace?.session_id && event.trace.session_id !== sessionId) {
      throw new Error(`trace.session_id mismatch: ${event.trace.session_id} != ${sessionId}`);
    }

    const appendTx = this.db.transaction((input: EventInput): NormalizedEvent => {
      const current = this.maxSeqStmt.get(sessionId) as { seq: number } | undefined;
      const nextSeq = input.seq ?? (current ? current.seq + 1 : 1);
      const normalized: NormalizedEvent = {
        schema_version: input.schema_version ?? EVENT_SCHEMA_VERSION,
        seq: nextSeq,
        time: input.time ?? new Date().toISOString(),
        type: input.type,
        trace: { ...input.trace, session_id: sessionId },
        runtime: input.runtime,
        payload: input.payload ?? {}
      };

      this.insertStmt.run(
        sessionId,
        normalized.seq,
        normalized.time,
        normalized.schema_version,
        normalized.type,
        normalized.trace.task_id ?? null,
        normalized.runtime.name,
        JSON.stringify(normalized.trace),
        JSON.stringify(normalized.runtime),
        JSON.stringify(normalized.payload ?? {})
      );

      return normalized;
    });

    const normalized = appendTx(event);

    const queues = this.subscribers.get(sessionId);
    if (queues) {
      for (const queue of queues) {
        queue.push(normalized);
      }
    }

    return normalized;
  }

  list(sessionId: string, options?: { afterSeq?: number; limit?: number }): NormalizedEvent[] {
    const afterSeq = options?.afterSeq ?? 0;
    const limit = options?.limit ?? Number.MAX_SAFE_INTEGER;
    const rows = this.listStmt.all(sessionId, afterSeq, limit) as Array<{
      session_id: string;
      seq: number;
      time: string;
      schema_version: number;
      type: NormalizedEvent['type'];
      task_id: string | null;
      runtime_name: string | null;
      trace_json: string;
      runtime_json: string;
      payload_json: string;
    }>;
    return rows.map((row) => {
      const trace = JSON.parse(row.trace_json) as NormalizedEvent['trace'];
      const runtime = JSON.parse(row.runtime_json) as NormalizedEvent['runtime'];
      const payload = JSON.parse(row.payload_json) as NormalizedEvent['payload'];
      return {
        schema_version: row.schema_version,
        seq: row.seq,
        time: row.time,
        type: row.type,
        trace,
        runtime,
        payload
      };
    });
  }

  subscribe(sessionId: string, options?: { fromSeq?: number }): AsyncIterable<NormalizedEvent> {
    const queue = new AsyncQueue<NormalizedEvent>();
    const existing = this.list(sessionId, { afterSeq: options?.fromSeq });
    for (const event of existing) {
      queue.push(event);
    }

    const set = this.subscribers.get(sessionId) ?? new Set();
    set.add(queue);
    this.subscribers.set(sessionId, set);

    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const value = await queue.shift();
            if (value === undefined) return { done: true, value: undefined };
            return { done: false, value };
          },
          async return() {
            queue.close();
            const queues = self.subscribers.get(sessionId);
            if (queues) {
              queues.delete(queue);
              if (queues.size === 0) self.subscribers.delete(sessionId);
            }
            return { done: true, value: undefined };
          }
        };
      }
    };
  }

  close(): void {
    this.db.close();
  }

  private migrate() {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version >= 1) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        time TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        task_id TEXT,
        runtime_name TEXT,
        trace_json TEXT NOT NULL,
        runtime_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_session_task ON events(session_id, task_id);
    `);
    this.db.pragma('user_version = 1');
  }
}

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: T | undefined) => void> = [];
  private closed = false;

  push(value: T) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(value);
    } else {
      this.values.push(value);
    }
  }

  close() {
    this.closed = true;
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      if (waiter) waiter(undefined);
    }
  }

  async shift(): Promise<T | undefined> {
    if (this.values.length) return this.values.shift();
    if (this.closed) return undefined;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
