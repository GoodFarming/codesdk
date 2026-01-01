import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ExecutorEngine } from '../../src/executor/engine.js';
import type { NormalizedEvent, RuntimeEnv, RuntimeSessionHandle } from '../../src/core/types.js';
import { ClaudeAgentSdkAdapter } from '../../src/adapters/claude-agent-sdk.js';
import { CodexSdkAdapter } from '../../src/adapters/codex-sdk.js';
import { GeminiCliCoreAdapter } from '../../src/adapters/gemini-cli-core.js';
import { OpencodeServerAdapter } from '../../src/adapters/opencode-server.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ThreadEvent } from '@openai/codex-sdk';
import { Config, type ServerGeminiStreamEvent } from '@google/gemini-cli-core';
import type { Event } from '@opencode-ai/sdk';
import { readJson, normalizeEvents } from './fixture-utils.js';

type FixtureMeta = {
  runtime: string;
  scenario: string;
  cwd: string;
  messages: Array<{ role: string; content: Array<{ type: string; [key: string]: unknown }> }>;
  tool_manifest?: unknown;
  runtime_config?: Record<string, unknown>;
  adapter_options?: Record<string, unknown>;
};

type FixtureData = {
  meta: FixtureMeta;
  raw: unknown;
  normalized: NormalizedEvent[];
};

const baseDir = path.join(process.cwd(), 'tests', 'fixtures');

async function loadFixture(runtime: string, scenario: string): Promise<FixtureData> {
  const dir = path.join(baseDir, runtime, scenario);
  const meta = await readJson<FixtureMeta>(path.join(dir, 'meta.json'));
  const raw = await readJson(path.join(dir, 'raw.json'));
  const normalized = await readJson<NormalizedEvent[]>(path.join(dir, 'normalized.json'));
  return { meta, raw, normalized };
}

function fixtureExists(runtime: string, scenario: string): boolean {
  const dir = path.join(baseDir, runtime, scenario);
  return (
    existsSync(path.join(dir, 'meta.json')) &&
    existsSync(path.join(dir, 'raw.json')) &&
    existsSync(path.join(dir, 'normalized.json'))
  );
}

function buildRuntimeEnv(meta: FixtureMeta): RuntimeEnv {
  const cwd = meta.cwd.includes('<CWD>') ? process.cwd() : meta.cwd;
  return { cwd, env: {}, credentialNamespace: 'fixture' };
}

async function replayClaude(
  fixture: FixtureData,
  sessionIdOverride?: string
): Promise<NormalizedEvent[]> {
  const raw = fixture.raw as SDKMessage[];
  const queryFn = (_params: unknown) => {
    const stream = (async function* () {
      for (const msg of raw) {
        yield msg;
      }
    })();
    (stream as any).interrupt = async () => {};
    return stream as any;
  };
  const adapter = new ClaudeAgentSdkAdapter({
    ...(fixture.meta.adapter_options ?? {}),
    queryFn
  });
  return runEngine(adapter, fixture.meta, undefined, sessionIdOverride);
}

async function replayCodex(
  fixture: FixtureData,
  sessionIdOverride?: string
): Promise<NormalizedEvent[]> {
  class FakeThread {
    constructor(private readonly events: ThreadEvent[]) {}
    async runStreamed(_input: string) {
      return {
        events: (async function* (events: ThreadEvent[]) {
          for (const event of events) {
            yield event;
          }
        })(this.events)
      };
    }
  }

  class FakeCodex {
    constructor(private readonly events: ThreadEvent[]) {}
    startThread() {
      return new FakeThread(this.events);
    }
    resumeThread() {
      return new FakeThread(this.events);
    }
  }

  const adapter = new CodexSdkAdapter({
    ...(fixture.meta.adapter_options ?? {}),
    codexFactory: () => new FakeCodex(fixture.raw as ThreadEvent[]) as any
  });
  return runEngine(adapter, fixture.meta, undefined, sessionIdOverride);
}

async function replayGemini(
  fixture: FixtureData,
  sessionIdOverride?: string
): Promise<NormalizedEvent[]> {
  const streams = fixture.raw as ServerGeminiStreamEvent[][];
  let callIndex = 0;
  const adapter = new GeminiCliCoreAdapter({
    ...(fixture.meta.adapter_options ?? {}),
    initializeConfig: false,
    configFactory: (params) => new Config(params),
    clientFactory: () => ({}) as any,
    streamFactory: () =>
      (async function* () {
        const batch = streams[callIndex++] ?? [];
        for (const event of batch) {
          yield event;
        }
      })()
  });
  return runEngine(adapter, fixture.meta, undefined, sessionIdOverride);
}

async function replayOpencode(
  fixture: FixtureData,
  sessionIdOverride?: string
): Promise<NormalizedEvent[]> {
  const events = fixture.raw as Event[];
  const stream = (async function* () {
    for (const event of events) {
      yield event;
    }
  })();

  const sessionId = extractOpencodeSessionId(events) ?? 'fixture-session';
  const fakeClient = {
    event: {
      subscribe: async () => ({ stream })
    },
    session: {
      promptAsync: async () => undefined,
      abort: async () => undefined
    },
    config: {
      get: async () => ({})
    },
    mcp: {
      status: async () => ({})
    }
  } as any;

  const adapter = new OpencodeServerAdapter({
    ...(fixture.meta.adapter_options ?? {}),
    client: fakeClient,
    captureImplicitSources: false
  });

  return runEngine(adapter, fixture.meta, sessionId, sessionIdOverride);
}

async function runEngine(
  adapter: {
    name: string;
    startTask: (env: RuntimeEnv, handle: RuntimeSessionHandle, input: any) => Promise<any>;
    getCapabilities: () => { toolExecutionModel: string };
  },
  meta: FixtureMeta,
  runtimeSessionId?: string,
  sessionIdOverride?: string
): Promise<NormalizedEvent[]> {
  const engine = new ExecutorEngine();
  const sessionId = sessionIdOverride ?? `replay-${meta.runtime}-${meta.scenario}`;
  const env = buildRuntimeEnv(meta);
  const runtimeSession: RuntimeSessionHandle = runtimeSessionId
    ? { sessionId, runtimeSessionId }
    : { sessionId };

  const task = engine.startTask({
    sessionId,
    taskId: 't1',
    env,
    runtime: adapter as any,
    runtimeSession,
    messages: meta.messages,
    toolManifest: meta.tool_manifest,
    runtimeConfig: meta.runtime_config,
    permissionMode: 'auto'
  });

  await task.completion;
  return engine.getEventStore().list(sessionId);
}

function extractOpencodeSessionId(events: Event[]): string | undefined {
  for (const event of events) {
    if (event.type === 'message.part.updated') {
      const part = event.properties?.part as { sessionID?: string } | undefined;
      if (part?.sessionID) return part.sessionID;
    }
    if (event.type === 'message.updated') {
      const info = event.properties?.info as { sessionID?: string } | undefined;
      if (info?.sessionID) return info.sessionID;
    }
    if (event.type === 'session.error') {
      const sessionID = event.properties?.sessionID as string | undefined;
      if (sessionID) return sessionID;
    }
  }
  return undefined;
}

describe('fixture replay', () => {
  it('claude basic fixture is deterministic', async () => {
    if (!fixtureExists('claude-agent-sdk', 'basic')) return;
    const fixture = await loadFixture('claude-agent-sdk', 'basic');
    const fixtureSessionId = fixture.normalized[0]?.trace?.session_id;
    const events = await replayClaude(fixture, fixtureSessionId);
    const normalizedActual = normalizeEvents(events, []);
    expect(normalizedActual).toEqual(fixture.normalized);
    if (fixtureSessionId) {
      expect(events[0]?.trace?.session_id).toBe(fixtureSessionId);
    }
  });

  it('codex basic fixture is deterministic', async () => {
    if (!fixtureExists('codex-sdk', 'basic')) return;
    const fixture = await loadFixture('codex-sdk', 'basic');
    const fixtureSessionId = fixture.normalized[0]?.trace?.session_id;
    const events = await replayCodex(fixture, fixtureSessionId);
    const normalizedActual = normalizeEvents(events, []);
    expect(normalizedActual).toEqual(fixture.normalized);
    if (fixtureSessionId) {
      expect(events[0]?.trace?.session_id).toBe(fixtureSessionId);
    }
  });

  it('gemini basic fixture is deterministic', async () => {
    if (!fixtureExists('gemini-cli-core', 'basic')) return;
    const fixture = await loadFixture('gemini-cli-core', 'basic');
    const fixtureSessionId = fixture.normalized[0]?.trace?.session_id;
    const events = await replayGemini(fixture, fixtureSessionId);
    const normalizedActual = normalizeEvents(events, []);
    expect(normalizedActual).toEqual(fixture.normalized);
    if (fixtureSessionId) {
      expect(events[0]?.trace?.session_id).toBe(fixtureSessionId);
    }
  });

  it('opencode basic fixture is deterministic', async () => {
    if (!fixtureExists('opencode-server', 'basic')) return;
    const fixture = await loadFixture('opencode-server', 'basic');
    const fixtureSessionId = fixture.normalized[0]?.trace?.session_id;
    const events = await replayOpencode(fixture, fixtureSessionId);
    const normalizedActual = normalizeEvents(events, []);
    expect(normalizedActual).toEqual(fixture.normalized);
    if (fixtureSessionId) {
      expect(events[0]?.trace?.session_id).toBe(fixtureSessionId);
    }
  });

  it('basic fixtures share core SSOT shape', async () => {
    const runtimes = ['claude-agent-sdk', 'codex-sdk', 'gemini-cli-core', 'opencode-server'];
    for (const runtime of runtimes) {
      if (!fixtureExists(runtime, 'basic')) continue;
      const fixture = await loadFixture(runtime, 'basic');
      const types = fixture.normalized.map((event) => event.type);
      expect(types).toContain('model.input');
      const hasTerminal = types.some((type) =>
        ['task.completed', 'task.failed', 'task.stopped'].includes(type)
      );
      expect(hasTerminal).toBe(true);
      if (!types.includes('task.failed')) {
        expect(types).toContain('model.output.completed');
      }
    }
  });
});
