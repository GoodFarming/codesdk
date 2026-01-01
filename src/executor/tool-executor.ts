import type { ToolExecutionEnv, ToolSandboxSummary } from '../core/types.js';

export interface ToolExecutionResult {
  result: unknown;
  stdout?: string;
  stderr?: string;
  is_error?: boolean;
  sandbox?: ToolSandboxSummary;
  executionEnv?: ToolExecutionEnv;
}

export type ToolOutputStream = 'stdout' | 'stderr';

export interface ToolExecutionOptions {
  onOutput?: (stream: ToolOutputStream, chunk: string) => void;
  signal?: AbortSignal;
}

export interface ToolExecutor {
  execute(toolName: string, input: unknown, options?: ToolExecutionOptions): Promise<ToolExecutionResult>;
}

export class NoopToolExecutor implements ToolExecutor {
  async execute(
    toolName: string,
    input: unknown,
    _options?: ToolExecutionOptions
  ): Promise<ToolExecutionResult> {
    return {
      result: { ok: true, tool: toolName, input }
    };
  }
}
