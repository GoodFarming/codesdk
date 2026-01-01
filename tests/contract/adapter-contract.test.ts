import { describe, expect, it } from 'vitest';
import type { NormalizedEvent, RuntimeAdapter, RuntimeEnv, RuntimeSessionHandle } from '../../src/core/types.js';
import { compileRuntimeInput } from '../../src/core/context-compiler.js';
import { buildImplicitSourcesSnapshot } from '../../src/core/implicit-sources.js';
import { ExecutorEngine } from '../../src/executor/engine.js';
import { storeImplicitSourcesSnapshot } from '../../src/executor/implicit-sources.js';
import { buildModelInputPayload } from '../../src/executor/model-input.js';

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

class MockRuntimeTaskHandle {
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

function mockRuntime(handle: MockRuntimeTaskHandle): RuntimeAdapter {
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

describe('adapter contract (mock)', () => {
  it('emits model.input + streaming output', async () => {
    const handle = new MockRuntimeTaskHandle();
    const runtime = mockRuntime(handle);
    const engine = new ExecutorEngine();

    const messages = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
    const compiled = compileRuntimeInput(messages as any, { maxChars: 100 });
    const implicitSnapshot = buildImplicitSourcesSnapshot({ disabled: true, reason: 'disabled' });
    const implicitRef = storeImplicitSourcesSnapshot(engine.getArtifactStore(), implicitSnapshot);
    const modelInput = buildModelInputPayload({
      store: engine.getArtifactStore(),
      compiled,
      implicitSourcesRef: implicitRef
    });

    handle.queue.push(event(1, 'model.input', modelInput as any));
    handle.queue.push(
      event(2, 'model.output.delta', { kind: 'text_delta', block_id: 'b1', delta: 'hi' })
    );
    handle.queue.push(
      event(3, 'model.output.completed', { content: [{ type: 'text', text: 'hi' }] })
    );
    handle.queue.close();

    const task = engine.startTask({
      sessionId: 's1',
      taskId: 't1',
      env,
      runtime,
      runtimeSession,
      messages
    });

    await task.completion;
    const events = engine.getEventStore().list('s1');
    const modelInputEvent = events.find((e) => e.type === 'model.input');
    expect(modelInputEvent).toBeDefined();
    expect((modelInputEvent?.payload as any).implicit_sources_ref).toBeDefined();
    const deltaEvent = events.find((e) => e.type === 'model.output.delta');
    expect(deltaEvent).toBeDefined();
  });

  it('executes tool calls when approved', async () => {
    const handle = new MockRuntimeTaskHandle();
    const runtime = mockRuntime(handle);
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
    const types = engine.getEventStore().list('s1').map((e) => e.type);
    expect(types).toContain('tool.call.approved');
    expect(types).toContain('tool.call.completed');
    expect(handle.results).toHaveLength(1);
  });

  it('waits for tool approval in ask mode (deny)', async () => {
    const handle = new MockRuntimeTaskHandle();
    const runtime = mockRuntime(handle);
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

  it('handles multiple outstanding tool calls', async () => {
    const handle = new MockRuntimeTaskHandle();
    const runtime = mockRuntime(handle);
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
    const types = engine.getEventStore().list('s1').map((e) => e.type);
    expect(types.filter((t) => t === 'tool.call.completed')).toHaveLength(2);
  });
});
