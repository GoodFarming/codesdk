import { describe, it } from 'vitest';
import path from 'node:path';
import { ExecutorEngine } from '../../src/executor/engine.js';
import type { RuntimeEnv } from '../../src/core/types.js';
import { ClaudeAgentSdkAdapter } from '../../src/adapters/claude-agent-sdk.js';
import { CodexSdkAdapter } from '../../src/adapters/codex-sdk.js';
import { GeminiCliCoreAdapter } from '../../src/adapters/gemini-cli-core.js';
import { OpencodeServerAdapter } from '../../src/adapters/opencode-server.js';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Codex, type CodexOptions, type ThreadEvent } from '@openai/codex-sdk';
import { Config, type ServerGeminiStreamEvent } from '@google/gemini-cli-core';
import { createOpencodeClient, type Event } from '@opencode-ai/sdk';
import { writeFixtureBundle, type FixtureBundle, type Redaction } from './fixture-utils.js';

const shouldRecord = process.env.RECORD_FIXTURES === '1';
const FIXTURE_PROMPT = 'Respond with the exact phrase: FIXTURE OK.';
const TIMEOUT_MS = 120_000;

const cwd = process.cwd();
const envVars: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === 'string') as Array<[string, string]>
);

const runtimeEnv: RuntimeEnv = {
  cwd,
  env: envVars,
  credentialNamespace: 'fixture'
};

const redactions: Redaction[] = [
  { from: cwd, to: '<CWD>' },
  { from: envVars.HOME ?? '', to: '<HOME>' },
  { from: envVars.USERPROFILE ?? '', to: '<HOME>' }
].filter((entry) => entry.from);

class RecordingThread {
  constructor(
    private readonly inner: { id: string | null; runStreamed: (input: string, options?: { signal?: AbortSignal }) => Promise<{ events: AsyncGenerator<ThreadEvent> }>; run: (input: string, options?: unknown) => Promise<unknown> },
    private readonly sink: ThreadEvent[]
  ) {}

  async runStreamed(input: string, options?: { signal?: AbortSignal }) {
    const streamed = await this.inner.runStreamed(input, options);
    const sink = this.sink;
    return {
      events: (async function* () {
        for await (const event of streamed.events) {
          sink.push(event);
          yield event;
        }
      })()
    };
  }

  async run(input: string, options?: unknown) {
    return this.inner.run(input, options);
  }
}

class RecordingCodex {
  private readonly inner: Codex;
  constructor(options: CodexOptions, private readonly sink: ThreadEvent[]) {
    this.inner = new Codex(options);
  }

  startThread(options?: unknown) {
    const thread = this.inner.startThread(options as any);
    return new RecordingThread(thread as any, this.sink);
  }

  resumeThread(id: string, options?: unknown) {
    const thread = this.inner.resumeThread(id, options as any);
    return new RecordingThread(thread as any, this.sink);
  }
}

describe.skipIf(!shouldRecord)('record runtime fixtures', () => {
  it(
    'records claude-agent-sdk basic fixture',
    async () => {
      const raw: SDKMessage[] = [];
      const queryFn = (params: Parameters<typeof query>[0]) => {
        const stream = query(params);
        const wrapped = (async function* () {
          for await (const msg of stream) {
            raw.push(msg);
            yield msg;
          }
        })();
        (wrapped as any).interrupt = (stream as any).interrupt?.bind(stream);
        return wrapped as any;
      };

      const adapter = new ClaudeAgentSdkAdapter({
        queryFn,
        includePartialMessages: true,
        settingSources: []
      });

      const status = await adapter.getAuthStatus(runtimeEnv);
      if (!status.loggedIn) {
        throw new Error('Claude auth not available; run `claude login` or set credentials.');
      }

      const engine = new ExecutorEngine();
      const sessionId = 'fixture-claude-basic';
      const task = engine.startTask({
        sessionId,
        taskId: 't1',
        env: runtimeEnv,
        runtime: adapter,
        runtimeSession: { sessionId },
        messages: [{ role: 'user', content: [{ type: 'text', text: FIXTURE_PROMPT }] }],
        permissionMode: 'auto'
      });

      await task.completion;
      const bundle: FixtureBundle = {
        meta: {
          runtime: adapter.name,
          scenario: 'basic',
          captured_at: new Date().toISOString(),
          cwd,
          messages: [{ role: 'user', content: [{ type: 'text', text: FIXTURE_PROMPT }] }],
          adapter_options: { includePartialMessages: true, settingSources: [] }
        },
        raw,
        normalized: engine.getEventStore().list(sessionId)
      };

      await writeFixtureBundle(path.join(cwd, 'tests', 'fixtures'), bundle, redactions);
    },
    TIMEOUT_MS
  );

  it(
    'records codex-sdk basic fixture',
    async () => {
      const raw: ThreadEvent[] = [];
      const adapter = new CodexSdkAdapter({
        captureImplicitSources: false,
        codexFactory: (options: CodexOptions) => new RecordingCodex(options, raw) as any
      });

      const status = await adapter.getAuthStatus(runtimeEnv);
      if (!status.loggedIn) {
        throw new Error('Codex auth not available; set CODEX_API_KEY or OPENAI_API_KEY.');
      }

      const engine = new ExecutorEngine();
      const sessionId = 'fixture-codex-basic';
      const task = engine.startTask({
        sessionId,
        taskId: 't1',
        env: runtimeEnv,
        runtime: adapter,
        runtimeSession: { sessionId },
        messages: [{ role: 'user', content: [{ type: 'text', text: FIXTURE_PROMPT }] }],
        permissionMode: 'auto'
      });

      await task.completion;
      const bundle: FixtureBundle = {
        meta: {
          runtime: adapter.name,
          scenario: 'basic',
          captured_at: new Date().toISOString(),
          cwd,
          messages: [{ role: 'user', content: [{ type: 'text', text: FIXTURE_PROMPT }] }],
          adapter_options: { captureImplicitSources: false }
        },
        raw,
        normalized: engine.getEventStore().list(sessionId)
      };

      await writeFixtureBundle(path.join(cwd, 'tests', 'fixtures'), bundle, redactions);
    },
    TIMEOUT_MS
  );

  it(
    'records gemini-cli-core basic fixture',
    async () => {
      const raw: ServerGeminiStreamEvent[][] = [];
      const adapter = new GeminiCliCoreAdapter({
        captureImplicitSources: false,
        initializeConfig: true,
        configFactory: (params) => new Config(params),
        clientFactory: (config) => config.getGeminiClient(),
        streamFactory: (client, request, signal, promptId) => {
          const bucket: ServerGeminiStreamEvent[] = [];
          raw.push(bucket);
          const stream = client.sendMessageStream(request, signal, promptId);
          return (async function* () {
            for await (const event of stream) {
              bucket.push(event);
              yield event;
            }
          })();
        }
      });

      const status = await adapter.getAuthStatus(runtimeEnv);
      if (!status.loggedIn) {
        throw new Error('Gemini auth not available; set GEMINI_API_KEY or login.');
      }

      const engine = new ExecutorEngine();
      const sessionId = 'fixture-gemini-basic';
      const task = engine.startTask({
        sessionId,
        taskId: 't1',
        env: runtimeEnv,
        runtime: adapter,
        runtimeSession: { sessionId },
        messages: [{ role: 'user', content: [{ type: 'text', text: FIXTURE_PROMPT }] }],
        permissionMode: 'auto'
      });

      await task.completion;
      const bundle: FixtureBundle = {
        meta: {
          runtime: adapter.name,
          scenario: 'basic',
          captured_at: new Date().toISOString(),
          cwd,
          messages: [{ role: 'user', content: [{ type: 'text', text: FIXTURE_PROMPT }] }],
          adapter_options: { captureImplicitSources: false, initializeConfig: true }
        },
        raw,
        normalized: engine.getEventStore().list(sessionId)
      };

      await writeFixtureBundle(path.join(cwd, 'tests', 'fixtures'), bundle, redactions);
    },
    TIMEOUT_MS
  );

  it(
    'records opencode-server basic fixture',
    async () => {
      const baseUrl = envVars.OPENCODE_BASE_URL ?? envVars.OPENCODE_URL;
      if (!baseUrl) {
        throw new Error('OpenCode base URL not set; export OPENCODE_BASE_URL or OPENCODE_URL.');
      }

      const raw: Event[] = [];
      const client = createOpencodeClient({ baseUrl, directory: cwd }) as any;
      const originalSubscribe = client.event.subscribe.bind(client.event);
      client.event.subscribe = async (options: unknown) => {
        const result = await originalSubscribe(options as any);
        const stream = result.stream;
        const wrapped = (async function* () {
          for await (const event of stream) {
            raw.push(event as Event);
            yield event;
          }
        })();
        return { ...result, stream: wrapped };
      };

      const adapter = new OpencodeServerAdapter({
        client,
        captureImplicitSources: false
      });

      const status = await adapter.getAuthStatus(runtimeEnv);
      if (!status.loggedIn) {
        throw new Error('OpenCode auth/health check failed; ensure opencode server is running.');
      }

      const engine = new ExecutorEngine();
      const sessionId = 'fixture-opencode-basic';
      const task = engine.startTask({
        sessionId,
        taskId: 't1',
        env: runtimeEnv,
        runtime: adapter,
        runtimeSession: { sessionId },
        messages: [{ role: 'user', content: [{ type: 'text', text: FIXTURE_PROMPT }] }],
        permissionMode: 'auto'
      });

      await task.completion;
      const bundle: FixtureBundle = {
        meta: {
          runtime: adapter.name,
          scenario: 'basic',
          captured_at: new Date().toISOString(),
          cwd,
          messages: [{ role: 'user', content: [{ type: 'text', text: FIXTURE_PROMPT }] }],
          adapter_options: { captureImplicitSources: false, baseUrl }
        },
        raw,
        normalized: engine.getEventStore().list(sessionId)
      };

      await writeFixtureBundle(path.join(cwd, 'tests', 'fixtures'), bundle, redactions);
    },
    TIMEOUT_MS
  );
});
