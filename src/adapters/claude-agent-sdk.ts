import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { query, unstable_v2_createSession, unstable_v2_resumeSession } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSession
} from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type {
  AuthStatus,
  ModelInputPayload,
  ModelOutputDeltaKind,
  ModelOutputDeltaPayload,
  ModelOutputCompletedPayload,
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

type PendingToolCall = {
  resolve: (result: CallToolResult) => void;
  reject: (error: Error) => void;
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

export interface ClaudeAgentSdkAdapterOptions {
  model?: string;
  mcpServerName?: string;
  includePartialMessages?: boolean;
  settingSources?: Array<'user' | 'project' | 'local'>;
  artifactStore?: ArtifactStore;
  disableBuiltInTools?: boolean;
  persistSession?: boolean;
  queryFn?: typeof query;
  maxChars?: number;
}

export class ClaudeAgentSdkAdapter implements RuntimeAdapter {
  readonly name = 'claude-agent-sdk' as const;
  private readonly options: ClaudeAgentSdkAdapterOptions;
  private readonly artifactStore: ArtifactStore;
  private readonly sessions = new Map<string, SDKSession>();
  private readonly sessionIdByCodesdk = new Map<string, string>();

  constructor(options: ClaudeAgentSdkAdapterOptions = {}) {
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
      authModel: 'oauth_local',
      toolExecutionModel: 'external_mcp',
      permissionModel: 'codesdk',
      stateModel: 'local_disk',
      resumeModel: 'native',
      toolReplaySafety: 'unknown',
      mcpSupport: 'client_only',
      mcpTransports: ['stdio', 'sse', 'http'],
      cancellationModel: 'best_effort',
      supportedIsolationModes: ['in_process', 'subprocess'],
      recommendedIsolationMode: 'subprocess'
    };
  }

  async getAuthStatus(env: RuntimeEnv): Promise<AuthStatus> {
    const configDir = resolveClaudeEnv(env).CLAUDE_CONFIG_DIR ?? env.env.HOME ?? env.cwd;
    let hasCredentials = false;
    try {
      await stat(path.join(configDir, '.credentials.json'));
      hasCredentials = true;
    } catch {
      hasCredentials = false;
    }
    return {
      ok: true,
      loggedIn: hasCredentials,
      authModel: 'oauth_local',
      details: {
        configDir,
        hasCredentials
      }
    };
  }

  async createSession(env: RuntimeEnv, input: { title?: string; model?: string }): Promise<RuntimeSessionHandle> {
    const runtimeSessionId = randomUUID();
    const session = unstable_v2_createSession({
      model: input.model ?? this.options.model ?? 'claude-sonnet-4-5-20250929',
      env: resolveClaudeEnv(env)
    });
    this.sessions.set(runtimeSessionId, session);
    const sessionId = randomUUID();
    this.sessionIdByCodesdk.set(sessionId, runtimeSessionId);
    return { sessionId, runtimeSessionId };
  }

  async resumeSession(
    env: RuntimeEnv,
    handle: RuntimeSessionHandle
  ): Promise<{ ok: boolean; runtimeSessionId?: string }> {
    const known = handle.runtimeSessionId ?? this.sessionIdByCodesdk.get(handle.sessionId);
    if (known && this.sessions.has(known)) {
      return { ok: true, runtimeSessionId: known };
    }
    if (known) {
      const session = unstable_v2_resumeSession(known, { model: this.options.model ?? 'claude-sonnet-4-5-20250929', env: resolveClaudeEnv(env) });
      this.sessions.set(known, session);
      return { ok: true, runtimeSessionId: known };
    }
    return { ok: false };
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
    const pendingToolCalls = new Map<string, PendingToolCall>();
    const abortController = new AbortController();
    let seq = 1;
    let runtimeSessionId = handle.runtimeSessionId ?? this.sessionIdByCodesdk.get(handle.sessionId);

    const emit = (type: NormalizedEvent['type'], payload: Record<string, unknown>) => {
      const event: NormalizedEvent = {
        schema_version: 1,
        seq: seq++,
        time: new Date().toISOString(),
        type,
        trace: { session_id: handle.sessionId, task_id: input.taskId },
        runtime: { name: this.name, model: this.options.model, runtime_session_id: runtimeSessionId },
        payload
      };
      queue.push(event);
    };

    const runtimePermissionMode =
      input.toolManifest && input.toolManifest.tools.length > 0 ? 'bypassPermissions' : 'dontAsk';
    const effectiveRuntimeConfig = {
      ...input.runtimeConfig,
      model: this.options.model,
      permissionMode: runtimePermissionMode,
      settingSources: this.options.settingSources ?? [],
      tools: this.options.disableBuiltInTools === false ? undefined : []
    };

    const compiled = compileRuntimeInput(input.messages as any, {
      toolManifest: input.toolManifest,
      runtimeConfig: effectiveRuntimeConfig,
      maxChars: this.options.maxChars
    });

    const implicitSnapshot = await collectImplicitSources(env, this.options.settingSources ?? []);
    const implicitRef = storeImplicitSourcesSnapshot(this.artifactStore, implicitSnapshot);
    const modelInputPayload: ModelInputPayload = buildModelInputPayload({
      store: this.artifactStore,
      compiled,
      implicitSourcesRef: implicitRef
    });
    emit('model.input', modelInputPayload as unknown as Record<string, unknown>);

    const prompt = formatMessagesAsPrompt(compiled.messages as Array<{ role: string; content: Array<{ type: string; [key: string]: unknown }> }>);
    const mcpServerName = this.options.mcpServerName ?? 'codesdk';
    const mcpServer = this.createMcpServer(input.toolManifest, pendingToolCalls, emit);
    const normalizedServer = normalizeMcpName(mcpServerName);
    const allowedTools =
      mcpServer && input.toolManifest
        ? input.toolManifest.tools.map((tool) => `mcp__${normalizedServer}__${normalizeMcpName(tool.name)}`)
        : undefined;

    const claudeEnv = resolveClaudeEnv(env);

    const session = runtimeSessionId ? this.sessions.get(runtimeSessionId) : undefined;
    const useQuery = Boolean(mcpServer);
    const queryFn = this.options.queryFn ?? query;
    const stderr = process.env.DEBUG_CLAUDE_STDERR === '1'
      ? (data: string) => {
          console.error(`[claude stderr] ${data}`);
        }
      : undefined;

    const resumeId = this.options.persistSession ? runtimeSessionId : undefined;
    const stream = session
      ? useQuery
        ? queryFn({
            prompt,
            options: {
              abortController,
              env: claudeEnv,
              cwd: env.cwd,
              model: this.options.model,
              includePartialMessages: this.options.includePartialMessages ?? true,
              permissionMode: runtimePermissionMode,
              allowDangerouslySkipPermissions: runtimePermissionMode === 'bypassPermissions' ? true : undefined,
              settingSources: this.options.settingSources ?? [],
              persistSession: this.options.persistSession ?? false,
              tools: this.options.disableBuiltInTools === false ? undefined : [],
              mcpServers: mcpServer ? { [mcpServer.name]: mcpServer } : undefined,
              allowedTools,
              stderr,
              resume: resumeId
            }
          })
        : (async function* streamSession() {
            await session.send(prompt);
            for await (const msg of session.stream()) {
              yield msg;
            }
          })()
      : queryFn({
          prompt,
          options: {
            abortController,
            env: claudeEnv,
            cwd: env.cwd,
            model: this.options.model,
            includePartialMessages: this.options.includePartialMessages ?? true,
            permissionMode: runtimePermissionMode,
            allowDangerouslySkipPermissions: runtimePermissionMode === 'bypassPermissions' ? true : undefined,
            settingSources: this.options.settingSources ?? [],
            persistSession: this.options.persistSession ?? false,
            tools: this.options.disableBuiltInTools === false ? undefined : [],
            mcpServers: mcpServer ? { [mcpServer.name]: mcpServer } : undefined,
            allowedTools,
            stderr,
            resume: resumeId
          }
        });

    const outputAccumulator = createOutputAccumulator();

    (async () => {
      try {
        for await (const message of stream) {
          this.handleMessage(message, emit, (id) => {
            runtimeSessionId = id;
            if (handle.sessionId) {
              this.sessionIdByCodesdk.set(handle.sessionId, id);
            }
          }, outputAccumulator);
        }

        if (!outputAccumulator.seenCompleted && outputAccumulator.hasContent()) {
          emit('model.output.completed', { content: outputAccumulator.toCompletedBlocks() });
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
        pendingToolCalls.delete(toolCallId);
        pending.resolve({
          content: toContentBlocks(result),
          structuredContent: isPlainObject(result) ? (result as Record<string, unknown>) : undefined
        });
      },
      sendToolDenied: async (toolCallId: string, reason: string) => {
        const pending = pendingToolCalls.get(toolCallId);
        if (!pending) return;
        pendingToolCalls.delete(toolCallId);
        pending.resolve({
          content: [{ type: 'text', text: reason }],
          isError: true
        });
      },
      stop: async () => {
        abortController.abort();
        session?.close();
        queue.close();
      }
    };
  }

  private handleMessage(
    message: SDKMessage,
    emit: (type: NormalizedEvent['type'], payload: Record<string, unknown>) => void,
    onSessionId: (id: string) => void,
    outputAccumulator: OutputAccumulator
  ) {
    const sessionId = (message as { session_id?: string }).session_id;
    if (sessionId) onSessionId(sessionId);
    if (message.type === 'stream_event') {
      const partial = message as SDKPartialAssistantMessage;
      const event = partial.event;
      if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          const payload: ModelOutputDeltaPayload = {
            kind: 'text_delta',
            block_id: `block-${partial.uuid}-${event.index}`,
            delta: delta.text
          };
          emit('model.output.delta', payload as unknown as Record<string, unknown>);
          outputAccumulator.recordDelta(payload);
        }
        if (delta.type === 'input_json_delta') {
          const payload: ModelOutputDeltaPayload = {
            kind: 'json_delta',
            block_id: `block-${partial.uuid}-${event.index}`,
            delta: delta.partial_json ?? ''
          };
          emit('model.output.delta', payload as unknown as Record<string, unknown>);
          outputAccumulator.recordDelta(payload);
        }
      }
      return;
    }

    if (message.type === 'assistant') {
      const assistant = message as SDKAssistantMessage;
      const contentBlocks = extractAssistantContent(assistant);
      if (contentBlocks.length > 0) {
        const payload: ModelOutputCompletedPayload = { content: contentBlocks };
        emit('model.output.completed', payload as unknown as Record<string, unknown>);
        outputAccumulator.markCompleted();
      }
      return;
    }

    if (message.type === 'result') {
      const result = message as SDKResultMessage;
      emit('usage.reported', {
        usage: result.usage,
        model_usage: result.modelUsage,
        total_cost_usd: result.total_cost_usd
      });
    }
  }

  private createMcpServer(
    toolManifest: ToolManifest | undefined,
    pendingToolCalls: Map<string, PendingToolCall>,
    emit: (type: NormalizedEvent['type'], payload: Record<string, unknown>) => void
  ): { type: 'sdk'; name: string; instance: McpServer } | undefined {
    if (!toolManifest || toolManifest.tools.length === 0) return undefined;

    const server = new McpServer(
      { name: this.options.mcpServerName ?? 'codesdk', version: '0.1.0' },
      { capabilities: { tools: {} } }
    );

    const inputSchema = z.object({}).passthrough();

    for (const tool of toolManifest.tools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description ?? '',
          inputSchema
        },
        async (args: Record<string, unknown>, extra) => {
          const requestId = extra?.requestId ?? randomUUID();
          const toolCallId = `mcp:${String(requestId)}`;
          const inputHash = hashCanonical(args);
          emit('tool.call.requested', {
            tool_call_id: toolCallId,
            runtime_tool_call_id: String(requestId),
            attempt: 1,
            input_hash: inputHash,
            name: tool.name,
            input: args
          });

          const result = await new Promise<CallToolResult>((resolve, reject) => {
            pendingToolCalls.set(toolCallId, { resolve, reject });
          });

          return result;
        }
      );
    }

    return { type: 'sdk', name: this.options.mcpServerName ?? 'codesdk', instance: server };
  }
}

interface OutputAccumulator {
  seenCompleted: boolean;
  recordDelta(payload: ModelOutputDeltaPayload): void;
  markCompleted(): void;
  hasContent(): boolean;
  toCompletedBlocks(): Array<{ type: 'text'; text: string }>;
}

function createOutputAccumulator(): OutputAccumulator {
  const blocks = new Map<string, { kind: ModelOutputDeltaKind; text: string }>();
  const order: string[] = [];
  let seenCompleted = false;

  return {
    get seenCompleted() {
      return seenCompleted;
    },
    recordDelta(payload: ModelOutputDeltaPayload) {
      const existing = blocks.get(payload.block_id);
      if (!existing) {
        blocks.set(payload.block_id, { kind: payload.kind, text: payload.delta });
        order.push(payload.block_id);
        return;
      }
      existing.text += payload.delta;
    },
    markCompleted() {
      seenCompleted = true;
    },
    hasContent() {
      return blocks.size > 0;
    },
    toCompletedBlocks() {
      return order
        .map((id) => blocks.get(id))
        .filter((block): block is { kind: ModelOutputDeltaKind; text: string } => Boolean(block))
        .map((block) => ({ type: 'text' as const, text: block.text }));
    }
  };
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

function extractAssistantContent(message: SDKAssistantMessage): Array<{ type: 'text'; text: string }> {
  const content = message.message.content as Array<{ type: string; text?: string }>;
  const blocks: Array<{ type: 'text'; text: string }> = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
    }
  }
  return blocks;
}

function toContentBlocks(result: unknown): ContentBlock[] {
  if (typeof result === 'string') {
    return [{ type: 'text', text: result }];
  }
  return [{ type: 'text', text: JSON.stringify(result) }];
}

function normalizeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function resolveClaudeEnv(env: RuntimeEnv): Record<string, string> {
  const next = { ...env.env };
  if (!next.CLAUDE_CONFIG_DIR) {
    const home = env.isolation?.homeDir ?? next.HOME ?? env.cwd;
    next.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  }
  return next;
}

async function collectImplicitSources(
  env: RuntimeEnv,
  settingSources: Array<'user' | 'project' | 'local'>
) {
  const sources: Array<{ path: string; kind: 'config'; hash?: string; disabled?: boolean; redacted?: boolean }> = [];
  const configDir = resolveClaudeEnv(env).CLAUDE_CONFIG_DIR ?? path.join(env.cwd, '.claude');

  if (settingSources.includes('user')) {
    sources.push(await buildSourceEntry(path.join(configDir, 'settings.json')));
  }
  if (settingSources.includes('local')) {
    sources.push(await buildSourceEntry(path.join(configDir, 'settings.local.json')));
  }
  if (settingSources.includes('project')) {
    sources.push(await buildSourceEntry(path.join(env.cwd, '.claude', 'settings.json')));
  }

  return buildImplicitSourcesSnapshot({
    disabled: settingSources.length === 0,
    reason: settingSources.length === 0 ? 'settingSources empty' : undefined,
    sources,
    precedence: settingSources
  });
}

async function buildSourceEntry(filePath: string) {
  try {
    const data = await readFile(filePath);
    return { path: filePath, kind: 'config' as const, hash: hashCanonical(data.toString('utf8')) };
  } catch {
    return { path: filePath, kind: 'config' as const, redacted: true };
  }
}
