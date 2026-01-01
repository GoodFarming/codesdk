import type { ToolExecutionResult } from '../executor/tool-executor.js';
import type { ToolPermission } from '../core/types.js';

export interface ToolContext {
  workspaceRoot: string;
  signal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  defaultPermission?: ToolPermission;
  handler: (input: unknown, context: ToolContext) => Promise<ToolExecutionResult>;
}
