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

export type RuntimeIsolationMode = 'in_process' | 'subprocess' | 'server_side';
export type RuntimeIsolationLevel = 'shared' | 'namespaced' | 'ephemeral';

export type PermissionMode = 'ask' | 'auto' | 'yolo';
export type ToolPermission = 'read-only' | 'write' | 'network' | 'dangerous';

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
  credentialNamespace: string;
  isolation?: {
    level?: RuntimeIsolationLevel;
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
  runtimeConfig?: Record<string, unknown>;
}

export interface RuntimeSessionHandle {
  sessionId: string;
  runtimeSessionId?: string;
}

export interface ToolCallIdentity {
  tool_call_id: string;
  runtime_tool_call_id?: string;
  attempt: number;
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

export interface ContextWindowMeta {
  strategy: 'none' | 'truncate_oldest';
  max_chars?: number;
  omitted_indices?: number[];
  overflow?: boolean;
}

export type AssistantContentBlock =
  | { type: 'text'; text: string }
  | { type: 'code'; code: string; language?: string }
  | { type: 'artifact_ref'; artifact_id: string; name?: string; content_type?: string };

export interface ModelInputPayload {
  input_ref: ArtifactRef;
  input_hash: string;
  context_window: ContextWindowMeta;
  implicit_sources_ref?: ArtifactRef;
}

export type ModelOutputDeltaKind = 'text_delta' | 'json_delta' | 'code_delta' | 'unknown_delta';

export interface ModelOutputDeltaPayload {
  kind: ModelOutputDeltaKind;
  block_id: string;
  delta: string;
  tool_call_id?: string;
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
  decision: 'allow' | 'deny' | 'ask';
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
  result_ref?: ArtifactRef;
  result_preview?: unknown;
  is_error?: boolean;
}

export interface ToolOutputDeltaPayload extends ToolCallIdentity {
  stream: 'stdout' | 'stderr';
  delta: string;
}

export interface ToolOutputCompletedPayload extends ToolCallIdentity {
  stdout?: string;
  stderr?: string;
}

export interface ToolManifestEntry {
  name: string;
  description?: string;
  input_schema?: unknown;
  schema_hash?: string;
  output_schema?: unknown;
  output_schema_hash?: string;
  permission?: ToolPermission;
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

export interface TraceContext {
  session_id: string;
  task_id?: string;
  request_id?: string;
  client_id?: string;
  user_id?: string;
}

export interface RuntimeRef {
  name: RuntimeName;
  model?: string;
  runtime_session_id?: string;
  raw?: unknown;
}

export interface NormalizedEvent<TPayload = unknown> {
  schema_version: number;
  seq: number;
  time: string;
  type: NormalizedEventType;
  trace: TraceContext;
  runtime: RuntimeRef;
  payload: TPayload;
}

export interface ArtifactRef {
  artifact_id: string;
  content_type?: string;
  size_bytes?: number;
  content_hash?: string;
  name?: string;
}

export interface RuntimeTaskHandle {
  events(): AsyncIterable<NormalizedEvent>;
  sendToolResult(toolCallId: string, result: unknown): Promise<void>;
  sendToolDenied(toolCallId: string, reason: string): Promise<void>;
  stop(reason?: string): Promise<void>;
}

export interface RuntimeAdapter {
  readonly name: RuntimeName;

  getCapabilities(): RuntimeCapabilities;
  getAuthStatus(env: RuntimeEnv): Promise<AuthStatus>;
  ensureLogin?(env: RuntimeEnv): Promise<{ ok: boolean; instructions?: string }>;
  createSession?(env: RuntimeEnv, input: CreateSessionInput): Promise<RuntimeSessionHandle>;
  resumeSession?(
    env: RuntimeEnv,
    handle: RuntimeSessionHandle
  ): Promise<{ ok: boolean; runtimeSessionId?: string }>;
  startTask(
    env: RuntimeEnv,
    handle: RuntimeSessionHandle,
    input: {
      taskId: string;
      messages: TranscriptMessage[];
      toolManifest?: ToolManifest;
      permissionMode?: PermissionMode;
      interactionMode?: InteractionMode;
      runtimeConfig?: Record<string, unknown>;
    }
  ): Promise<RuntimeTaskHandle>;
}
