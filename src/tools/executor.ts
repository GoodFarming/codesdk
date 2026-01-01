import type { ToolExecutionOptions, ToolExecutionResult, ToolExecutor } from '../executor/tool-executor.js';
import type { ToolContext } from './types.js';
import { ToolRegistry } from './registry.js';

export class RegistryToolExecutor implements ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly context: ToolContext;
  private readonly allowDangerous: boolean;

  constructor(registry: ToolRegistry, context: ToolContext, options?: { allowDangerous?: boolean }) {
    this.registry = registry;
    this.context = context;
    this.allowDangerous = options?.allowDangerous ?? false;
  }

  async execute(
    toolName: string,
    input: unknown,
    _options?: ToolExecutionOptions
  ): Promise<ToolExecutionResult> {
    const tool = this.registry.get(toolName);
    if (!tool) {
      return { result: { error: `unknown tool: ${toolName}` }, is_error: true };
    }
    if (tool.defaultPermission === 'dangerous' && !this.allowDangerous) {
      return {
        result: { error: 'dangerous tools require Docker', tool: toolName },
        is_error: true
      };
    }
    const inputValidation = this.registry.validateInput(toolName, input);
    if (!inputValidation.ok) {
      return {
        result: { error: 'invalid tool input', issues: inputValidation.errors },
        is_error: true
      };
    }
    const execution = await tool.handler(input, this.context);
    if (execution.is_error) {
      return execution;
    }
    const outputValidation = this.registry.validateOutput(toolName, execution.result);
    if (!outputValidation.ok) {
      return {
        result: { error: 'invalid tool output', issues: outputValidation.errors },
        is_error: true
      };
    }
    return execution;
  }
}
