import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import {
  Codex,
  type ApprovalMode,
  type CodexOptions,
  type ModelReasoningEffort,
  type SandboxMode,
  type Thread,
  type ThreadEvent,
  type ThreadOptions
} from '@openai/codex-sdk';
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
  ArtifactRef,
  ToolManifest,
  ToolPolicySnapshot
} from '../core/types.js';
import { compileRuntimeInput } from '../core/context-compiler.js';
import { hashCanonical } from '../core/hash.js';
import { buildImplicitSourcesSnapshot } from '../core/implicit-sources.js';
import { InMemoryArtifactStore, type ArtifactStore } from '../executor/artifact-store.js';
import { storeImplicitSourcesSnapshot } from '../executor/implicit-sources.js';
import { buildModelInputPayload } from '../executor/model-input.js';

const TOOL_RESULT_INLINE_LIMIT_BYTES = 8_000;
const TOOL_RESULT_PREVIEW_CHARS = 512;

type ToolIdentity = {
  tool_call_id: string;
  runtime_tool_call_id: string;
  attempt: number;
  input_hash: string;
  name: string;
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

export interface CodexSdkAdapterOptions {
  model?: string;
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalMode;
  networkAccessEnabled?: boolean;
  webSearchEnabled?: boolean;
  skipGitRepoCheck?: boolean;
  workingDirectory?: string;
  additionalDirectories?: string[];
  modelReasoningEffort?: ModelReasoningEffort;
  codexPathOverride?: string;
  baseUrl?: string;
  apiKey?: string;
  env?: Record<string, string>;
  maxChars?: number;
  artifactStore?: ArtifactStore;
  captureImplicitSources?: boolean;
  codexFactory?: (options: CodexOptions) => Codex;
}

export class CodexSdkAdapter implements RuntimeAdapter {
  readonly name = 'codex-sdk' as const;
  private readonly options: CodexSdkAdapterOptions;
  private readonly artifactStore: ArtifactStore;
  private readonly threads = new Map<string, Thread>();
  private readonly threadIdBySession = new Map<string, string>();
  private readonly codexFactory: (options: CodexOptions) => Codex;

  constructor(options: CodexSdkAdapterOptions = {}) {
    this.options = options;
    this.artifactStore = options.artifactStore ?? new InMemoryArtifactStore();
    this.codexFactory = options.codexFactory ?? ((opts) => new Codex(opts));
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
      toolExecutionModel: 'runtime_internal',
      permissionModel: 'runtime',
      stateModel: 'local_disk',
      resumeModel: 'native',
      toolReplaySafety: 'unknown',
      mcpSupport: 'client_only',
      mcpTransports: ['stdio', 'http', 'sse'],
      cancellationModel: 'best_effort',
      supportedIsolationModes: ['in_process', 'subprocess'],
      recommendedIsolationMode: 'subprocess'
    };
  }

  async getAuthStatus(env: RuntimeEnv): Promise<AuthStatus> {
    const resolvedEnv = resolveCodexEnv(env);
    const apiKey = resolvedEnv.CODEX_API_KEY ?? resolvedEnv.OPENAI_API_KEY;
    let hasOauth = false;
    if (resolvedEnv.CODEX_HOME) {
      try {
        await stat(path.join(resolvedEnv.CODEX_HOME, 'auth.json'));
        hasOauth = true;
      } catch {
        hasOauth = false;
      }
    }
    return {
      ok: true,
      loggedIn: Boolean(apiKey) || hasOauth,
      authModel: 'both',
      details: {
        configDir: resolvedEnv.CODEX_HOME,
        hasApiKey: Boolean(apiKey),
        hasOauth
      }
    };
  }

  async createSession(env: RuntimeEnv, input: { title?: string; model?: string }): Promise<RuntimeSessionHandle> {
    const sessionId = randomUUID();
    const threadOptions = this.buildThreadOptions(env, { model: input.model ?? this.options.model });
    const thread = this.createCodexClient(env).startThread(threadOptions);
    this.threads.set(sessionId, thread);
    return { sessionId };
  }

  async resumeSession(
    env: RuntimeEnv,
    handle: RuntimeSessionHandle
  ): Promise<{ ok: boolean; runtimeSessionId?: string }> {
    const known = handle.runtimeSessionId ?? this.threadIdBySession.get(handle.sessionId);
    if (!known) return { ok: false };
    const thread = this.createCodexClient(env).resumeThread(known, this.buildThreadOptions(env, {}));
    this.threads.set(handle.sessionId, thread);
    this.threadIdBySession.set(handle.sessionId, known);
    return { ok: true, runtimeSessionId: known };
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
    let seq = 1;
    let runtimeThreadId = handle.runtimeSessionId ?? this.threadIdBySession.get(handle.sessionId);

    const emit = (type: NormalizedEvent['type'], payload: Record<string, unknown>) => {
      const event: NormalizedEvent = {
        schema_version: 1,
        seq: seq++,
        time: new Date().toISOString(),
        type,
        trace: { session_id: handle.sessionId, task_id: input.taskId },
        runtime: { name: this.name, model: this.options.model, runtime_session_id: runtimeThreadId },
        payload
      };
      queue.push(event);
    };

    const effectiveRuntimeConfig = this.buildRuntimeConfig(env, input.runtimeConfig);
    const compiledRuntimeConfig = canonicalizeRuntimeConfigForModelInput(effectiveRuntimeConfig, env);
    const compiled = compileRuntimeInput(input.messages as any, {
      toolManifest: input.toolManifest,
      runtimeConfig: compiledRuntimeConfig,
      maxChars: this.options.maxChars
    });

    const implicitSnapshot = this.options.captureImplicitSources === false
      ? buildImplicitSourcesSnapshot({ disabled: true, reason: 'capture disabled' })
      : await collectCodexImplicitSources(env);
    const implicitRef = storeImplicitSourcesSnapshot(this.artifactStore, implicitSnapshot);
    const modelInputPayload: ModelInputPayload = buildModelInputPayload({
      store: this.artifactStore,
      compiled,
      implicitSourcesRef: implicitRef
    });
    emit('model.input', modelInputPayload as unknown as Record<string, unknown>);

    const prompt = formatMessagesAsPrompt(
      compiled.messages as Array<{ role: string; content: Array<{ type: string; [key: string]: unknown }> }>
    );

    const thread = this.resolveThread(env, handle, effectiveRuntimeConfig);
    let streamed: { events: AsyncGenerator<ThreadEvent> } | undefined;
    try {
      streamed = await thread.runStreamed(prompt, { signal: abortController.signal });
    } catch (error) {
      emit('task.failed', {
        error: error instanceof Error ? error.message : String(error),
        retryable: false
      });
      queue.close();
    }

    const toolIdentities = new Map<string, ToolIdentity>();
    const agentBuffers = new Map<string, string>();

    if (streamed) {
      (async () => {
        try {
          for await (const event of streamed.events) {
            this.handleThreadEvent(event, {
              emit,
              toolIdentities,
              agentBuffers,
              onThreadId: (threadId) => {
                runtimeThreadId = threadId;
                this.threadIdBySession.set(handle.sessionId, threadId);
              }
            });
          }
        } catch (error) {
          emit('task.failed', {
            error: error instanceof Error ? error.message : String(error),
            retryable: false
          });
        } finally {
          queue.close();
        }
      })();
    }

    return {
      events: async function* events() {
        while (true) {
          const next = await queue.shift();
          if (!next) break;
          yield next;
        }
      },
      sendToolResult: async () => {},
      sendToolDenied: async () => {},
      stop: async () => {
        abortController.abort();
        queue.close();
      }
    };
  }

  private createCodexClient(env: RuntimeEnv): Codex {
    const resolvedEnv = resolveCodexEnv(env);
    const mergedEnv = this.options.env ? { ...resolvedEnv, ...this.options.env } : resolvedEnv;
    return this.codexFactory({
      codexPathOverride: this.options.codexPathOverride,
      baseUrl: this.options.baseUrl,
      apiKey: this.options.apiKey,
      env: mergedEnv
    });
  }

  private resolveThread(
    env: RuntimeEnv,
    handle: RuntimeSessionHandle,
    runtimeConfig: Record<string, unknown>
  ): Thread {
    if (handle.runtimeSessionId) {
      return this.createCodexClient(env).resumeThread(handle.runtimeSessionId, this.buildThreadOptions(env, runtimeConfig));
    }

    const existing = this.threads.get(handle.sessionId);
    if (existing) return existing;

    const known = this.threadIdBySession.get(handle.sessionId);
    if (known) {
      return this.createCodexClient(env).resumeThread(known, this.buildThreadOptions(env, runtimeConfig));
    }

    const thread = this.createCodexClient(env).startThread(this.buildThreadOptions(env, runtimeConfig));
    this.threads.set(handle.sessionId, thread);
    return thread;
  }

  private buildThreadOptions(env: RuntimeEnv, runtimeConfig: Record<string, unknown>): ThreadOptions {
    return {
      model: runtimeConfig.model as string | undefined,
      sandboxMode: runtimeConfig.sandboxMode as SandboxMode | undefined,
      workingDirectory: (runtimeConfig.workingDirectory as string | undefined) ?? this.options.workingDirectory ?? env.cwd,
      skipGitRepoCheck: runtimeConfig.skipGitRepoCheck as boolean | undefined,
      modelReasoningEffort: runtimeConfig.modelReasoningEffort as ModelReasoningEffort | undefined,
      networkAccessEnabled: runtimeConfig.networkAccessEnabled as boolean | undefined,
      webSearchEnabled: runtimeConfig.webSearchEnabled as boolean | undefined,
      approvalPolicy: runtimeConfig.approvalPolicy as ApprovalMode | undefined,
      additionalDirectories: runtimeConfig.additionalDirectories as string[] | undefined
    };
  }

  private buildRuntimeConfig(env: RuntimeEnv, runtimeConfig: Record<string, unknown> | undefined): Record<string, unknown> {
    return {
      ...runtimeConfig,
      model: runtimeConfig?.model ?? this.options.model,
      sandboxMode: runtimeConfig?.sandboxMode ?? this.options.sandboxMode ?? 'read-only',
      approvalPolicy: runtimeConfig?.approvalPolicy ?? this.options.approvalPolicy ?? 'never',
      networkAccessEnabled: runtimeConfig?.networkAccessEnabled ?? this.options.networkAccessEnabled ?? false,
      webSearchEnabled: runtimeConfig?.webSearchEnabled ?? this.options.webSearchEnabled ?? false,
      workingDirectory: runtimeConfig?.workingDirectory ?? this.options.workingDirectory ?? env.cwd,
      skipGitRepoCheck: runtimeConfig?.skipGitRepoCheck ?? this.options.skipGitRepoCheck ?? true,
      additionalDirectories: runtimeConfig?.additionalDirectories ?? this.options.additionalDirectories,
      modelReasoningEffort: runtimeConfig?.modelReasoningEffort ?? this.options.modelReasoningEffort
    };
  }

  private handleThreadEvent(
    event: ThreadEvent,
    options: {
      emit: (type: NormalizedEvent['type'], payload: Record<string, unknown>) => void;
      toolIdentities: Map<string, ToolIdentity>;
      agentBuffers: Map<string, string>;
      onThreadId: (threadId: string) => void;
    }
  ) {
    const { emit, toolIdentities, agentBuffers, onThreadId } = options;

    if (event.type === 'thread.started') {
      onThreadId(event.thread_id);
      return;
    }

    if (event.type === 'turn.completed') {
      emit('usage.reported', { usage: event.usage });
      return;
    }

    if (event.type === 'turn.failed') {
      emit('task.failed', { error: event.error.message, retryable: false });
      return;
    }

    if (event.type === 'error') {
      emit('task.failed', { error: event.message, retryable: false });
      return;
    }

    if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
      const item = event.item;
      if (item.type === 'agent_message') {
        if (event.type !== 'item.completed') {
          const previous = agentBuffers.get(item.id) ?? '';
          const text = item.text ?? '';
          const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
          if (delta.length > 0) {
            const payload: ModelOutputDeltaPayload = {
              kind: 'text_delta',
              block_id: `agent-${item.id}`,
              delta
            };
            emit('model.output.delta', payload as unknown as Record<string, unknown>);
          }
          agentBuffers.set(item.id, text);
        } else {
          const payload: ModelOutputCompletedPayload = {
            content: [{ type: 'text', text: item.text }]
          };
          emit('model.output.completed', payload as unknown as Record<string, unknown>);
        }
        return;
      }

      if (item.type === 'mcp_tool_call') {
        const toolName = formatToolName(item.server, item.tool);
        const identity = getOrCreateToolIdentity(toolIdentities, item.id, toolName, item.arguments, emit);
        if (event.type === 'item.completed') {
          const result = item.result?.structured_content ?? item.result?.content ?? item.result;
          const stored = maybeStoreToolResult(this.artifactStore, result);
          const errorMessage = item.error?.message;
          const isError = item.status === 'failed' || Boolean(errorMessage);
          const payload = {
            ...identity,
            name: toolName,
            executed_by: 'runtime',
            execution_env: 'runtime_internal',
            policy_snapshot: buildRuntimePolicySnapshot(),
            result_ref: stored.result_ref,
            result_preview: isError ? errorMessage ?? stored.result_preview : stored.result_preview,
            is_error: isError
          };
          emit('tool.call.completed', payload);
        }
        return;
      }

      if (item.type === 'command_execution') {
        const toolName = 'runtime.command_execution';
        const identity = getOrCreateToolIdentity(
          toolIdentities,
          item.id,
          toolName,
          { command: item.command },
          emit
        );
        if (event.type === 'item.completed') {
          const result = { output: item.aggregated_output, exit_code: item.exit_code };
          const stored = maybeStoreToolResult(this.artifactStore, result);
          const isError = item.status === 'failed' || (item.exit_code !== undefined && item.exit_code !== 0);
          emit('tool.call.completed', {
            ...identity,
            name: toolName,
            executed_by: 'runtime',
            execution_env: 'runtime_internal',
            policy_snapshot: buildRuntimePolicySnapshot(),
            result_ref: stored.result_ref,
            result_preview: stored.result_preview,
            is_error: isError
          });
        }
        return;
      }
    }
  }
}

function resolveCodexEnv(env: RuntimeEnv): Record<string, string> {
  const next = { ...env.env };
  const home = env.isolation?.homeDir ?? next.HOME ?? env.cwd;
  if (!next.HOME) next.HOME = home;
  if (!next.CODEX_HOME) {
    next.CODEX_HOME = path.join(home, '.codex');
  }
  return next;
}

function canonicalizeRuntimeConfigForModelInput(
  runtimeConfig: Record<string, unknown>,
  env: RuntimeEnv
): Record<string, unknown> {
  const next = { ...runtimeConfig };

  if (typeof next.workingDirectory === 'string' && next.workingDirectory === env.cwd) {
    next.workingDirectory = '<CWD>';
  }

  if (Array.isArray(next.additionalDirectories)) {
    next.additionalDirectories = next.additionalDirectories.map((entry) => {
      if (typeof entry === 'string' && entry === env.cwd) return '<CWD>';
      return entry;
    });
  }

  return next;
}

async function collectCodexImplicitSources(env: RuntimeEnv) {
  const resolvedEnv = resolveCodexEnv(env);
  const codexHome = resolvedEnv.CODEX_HOME ?? path.join(env.cwd, '.codex');
  const sources: Array<{ path: string; kind: 'config'; hash?: string; disabled?: boolean; redacted?: boolean }> = [];
  sources.push(await buildFileSource(path.join(codexHome, 'config.toml')));
  sources.push(await buildDirectorySource(path.join(codexHome, 'rules')));
  sources.push(await buildFileSource(path.join(env.cwd, 'AGENTS.md')));
  return buildImplicitSourcesSnapshot({
    disabled: false,
    sources,
    precedence: ['CODEX_HOME', 'project']
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

function formatMessagesAsPrompt(
  messages: Array<{ role: string; content: Array<{ type: string; [key: string]: unknown }> }>
): string {
  const parts: string[] = [];
  for (const message of messages) {
    const blocks = message.content
      .map((block) => {
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        if (block.type === 'code' && typeof block.code === 'string') return block.code;
        return JSON.stringify(block);
      })
      .join('\n');
    parts.push(`${message.role.toUpperCase()}: ${blocks}`);
  }
  return parts.join('\n\n');
}

function formatToolName(server: string, tool: string): string {
  if (!server) return tool;
  return `${server}.${tool}`;
}

function getOrCreateToolIdentity(
  map: Map<string, ToolIdentity>,
  runtimeId: string,
  name: string,
  input: unknown,
  emit: (type: NormalizedEvent['type'], payload: Record<string, unknown>) => void
): ToolIdentity {
  const existing = map.get(runtimeId);
  if (existing) return existing;
  const tool_call_id = `codex:${runtimeId}`;
  const identity: ToolIdentity = {
    tool_call_id,
    runtime_tool_call_id: runtimeId,
    attempt: 1,
    input_hash: hashCanonical(input),
    name
  };
  emit('tool.call.requested', {
    tool_call_id: identity.tool_call_id,
    runtime_tool_call_id: identity.runtime_tool_call_id,
    attempt: identity.attempt,
    input_hash: identity.input_hash,
    name: identity.name,
    input
  });
  emit('tool.call.started', {
    tool_call_id: identity.tool_call_id,
    attempt: identity.attempt,
    input_hash: identity.input_hash
  });
  map.set(runtimeId, identity);
  return identity;
}

function buildRuntimePolicySnapshot(): ToolPolicySnapshot {
  return {
    decision: 'allow',
    sources: [
      {
        source: 'runtime',
        result: 'allow',
        rule: 'runtime_internal'
      }
    ]
  };
}

function maybeStoreToolResult(
  store: ArtifactStore,
  result: unknown
): { result_preview: unknown; result_ref?: ArtifactRef } {
  const serialized = serializeToolResult(result);
  if (serialized.bytes <= TOOL_RESULT_INLINE_LIMIT_BYTES) {
    return { result_preview: result };
  }

  const ref = store.put(serialized.data, {
    contentType: serialized.contentType,
    name: serialized.name
  });

  const preview = serialized.text.slice(0, TOOL_RESULT_PREVIEW_CHARS);
  return { result_preview: preview, result_ref: ref };
}

function serializeToolResult(result: unknown): {
  text: string;
  data: Uint8Array;
  bytes: number;
  contentType: string;
  name: string;
} {
  if (typeof result === 'string') {
    const data = Buffer.from(result, 'utf8');
    return {
      text: result,
      data,
      bytes: data.byteLength,
      contentType: 'text/plain',
      name: 'tool_result.txt'
    };
  }

  let text = '';
  try {
    text = JSON.stringify(result, null, 2);
  } catch (error) {
    text = JSON.stringify({ error: 'unserializable tool result', detail: String(error) });
  }

  const data = Buffer.from(text, 'utf8');
  return {
    text,
    data,
    bytes: data.byteLength,
    contentType: 'application/json',
    name: 'tool_result.json'
  };
}
