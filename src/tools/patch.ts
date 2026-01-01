import { spawn } from 'node:child_process';
import type { ToolExecutionResult } from '../executor/tool-executor.js';
import type { ToolDefinition, ToolContext } from './types.js';

type PatchApplyInput = {
  patch: string;
  strip?: number;
  check?: boolean;
  reverse?: boolean;
};

export function createPatchApplyTool(): ToolDefinition {
  return {
    name: 'patch.apply',
    description: 'Apply a unified diff patch to the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        patch: { type: 'string' },
        strip: { type: 'number' },
        check: { type: 'boolean' },
        reverse: { type: 'boolean' }
      },
      required: ['patch'],
      additionalProperties: false
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        checked: { type: 'boolean' },
        stdout: { type: 'string' },
        stderr: { type: 'string' }
      },
      required: ['ok', 'checked'],
      additionalProperties: false
    },
    defaultPermission: 'write',
    handler: async (input: unknown, context: ToolContext): Promise<ToolExecutionResult> => {
      const parsed = input as PatchApplyInput;
      if (!parsed?.patch || typeof parsed.patch !== 'string') {
        return { result: { error: 'patch is required' }, is_error: true };
      }

      const args = ['apply', '--whitespace=nowarn'];
      if (parsed.check) args.push('--check');
      if (parsed.reverse) args.push('--reverse');
      if (typeof parsed.strip === 'number') {
        args.push(`-p${parsed.strip}`);
      }

      return new Promise<ToolExecutionResult>((resolve) => {
        const child = spawn('git', args, { cwd: context.workspaceRoot });
        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (chunk) => {
          stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk) => {
          stderr += chunk.toString('utf8');
        });
        child.on('error', (error) => {
          resolve({
            result: { error: error instanceof Error ? error.message : String(error) },
            is_error: true,
            stdout: stdout.trim() || undefined,
            stderr: stderr.trim() || undefined
          });
        });
        child.on('close', (code) => {
          if (code === 0) {
            resolve({
              result: {
                ok: true,
                checked: Boolean(parsed.check),
                stdout: stdout.trim() || undefined,
                stderr: stderr.trim() || undefined
              },
              stdout: stdout.trim() || undefined,
              stderr: stderr.trim() || undefined
            });
          } else {
            resolve({
              result: {
                error: stderr.trim() || stdout.trim() || `git apply failed (${code ?? 'unknown'})`,
                stdout: stdout.trim() || undefined,
                stderr: stderr.trim() || undefined
              },
              is_error: true,
              stdout: stdout.trim() || undefined,
              stderr: stderr.trim() || undefined
            });
          }
        });

        child.stdin?.write(parsed.patch);
        child.stdin?.end();
      });
    }
  };
}
