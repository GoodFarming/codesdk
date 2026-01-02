import process from 'node:process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { PermissionMode } from '../core/types.js';
import { readCodesdkPackageVersion, resolveCodesdkPackageRoot } from '../core/package.js';
import { ToolRegistry } from '../tools/registry.js';
import { DockerToolExecutor } from '../tools/docker.js';
import { createPatchApplyTool } from '../tools/patch.js';
import { createWorkspaceReadTool } from '../tools/workspace.js';
import { InProcessMcpServer } from './server.js';

export interface CodesdkMcpConfig {
  workspaceRoot: string;
  permissionMode: PermissionMode;
  allowedTools?: string[];
  sandbox: 'host' | 'docker';
  timeoutMs: number;
  network: boolean;
  toolNameStyle: 'native' | 'codex';
}

export type CodesdkMcpCliParseResult =
  | { kind: 'help'; message: string; exitCode: 0 }
  | { kind: 'error'; message: string; exitCode: 1 }
  | { kind: 'run'; config: CodesdkMcpConfig };

export function parseCodesdkMcpArgs(argv: string[]): CodesdkMcpCliParseResult {
  const args = [...argv];

  const takeValue = (flag: string) => {
    const idx = args.indexOf(flag);
    if (idx === -1) return undefined;
    const value = args[idx + 1];
    args.splice(idx, 2);
    return value;
  };

  const hasFlag = (flag: string) => {
    const idx = args.indexOf(flag);
    if (idx === -1) return false;
    args.splice(idx, 1);
    return true;
  };

  if (hasFlag('--help') || hasFlag('-h')) {
    return { kind: 'help', message: codesdkMcpUsage(), exitCode: 0 };
  }

  const workspaceRoot = takeValue('--workspace-root') ?? process.cwd();
  const permissionModeRaw = takeValue('--permission-mode') ?? 'auto';
  const toolsRaw = takeValue('--tools');
  const sandboxRaw = takeValue('--sandbox') ?? 'host';
  const timeoutRaw = takeValue('--timeout-ms');
  const networkEnabled = hasFlag('--network');
  const toolNameStyleRaw = takeValue('--tool-name-style') ?? 'native';

  if (args.length) {
    return { kind: 'error', message: `Unknown args: ${args.join(' ')}`, exitCode: 1 };
  }

  const permissionMode = parsePermissionMode(permissionModeRaw);
  if (!permissionMode) {
    return {
      kind: 'error',
      message: `Invalid --permission-mode: ${permissionModeRaw} (expected auto|ask|yolo)`,
      exitCode: 1
    };
  }

  const allowedTools = toolsRaw
    ? toolsRaw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : undefined;

  const sandbox = sandboxRaw === 'docker' ? 'docker' : sandboxRaw === 'host' ? 'host' : null;
  if (!sandbox) {
    return {
      kind: 'error',
      message: `Invalid --sandbox: ${sandboxRaw} (expected host|docker)`,
      exitCode: 1
    };
  }

  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      kind: 'error',
      message: `Invalid --timeout-ms: ${timeoutRaw ?? ''}`,
      exitCode: 1
    };
  }

  const toolNameStyle =
    toolNameStyleRaw === 'codex' ? 'codex' : toolNameStyleRaw === 'native' ? 'native' : null;
  if (!toolNameStyle) {
    return {
      kind: 'error',
      message: `Invalid --tool-name-style: ${toolNameStyleRaw} (expected native|codex)`,
      exitCode: 1
    };
  }

  return {
    kind: 'run',
    config: {
      workspaceRoot,
      permissionMode,
      allowedTools,
      sandbox,
      timeoutMs,
      network: networkEnabled,
      toolNameStyle
    }
  };
}

export async function startCodesdkMcp(config: CodesdkMcpConfig): Promise<{ close: () => Promise<void> }> {
  const registry = new ToolRegistry();
  registry.register(createWorkspaceReadTool());
  registry.register(createPatchApplyTool());

  const allowed = config.allowedTools?.length ? config.allowedTools : registry.list().map((tool) => tool.name);
  const toolExecutor =
    config.sandbox === 'docker'
      ? new DockerToolExecutor({
          workspaceRoot: config.workspaceRoot,
          timeoutMs: config.timeoutMs,
          network: config.network,
          allowedTools: allowed,
          codesdkRoot: resolveCodesdkPackageRoot()
        })
      : undefined;

  const toolServer = new InProcessMcpServer({
    registry,
    context: { workspaceRoot: config.workspaceRoot },
    permissionMode: config.permissionMode,
    toolExecutor
  });

  const server = new McpServer(
    { name: 'codesdk', version: await readCodesdkPackageVersion() },
    { capabilities: { tools: {} } }
  );

  const passthrough = z.object({}).passthrough();

  const toolNameMap = new Map<string, string>();
  for (const name of allowed) {
    const def = registry.get(name);
    if (!def) continue;
    const exposedName = config.toolNameStyle === 'codex' ? normalizeToolName(name) : name;
    toolNameMap.set(exposedName, name);
    const inputSchema = def.inputSchema ? jsonSchemaToZod(def.inputSchema) : passthrough;
    server.registerTool(
      exposedName,
      {
        description: def.description ?? '',
        inputSchema
      },
      async (args: unknown) => {
        const targetName = toolNameMap.get(exposedName) ?? exposedName;
        const result = await toolServer.callTool(
          targetName,
          (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
        );
        if (!result.ok) {
          return {
            content: [{ type: 'text', text: result.error ?? 'tool error' }],
            isError: true,
            structuredContent: {
              ok: false,
              error: result.error ?? 'tool error',
              policy_snapshot: result.policy_snapshot
            }
          };
        }
        return {
          content: toContentBlocks(result.result),
          structuredContent: isPlainObject(result.result) ? (result.result as Record<string, unknown>) : undefined
        };
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  return {
    close: async () => {
      await server.close();
    }
  };
}

function parsePermissionMode(value: string): PermissionMode | undefined {
  if (value === 'auto' || value === 'ask' || value === 'yolo') return value;
  return undefined;
}

function toContentBlocks(result: unknown) {
  if (isPlainObject(result) && typeof result.content === 'string') {
    return [{ type: 'text' as const, text: result.content }];
  }
  if (typeof result === 'string') {
    return [{ type: 'text' as const, text: result }];
  }
  try {
    return [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }];
  } catch {
    return [{ type: 'text' as const, text: 'unserializable tool result' }];
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function codesdkMcpUsage() {
  return [
    'codesdk-mcp',
    '',
    'Usage:',
    '  codesdk-mcp [options]',
    '',
    'Options:',
    '  --workspace-root <dir>         Workspace root for CodeSDK-owned tools (default: cwd)',
    '  --permission-mode <mode>       auto|ask|yolo (default: auto)',
    '  --tools <list>                 Comma-separated tool allowlist (default: all built-in)',
    '  --sandbox <mode>               host|docker (default: host)',
    '  --timeout-ms <n>               Tool timeout in ms (default: 120000)',
    '  --network                      Enable network inside Docker sandbox (default: off)',
    '  --tool-name-style <mode>       native|codex (default: native)',
    ''
  ].join('\n');
}

function normalizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') {
    return z.any();
  }
  const typed = schema as {
    type?: string;
    enum?: unknown[];
    properties?: Record<string, unknown>;
    required?: string[];
    items?: unknown;
    additionalProperties?: boolean;
  };

  if (Array.isArray(typed.enum) && typed.enum.length > 0) {
    const allStrings = typed.enum.every((value) => typeof value === 'string');
    if (allStrings) {
      return z.enum(typed.enum as [string, ...string[]]);
    }
    const literals = typed.enum.map((value) => z.literal(value as any));
    if (literals.length === 1) return literals[0]!;
    return z.union(literals as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  switch (typed.type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'array': {
      const itemSchema = typed.items ? jsonSchemaToZod(typed.items) : z.any();
      return z.array(itemSchema);
    }
    case 'object': {
      const required = new Set(typed.required ?? []);
      const shape: Record<string, z.ZodTypeAny> = {};
      const props = typed.properties ?? {};
      for (const [key, propSchema] of Object.entries(props)) {
        const prop = jsonSchemaToZod(propSchema);
        shape[key] = required.has(key) ? prop : prop.optional();
      }
      let obj = z.object(shape);
      if (typed.additionalProperties === false) {
        obj = obj.strict();
      }
      return obj;
    }
    default:
      return z.any();
  }
}
