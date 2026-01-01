import type { PermissionMode, ToolPolicySnapshot } from '../core/types.js';
import { PermissionService, SimplePolicyEngine, type PermissionOverrides } from '../executor/policy.js';
import type { ToolExecutionResult } from '../executor/tool-executor.js';
import type { ToolContext } from '../tools/types.js';
import { ToolRegistry } from '../tools/registry.js';

export type McpMethod = 'tools/list' | 'tools/call';

export interface McpRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: McpMethod;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolPolicyEvent {
  type: 'tool.call.policy_evaluated' | 'tool.call.approved' | 'tool.call.denied';
  tool: string;
  snapshot: ToolPolicySnapshot;
  time: string;
  reason?: string;
}

export interface McpToolCallResult {
  ok: boolean;
  result?: unknown;
  is_error?: boolean;
  error?: string;
  policy_snapshot: ToolPolicySnapshot;
}

export interface InProcessMcpServerOptions {
  registry: ToolRegistry;
  context: ToolContext;
  permissionMode?: PermissionMode;
  permissionOverrides?: PermissionOverrides;
  policyEngine?: PermissionService;
  onPolicyEvent?: (event: ToolPolicyEvent) => void;
}

export class InProcessMcpServer {
  private readonly registry: ToolRegistry;
  private readonly context: ToolContext;
  private readonly permissionMode: PermissionMode;
  private readonly permissionOverrides?: PermissionOverrides;
  private readonly policyEngine: PermissionService;
  private readonly onPolicyEvent?: (event: ToolPolicyEvent) => void;

  constructor(options: InProcessMcpServerOptions) {
    this.registry = options.registry;
    this.context = options.context;
    this.permissionMode = options.permissionMode ?? 'ask';
    this.permissionOverrides = options.permissionOverrides;
    this.policyEngine = options.policyEngine ?? new SimplePolicyEngine();
    this.onPolicyEvent = options.onPolicyEvent;
  }

  listTools() {
    return this.registry.toManifest();
  }

  async callTool(name: string, input: unknown): Promise<McpToolCallResult> {
    const tool = this.registry.get(name);
    if (!tool) {
      return {
        ok: false,
        is_error: true,
        error: `unknown tool: ${name}`,
        policy_snapshot: {
          permission_mode: this.permissionMode,
          decision: 'deny',
          sources: [{ source: 'codesdk', result: 'deny', rule: 'tool_not_found' }]
        }
      };
    }

    const toolPermission = tool.defaultPermission;
    const decision = this.policyEngine.decide(this.permissionMode, name, {
      toolPermission,
      overrides: this.permissionOverrides
    });
    this.emitPolicyEvent('tool.call.policy_evaluated', name, decision.snapshot);

    if (decision.decision !== 'allow') {
      const reason = decision.decision === 'ask' ? 'approval required' : 'permission denied';
      this.emitPolicyEvent('tool.call.denied', name, decision.snapshot, reason);
      return {
        ok: false,
        is_error: true,
        error: reason,
        policy_snapshot: decision.snapshot
      };
    }

    this.emitPolicyEvent('tool.call.approved', name, decision.snapshot);

    const inputValidation = this.registry.validateInput(name, input);
    if (!inputValidation.ok) {
      return {
        ok: false,
        is_error: true,
        error: 'invalid tool input',
        result: { issues: inputValidation.errors },
        policy_snapshot: decision.snapshot
      };
    }

    let execution: ToolExecutionResult;
    try {
      execution = await tool.handler(input, this.context);
    } catch (error) {
      return {
        ok: false,
        is_error: true,
        error: error instanceof Error ? error.message : String(error),
        policy_snapshot: decision.snapshot
      };
    }

    if (!execution.is_error) {
      const outputValidation = this.registry.validateOutput(name, execution.result);
      if (!outputValidation.ok) {
        return {
          ok: false,
          is_error: true,
          error: 'invalid tool output',
          result: { issues: outputValidation.errors },
          policy_snapshot: decision.snapshot
        };
      }
    }

    return {
      ok: !execution.is_error,
      result: execution.result,
      is_error: execution.is_error,
      error: execution.is_error ? 'tool execution failed' : undefined,
      policy_snapshot: decision.snapshot
    };
  }

  async handle(request: McpRequest): Promise<McpResponse> {
    if (request.method === 'tools/list') {
      return { jsonrpc: '2.0', id: request.id, result: this.listTools() };
    }

    if (request.method === 'tools/call') {
      const name = request.params?.name;
      const args = request.params?.arguments;
      if (typeof name !== 'string') {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32602, message: 'Invalid params: missing tool name' }
        };
      }
      const result = await this.callTool(name, args);
      if (!result.ok) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32000, message: result.error ?? 'tool error', data: result }
        };
      }
      return { jsonrpc: '2.0', id: request.id, result };
    }

    return {
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: `Method not found: ${request.method}` }
    };
  }

  private emitPolicyEvent(
    type: ToolPolicyEvent['type'],
    tool: string,
    snapshot: ToolPolicySnapshot,
    reason?: string
  ) {
    if (!this.onPolicyEvent) return;
    this.onPolicyEvent({
      type,
      tool,
      snapshot,
      reason,
      time: new Date().toISOString()
    });
  }
}
