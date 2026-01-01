# Runtime Adapter Interface (v1)

CodeSDK is not abstracting “model providers”; it is abstracting **agent runtimes** (each with its own event loop, tool system, policy model, and persistence assumptions).

This interface is intentionally capability-driven and “honest” about what CodeSDK can control.

Key design requirement: the runtime integration must be **duplex** (events out, commands/results back in). An `AsyncGenerator<events>` alone is not sufficient once you add tool calls, denials, and stop/cancel.

## Core types

```ts
export type RuntimeName = 'claude-agent-sdk' | 'codex-sdk' | 'gemini-cli-core' | 'opencode-server';

export type AuthModel = 'oauth_local' | 'api_key' | 'both' | 'unknown';
export type ToolExecutionModel = 'external_mcp' | 'runtime_internal' | 'hybrid';
export type PermissionModel = 'codesdk' | 'runtime' | 'hybrid';
export type RuntimeStateModel = 'in_process' | 'local_disk' | 'server_side' | 'hybrid' | 'unknown';
export type ResumeModel = 'native' | 'reconstruct' | 'none';
export type ToolReplaySafety = 'safe_replay' | 'requires_reapproval' | 'unknown';

export type McpSupport = 'none' | 'client_only' | 'server_only' | 'both';
export type McpTransport = 'stdio' | 'sse' | 'http';

export type CancellationModel = 'best_effort' | 'guaranteed' | 'unknown';

/**
 * How CodeSDK should host/isolate this runtime for correctness & tenant safety.
 * - in_process: same Node process (fastest, least isolated)
 * - subprocess: separate process with its own env/HOME/XDG (recommended for multi-tenant with local OAuth state)
 * - server_side: CodeSDK talks to an external runtime server (e.g., OpenCode)
 */
export type RuntimeIsolationMode = 'in_process' | 'subprocess' | 'server_side';

export type PermissionMode = 'ask' | 'auto' | 'yolo';

export type InteractionMode = 'interactive' | 'non_interactive';

export interface RuntimeCapabilities {
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  supportsParallelToolCalls: boolean;
  supportsStop: boolean;
  supportsArtifacts: boolean;
  supportsSessionCreate: boolean;
  supportsSessionResume: boolean;
  supportsUsageReporting: boolean;
  supportsNonInteractive: boolean;
  /** Max number of simultaneously outstanding tool calls per task (>= 1). */
  maxOutstandingToolCalls?: number;

  authModel: AuthModel;
  toolExecutionModel: ToolExecutionModel;
  permissionModel: PermissionModel;
  stateModel: RuntimeStateModel;
  resumeModel: ResumeModel;
  toolReplaySafety: ToolReplaySafety;

  mcpSupport: McpSupport;
  mcpTransports?: McpTransport[];

  cancellationModel: CancellationModel;

  /** How CodeSDK may (or must) isolate this runtime. */
  supportedIsolationModes: RuntimeIsolationMode[];
  recommendedIsolationMode: RuntimeIsolationMode;
}

export interface AuthStatus {
  ok: boolean;
  loggedIn: boolean;
  authModel: AuthModel;
  accountLabel?: string;
  details?: Record<string, unknown>;
}

export interface RuntimeEnv {
  cwd: string;
  env: Record<string, string>;
  /**
   * Namespace identifier for “where runtime state lives” (HOME/XDG / config dirs / credential cache).
   * For multi-tenant: this should include user_id or another stable principal key.
   */
  credentialNamespace: string;
  isolation?: {
    mode: RuntimeIsolationMode;
    homeDir?: string;
    xdgConfigHome?: string;
    xdgStateHome?: string;
    xdgCacheHome?: string;
  };
}

export interface CreateSessionInput {
  title?: string;
  model?: string;
  permissionMode?: PermissionMode;
  /** Optional runtime-specific config (kept explicit, never silently interpreted). */
  runtimeConfig?: Record<string, unknown>;
}

export interface RuntimeSessionHandle {
  /** CodeSDK session id (SSOT) */
  sessionId: string;
  /** Runtime-native session/thread id (optimization only) */
  runtimeSessionId?: string;
}

export interface ToolCallIdentity {
  /** Stable identity within CodeSDK (SSOT) */
  tool_call_id: string;
  /** Runtime-native id if the runtime provides one */
  runtime_tool_call_id?: string;
  /** Starts at 1; increments on replay/resume/retry */
  attempt: number;
  /** Hash of canonicalized input for idempotency checks (see plan: canonical JSON + SHA-256). */
  input_hash: string;
}

export type TranscriptRole = 'system' | 'user' | 'assistant' | 'tool';

export type TranscriptContentBlock =
  | { type: 'text'; text: string }
  | { type: 'code'; code: string; language?: string }
  | { type: 'artifact_ref'; artifact_id: string; name?: string; content_type?: string }
  | { type: 'tool_use'; tool_call_id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_call_id: string; result: unknown; is_error?: boolean };

export interface TranscriptMessage {
  role: TranscriptRole;
  content: TranscriptContentBlock[];
}

export type AssistantContentBlock =
  | { type: 'text'; text: string }
  | { type: 'code'; code: string; language?: string }
  | { type: 'artifact_ref'; artifact_id: string; name?: string; content_type?: string };

export type ModelOutputDeltaKind = 'text_delta' | 'json_delta' | 'code_delta' | 'unknown_delta';

export interface ModelOutputDeltaPayload {
  kind: ModelOutputDeltaKind;
  /** Stable within a task so UIs can append deltas to the right block. */
  block_id: string;
  /** The streamed delta (text/json/code) for this block. */
  delta: string;
  /** Optional: tie JSON deltas to a tool call while args are streaming. */
  tool_call_id?: string;
  /** Optional: for code deltas/blocks. */
  language?: string;
}

export interface ModelOutputCompletedPayload {
  content: AssistantContentBlock[];
}

export type ToolExecutedBy = 'codesdk' | 'runtime';
export type ToolExecutionEnv = 'codesdk_docker' | 'codesdk_host' | 'runtime_internal' | 'unknown';

export interface ToolPolicyEvaluation {
  source: 'runtime' | 'codesdk' | 'user';
  result: 'allow' | 'deny' | 'ask';
  rule?: string;
}

export interface ToolPolicySnapshot {
  permission_mode?: PermissionMode;
  decision: 'allow' | 'deny';
  sources: ToolPolicyEvaluation[];
}

export interface ToolSandboxSummary {
  network?: boolean;
  timeout_ms?: number;
  mounts?: string[];
}

export interface ToolCallDeniedPayload extends ToolCallIdentity {
  name: string;
  reason: string;
  policy_snapshot: ToolPolicySnapshot;
}

export interface ToolCallCompletedPayload extends ToolCallIdentity {
  name: string;
  executed_by: ToolExecutedBy;
  execution_env: ToolExecutionEnv;
  policy_snapshot: ToolPolicySnapshot;
  sandbox?: ToolSandboxSummary;
  /** Prefer artifact refs for large outputs. */
  result_ref?: ArtifactRef;
  result_preview?: unknown;
  is_error?: boolean;
}

export interface ToolManifestEntry {
  name: string;
  description?: string;
  /** JSON schema (or runtime-native equivalent) */
  input_schema?: unknown;
  /** Optional: hash of the canonical schema for traceability */
  schema_hash?: string;
}

export interface ToolManifest {
  tools: ToolManifestEntry[];
}

export type NormalizedEventType =
  | 'session.created'
  | 'task.started'
  | 'model.input'
  | 'runtime.request.started'
  | 'runtime.request.completed'
  | 'model.output.delta'
  | 'model.output.completed'
  | 'tool.call.requested'
  | 'tool.call.policy_evaluated'
  | 'tool.call.approved'
  | 'tool.call.denied'
  | 'tool.call.started'
  | 'tool.output.delta'
  | 'tool.output.completed'
  | 'tool.call.completed'
  | 'usage.reported'
  | 'task.completed'
  | 'task.failed'
  | 'task.stopped';

export interface NormalizedEvent {
  /** Bump on breaking changes to event payload shapes/semantics. */
  schema_version: number;
  seq: number;
  time: string;
  type: NormalizedEventType;
  trace: {
    session_id: string;
    task_id?: string;
    request_id?: string;
    client_id?: string;
    user_id?: string;
  };
  runtime: {
    name: RuntimeName;
    model?: string;
    runtime_session_id?: string;
    /** Always keep a raw escape hatch for debugging. */
    raw?: unknown;
  };
  payload: Record<string, unknown>;
}
```

## Runtime adapter interface

```ts
export interface RuntimeTaskHandle {
  /**
   * Stream normalized events for this task.
   * Note: `tool.call.requested` is an OUTPUT event; CodeSDK replies via `sendToolResult`/`sendToolDenied`.
   */
  events(): AsyncIterable<NormalizedEvent>;

  /**
   * Provide tool output back to the runtime to continue its loop.
   * `toolCallId` is CodeSDK’s stable `tool_call_id` (adapter must map to runtime ids if needed).
   */
  sendToolResult(toolCallId: string, result: unknown): Promise<void>;

  /** Deny a tool call and provide a reason back to the runtime. */
  sendToolDenied(toolCallId: string, reason: string): Promise<void>;

  /** Best-effort cancellation for this task. */
  stop(reason?: string): Promise<void>;
}

export interface RuntimeAdapter {
  readonly name: RuntimeName;

  getCapabilities(): RuntimeCapabilities;

  /**
   * “Am I logged in and ready?” — first-class because OAuth implies local runtime state.
   * Must not leak sensitive token values; include only safe metadata.
   */
  getAuthStatus(env: RuntimeEnv): Promise<AuthStatus>;

  /**
   * Dev-only helper: if interactive login is required, return instructions (or a URL)
   * rather than trying to spawn browsers in production.
   */
  ensureLogin?(env: RuntimeEnv): Promise<{ ok: boolean; instructions?: string }>;

  /**
   * Create a new runtime session/thread (if supported).
   */
  createSession?(env: RuntimeEnv, input: CreateSessionInput): Promise<RuntimeSessionHandle>;

  /**
   * Resume an existing runtime session/thread, if the runtime supports stable resume.
   * This should be treated as an optimization: CodeSDK can always rebuild context from its SSOT transcript.
   */
  resumeSession?(
    env: RuntimeEnv,
    handle: RuntimeSessionHandle
  ): Promise<{ ok: boolean; runtimeSessionId?: string }>;

  /**
   * Start a task and return a duplex handle:
   * - Events are streamed out of `task.events()`
   * - Tool results/denials are sent back into the runtime loop
   *
   * Contract:
   * - Must emit `model.input` describing the canonical input sent to the runtime.
   * - Must emit `model.output.delta` and/or `model.output.completed` for assistant output.
   *   - `model.output.delta` payload should be `ModelOutputDeltaPayload` (typed blocks, not runtime-specific tokens).
   *   - `model.output.completed` payload should be `ModelOutputCompletedPayload` (final assistant blocks).
   * - When a tool call is requested, emit `tool.call.requested` with `ToolCallIdentity` fields in payload
   *   (`tool_call_id`, optional `runtime_tool_call_id`, `attempt`, `input_hash`).
   * - If a tool call is denied, emit `tool.call.denied` with `ToolCallDeniedPayload` so transcript/debugging are deterministic.
   * - When a tool call completes, emit `tool.call.completed` with `ToolCallCompletedPayload` including execution metadata.
   * - Must handle `sendToolResult` / `sendToolDenied` to continue the runtime loop.
   */
  startTask(
    env: RuntimeEnv,
    handle: RuntimeSessionHandle,
    input: {
      taskId: string;
      /** Compiled context (full or delta), runtime-agnostic. */
      messages: TranscriptMessage[];
      /** Tools exposed to the runtime for this task (names + schema hashes). */
      toolManifest?: ToolManifest;
      permissionMode?: PermissionMode;
      /** Default should be `non_interactive` for server use (no stdin prompts). */
      interactionMode?: InteractionMode;
      /** Optional runtime-specific config (kept explicit, never silently interpreted). */
      runtimeConfig?: Record<string, unknown>;
    }
  ): Promise<RuntimeTaskHandle>;
}
```

## Design notes (what this interface forces us to be honest about)

- CodeSDK can unify *eventing + storage + tools + auditing*.
- Resume semantics differ wildly; treat `runtimeSessionId` as optional.
- “Tool ownership” can be MCP-first even if a runtime has its own tool engine — the adapter should declare `toolExecutionModel` and emit `tool.call.policy_evaluated` + execution metadata so support bundles stay actionable.
- Policy is multi-layered: `tool.call.policy_evaluated` may occur multiple times (runtime, CodeSDK, user), while `tool.call.approved/denied` is the single terminal effective decision.
