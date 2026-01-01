import { describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter } from '../src/adapters/claude-agent-sdk.js';
import { ExecutorEngine } from '../src/executor/engine.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { RegistryToolExecutor } from '../src/tools/executor.js';
import type { RuntimeEnv, RuntimeSessionHandle } from '../src/core/types.js';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function waitForFinishOrAbort(signal: AbortSignal | undefined, done: Promise<void>): Promise<void> {
  if (!signal) return done;
  if (signal.aborted) return Promise.resolve();
  return Promise.race([
    done,
    new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    })
  ]);
}

function createQueryHarness() {
  const ready = createDeferred<void>();
  const finished = createDeferred<void>();
  let mcpServer: any;

  const queryFn = ((params: { options?: Record<string, unknown> }) => {
    const options = params.options as any;
    const mcpServers = options?.mcpServers as Record<string, any> | undefined;
    if (mcpServers) {
      const first = Object.values(mcpServers)[0] as any;
      mcpServer = first?.instance;
    }
    ready.resolve();
    return (async function* (): AsyncGenerator<any> {
      await waitForFinishOrAbort(options?.abortController?.signal, finished.promise);
    })();
  }) as any;

  return {
    queryFn,
    ready: ready.promise,
    finish: () => finished.resolve(),
    getMcpServer: () => mcpServer
  };
}

function buildRegistry() {
  const registry = new ToolRegistry();
  registry.register({
    name: 'test.echo',
    description: 'Echo the input',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value']
    },
    handler: async (input) => ({
      result: { echo: (input as { value?: string }).value }
    })
  });
  return registry;
}

const env: RuntimeEnv = { cwd: '/tmp', env: {}, credentialNamespace: 'default' };
const runtimeSession: RuntimeSessionHandle = { sessionId: 's1' };

describe('ClaudeAgentSdkAdapter integration (engine + MCP)', () => {
  it('approves tool calls and returns results', async () => {
    const { queryFn, ready, finish, getMcpServer } = createQueryHarness();
    const adapter = new ClaudeAgentSdkAdapter({ queryFn });
    const registry = buildRegistry();
    const toolExecutor = new RegistryToolExecutor(registry, { workspaceRoot: '/tmp' });
    const engine = new ExecutorEngine({ toolExecutor });

    const task = engine.startTask({
      sessionId: 's1',
      taskId: 't1',
      env,
      runtime: adapter,
      runtimeSession,
      messages: [],
      toolManifest: registry.toManifest(),
      permissionMode: 'auto'
    });

    await ready;
    const server = getMcpServer();
    expect(server).toBeDefined();

    const tool = (server as any)._registeredTools['test.echo'];
    const callPromise = tool.handler({ value: 'hi' }, { requestId: 'req-1' });
    const result = await callPromise;

    expect(result.structuredContent).toEqual({ echo: 'hi' });

    finish();
    await task.completion;

    const events = engine.getEventStore().list('s1');
    expect(events.some((event) => event.type === 'tool.call.approved')).toBe(true);
    const completed = events.find((event) => event.type === 'tool.call.completed');
    expect((completed?.payload as any).executed_by).toBe('codesdk');
    expect((completed?.payload as any).policy_snapshot?.decision).toBe('allow');
  });

  it('waits for tool approval in ask mode (deny)', async () => {
    const { queryFn, ready, finish, getMcpServer } = createQueryHarness();
    const adapter = new ClaudeAgentSdkAdapter({ queryFn });
    const registry = buildRegistry();
    const toolExecutor = new RegistryToolExecutor(registry, { workspaceRoot: '/tmp' });
    const engine = new ExecutorEngine({ toolExecutor });

    const task = engine.startTask({
      sessionId: 's1',
      taskId: 't1',
      env,
      runtime: adapter,
      runtimeSession,
      messages: [],
      toolManifest: registry.toManifest(),
      permissionMode: 'ask'
    });

    await ready;
    const server = getMcpServer();
    const tool = (server as any)._registeredTools['test.echo'];
    const callPromise = tool.handler({ value: 'hi' }, { requestId: 'req-2' });

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

    const requested = engine
      .getEventStore()
      .list('s1')
      .find((e) => e.type === 'tool.call.requested');
    expect(requested).toBeDefined();
    const payload = requested?.payload as any;
    const denyDecision = engine.denyToolCall('s1', payload.tool_call_id, {
      attempt: payload.attempt,
      input_hash: payload.input_hash,
      reason: 'approval required'
    });
    expect(denyDecision.ok).toBe(true);

    const result = await callPromise;
    expect(result.isError).toBe(true);

    finish();
    await task.completion;

    const events = engine.getEventStore().list('s1');
    const types = events.map((event) => event.type);
    expect(types).toContain('tool.call.denied');
    expect(types).not.toContain('tool.call.completed');
    const deniedEvent = events.find((event) => event.type === 'tool.call.denied');
    expect((deniedEvent?.payload as any).policy_snapshot?.decision).toBe('deny');
  });

  it('handles multiple outstanding tool calls', async () => {
    const { queryFn, ready, finish, getMcpServer } = createQueryHarness();
    const adapter = new ClaudeAgentSdkAdapter({ queryFn });
    const registry = buildRegistry();
    const toolExecutor = new RegistryToolExecutor(registry, { workspaceRoot: '/tmp' });
    const engine = new ExecutorEngine({ toolExecutor });

    const task = engine.startTask({
      sessionId: 's1',
      taskId: 't1',
      env,
      runtime: adapter,
      runtimeSession,
      messages: [],
      toolManifest: registry.toManifest(),
      permissionMode: 'auto'
    });

    await ready;
    const server = getMcpServer();
    const tool = (server as any)._registeredTools['test.echo'];

    const callA = tool.handler({ value: 'a' }, { requestId: 'req-3' });
    const callB = tool.handler({ value: 'b' }, { requestId: 'req-4' });

    const results = await Promise.all([callA, callB]);
    expect(results[0].structuredContent).toEqual({ echo: 'a' });
    expect(results[1].structuredContent).toEqual({ echo: 'b' });

    finish();
    await task.completion;

    const completed = engine.getEventStore().list('s1').filter((event) => event.type === 'tool.call.completed');
    expect(completed).toHaveLength(2);
  });

  it('emits task.stopped on stop', async () => {
    const { queryFn, ready } = createQueryHarness();
    const adapter = new ClaudeAgentSdkAdapter({ queryFn });
    const engine = new ExecutorEngine();

    const task = engine.startTask({
      sessionId: 's1',
      taskId: 't1',
      env,
      runtime: adapter,
      runtimeSession,
      messages: [],
      permissionMode: 'auto'
    });

    await ready;
    await task.stop('user');
    await task.completion;

    const types = engine.getEventStore().list('s1').map((event) => event.type);
    expect(types).toContain('task.stopped');
  });
});
