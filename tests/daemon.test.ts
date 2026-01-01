import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  NormalizedEvent,
  RuntimeAdapter,
  RuntimeEnv,
  RuntimeSessionHandle
} from '../src/core/types.js';
import { createCodeSdkdServer } from '../src/daemon/server.js';
import { x as untar } from 'tar';

class FakeRuntimeTaskHandle {
  constructor(
    private readonly sessionId: string,
    private readonly taskId: string
  ) {}

  async *events() {
    yield fakeEvent(this.sessionId, this.taskId, 1, 'model.output.delta', {
      kind: 'text_delta',
      block_id: 'b1',
      delta: 'hello'
    });
    yield fakeEvent(this.sessionId, this.taskId, 2, 'model.output.completed', {
      content: [{ type: 'text', text: 'hello' }]
    });
  }

  async sendToolResult(): Promise<void> {}
  async sendToolDenied(): Promise<void> {}
  async stop(): Promise<void> {}
}

function fakeRuntime(): RuntimeAdapter {
  return {
    name: 'codex-sdk',
    getCapabilities: () => ({
      supportsStreaming: true,
      supportsToolCalls: false,
      supportsParallelToolCalls: false,
      supportsStop: true,
      supportsArtifacts: false,
      supportsSessionCreate: true,
      supportsSessionResume: false,
      supportsUsageReporting: false,
      supportsNonInteractive: true,
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
    createSession: async (_env: RuntimeEnv, _input: unknown): Promise<RuntimeSessionHandle> => ({
      sessionId: randomUUID()
    }),
    startTask: async (_env, handle, input) =>
      new FakeRuntimeTaskHandle(handle.sessionId, input.taskId) as any
  };
}

class ToolWaitingRuntimeTaskHandle {
  private decided = false;
  private resolveDecision?: () => void;
  results: Array<{ toolCallId: string; result: unknown }> = [];
  denials: Array<{ toolCallId: string; reason: string }> = [];

  constructor(
    private readonly sessionId: string,
    private readonly taskId: string
  ) {}

  async *events() {
    yield fakeEvent(this.sessionId, this.taskId, 1, 'tool.call.requested', {
      tool_call_id: 'tc-ask-1',
      name: 'workspace.read',
      attempt: 1,
      input_hash: 'hash-ask-1',
      input: { path: 'hello.txt' }
    });

    await new Promise<void>((resolve) => {
      if (this.decided) return resolve();
      this.resolveDecision = resolve;
    });

    yield fakeEvent(this.sessionId, this.taskId, 2, 'model.output.completed', {
      content: [{ type: 'text', text: 'done' }]
    });
  }

  async sendToolResult(toolCallId: string, result: unknown): Promise<void> {
    this.results.push({ toolCallId, result });
    this.decided = true;
    this.resolveDecision?.();
  }

  async sendToolDenied(toolCallId: string, reason: string): Promise<void> {
    this.denials.push({ toolCallId, reason });
    this.decided = true;
    this.resolveDecision?.();
  }

  async stop(): Promise<void> {
    this.decided = true;
    this.resolveDecision?.();
  }
}

function toolRuntime(onHandle: (handle: ToolWaitingRuntimeTaskHandle) => void): RuntimeAdapter {
  return {
    name: 'codex-sdk',
    getCapabilities: () => ({
      supportsStreaming: true,
      supportsToolCalls: true,
      supportsParallelToolCalls: false,
      supportsStop: true,
      supportsArtifacts: false,
      supportsSessionCreate: true,
      supportsSessionResume: false,
      supportsUsageReporting: false,
      supportsNonInteractive: true,
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
    createSession: async (_env: RuntimeEnv, _input: unknown): Promise<RuntimeSessionHandle> => ({
      sessionId: randomUUID()
    }),
    startTask: async (_env, handle, input) => {
      const taskHandle = new ToolWaitingRuntimeTaskHandle(handle.sessionId, input.taskId);
      onHandle(taskHandle);
      return taskHandle as any;
    }
  };
}

function fakeEvent(
  sessionId: string,
  taskId: string,
  seq: number,
  type: NormalizedEvent['type'],
  payload: Record<string, unknown>
): NormalizedEvent {
  return {
    schema_version: 1,
    seq,
    time: new Date().toISOString(),
    type,
    trace: { session_id: sessionId, task_id: taskId },
    runtime: { name: 'codex-sdk' },
    payload
  };
}

async function readFirstSseEvent(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal
  });
  const reader = res.body?.getReader();
  if (!reader) throw new Error('missing stream');
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const idx = buffer.indexOf('\n\n');
        if (idx === -1) break;
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = chunk
          .split('\n')
          .map((entry) => entry.trim())
          .find((entry) => entry.startsWith('data:'));
        if (line) {
          const json = line.replace(/^data:\s*/, '');
          const parsed = JSON.parse(json) as NormalizedEvent;
          if (parsed && typeof (parsed as NormalizedEvent).type === 'string') {
            controller.abort();
            return parsed;
          }
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  throw new Error('no sse event');
}

describe('codesdkd server', () => {
  const runtime = fakeRuntime();
  const daemon = createCodeSdkdServer({
    runtimes: [runtime],
    host: '127.0.0.1',
    port: 0
  });
  let baseUrl = '';

  beforeAll(async () => {
    const info = await daemon.listen();
    baseUrl = info.url;
  });

  afterAll(async () => {
    await daemon.close();
  });

  it('creates sessions and tasks and returns events', async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);

    const sessionRes = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: runtime.name, credentialNamespace: 'test' })
    });
    expect(sessionRes.status).toBe(201);
    const session = (await sessionRes.json()) as { session_id: string };
    expect(session.session_id).toBeTruthy();

    const sessionsRes = await fetch(`${baseUrl}/sessions?limit=10`);
    expect(sessionsRes.status).toBe(200);
    const sessionsPayload = (await sessionsRes.json()) as { sessions: Array<{ session_id: string }> };
    expect(sessionsPayload.sessions.some((s) => s.session_id === session.session_id)).toBe(true);

    const taskRes = await fetch(`${baseUrl}/sessions/${session.session_id}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
      })
    });
    expect(taskRes.status).toBe(202);
    const task = (await taskRes.json()) as { task_id: string };
    expect(task.task_id).toBeTruthy();

    let status = 'unknown';
    for (let i = 0; i < 10; i += 1) {
      const statusRes = await fetch(
        `${baseUrl}/sessions/${session.session_id}/tasks/${task.task_id}`
      );
      const payload = (await statusRes.json()) as { status: string };
      status = payload.status;
      if (status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(status).toBe('completed');

    const eventsRes = await fetch(`${baseUrl}/sessions/${session.session_id}/events?limit=10`);
    const eventsPayload = (await eventsRes.json()) as { events: NormalizedEvent[] };
    expect(eventsPayload.events.length).toBeGreaterThan(0);

    const sseEvent = await readFirstSseEvent(
      `${baseUrl}/sessions/${session.session_id}/events?stream=1`
    );
    expect(sseEvent.type).toBeTruthy();

    const artifact = daemon.engine.getArtifactStore().put(Buffer.from('hello'), {
      contentType: 'text/plain',
      name: 'hello.txt'
    });
    const downloadRes = await fetch(`${baseUrl}/artifacts/${artifact.artifact_id}/download`);
    expect(downloadRes.status).toBe(200);
    expect(await downloadRes.text()).toBe('hello');

    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'codesdkd-bundle-test-'));
    const extractDir = path.join(tmpDir, 'extract');
    mkdirSync(extractDir, { recursive: true });
    const bundleRes = await fetch(`${baseUrl}/sessions/${session.session_id}/support-bundle`);
    expect(bundleRes.status).toBe(200);
    const bundlePath = path.join(tmpDir, 'bundle.tgz');
    const bytes = new Uint8Array(await bundleRes.arrayBuffer());
    writeFileSync(bundlePath, bytes);
    await untar({ file: bundlePath, cwd: extractDir });
    const manifest = JSON.parse(readFileSync(path.join(extractDir, 'manifest.json'), 'utf8')) as {
      session_id: string;
    };
    expect(manifest.session_id).toBe(session.session_id);
  });

  it('implements permissionMode=ask with approve/deny endpoints', async () => {
    const handles: ToolWaitingRuntimeTaskHandle[] = [];
    let toolCalls = 0;
    const runtime = toolRuntime((handle) => {
      handles.push(handle);
    });
    const daemon = createCodeSdkdServer({
      runtimes: [runtime],
      host: '127.0.0.1',
      port: 0,
      toolExecutor: {
        execute: async () => {
          toolCalls += 1;
          return { result: { ok: true } };
        }
      }
    });

    const info = await daemon.listen();
    const baseUrl = info.url;

    try {
      const sessionRes = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtime: runtime.name, credentialNamespace: 'test', permissionMode: 'ask' })
      });
      expect(sessionRes.status).toBe(201);
      const session = (await sessionRes.json()) as { session_id: string };

      const taskRes = await fetch(`${baseUrl}/sessions/${session.session_id}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          taskId: 't-ask-1',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
        })
      });
      expect(taskRes.status).toBe(202);

      for (let i = 0; i < 50; i += 1) {
        const eventsRes = await fetch(`${baseUrl}/sessions/${session.session_id}/events?limit=500`);
        const payload = (await eventsRes.json()) as { events: NormalizedEvent[] };
        const asked = payload.events.some(
          (e) =>
            e.type === 'tool.call.policy_evaluated' &&
            (e.payload as any)?.source === 'codesdk' &&
            (e.payload as any)?.result === 'ask'
        );
        if (asked) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(toolCalls).toBe(0);

      const approveRes = await fetch(
        `${baseUrl}/sessions/${session.session_id}/tool-calls/tc-ask-1/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ attempt: 1, input_hash: 'hash-ask-1' })
        }
      );
      expect(approveRes.status).toBe(200);

      for (let i = 0; i < 100; i += 1) {
        const statusRes = await fetch(`${baseUrl}/sessions/${session.session_id}/tasks/t-ask-1`);
        const statusPayload = (await statusRes.json()) as { status: string };
        if (statusPayload.status === 'completed') break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(toolCalls).toBe(1);
      expect(handles[0]?.results).toHaveLength(1);

      const denyRes = await fetch(
        `${baseUrl}/sessions/${session.session_id}/tool-calls/tc-ask-1/deny`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ attempt: 1, input_hash: 'hash-ask-1', reason: 'no' })
        }
      );
      expect(denyRes.status).toBe(404);

      const session2Res = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtime: runtime.name, credentialNamespace: 'test', permissionMode: 'ask' })
      });
      expect(session2Res.status).toBe(201);
      const session2 = (await session2Res.json()) as { session_id: string };

      const task2Res = await fetch(`${baseUrl}/sessions/${session2.session_id}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          taskId: 't-ask-2',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
        })
      });
      expect(task2Res.status).toBe(202);

      for (let i = 0; i < 50; i += 1) {
        const eventsRes = await fetch(`${baseUrl}/sessions/${session2.session_id}/events?limit=500`);
        const payload = (await eventsRes.json()) as { events: NormalizedEvent[] };
        const asked = payload.events.some(
          (e) =>
            e.type === 'tool.call.policy_evaluated' &&
            (e.payload as any)?.source === 'codesdk' &&
            (e.payload as any)?.result === 'ask'
        );
        if (asked) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const deny2Res = await fetch(
        `${baseUrl}/sessions/${session2.session_id}/tool-calls/tc-ask-1/deny`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ attempt: 1, input_hash: 'hash-ask-1', reason: 'no' })
        }
      );
      expect(deny2Res.status).toBe(200);

      for (let i = 0; i < 100; i += 1) {
        const statusRes = await fetch(`${baseUrl}/sessions/${session2.session_id}/tasks/t-ask-2`);
        const statusPayload = (await statusRes.json()) as { status: string };
        if (statusPayload.status === 'completed') break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(toolCalls).toBe(1);
      expect(handles[1]?.denials).toHaveLength(1);
    } finally {
      await daemon.close();
    }
  });
});
