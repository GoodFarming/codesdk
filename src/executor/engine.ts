import type {
  ArtifactRef,
  NormalizedEvent,
  PermissionMode,
  RuntimeAdapter,
  RuntimeEnv,
  RuntimeName,
  RuntimeSessionHandle,
  RuntimeTaskHandle,
  ToolPolicyEvaluation,
  ToolPolicySnapshot,
  ToolCallCompletedPayload,
  ToolCallDeniedPayload,
  ToolOutputCompletedPayload,
  ToolOutputDeltaPayload
} from '../core/types.js';
import { InMemoryEventStore, type EventStore } from './event-store.js';
import type { ArtifactStore } from './artifact-store.js';
import { InMemoryArtifactStore } from './artifact-store.js';
import { PermissionService, SimplePolicyEngine, type PermissionOverrides } from './policy.js';
import { NoopToolExecutor, type ToolExecutionResult, type ToolExecutor } from './tool-executor.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Logger } from '../observability/logger.js';
import { noopLogger } from '../observability/logger.js';
import type { EngineMetrics, TaskStatus, ToolStatus } from '../observability/metrics.js';
import { noopMetrics } from '../observability/metrics.js';

const TOOL_RESULT_INLINE_LIMIT_BYTES = 8_000;
const TOOL_RESULT_PREVIEW_CHARS = 512;

export interface EngineOptions {
  eventStore?: EventStore;
  artifactStore?: ArtifactStore;
  toolExecutor?: ToolExecutor;
  policyEngine?: PermissionService;
  toolRegistry?: ToolRegistry;
  logger?: Logger;
  metrics?: EngineMetrics;
}

export interface StartTaskInput {
  sessionId: string;
  taskId: string;
  env: RuntimeEnv;
  runtime: RuntimeAdapter;
  runtimeSession: RuntimeSessionHandle;
  messages: unknown[];
  permissionMode?: PermissionMode;
  toolManifest?: unknown;
  runtimeConfig?: Record<string, unknown>;
  permissionOverrides?: PermissionOverrides;
}

export interface EngineTaskHandle {
  stop(reason?: string): Promise<void>;
  completion: Promise<void>;
}

export class ExecutorEngine {
  private readonly eventStore: EventStore;
  private readonly artifactStore: ArtifactStore;
  private readonly toolExecutor: ToolExecutor;
  private readonly policyEngine: PermissionService;
  private readonly toolRegistry?: ToolRegistry;
  private readonly logger: Logger;
  private readonly metrics: EngineMetrics;
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private pendingTasks = 0;
  private activeTasks = 0;
  private readonly activeSessions = new Set<string>();
  private readonly taskStartTimes = new Map<string, number>();
  private readonly taskTerminalStatus = new Map<string, { status: TaskStatus; at: number }>();
  private readonly pendingToolCalls = new Map<
    string,
    {
      sessionId: string;
      taskId: string;
      tool_call_id: string;
      attempt: number;
      input_hash: string;
      name: string;
      resolve: (decision: { decision: 'approve' } | { decision: 'deny'; reason: string }) => void;
    }
  >();

  constructor(options: EngineOptions = {}) {
    this.eventStore = options.eventStore ?? new InMemoryEventStore();
    this.artifactStore = options.artifactStore ?? new InMemoryArtifactStore();
    this.toolExecutor = options.toolExecutor ?? new NoopToolExecutor();
    this.policyEngine = options.policyEngine ?? new SimplePolicyEngine();
    this.toolRegistry = options.toolRegistry;
    this.logger = options.logger ?? noopLogger;
    this.metrics = options.metrics ?? noopMetrics;
  }

  getEventStore(): EventStore {
    return this.eventStore;
  }

  getArtifactStore(): ArtifactStore {
    return this.artifactStore;
  }

  approveToolCall(
    sessionId: string,
    toolCallId: string,
    input: { attempt: number; input_hash: string }
  ): { ok: true } | { ok: false; error: string } {
    const key = this.toolCallKey(sessionId, toolCallId);
    const pending = this.pendingToolCalls.get(key);
    if (!pending) return { ok: false, error: 'tool_call_not_pending' };
    if (pending.attempt !== input.attempt) return { ok: false, error: 'attempt_mismatch' };
    if (pending.input_hash !== input.input_hash) return { ok: false, error: 'input_hash_mismatch' };
    this.pendingToolCalls.delete(key);
    pending.resolve({ decision: 'approve' });
    return { ok: true };
  }

  denyToolCall(
    sessionId: string,
    toolCallId: string,
    input: { attempt: number; input_hash: string; reason?: string }
  ): { ok: true } | { ok: false; error: string } {
    const key = this.toolCallKey(sessionId, toolCallId);
    const pending = this.pendingToolCalls.get(key);
    if (!pending) return { ok: false, error: 'tool_call_not_pending' };
    if (pending.attempt !== input.attempt) return { ok: false, error: 'attempt_mismatch' };
    if (pending.input_hash !== input.input_hash) return { ok: false, error: 'input_hash_mismatch' };
    this.pendingToolCalls.delete(key);
    pending.resolve({ decision: 'deny', reason: input.reason ?? 'permission denied' });
    return { ok: true };
  }

  startTask(input: StartTaskInput): EngineTaskHandle {
    const existing = this.sessionLocks.get(input.sessionId) ?? Promise.resolve();
    const control = { stopRequested: false };
    const logger = this.logger.child({
      session_id: input.sessionId,
      task_id: input.taskId,
      runtime: input.runtime.name
    });

    this.pendingTasks += 1;
    this.updateGauges();

    let runtimeHandle: RuntimeTaskHandle | undefined;
    let resolveRuntimeHandle: (handle: RuntimeTaskHandle) => void;
    const runtimeHandleReady = new Promise<RuntimeTaskHandle>((resolve) => {
      resolveRuntimeHandle = resolve;
    });

    const runPromise = existing.then(() => this.runTask(input, resolveRuntimeHandle!, control));
    const lockPromise = runPromise.then(() => undefined);
    this.sessionLocks.set(input.sessionId, lockPromise);
    lockPromise
      .finally(() => {
        this.pendingTasks = Math.max(0, this.pendingTasks - 1);
        this.updateGauges();
        const current = this.sessionLocks.get(input.sessionId);
        if (current === lockPromise) {
          this.sessionLocks.delete(input.sessionId);
        }
      })
      .catch(() => undefined);

    const completion = lockPromise;

    runtimeHandleReady.then((handle) => {
      runtimeHandle = handle;
    });

    const stop = async (reason?: string) => {
      control.stopRequested = true;
      this.cancelPendingToolCallsForTask(input.sessionId, input.taskId, reason ?? 'stopped');
      const handle = runtimeHandle ?? (await runtimeHandleReady);
      await handle.stop(reason);
      logger.warn('task.stop_requested', { reason: reason ?? 'stopped' });
      this.emitTerminal(input.sessionId, input.taskId, input.runtime.name, 'task.stopped', {
        reason: reason ?? 'stopped'
      });
    };

    return { stop, completion };
  }

  private async runTask(
    input: StartTaskInput,
    onRuntimeHandle: (handle: RuntimeTaskHandle) => void,
    control: { stopRequested: boolean }
  ): Promise<RuntimeTaskHandle> {
    const logger = this.logger.child({
      session_id: input.sessionId,
      task_id: input.taskId,
      runtime: input.runtime.name
    });
    let runtimeHandle: RuntimeTaskHandle;

    try {
      runtimeHandle = await input.runtime.startTask(input.env, input.runtimeSession, {
        taskId: input.taskId,
        messages: input.messages as never,
        toolManifest: input.toolManifest as never,
        permissionMode: input.permissionMode,
        runtimeConfig: input.runtimeConfig,
        interactionMode: 'non_interactive'
      });
    } catch (error) {
      logger.error('task.start_failed', errorToContext(error));
      this.recordTerminalStatus(input.sessionId, input.taskId, 'failed');
      this.finalizeTask(input.sessionId, input.taskId, input.runtime.name);
      throw error;
    }

    onRuntimeHandle(runtimeHandle);
    this.markTaskStarted(input.sessionId, input.taskId, input.runtime.name);
    logger.info('task.started');

    let terminalEmitted = false;
    let toolProcessing: Promise<void> = Promise.resolve();
    const toolExecutionModel = input.runtime.getCapabilities().toolExecutionModel;
    const shouldExecuteTools = toolExecutionModel === 'external_mcp' || toolExecutionModel === 'hybrid';

    const enqueueTool = (event: NormalizedEvent) => {
      if (control.stopRequested) return;
      toolProcessing = toolProcessing.then(() => this.handleToolCall(input, runtimeHandle, event, control));
    };

    let streamError: unknown | null = null;

    try {
      for await (const event of runtimeHandle.events()) {
        if (terminalEmitted) break;
        const stored = this.eventStore.append(input.sessionId, event);

        if (stored.type === 'tool.call.requested' && shouldExecuteTools) {
          enqueueTool(stored);
        }

        if (stored.type === 'task.completed' || stored.type === 'task.failed' || stored.type === 'task.stopped') {
          terminalEmitted = true;
          const status = terminalTypeToStatus(stored.type);
          this.recordTerminalStatus(input.sessionId, input.taskId, status);
          logger.info('task.terminal', { status });
        }
      }
    } catch (error) {
      streamError = error;
      logger.error('task.stream_failed', errorToContext(error));
    }

    this.cancelPendingToolCallsForTask(input.sessionId, input.taskId, 'task ended');
    await toolProcessing;

    if (!terminalEmitted) {
      if (streamError) {
        const context = errorToContext(streamError);
        this.emitTerminal(input.sessionId, input.taskId, input.runtime.name, 'task.failed', {
          reason: 'runtime stream error',
          error: context.error
        });
      } else {
        this.emitTerminal(input.sessionId, input.taskId, input.runtime.name, 'task.completed', {
          reason: 'stream ended'
        });
      }
    }

    this.finalizeTask(input.sessionId, input.taskId, input.runtime.name);

    if (streamError) {
      throw streamError;
    }

    return runtimeHandle;
  }

  private emitTerminal(
    sessionId: string,
    taskId: string,
    runtimeName: RuntimeName,
    type: 'task.completed' | 'task.failed' | 'task.stopped',
    payload: Record<string, unknown>
  ) {
    const last = this.eventStore.list(sessionId).slice(-1)[0];
    if (last && isTerminalEvent(last.type)) {
      this.recordTerminalStatus(sessionId, taskId, terminalTypeToStatus(last.type));
      return;
    }
    this.eventStore.append(sessionId, {
      type,
      trace: { session_id: sessionId, task_id: taskId },
      runtime: { name: runtimeName },
      payload
    });
    this.recordTerminalStatus(sessionId, taskId, terminalTypeToStatus(type));
  }

  private async handleToolCall(
    input: StartTaskInput,
    runtimeHandle: RuntimeTaskHandle,
    event: NormalizedEvent,
    control: { stopRequested: boolean }
  ) {
    if (control.stopRequested) return;
    const payload = event.payload as Record<string, unknown>;
    const toolCallId = payload.tool_call_id as string;
    const toolName = payload.name as string;
    const attempt = payload.attempt as number;
    const inputHash = payload.input_hash as string;
    const logger = this.logger.child({
      session_id: input.sessionId,
      task_id: input.taskId,
      runtime: input.runtime.name,
      tool_call_id: toolCallId,
      tool_name: toolName
    });

    const toolPermission = this.toolRegistry?.getPermission(toolName);
    const decision = this.policyEngine.decide(input.permissionMode, toolName, {
      toolPermission,
      overrides: input.permissionOverrides
    });

    this.eventStore.append(input.sessionId, {
      type: 'tool.call.policy_evaluated',
      trace: { session_id: input.sessionId, task_id: input.taskId },
      runtime: { name: input.runtime.name },
      payload: {
        tool_call_id: toolCallId,
        attempt,
        input_hash: inputHash,
        source: 'codesdk',
        result: decision.snapshot.sources[0]?.result ?? 'allow'
      }
    });

    if (decision.decision === 'deny') {
      const denyPayload: ToolCallDeniedPayload = {
        tool_call_id: toolCallId,
        attempt,
        input_hash: inputHash,
        name: toolName,
        reason: decision.reason ?? 'approval required',
        policy_snapshot: decision.snapshot
      };
      logger.warn('tool.call.denied', { reason: denyPayload.reason });
      this.eventStore.append(input.sessionId, {
        type: 'tool.call.denied',
        trace: { session_id: input.sessionId, task_id: input.taskId },
        runtime: { name: input.runtime.name },
        payload: denyPayload
      });
      await runtimeHandle.sendToolDenied(toolCallId, denyPayload.reason);
      return;
    }

    let policySnapshot: ToolPolicySnapshot = decision.snapshot;

    if (decision.decision === 'ask') {
      const pending = await this.waitForToolCallDecision(input.sessionId, input.taskId, {
        tool_call_id: toolCallId,
        attempt,
        input_hash: inputHash,
        name: toolName
      });

      const userEval: ToolPolicyEvaluation = {
        source: 'user',
        result: pending.decision === 'deny' ? 'deny' : 'allow',
        rule: pending.decision === 'deny' ? 'user_denied' : 'user_approved'
      };

      policySnapshot = {
        permission_mode: decision.snapshot.permission_mode,
        decision: pending.decision === 'deny' ? 'deny' : 'allow',
        sources: [...decision.snapshot.sources, userEval]
      };

      this.eventStore.append(input.sessionId, {
        type: 'tool.call.policy_evaluated',
        trace: { session_id: input.sessionId, task_id: input.taskId },
        runtime: { name: input.runtime.name },
        payload: {
          tool_call_id: toolCallId,
          attempt,
          input_hash: inputHash,
          source: 'user',
          result: userEval.result
        }
      });

      if (pending.decision === 'deny') {
        const denyPayload: ToolCallDeniedPayload = {
          tool_call_id: toolCallId,
          attempt,
          input_hash: inputHash,
          name: toolName,
          reason: pending.reason,
          policy_snapshot: policySnapshot
        };
        logger.warn('tool.call.denied', { reason: denyPayload.reason });
        this.eventStore.append(input.sessionId, {
          type: 'tool.call.denied',
          trace: { session_id: input.sessionId, task_id: input.taskId },
          runtime: { name: input.runtime.name },
          payload: denyPayload
        });
        await runtimeHandle.sendToolDenied(toolCallId, denyPayload.reason);
        return;
      }
    }

    if (control.stopRequested) return;

    this.eventStore.append(input.sessionId, {
      type: 'tool.call.approved',
      trace: { session_id: input.sessionId, task_id: input.taskId },
      runtime: { name: input.runtime.name },
      payload: {
        tool_call_id: toolCallId,
        attempt,
        input_hash: inputHash
      }
    });
    logger.info('tool.call.approved');

    this.eventStore.append(input.sessionId, {
      type: 'tool.call.started',
      trace: { session_id: input.sessionId, task_id: input.taskId },
      runtime: { name: input.runtime.name },
      payload: {
        tool_call_id: toolCallId,
        attempt,
        input_hash: inputHash
      }
    });

    if (control.stopRequested) return;

    const toolInput = payload.input;
    const outputBuffers: { stdout: string; stderr: string } = { stdout: '', stderr: '' };
    const startedAt = Date.now();
    logger.info('tool.execute.started');
    let result: ToolExecutionResult;
    try {
      result = await this.toolExecutor.execute(toolName, toolInput, {
        onOutput: (stream, chunk) => {
          outputBuffers[stream] += chunk;
          const outputPayload: ToolOutputDeltaPayload = {
            tool_call_id: toolCallId,
            attempt,
            input_hash: inputHash,
            stream,
            delta: chunk
          };
          this.eventStore.append(input.sessionId, {
            type: 'tool.output.delta',
            trace: { session_id: input.sessionId, task_id: input.taskId },
            runtime: { name: input.runtime.name },
            payload: outputPayload
          });
        }
      });
    } catch (error) {
      const durationSeconds = (Date.now() - startedAt) / 1000;
      this.metrics.toolExecution(input.runtime.name, toolName, 'error', durationSeconds, 'codesdk_host');
      logger.error('tool.execute.failed', errorToContext(error));
      throw error;
    }
    const durationSeconds = (Date.now() - startedAt) / 1000;
    const toolStatus: ToolStatus = result.is_error ? 'error' : 'success';
    this.metrics.toolExecution(
      input.runtime.name,
      toolName,
      toolStatus,
      durationSeconds,
      result.executionEnv ?? 'codesdk_host'
    );
    logger.info('tool.execute.completed', {
      status: toolStatus,
      duration_seconds: durationSeconds,
      execution_env: result.executionEnv ?? 'codesdk_host'
    });
    const storedResult = maybeStoreToolResult(this.artifactStore, result.result);
    const stdout = result.stdout ?? (outputBuffers.stdout || undefined);
    const stderr = result.stderr ?? (outputBuffers.stderr || undefined);

    if (stdout || stderr) {
      const outputCompleted: ToolOutputCompletedPayload = {
        tool_call_id: toolCallId,
        attempt,
        input_hash: inputHash,
        stdout,
        stderr
      };
      this.eventStore.append(input.sessionId, {
        type: 'tool.output.completed',
        trace: { session_id: input.sessionId, task_id: input.taskId },
        runtime: { name: input.runtime.name },
        payload: outputCompleted
      });
    }

    const completedPayload: ToolCallCompletedPayload = {
      tool_call_id: toolCallId,
      attempt,
      input_hash: inputHash,
      name: toolName,
      executed_by: 'codesdk',
      execution_env: result.executionEnv ?? 'codesdk_host',
      policy_snapshot: policySnapshot,
      sandbox: result.sandbox ?? { network: false },
      result_ref: storedResult.result_ref,
      result_preview: storedResult.result_preview,
      is_error: result.is_error
    };

    this.eventStore.append(input.sessionId, {
      type: 'tool.call.completed',
      trace: { session_id: input.sessionId, task_id: input.taskId },
      runtime: { name: input.runtime.name },
      payload: completedPayload
    });

    try {
      await runtimeHandle.sendToolResult(toolCallId, result.result);
    } catch (error) {
      logger.error('tool.result.send_failed', errorToContext(error));
      throw error;
    }
  }

  private taskKey(sessionId: string, taskId: string): string {
    return `${sessionId}:${taskId}`;
  }

  private toolCallKey(sessionId: string, toolCallId: string): string {
    return `${sessionId}:${toolCallId}`;
  }

  private cancelPendingToolCallsForTask(sessionId: string, taskId: string, reason: string) {
    for (const [key, pending] of this.pendingToolCalls.entries()) {
      if (pending.sessionId !== sessionId || pending.taskId !== taskId) continue;
      this.pendingToolCalls.delete(key);
      pending.resolve({ decision: 'deny', reason });
    }
  }

  private waitForToolCallDecision(
    sessionId: string,
    taskId: string,
    identity: { tool_call_id: string; attempt: number; input_hash: string; name: string }
  ): Promise<{ decision: 'approve' } | { decision: 'deny'; reason: string }> {
    const key = this.toolCallKey(sessionId, identity.tool_call_id);
    if (this.pendingToolCalls.has(key)) {
      throw new Error(`tool call already pending: ${identity.tool_call_id}`);
    }

    let resolve!: (value: { decision: 'approve' } | { decision: 'deny'; reason: string }) => void;
    const promise = new Promise<{ decision: 'approve' } | { decision: 'deny'; reason: string }>((r) => {
      resolve = r;
    });

    this.pendingToolCalls.set(key, {
      sessionId,
      taskId,
      tool_call_id: identity.tool_call_id,
      attempt: identity.attempt,
      input_hash: identity.input_hash,
      name: identity.name,
      resolve
    });

    return promise;
  }

  private updateGauges() {
    const queued = Math.max(0, this.pendingTasks - this.activeTasks);
    this.metrics.setQueueDepth(queued);
    this.metrics.setActiveTasks(this.activeTasks);
    this.metrics.setActiveSessions(this.activeSessions.size);
  }

  private markTaskStarted(sessionId: string, taskId: string, runtimeName: RuntimeName) {
    const key = this.taskKey(sessionId, taskId);
    if (this.taskStartTimes.has(key)) return;
    this.taskStartTimes.set(key, Date.now());
    this.activeTasks += 1;
    this.activeSessions.add(sessionId);
    this.metrics.taskStarted(runtimeName);
    this.updateGauges();
  }

  private recordTerminalStatus(sessionId: string, taskId: string, status: TaskStatus) {
    const key = this.taskKey(sessionId, taskId);
    if (this.taskTerminalStatus.has(key)) return;
    this.taskTerminalStatus.set(key, { status, at: Date.now() });
  }

  private finalizeTask(sessionId: string, taskId: string, runtimeName: RuntimeName) {
    const key = this.taskKey(sessionId, taskId);
    if (!this.taskTerminalStatus.has(key)) {
      this.taskTerminalStatus.set(key, { status: 'completed', at: Date.now() });
    }

    const terminal = this.taskTerminalStatus.get(key);
    const startAt = this.taskStartTimes.get(key);
    const durationSeconds =
      startAt !== undefined && terminal ? Math.max(0, (terminal.at - startAt) / 1000) : undefined;

    if (terminal) {
      this.metrics.taskFinished(runtimeName, terminal.status, durationSeconds);
    }

    if (this.taskStartTimes.has(key)) {
      this.activeTasks = Math.max(0, this.activeTasks - 1);
      this.activeSessions.delete(sessionId);
    }

    this.taskStartTimes.delete(key);
    this.taskTerminalStatus.delete(key);
    this.updateGauges();
  }
}

function isTerminalEvent(type: NormalizedEvent['type']): boolean {
  return type === 'task.completed' || type === 'task.failed' || type === 'task.stopped';
}

function terminalTypeToStatus(type: NormalizedEvent['type']): TaskStatus {
  if (type === 'task.failed') return 'failed';
  if (type === 'task.stopped') return 'stopped';
  return 'completed';
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

function errorToContext(error: unknown): { error: string; stack?: string } {
  if (error instanceof Error) {
    return { error: error.message, stack: error.stack };
  }
  return { error: String(error) };
}
