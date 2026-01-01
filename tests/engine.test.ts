import { describe, expect, it } from 'vitest';
import { ExecutorEngine } from '../src/executor/engine.js';
import type { NormalizedEvent, RuntimeAdapter, RuntimeEnv, RuntimeSessionHandle } from '../src/core/types.js';

class AsyncQueue<T> {
  private values: T[] = [];
  private waiters: Array<(value: T | undefined) => void> = [];
  private closed = false;

  push(value: T) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
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

class FakeRuntimeTaskHandle {
  readonly queue = new AsyncQueue<NormalizedEvent>();
  readonly results: Array<{ toolCallId: string; result: unknown }> = [];
  readonly denials: Array<{ toolCallId: string; reason: string }> = [];
  stopCalls = 0;

  async *events() {
    while (true) {
      const next = await this.queue.shift();
      if (!next) break;
      yield next;
    }
  }

  async sendToolResult(toolCallId: string, result: unknown): Promise<void> {
    this.results.push({ toolCallId, result });
  }

  async sendToolDenied(toolCallId: string, reason: string): Promise<void> {
    this.denials.push({ toolCallId, reason });
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.queue.close();
  }
}

function fakeRuntime(handle: FakeRuntimeTaskHandle): RuntimeAdapter {
  return {
    name: 'codex-sdk',
    getCapabilities: () => ({
      supportsStreaming: true,
      supportsToolCalls: true,
      supportsParallelToolCalls: true,
      supportsStop: true,
      supportsArtifacts: true,
      supportsSessionCreate: false,
      supportsSessionResume: false,
      supportsUsageReporting: false,
      supportsNonInteractive: true,
      maxOutstandingToolCalls: 4,
      authModel: 'unknown',
      toolExecutionModel: 'external_mcp',
      permissionModel: 'codesdk',
      stateModel: 'in_process',
      resumeModel: 'reconstruct',
      toolReplaySafety: 'unknown',
      mcpSupport: 'none',
      cancellationModel: 'best_effort',
      supportedIsolationModes: ['in_process'],
      recommendedIsolationMode: 'in_process'
    }),
    getAuthStatus: async () => ({ ok: true, loggedIn: true, authModel: 'unknown' }),
    startTask: async () => handle as any
  };
}

function event(seq: number, type: NormalizedEvent['type'], payload: Record<string, unknown>): NormalizedEvent {
  return {
    schema_version: 1,
    seq,
    time: new Date().toISOString(),
    type,
    trace: { session_id: 's1', task_id: 't1' },
    runtime: { name: 'codex-sdk' },
    payload
  };
}

const env: RuntimeEnv = {
  cwd: '/tmp',
  env: {},
  credentialNamespace: 'default'
};
const runtimeSession: RuntimeSessionHandle = { sessionId: 's1' };

describe('ExecutorEngine tool flow', () => {
  it('approves and executes tool calls in order', async () => {
    const handle = new FakeRuntimeTaskHandle();
    const runtime = fakeRuntime(handle);
    const engine = new ExecutorEngine();

    handle.queue.push(
      event(1, 'tool.call.requested', {
        tool_call_id: 'tc1',
        name: 'workspace.read',
        attempt: 1,
        input_hash: 'hash1',
        input: { path: 'a' }
      })
    );
    handle.queue.close();

    const task = engine.startTask({
      sessionId: 's1',
      taskId: 't1',
      env,
      runtime,
      runtimeSession,
      messages: [],
      permissionMode: 'auto'
    });

    await task.completion;

    const events = engine.getEventStore().list('s1');
    const types = events.map((e) => e.type);
    const idx = (t: string) => types.indexOf(t as any);

    expect(idx('tool.call.requested')).toBeGreaterThanOrEqual(0);
    expect(idx('tool.call.policy_evaluated')).toBeGreaterThan(idx('tool.call.requested'));
    expect(idx('tool.call.approved')).toBeGreaterThan(idx('tool.call.policy_evaluated'));
    expect(idx('tool.call.started')).toBeGreaterThan(idx('tool.call.approved'));
    expect(idx('tool.call.completed')).toBeGreaterThan(idx('tool.call.started'));
    expect(idx('task.completed')).toBeGreaterThan(idx('tool.call.completed'));

    expect(handle.results).toHaveLength(1);
  });

  it('waits for tool approval in ask mode (deny)', async () => {
    const handle = new FakeRuntimeTaskHandle();
    const runtime = fakeRuntime(handle);
    const engine = new ExecutorEngine();

    handle.queue.push(
      event(1, 'tool.call.requested', {
        tool_call_id: 'tc2',
        name: 'workspace.write',
        attempt: 1,
        input_hash: 'hash2',
        input: { path: 'a' }
      })
    );

    const task = engine.startTask({
      sessionId: 's1',
      taskId: 't1',
      env,
      runtime,
      runtimeSession,
      messages: [],
      permissionMode: 'ask'
    });

    for (let i = 0; i < 50; i += 1) {
      const asked = engine
        .getEventStore()
        .list('s1')
        .some(
          (e) =>
            e.type === 'tool.call.policy_evaluated' &&
            (e.payload as any)?.source === 'codesdk' &&
            (e.payload as any)?.result === 'ask'
        );
      if (asked) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const denied = engine.denyToolCall('s1', 'tc2', {
      attempt: 1,
      input_hash: 'hash2',
      reason: 'user denied'
    });
    expect(denied.ok).toBe(true);
    handle.queue.close();

    await task.completion;

    const types = engine.getEventStore().list('s1').map((e) => e.type);
    expect(types).toContain('tool.call.denied');
    expect(handle.denials).toHaveLength(1);
  });

  it('waits for tool approval in ask mode (approve)', async () => {
    const handle = new FakeRuntimeTaskHandle();
    const runtime = fakeRuntime(handle);
    const engine = new ExecutorEngine();

    handle.queue.push(
      event(1, 'tool.call.requested', {
        tool_call_id: 'tc5',
        name: 'workspace.read',
        attempt: 1,
        input_hash: 'hash5',
        input: { path: 'a' }
      })
    );

    const task = engine.startTask({
      sessionId: 's1',
      taskId: 't1',
      env,
      runtime,
      runtimeSession,
      messages: [],
      permissionMode: 'ask'
    });

    for (let i = 0; i < 50; i += 1) {
      const asked = engine
        .getEventStore()
        .list('s1')
        .some(
          (e) =>
            e.type === 'tool.call.policy_evaluated' &&
            (e.payload as any)?.source === 'codesdk' &&
            (e.payload as any)?.result === 'ask'
        );
      if (asked) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const approved = engine.approveToolCall('s1', 'tc5', { attempt: 1, input_hash: 'hash5' });
    expect(approved.ok).toBe(true);
    handle.queue.close();

    await task.completion;

    const types = engine.getEventStore().list('s1').map((e) => e.type);
    expect(types).toContain('tool.call.completed');
    expect(handle.results).toHaveLength(1);
  });

  it('handles multiple outstanding tool calls', async () => {
    const handle = new FakeRuntimeTaskHandle();
    const runtime = fakeRuntime(handle);
    const engine = new ExecutorEngine();

    handle.queue.push(
      event(1, 'tool.call.requested', {
        tool_call_id: 'tc1',
        name: 'workspace.read',
        attempt: 1,
        input_hash: 'hash1',
        input: { path: 'a' }
      })
    );
    handle.queue.push(
      event(2, 'tool.call.requested', {
        tool_call_id: 'tc2',
        name: 'workspace.read',
        attempt: 1,
        input_hash: 'hash2',
        input: { path: 'b' }
      })
    );
    handle.queue.close();

    const task = engine.startTask({
      sessionId: 's1',
      taskId: 't1',
      env,
      runtime,
      runtimeSession,
      messages: [],
      permissionMode: 'auto'
    });

    await task.completion;

    expect(handle.results).toHaveLength(2);
    const completed = engine.getEventStore().list('s1').filter((e) => e.type === 'tool.call.completed');
    expect(completed).toHaveLength(2);
  });

  it('emits task.stopped on stop', async () => {
    const handle = new FakeRuntimeTaskHandle();
    const runtime = fakeRuntime(handle);
    const engine = new ExecutorEngine();

    const task = engine.startTask({
      sessionId: 's1',
      taskId: 't1',
      env,
      runtime,
      runtimeSession,
      messages: [],
      permissionMode: 'auto'
    });

    await task.stop('user');
    await task.completion;

    const types = engine.getEventStore().list('s1').map((e) => e.type);
    expect(types).toContain('task.stopped');
    expect(handle.stopCalls).toBeGreaterThanOrEqual(1);
  });

  it('skips tool execution when runtime handles tools', async () => {
    const handle = new FakeRuntimeTaskHandle();
    const base = fakeRuntime(handle);
    const baseCaps = base.getCapabilities();
    const runtime: RuntimeAdapter = {
      ...base,
      getCapabilities: () => ({
        ...baseCaps,
        toolExecutionModel: 'runtime_internal',
        permissionModel: 'runtime'
      })
    };
    const engine = new ExecutorEngine();

    handle.queue.push(
      event(1, 'tool.call.requested', {
        tool_call_id: 'tc3',
        name: 'runtime.command',
        attempt: 1,
        input_hash: 'hash3',
        input: { command: 'ls' }
      })
    );
    handle.queue.close();

    const task = engine.startTask({
      sessionId: 's1',
      taskId: 't1',
      env,
      runtime,
      runtimeSession,
      messages: [],
      permissionMode: 'auto'
    });

    await task.completion;

    const types = engine.getEventStore().list('s1').map((e) => e.type);
    expect(types).toContain('tool.call.requested');
    expect(types).not.toContain('tool.call.approved');
    expect(handle.results).toHaveLength(0);
  });

  it('emits tool output events and captures sandbox summary', async () => {
    const handle = new FakeRuntimeTaskHandle();
    const runtime = fakeRuntime(handle);
    const engine = new ExecutorEngine({
      toolExecutor: {
        execute: async (_name, _input, options) => {
          options?.onOutput?.('stdout', 'hello');
          return {
            result: { ok: true },
            stdout: 'hello',
            sandbox: { network: false, timeout_ms: 500, mounts: ['/workspace:rw'] }
          };
        }
      }
    });

    handle.queue.push(
      event(1, 'tool.call.requested', {
        tool_call_id: 'tc4',
        name: 'workspace.read',
        attempt: 1,
        input_hash: 'hash4',
        input: { path: 'a' }
      })
    );
    handle.queue.close();

    const task = engine.startTask({
      sessionId: 's1',
      taskId: 't1',
      env,
      runtime,
      runtimeSession,
      messages: [],
      permissionMode: 'auto'
    });

    await task.completion;

    const events = engine.getEventStore().list('s1');
    expect(events.some((e) => e.type === 'tool.output.delta')).toBe(true);
    const outputCompleted = events.find((e) => e.type === 'tool.output.completed');
    expect(outputCompleted?.payload).toMatchObject({ stdout: 'hello' });
    const completed = events.find((e) => e.type === 'tool.call.completed');
    expect(completed?.payload).toMatchObject({ sandbox: { network: false, timeout_ms: 500 } });
  });
});
