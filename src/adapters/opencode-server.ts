import { randomUUID } from 'node:crypto';
import type {
  Event,
  Message,
  OpencodeClient,
  ToolPart,
  ToolState
} from '@opencode-ai/sdk';
import { createOpencodeClient } from '@opencode-ai/sdk';
import type {
  ArtifactRef,
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

type ResponseWithData<T> = { data: T };

function unwrapData<T>(value: T | ResponseWithData<T> | undefined): T | undefined {
  if (!value) return undefined;
  if (typeof value === 'object' && 'data' in value) {
    return (value as ResponseWithData<T>).data;
  }
  return value as T;
}

export interface OpencodeServerAdapterOptions {
  baseUrl?: string;
  directory?: string;
  providerId?: string;
  modelId?: string;
  agent?: string;
  artifactStore?: ArtifactStore;
  maxChars?: number;
  captureImplicitSources?: boolean;
  client?: OpencodeClient;
}

export class OpencodeServerAdapter implements RuntimeAdapter {
  readonly name = 'opencode-server' as const;
  private readonly options: OpencodeServerAdapterOptions;
  private readonly artifactStore: ArtifactStore;
  private readonly sessionIdByCodesdk = new Map<string, string>();
  private readonly toolCallAttempts = new Map<string, number>();

  constructor(options: OpencodeServerAdapterOptions) {
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
      authModel: 'unknown',
      toolExecutionModel: 'runtime_internal',
      permissionModel: 'runtime',
      stateModel: 'server_side',
      resumeModel: 'native',
      toolReplaySafety: 'unknown',
      mcpSupport: 'server_only',
      mcpTransports: ['stdio', 'http', 'sse'],
      cancellationModel: 'best_effort',
      supportedIsolationModes: ['server_side'],
      recommendedIsolationMode: 'server_side'
    };
  }

  async getAuthStatus(env: RuntimeEnv): Promise<AuthStatus> {
    const client = this.getClient(env);
    try {
      await client.config.get({
        responseStyle: 'data',
        throwOnError: true,
        query: { directory: this.getDirectory(env) }
      });
      return {
        ok: true,
        loggedIn: true,
        authModel: 'unknown',
        details: { baseUrl: this.getBaseUrl(env), directory: this.getDirectory(env) }
      };
    } catch (error) {
      return {
        ok: false,
        loggedIn: false,
        authModel: 'unknown',
        details: {
          baseUrl: this.getBaseUrl(env),
          directory: this.getDirectory(env),
          error: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  async createSession(env: RuntimeEnv, _input: { title?: string; model?: string }): Promise<RuntimeSessionHandle> {
    const client = this.getClient(env);
    const sessionResponse = await client.session.create({
      responseStyle: 'data',
      throwOnError: true,
      query: { directory: this.getDirectory(env) }
    });
    const session = unwrapData(sessionResponse);
    if (!session) {
      throw new Error('Failed to create opencode session');
    }
    const sessionId = randomUUID();
    this.sessionIdByCodesdk.set(sessionId, session.id);
    return { sessionId, runtimeSessionId: session.id };
  }

  async resumeSession(
    _env: RuntimeEnv,
    handle: RuntimeSessionHandle
  ): Promise<{ ok: boolean; runtimeSessionId?: string }> {
    const runtimeSessionId = handle.runtimeSessionId ?? this.sessionIdByCodesdk.get(handle.sessionId);
    if (!runtimeSessionId) {
      return { ok: false };
    }
    this.sessionIdByCodesdk.set(handle.sessionId, runtimeSessionId);
    return { ok: true, runtimeSessionId };
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
    let seq = 1;
    let stopped = false;
    let completed = false;
    let runtimeSessionId = handle.runtimeSessionId ?? this.sessionIdByCodesdk.get(handle.sessionId);
    const directory = this.getDirectory(env);
    const client = this.getClient(env);

    if (!runtimeSessionId) {
      const sessionResponse = await client.session.create({
        responseStyle: 'data',
        throwOnError: true,
        query: { directory }
      });
      const session = unwrapData(sessionResponse);
      if (!session) {
        throw new Error('Failed to create opencode session');
      }
      runtimeSessionId = session.id;
      this.sessionIdByCodesdk.set(handle.sessionId, runtimeSessionId);
    }
    if (!runtimeSessionId) {
      throw new Error('Missing opencode session id');
    }
    const sessionId = runtimeSessionId;

    const emit = (type: NormalizedEvent['type'], payload: Record<string, unknown>) => {
      const event: NormalizedEvent = {
        schema_version: 1,
        seq: seq++,
        time: new Date().toISOString(),
        type,
        trace: { session_id: handle.sessionId, task_id: input.taskId },
        runtime: { name: this.name, runtime_session_id: sessionId },
        payload
      };
      queue.push(event);
    };

    const compiled = compileRuntimeInput(input.messages as any, {
      toolManifest: input.toolManifest,
      runtimeConfig: input.runtimeConfig,
      maxChars: this.options.maxChars
    });

    const implicitSnapshot = await collectOpencodeImplicitSources(
      client,
      directory,
      this.options.captureImplicitSources !== false
    );
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

    const streamResult = await client.event.subscribe({
      responseStyle: 'data',
      throwOnError: true,
      query: { directory }
    });
    const stream = streamResult.stream;

    const textParts = new Map<string, string>();
    const messagePartOrder = new Map<string, string[]>();
    const toolCalls = new Map<string, ToolIdentity>();
    const toolStatuses = new Map<string, 'requested' | 'running' | 'completed'>();

    const handleTextPart = (part: { id: string; messageID: string; text: string }, delta?: string) => {
      const previous = textParts.get(part.id) ?? '';
      let deltaText = '';
      let nextText = previous;

      if (typeof delta === 'string') {
        deltaText = delta;
        nextText = previous + delta;
      } else if (typeof part.text === 'string') {
        if (part.text.startsWith(previous)) {
          deltaText = part.text.slice(previous.length);
        } else {
          deltaText = part.text;
        }
        nextText = part.text;
      }

      if (deltaText) {
        const payload: ModelOutputDeltaPayload = {
          kind: 'text_delta',
          block_id: part.id,
          delta: deltaText
        };
        emit('model.output.delta', payload as unknown as Record<string, unknown>);
      }

      textParts.set(part.id, nextText);
      const order = messagePartOrder.get(part.messageID) ?? [];
      if (!order.includes(part.id)) {
        order.push(part.id);
        messagePartOrder.set(part.messageID, order);
      }
    };

    const buildMessageText = (messageId: string) => {
      const order = messagePartOrder.get(messageId) ?? [];
      return order.map((id) => textParts.get(id) ?? '').join('');
    };

    const ensureToolIdentity = (part: ToolPart): ToolIdentity => {
      const existing = toolCalls.get(part.callID);
      if (existing && toolStatuses.get(part.callID) !== 'completed') {
        return existing;
      }
      const attempt = (this.toolCallAttempts.get(part.callID) ?? 0) + 1;
      this.toolCallAttempts.set(part.callID, attempt);
      const inputHash = hashCanonical(part.state.input ?? {});
      const toolCallId = `opencode:${part.callID}:${attempt}`;
      const identity: ToolIdentity = {
        tool_call_id: toolCallId,
        runtime_tool_call_id: part.callID,
        attempt,
        input_hash: inputHash,
        name: part.tool
      };
      toolCalls.set(part.callID, identity);
      toolStatuses.set(part.callID, 'requested');
      emit('tool.call.requested', {
        tool_call_id: identity.tool_call_id,
        runtime_tool_call_id: identity.runtime_tool_call_id,
        attempt: identity.attempt,
        input_hash: identity.input_hash,
        name: identity.name,
        input: part.state.input ?? {}
      });
      return identity;
    };

    const emitToolApproved = (identity: ToolIdentity) => {
      emit('tool.call.approved', {
        tool_call_id: identity.tool_call_id,
        attempt: identity.attempt,
        input_hash: identity.input_hash
      });
      emit('tool.call.started', {
        tool_call_id: identity.tool_call_id,
        attempt: identity.attempt,
        input_hash: identity.input_hash
      });
    };

    const buildPolicySnapshot = (state: ToolState): ToolPolicySnapshot => {
      const denied = state.status === 'error';
      return {
        decision: denied ? 'deny' : 'allow',
        sources: [
          {
            source: 'runtime',
            result: denied ? 'deny' : 'allow',
            rule: 'runtime_internal'
          }
        ]
      };
    };

    const emitToolCompleted = (identity: ToolIdentity, state: ToolState) => {
      if (state.status !== 'completed' && state.status !== 'error') return;
      const result =
        state.status === 'completed'
          ? { output: state.output, metadata: state.metadata, attachments: state.attachments }
          : { error: state.error, metadata: state.metadata };

      const stored = maybeStoreToolResult(this.artifactStore, result);
      emit('tool.call.completed', {
        tool_call_id: identity.tool_call_id,
        runtime_tool_call_id: identity.runtime_tool_call_id,
        attempt: identity.attempt,
        input_hash: identity.input_hash,
        name: identity.name,
        executed_by: 'runtime',
        execution_env: 'runtime_internal',
        policy_snapshot: buildPolicySnapshot(state),
        result_ref: stored.result_ref,
        result_preview: stored.result_preview,
        is_error: state.status === 'error'
      });
    };

    const handleToolPart = (part: ToolPart) => {
      const identity = ensureToolIdentity(part);
      const status = toolStatuses.get(part.callID);
      if (part.state.status === 'running' && status !== 'running') {
        emitToolApproved(identity);
        toolStatuses.set(part.callID, 'running');
      }
      if ((part.state.status === 'completed' || part.state.status === 'error') && status !== 'completed') {
        emitToolCompleted(identity, part.state);
        toolStatuses.set(part.callID, 'completed');
      }
    };

    (async () => {
      try {
        await client.session.promptAsync({
          throwOnError: true,
          path: { id: sessionId },
          query: { directory },
          body: {
            parts: [{ type: 'text', text: prompt }],
            model:
              this.options.providerId && this.options.modelId
                ? { providerID: this.options.providerId, modelID: this.options.modelId }
                : undefined,
            agent: this.options.agent
          }
        });

        for await (const globalEvent of stream) {
          if (stopped) break;
          const payload = globalEvent as Event;

          if (payload.type === 'message.part.updated') {
            const part = payload.properties.part;
            if (part.sessionID !== sessionId) continue;
            if (part.type === 'text') {
              handleTextPart(part, payload.properties.delta);
            } else if (part.type === 'tool') {
              handleToolPart(part);
            }
          } else if (payload.type === 'message.updated') {
            const info = payload.properties.info as Message;
            if (info.sessionID !== sessionId) continue;
            if (info.role === 'assistant' && info.time.completed && !completed) {
              const content = buildMessageText(info.id);
              if (content) {
                const payloadOut: ModelOutputCompletedPayload = {
                  content: [{ type: 'text', text: content }]
                };
                emit('model.output.completed', payloadOut as unknown as Record<string, unknown>);
              }
              emit('usage.reported', {
                input_tokens: info.tokens.input,
                output_tokens: info.tokens.output,
                cached_input_tokens: info.tokens.cache.read
              });
              if (info.error) {
                emit('task.failed', {
                  error: info.error.name ?? 'runtime_error',
                  retryable: false,
                  raw: info.error
                });
              }
              completed = true;
              break;
            }
          } else if (payload.type === 'session.error') {
            if (payload.properties.sessionID && payload.properties.sessionID !== sessionId) continue;
            emit('task.failed', {
              error: payload.properties.error?.name ?? 'runtime_error',
              retryable: false,
              raw: payload.properties.error
            });
            completed = true;
            break;
          }
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
      sendToolResult: async () => {
        // runtime-internal tool execution; no-op
      },
      sendToolDenied: async () => {
        // runtime-internal tool execution; no-op
      },
      stop: async () => {
        stopped = true;
        try {
          await client.session.abort({
            throwOnError: false,
            path: { id: sessionId },
            query: { directory }
          });
        } catch {
          // ignore
        }
        queue.close();
        if (stream && typeof stream.return === 'function') {
          await stream.return(undefined as never);
        }
      }
    };
  }

  private getBaseUrl(env: RuntimeEnv): string | undefined {
    return this.options.baseUrl ?? env.env.OPENCODE_BASE_URL ?? env.env.OPENCODE_URL;
  }

  private getDirectory(env: RuntimeEnv): string {
    return this.options.directory ?? env.cwd;
  }

  private getClient(env: RuntimeEnv): OpencodeClient {
    if (this.options.client) return this.options.client;
    const baseUrl = this.getBaseUrl(env);
    if (!baseUrl) {
      throw new Error('Opencode baseUrl is required');
    }
    return createOpencodeClient({ baseUrl, directory: this.getDirectory(env) });
  }
}

async function collectOpencodeImplicitSources(
  client: OpencodeClient,
  directory: string,
  capture: boolean
) {
  if (!capture) {
    return buildImplicitSourcesSnapshot({ disabled: true, reason: 'disabled' });
  }
  const sources: Array<{ path: string; kind: 'config'; hash?: string; disabled?: boolean; redacted?: boolean }> = [];

  try {
    const configResponse = await client.config.get({
      responseStyle: 'data',
      throwOnError: true,
      query: { directory }
    });
    const config = unwrapData(configResponse);
    if (config) {
      sources.push({ path: 'opencode:config', kind: 'config', hash: hashCanonical(config) });
    } else {
      sources.push({ path: 'opencode:config', kind: 'config', redacted: true });
    }
  } catch {
    sources.push({ path: 'opencode:config', kind: 'config', redacted: true });
  }

  try {
    const mcpResponse = await client.mcp.status({
      responseStyle: 'data',
      throwOnError: true,
      query: { directory }
    });
    const mcp = unwrapData(mcpResponse);
    if (mcp) {
      sources.push({ path: 'opencode:mcp', kind: 'config', hash: hashCanonical(mcp) });
    } else {
      sources.push({ path: 'opencode:mcp', kind: 'config', redacted: true });
    }
  } catch {
    sources.push({ path: 'opencode:mcp', kind: 'config', redacted: true });
  }

  return buildImplicitSourcesSnapshot({
    disabled: false,
    sources,
    precedence: ['server']
  });
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
