import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RuntimeAdapter, RuntimeEnv, TranscriptMessage } from '../src/core/types.js';
import { buildRuntimeEnv } from '../src/runtime-env/index.js';
import { ExecutorEngine } from '../src/executor/engine.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createWorkspaceReadTool } from '../src/tools/workspace.js';
import { RegistryToolExecutor } from '../src/tools/executor.js';
import { ClaudeAgentSdkAdapter } from '../src/adapters/claude-agent-sdk.js';
import { CodexSdkAdapter } from '../src/adapters/codex-sdk.js';
import { GeminiCliCoreAdapter } from '../src/adapters/gemini-cli-core.js';
import { OpencodeServerAdapter } from '../src/adapters/opencode-server.js';

const shouldRun = process.env.RUN_LIVE_TESTS === '1';
const shouldRunTools = process.env.RUN_LIVE_TOOL_TESTS === '1';
const describeLive = shouldRun ? describe : describe.skip;
const itTool = shouldRunTools ? it : it.skip;

const SIMPLE_PROMPT = 'Respond with the exact phrase: LIVE OK.';
const TOOL_PROMPT =
  'You must call the tool "workspace.read" with {"path":"README.md"}. After receiving the tool result, respond with only the first line of the file.';
const CLAUDE_TOOL_PROMPT =
  'You must call the MCP tool "mcp__codesdk__workspace_read" with {"path":"README.md"}. After receiving the tool result, respond with only the first line of the file.';

const SIMPLE_TIMEOUT_MS = 120_000;
const TOOL_TIMEOUT_MS = 180_000;

const runtimeEnv: RuntimeEnv = buildRuntimeEnv({
  credentialNamespace: 'live',
  isolationLevel: 'shared',
  isolationMode: 'in_process',
  createDirs: false
});

async function ensureLoggedIn(adapter: RuntimeAdapter, env: RuntimeEnv) {
  const status = await adapter.getAuthStatus(env);
  if (!status.loggedIn) {
    throw new Error(`${adapter.name} not logged in (details: ${JSON.stringify(status.details ?? {})})`);
  }
}

async function createSession(adapter: RuntimeAdapter, env: RuntimeEnv, model?: string) {
  if (!adapter.createSession) {
    throw new Error(`${adapter.name} does not support createSession`);
  }
  return adapter.createSession(env, { title: 'live-test', model });
}

async function runTask(options: {
  adapter: RuntimeAdapter;
  env: RuntimeEnv;
  messages: TranscriptMessage[];
  model?: string;
  toolRegistry?: ToolRegistry;
  toolExecutor?: RegistryToolExecutor;
}) {
  const engine = new ExecutorEngine({
    toolRegistry: options.toolRegistry,
    toolExecutor: options.toolExecutor
  });
  const session = await createSession(options.adapter, options.env, options.model);
  const taskId = randomUUID();
  const handle = engine.startTask({
    sessionId: session.sessionId,
    taskId,
    env: options.env,
    runtime: options.adapter,
    runtimeSession: session,
    messages: options.messages,
    permissionMode: 'auto',
    toolManifest: options.toolRegistry ? options.toolRegistry.toManifest() : undefined
  });
  await handle.completion;
  return engine.getEventStore().list(session.sessionId);
}

function promptMessage(text: string): TranscriptMessage[] {
  return [{ role: 'user', content: [{ type: 'text', text }] }];
}

function expectEvent(events: { type: string }[], type: string) {
  const has = events.some((event) => event.type === type);
  expect(has, `expected event type ${type}`).toBe(true);
}

describeLive('live runtime smoke tests', () => {
  it(
    'claude-agent-sdk prompt',
    async () => {
      const adapter = new ClaudeAgentSdkAdapter({
        model: process.env.CLAUDE_MODEL || undefined
      });
      await ensureLoggedIn(adapter, runtimeEnv);

      const simple = await runTask({
        adapter,
        env: runtimeEnv,
        messages: promptMessage(SIMPLE_PROMPT),
        model: process.env.CLAUDE_MODEL || undefined
      });
      expectEvent(simple, 'model.output.completed');

    },
    SIMPLE_TIMEOUT_MS
  );

  itTool(
    'claude-agent-sdk tool path',
    async () => {
      const adapter = new ClaudeAgentSdkAdapter({
        model: process.env.CLAUDE_MODEL || undefined
      });
      await ensureLoggedIn(adapter, runtimeEnv);

      const registry = new ToolRegistry();
      registry.register(createWorkspaceReadTool());
      const toolExecutor = new RegistryToolExecutor(registry, { workspaceRoot: process.cwd() });

      const withTool = await runTask({
        adapter,
        env: runtimeEnv,
        messages: promptMessage(CLAUDE_TOOL_PROMPT),
        model: process.env.CLAUDE_MODEL || undefined,
        toolRegistry: registry,
        toolExecutor
      });
      if (process.env.DEBUG_LIVE_EVENTS === '1') {
        console.log(
          'claude tool events',
          withTool.map((event) => ({ type: event.type, payload: event.payload }))
        );
      }
      expectEvent(withTool, 'tool.call.completed');
      expectEvent(withTool, 'model.output.completed');
    },
    TOOL_TIMEOUT_MS
  );

  it(
    'gemini-cli-core prompt',
    async () => {
      const adapter = new GeminiCliCoreAdapter({
        model: process.env.GEMINI_MODEL || undefined
      });
      await ensureLoggedIn(adapter, runtimeEnv);

      const simple = await runTask({
        adapter,
        env: runtimeEnv,
        messages: promptMessage(SIMPLE_PROMPT),
        model: process.env.GEMINI_MODEL || undefined
      });
      expectEvent(simple, 'model.output.completed');

    },
    SIMPLE_TIMEOUT_MS
  );

  itTool(
    'gemini-cli-core tool path',
    async () => {
      const adapter = new GeminiCliCoreAdapter({
        model: process.env.GEMINI_MODEL || undefined
      });
      await ensureLoggedIn(adapter, runtimeEnv);

      const registry = new ToolRegistry();
      registry.register(createWorkspaceReadTool());
      const toolExecutor = new RegistryToolExecutor(registry, { workspaceRoot: process.cwd() });

      const withTool = await runTask({
        adapter,
        env: runtimeEnv,
        messages: promptMessage(TOOL_PROMPT),
        model: process.env.GEMINI_MODEL || undefined,
        toolRegistry: registry,
        toolExecutor
      });
      expectEvent(withTool, 'tool.call.completed');
      expectEvent(withTool, 'model.output.completed');
    },
    TOOL_TIMEOUT_MS
  );

  it(
    'codex-sdk prompt',
    async () => {
      const adapter = new CodexSdkAdapter({
        model: process.env.CODEX_MODEL || undefined
      });
      await ensureLoggedIn(adapter, runtimeEnv);

      const events = await runTask({
        adapter,
        env: runtimeEnv,
        messages: promptMessage(SIMPLE_PROMPT),
        model: process.env.CODEX_MODEL || undefined
      });
      expectEvent(events, 'model.output.completed');
    },
    SIMPLE_TIMEOUT_MS
  );

  const opencodeUrl = runtimeEnv.env.OPENCODE_BASE_URL ?? runtimeEnv.env.OPENCODE_URL;
  const itOpencode = opencodeUrl ? it : it.skip;

  itOpencode(
    'opencode-server prompt',
    async () => {
      const adapter = new OpencodeServerAdapter({
        baseUrl: opencodeUrl,
        providerId: process.env.OPENCODE_PROVIDER_ID || process.env.OPENCODE_PROVIDER || undefined,
        modelId: process.env.OPENCODE_MODEL_ID || process.env.OPENCODE_MODEL || undefined
      });
      await ensureLoggedIn(adapter, runtimeEnv);

      const events = await runTask({
        adapter,
        env: runtimeEnv,
        messages: promptMessage(SIMPLE_PROMPT),
        model: process.env.OPENCODE_MODEL || undefined
      });
      expectEvent(events, 'model.output.completed');
    },
    SIMPLE_TIMEOUT_MS
  );
});
