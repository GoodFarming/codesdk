import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolExecutionResult } from '../executor/tool-executor.js';
import type { ToolDefinition, ToolContext } from './types.js';

type WorkspaceReadInput = {
  path: string;
  max_bytes?: number;
  encoding?: BufferEncoding;
};

export function createWorkspaceReadTool(): ToolDefinition {
  return {
    name: 'workspace.read',
    description: 'Read a file from the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        max_bytes: { type: 'number' },
        encoding: { type: 'string' }
      },
      required: ['path'],
      additionalProperties: false
    },
    outputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        truncated: { type: 'boolean' },
        bytes_read: { type: 'number' },
        total_bytes: { type: 'number' },
        encoding: { type: 'string' }
      },
      required: ['path', 'content', 'truncated', 'bytes_read', 'total_bytes', 'encoding'],
      additionalProperties: false
    },
    defaultPermission: 'read-only',
    handler: async (input: unknown, context: ToolContext): Promise<ToolExecutionResult> => {
      const parsed = input as WorkspaceReadInput;
      if (!parsed?.path || typeof parsed.path !== 'string') {
        return { result: { error: 'path is required' }, is_error: true };
      }

      if (path.isAbsolute(parsed.path)) {
        return { result: { error: 'absolute paths are not allowed' }, is_error: true };
      }

      const resolvedRoot = path.resolve(context.workspaceRoot);
      const resolvedPath = path.resolve(resolvedRoot, parsed.path);
      if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
        return { result: { error: 'path escapes workspace root' }, is_error: true };
      }

      try {
        const maxBytes = typeof parsed.max_bytes === 'number' ? parsed.max_bytes : 1024 * 1024;
        const encoding: BufferEncoding = parsed.encoding ?? 'utf8';
        const data = await readFile(resolvedPath);
        const sliced = data.byteLength > maxBytes ? data.subarray(0, maxBytes) : data;
        const content = sliced.toString(encoding);
        return {
          result: {
            path: parsed.path,
            content,
            truncated: data.byteLength > maxBytes,
            bytes_read: sliced.byteLength,
            total_bytes: data.byteLength,
            encoding
          }
        };
      } catch (error) {
        return {
          result: {
            error: error instanceof Error ? error.message : String(error),
            path: parsed.path
          },
          is_error: true
        };
      }
    }
  };
}
