import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import type { Content, Part, PartListUnion } from '@google/genai';
import {
  Config,
  GeminiClient,
  GeminiEventType,
  convertToFunctionResponse,
  DEFAULT_GEMINI_MODEL
} from '@google/gemini-cli-core';
import { AuthType } from '@google/gemini-cli-core/dist/src/core/contentGenerator.js';
import type { ServerGeminiStreamEvent } from '@google/gemini-cli-core';
import type {
  AuthStatus,
  ModelInputPayload,
  ModelOutputCompletedPayload,
  ModelOutputDeltaPayload,
  NormalizedEvent,
  PermissionMode,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEnv,
  RuntimeSessionHandle,
  RuntimeTaskHandle,
  ToolManifest
} from '../core/types.js';
import { compileRuntimeInput } from '../core/context-compiler.js';
import { hashCanonical } from '../core/hash.js';
import { buildImplicitSourcesSnapshot } from '../core/implicit-sources.js';
import { InMemoryArtifactStore, type ArtifactStore } from '../executor/artifact-store.js';
import { storeImplicitSourcesSnapshot } from '../executor/implicit-sources.js';
import { buildModelInputPayload } from '../executor/model-input.js';

type PendingToolResolution =
  | { status: 'result'; result: unknown }
  | { status: 'denied'; reason: string };

type PendingToolCall = {
  tool_call_id: string;
  runtime_call_id: string;
  name: string;
  input_hash: string;
  attempt: number;
  promise: Promise<PendingToolResolution>;
  resolve: (value: PendingToolResolution) => void;
};

type SessionState = {
  config: Config;
  client: GeminiClient;
  initialized: boolean;
};

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

export interface GeminiCliCoreAdapterOptions {
  model?: string;
  artifactStore?: ArtifactStore;
  maxChars?: number;
  captureImplicitSources?: boolean;
  env?: Record<string, string>;
  configOverrides?: Partial<ConstructorParameters<typeof Config>[0]>;
  initializeConfig?: boolean;
  configFactory?: (params: ConstructorParameters<typeof Config>[0]) => Config;
  clientFactory?: (config: Config) => GeminiClient;
  streamFactory?: (
    client: GeminiClient,
    request: PartListUnion,
    signal: AbortSignal,
    promptId: string
  ) => AsyncGenerator<ServerGeminiStreamEvent>;
}

export class GeminiCliCoreAdapter implements RuntimeAdapter {
  readonly name = 'gemini-cli-core' as const;
  private readonly options: GeminiCliCoreAdapterOptions;
  private readonly artifactStore: ArtifactStore;
  private readonly sessions = new Map<string, SessionState>();
  private readonly runtimeCallAttempts = new Map<string, number>();

  constructor(options: GeminiCliCoreAdapterOptions = {}) {
    this.options = options;
    this.artifactStore = options.artifactStore ?? new InMemoryArtifactStore();
  }

  getCapabilities(): RuntimeCapabilities {
    return {
      supportsStreaming: true,
      supportsToolCalls: true,
      supportsParallelToolCalls: true,
      supportsStop: true,
      supportsArtifacts: true,
      supportsSessionCreate: true,
      supportsSessionResume: true,
      supportsUsageReporting: true,
      supportsNonInteractive: true,
      maxOutstandingToolCalls: 8,
      authModel: 'both',
      toolExecutionModel: 'external_mcp',
      permissionModel: 'codesdk',
      stateModel: 'local_disk',
      resumeModel: 'reconstruct',
      toolReplaySafety: 'unknown',
      mcpSupport: 'client_only',
      mcpTransports: ['stdio', 'http', 'sse'],
      cancellationModel: 'best_effort',
      supportedIsolationModes: ['in_process', 'subprocess'],
      recommendedIsolationMode: 'subprocess'
    };
  }

  async getAuthStatus(env: RuntimeEnv): Promise<AuthStatus> {
    const resolvedEnv = resolveGeminiEnv(env, this.options.env);
    const home = resolvedEnv.HOME ?? env.cwd;
    const geminiDir = path.join(home, '.gemini');
    const apiKey = resolvedEnv.GEMINI_API_KEY ?? resolvedEnv.GOOGLE_API_KEY;
    const oauthPath = path.join(geminiDir, 'oauth_creds.json');
    let hasOauth = false;
    try {
      await stat(oauthPath);
      hasOauth = true;
    } catch {
      hasOauth = false;
    }
    return {
      ok: true,
      loggedIn: Boolean(apiKey) || hasOauth,
      authModel: 'both',
      details: {
        configDir: geminiDir,
        hasApiKey: Boolean(apiKey),
        hasOauth
      }
    };
  }

  async createSession(env: RuntimeEnv, input: { title?: string; model?: string }): Promise<RuntimeSessionHandle> {
    const sessionId = randomUUID();
    await this.ensureSession(env, sessionId, input.model ?? this.options.model);
    return { sessionId };
  }

  async resumeSession(
    env: RuntimeEnv,
    handle: RuntimeSessionHandle
  ): Promise<{ ok: boolean; runtimeSessionId?: string }> {
    if (this.sessions.has(handle.sessionId)) {
      return { ok: true, runtimeSessionId: handle.runtimeSessionId };
    }
    await this.ensureSession(env, handle.sessionId, this.options.model);
    return { ok: true, runtimeSessionId: handle.runtimeSessionId };
  }

  async startTask(
    env: RuntimeEnv,
    handle: RuntimeSessionHandle,
    input: {
      taskId: string;
      messages: Array<{ role: string; content: Array<{ type: string; [key: string]: unknown }> }>;
      toolManifest?: ToolManifest;
      permissionMode?: PermissionMode;
      interactionMode?: 'interactive' | 'non_interactive';
      runtimeConfig?: Record<string, unknown>;
    }
  ): Promise<RuntimeTaskHandle> {
    const queue = new AsyncQueue<NormalizedEvent>();
    const abortController = new AbortController();
    const pendingToolCalls = new Map<string, PendingToolCall>();
    let seq = 1;
    let stopped = false;
    let currentModel = this.options.model ?? DEFAULT_GEMINI_MODEL;

    const emit = (type: NormalizedEvent['type'], payload: Record<string, unknown>) => {
      const event: NormalizedEvent = {
        schema_version: 1,
        seq: seq++,
        time: new Date().toISOString(),
        type,
        trace: { session_id: handle.sessionId, task_id: input.taskId },
        runtime: { name: this.name, model: currentModel, runtime_session_id: handle.runtimeSessionId },
        payload
      };
      queue.push(event);
    };

    const compiled = compileRuntimeInput(input.messages as any, {
      toolManifest: input.toolManifest,
      runtimeConfig: input.runtimeConfig,
      maxChars: this.options.maxChars
    });

    const implicitSnapshot = await collectGeminiImplicitSources(
      env,
      this.options.captureImplicitSources !== false,
      this.options.env
    );
    const implicitRef = storeImplicitSourcesSnapshot(this.artifactStore, implicitSnapshot);
    const modelInputPayload: ModelInputPayload = buildModelInputPayload({
      store: this.artifactStore,
      compiled,
      implicitSourcesRef: implicitRef
    });
    emit('model.input', modelInputPayload as unknown as Record<string, unknown>);

    const resolvedEnv = resolveGeminiEnv(env, this.options.env);
    const restoreEnv = applyProcessEnv(resolvedEnv);

    const session = await this.ensureSession(env, handle.sessionId, this.options.model);
    const client = session.client;

    const { history, request } = splitMessages(compiled.messages as any);
    try {
      if (typeof client.setHistory === 'function') {
        client.setHistory(history);
      }
    } catch {
      // ignore history issues for mocked clients
    }

    if (input.toolManifest?.tools?.length && typeof client.getChat === 'function') {
      try {
        const declarations = input.toolManifest.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          parameters: tool.input_schema ?? { type: 'object', properties: {} }
        }));
        client.getChat().setTools([{ functionDeclarations: declarations }]);
      } catch {
        // ignore tool setup issues for mocked clients
      }
    }

    const runLoop = async () => {
      let nextRequest: PartListUnion = request;
      let turnIndex = 0;

      while (!stopped) {
        const blockId = `block-${input.taskId}-${turnIndex}`;
        let buffer = '';
        const toolIds: string[] = [];
        const promptId = randomUUID();

        const stream = this.options.streamFactory
          ? this.options.streamFactory(client, nextRequest, abortController.signal, promptId)
          : client.sendMessageStream(nextRequest, abortController.signal, promptId);

        const iterator = stream[Symbol.asyncIterator]();
        while (true) {
          const { value, done } = await iterator.next();
          if (done) break;
          const event = value as ServerGeminiStreamEvent;
          if (event.type === GeminiEventType.Content) {
            buffer += event.value;
            const payload: ModelOutputDeltaPayload = {
              kind: 'text_delta',
              block_id: blockId,
              delta: event.value
            };
            emit('model.output.delta', payload as unknown as Record<string, unknown>);
          } else if (event.type === GeminiEventType.Citation) {
            buffer += `\n${event.value}`;
            const payload: ModelOutputDeltaPayload = {
              kind: 'text_delta',
              block_id: blockId,
              delta: `\n${event.value}`
            };
            emit('model.output.delta', payload as unknown as Record<string, unknown>);
          } else if (event.type === GeminiEventType.ToolCallRequest) {
            const attempt = (this.runtimeCallAttempts.get(event.value.callId) ?? 0) + 1;
            this.runtimeCallAttempts.set(event.value.callId, attempt);
            const toolCallId = `gemini:${event.value.callId}:${attempt}`;
            const inputHash = hashCanonical(event.value.args ?? {});
            const pending = createPendingToolCall(
              toolCallId,
              event.value.callId,
              event.value.name,
              inputHash,
              attempt
            );
            pendingToolCalls.set(toolCallId, pending);
            toolIds.push(toolCallId);
            emit('tool.call.requested', {
              tool_call_id: toolCallId,
              runtime_tool_call_id: event.value.callId,
              attempt,
              input_hash: inputHash,
              name: event.value.name,
              input: event.value.args ?? {}
            });
          } else if (event.type === GeminiEventType.ModelInfo) {
            currentModel = event.value || currentModel;
          } else if (event.type === GeminiEventType.Finished) {
            if (buffer) {
              const payload: ModelOutputCompletedPayload = {
                content: [{ type: 'text', text: buffer }]
              };
              emit('model.output.completed', payload as unknown as Record<string, unknown>);
            }
            if (event.value?.usageMetadata) {
              emit('usage.reported', {
                input_tokens: event.value.usageMetadata.promptTokenCount ?? 0,
                cached_input_tokens: event.value.usageMetadata.cachedContentTokenCount ?? 0,
                output_tokens: event.value.usageMetadata.candidatesTokenCount ?? 0
              });
            }
          } else if (event.type === GeminiEventType.Error) {
            emit('task.failed', {
              error: event.value?.error?.message ?? 'runtime error',
              retryable: false,
              raw: event.value
            });
            stopped = true;
            break;
          } else if (event.type === GeminiEventType.UserCancelled) {
            emit('task.stopped', { reason: 'cancelled' });
            stopped = true;
            break;
          }
        }

        if (stopped) break;
        if (toolIds.length === 0) break;

        const pending = toolIds
          .map((id) => pendingToolCalls.get(id))
          .filter((entry): entry is PendingToolCall => Boolean(entry));
        const results = await Promise.all(pending.map((entry) => entry.promise));
        if (stopped) break;

        for (const entry of pending) {
          pendingToolCalls.delete(entry.tool_call_id);
        }

        const responseParts: Part[] = [];
        for (let i = 0; i < pending.length; i += 1) {
          const entry = pending[i]!;
          const resolution = results[i]!;
          if (resolution.status === 'denied') {
            responseParts.push({
              functionResponse: {
                id: entry.runtime_call_id,
                name: entry.name,
                response: { error: resolution.reason }
              }
            });
            continue;
          }
          const resultValue = resolution.result;
          const normalized = typeof resultValue === 'string' ? resultValue : JSON.stringify(resultValue);
          const parts = convertToFunctionResponse(entry.name, entry.runtime_call_id, normalized, currentModel);
          responseParts.push(...parts);
        }

        if (responseParts.length === 0) {
          nextRequest = [{ text: 'No tool results available. Continue.' }];
        } else {
          nextRequest = responseParts;
        }

        turnIndex += 1;
      }
    };

    (async () => {
      try {
        await runLoop();
      } catch (error) {
        emit('task.failed', {
          error: error instanceof Error ? error.message : String(error),
          retryable: false
        });
      } finally {
        restoreEnv();
        queue.close();
      }
    })();

    return {
      events: async function* events() {
        while (true) {
          const next = await queue.shift();
          if (!next) break;
          yield next;
        }
      },
      sendToolResult: async (toolCallId: string, result: unknown) => {
        const pending = pendingToolCalls.get(toolCallId);
        if (!pending) return;
        pending.resolve({ status: 'result', result });
      },
      sendToolDenied: async (toolCallId: string, reason: string) => {
        const pending = pendingToolCalls.get(toolCallId);
        if (!pending) return;
        pending.resolve({ status: 'denied', reason });
      },
      stop: async () => {
        stopped = true;
        abortController.abort();
        for (const pending of pendingToolCalls.values()) {
          pending.resolve({ status: 'denied', reason: 'cancelled' });
        }
        queue.close();
      }
    };
  }

  private async ensureSession(
    env: RuntimeEnv,
    sessionId: string,
    model?: string
  ): Promise<SessionState> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const resolvedEnv = resolveGeminiEnv(env, this.options.env);
    const params: ConstructorParameters<typeof Config>[0] = {
      sessionId,
      targetDir: env.cwd,
      cwd: env.cwd,
      debugMode: false,
      model: model ?? this.options.model ?? DEFAULT_GEMINI_MODEL,
      usageStatisticsEnabled: false,
      interactive: false,
      coreTools: [],
      telemetry: { enabled: false },
      ...this.options.configOverrides
    };

    const config = this.options.configFactory ? this.options.configFactory(params) : new Config(params);
    const client = this.options.clientFactory ? this.options.clientFactory(config) : config.getGeminiClient();

    const session: SessionState = { config, client, initialized: false };
    this.sessions.set(sessionId, session);

    if (this.options.initializeConfig !== false) {
      const authType = await selectGeminiAuthType(env, this.options.env);
      const restoreEnv = applyProcessEnv(resolvedEnv);
      try {
        await config.refreshAuth(authType);
        if (typeof config.initialize === 'function') {
          await config.initialize();
          session.initialized = true;
        }
      } finally {
        restoreEnv();
      }
    }

    return session;
  }
}

function createPendingToolCall(
  toolCallId: string,
  runtimeCallId: string,
  name: string,
  inputHash: string,
  attempt: number
): PendingToolCall {
  let resolve: (value: PendingToolResolution) => void = () => undefined;
  const promise = new Promise<PendingToolResolution>((innerResolve) => {
    resolve = innerResolve;
  });
  return {
    tool_call_id: toolCallId,
    runtime_call_id: runtimeCallId,
    name,
    input_hash: inputHash,
    attempt,
    promise,
    resolve
  };
}

function splitMessages(messages: Array<{ role: string; content: Array<{ type: string; [key: string]: unknown }> }>): {
  history: Content[];
  request: PartListUnion;
} {
  if (messages.length === 0) {
    return { history: [], request: [{ text: '' }] };
  }

  const last = messages[messages.length - 1]!;
  const historyMessages = messages.slice(0, -1);
  const history = historyMessages.map(toGeminiContent);
  if (last.role === 'user' || last.role === 'system' || last.role === 'tool') {
    return { history, request: toGeminiParts(last.content) };
  }
  return { history: [...history, toGeminiContent(last)], request: [{ text: '' }] };
}

function toGeminiContent(message: {
  role: string;
  content: Array<{ type: string; [key: string]: unknown }>;
}): Content {
  const role = message.role === 'assistant' ? 'model' : 'user';
  return {
    role,
    parts: toGeminiParts(message.content)
  };
}

function toGeminiParts(blocks: Array<{ type: string; [key: string]: unknown }>): Part[] {
  const parts: Part[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ text: block.text });
      continue;
    }
    if (block.type === 'code' && typeof block.code === 'string') {
      const language = typeof block.language === 'string' ? block.language : '';
      const fence = language ? `\n\n\`\`\`${language}\n` : '\n\n```';
      parts.push({ text: `${fence}${block.code}\n\`\`\`\n` });
      continue;
    }
    if (block.type === 'tool_use') {
      parts.push({ text: `Tool call (${block.name ?? 'unknown'}): ${JSON.stringify(block.input ?? {})}` });
      continue;
    }
    if (block.type === 'tool_result') {
      parts.push({ text: `Tool result (${block.tool_call_id ?? 'unknown'}): ${JSON.stringify(block.result ?? {})}` });
      continue;
    }
    if (block.type === 'artifact_ref') {
      parts.push({ text: `Artifact: ${block.name ?? block.artifact_id ?? 'unknown'}` });
      continue;
    }
    parts.push({ text: JSON.stringify(block) });
  }

  if (parts.length === 0) {
    return [{ text: '' }];
  }
  return parts;
}

function resolveGeminiEnv(env: RuntimeEnv, overrides?: Record<string, string>): Record<string, string> {
  const next = { ...env.env };
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      next[key] = value;
    }
  }
  if (!next.HOME) {
    next.HOME = env.isolation?.homeDir ?? env.cwd;
  }
  return next;
}

function applyProcessEnv(env: Record<string, string>): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  return () => {
    for (const key of Object.keys(env)) {
      const prior = previous[key];
      if (prior === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prior;
      }
    }
  };
}

async function collectGeminiImplicitSources(
  env: RuntimeEnv,
  capture: boolean,
  overrides?: Record<string, string>
) {
  if (!capture) {
    return buildImplicitSourcesSnapshot({ disabled: true, reason: 'disabled' });
  }

  const resolvedEnv = resolveGeminiEnv(env, overrides);
  const home = resolvedEnv.HOME ?? env.cwd;
  const geminiDir = path.join(home, '.gemini');
  const sources: Array<{ path: string; kind: 'config'; hash?: string; disabled?: boolean; redacted?: boolean }> = [];

  sources.push(await buildFileSource(path.join(geminiDir, 'settings.json')));
  sources.push(await buildDirectorySource(path.join(geminiDir, 'policies')));
  sources.push(await buildFileSource(path.join(geminiDir, 'system.md')));
  sources.push(await buildFileSource(path.join(geminiDir, 'GEMINI.md')));
  sources.push(await buildFileSource(path.join(geminiDir, 'memory.md')));
  sources.push(await buildFileSource(path.join(env.cwd, 'GEMINI.md')));
  sources.push(await buildFileSource(path.join(env.cwd, '.gemini', 'settings.json')));
  sources.push(await buildDirectorySource(path.join(env.cwd, '.gemini', 'policies')));

  const systemSettingsPath = resolveSystemSettingsPath(resolvedEnv);
  sources.push(await buildFileSource(systemSettingsPath));
  sources.push(await buildDirectorySource(path.join(path.dirname(systemSettingsPath), 'policies')));

  const systemOverride = resolvedEnv.GEMINI_SYSTEM_MD;
  if (systemOverride) {
    const lowered = systemOverride.trim().toLowerCase();
    if (lowered !== '0' && lowered !== 'false') {
      sources.push(await buildFileSource(resolveSystemMdPath(systemOverride, home)));
    }
  }

  return buildImplicitSourcesSnapshot({
    disabled: false,
    sources,
    precedence: ['system', 'user', 'project']
  });
}

async function buildFileSource(filePath: string) {
  try {
    const data = await readFile(filePath);
    return { path: filePath, kind: 'config' as const, hash: hashCanonical(data.toString('utf8')) };
  } catch {
    return { path: filePath, kind: 'config' as const, redacted: true };
  }
}

async function buildDirectorySource(dirPath: string) {
  try {
    const entries = await readdir(dirPath);
    const hashes: Array<{ path: string; hash: string }> = [];
    for (const entry of entries.sort()) {
      const filePath = path.join(dirPath, entry);
      const stats = await stat(filePath);
      if (!stats.isFile()) continue;
      const data = await readFile(filePath);
      hashes.push({ path: entry, hash: hashCanonical(data.toString('utf8')) });
    }
    return { path: dirPath, kind: 'config' as const, hash: hashCanonical(hashes) };
  } catch {
    return { path: dirPath, kind: 'config' as const, redacted: true };
  }
}

function resolveSystemSettingsPath(env: Record<string, string>): string {
  const override = env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  if (override) return override;
  if (process.platform === 'darwin') {
    return '/Library/Application Support/GeminiCli/settings.json';
  }
  if (process.platform === 'win32') {
    return 'C:\\ProgramData\\gemini-cli\\settings.json';
  }
  return '/etc/gemini-cli/settings.json';
}

function resolveSystemMdPath(value: string, home: string): string {
  const trimmed = value.trim();
  if (!trimmed) return path.join(home, '.gemini', 'system.md');
  const lower = trimmed.toLowerCase();
  if (lower === '0' || lower === 'false') {
    return path.join(home, '.gemini', 'system.md');
  }
  if (lower === '1' || lower === 'true') {
    return path.join(home, '.gemini', 'system.md');
  }
  if (trimmed === '~' || trimmed.startsWith('~/')) {
    const suffix = trimmed === '~' ? '' : trimmed.slice(2);
    return path.resolve(path.join(home, suffix));
  }
  return path.resolve(trimmed);
}

async function selectGeminiAuthType(
  env: RuntimeEnv,
  overrides?: Record<string, string>
): Promise<AuthType> {
  const resolvedEnv = resolveGeminiEnv(env, overrides);
  if (resolvedEnv.GEMINI_API_KEY || resolvedEnv.GOOGLE_API_KEY) {
    return AuthType.USE_GEMINI;
  }
  if (resolvedEnv.GOOGLE_CLOUD_PROJECT && resolvedEnv.GOOGLE_CLOUD_LOCATION) {
    return AuthType.USE_VERTEX_AI;
  }

  const home = resolvedEnv.HOME ?? env.cwd;
  const geminiDir = path.join(home, '.gemini');
  try {
    await stat(path.join(geminiDir, 'oauth_creds.json'));
    return AuthType.LOGIN_WITH_GOOGLE;
  } catch {
    return AuthType.LOGIN_WITH_GOOGLE;
  }
}
