import path from 'node:path';
import process from 'node:process';
import { mkdirSync } from 'node:fs';
import type { PermissionMode, RuntimeAdapter, RuntimeName } from '../core/types.js';
import { SqliteEventStore } from '../executor/event-store.js';
import { FileArtifactStore } from '../executor/artifact-store-file.js';
import { ToolRegistry } from '../tools/registry.js';
import { createWorkspaceReadTool } from '../tools/workspace.js';
import { createPatchApplyTool } from '../tools/patch.js';
import { RegistryToolExecutor } from '../tools/executor.js';
import { ClaudeAgentSdkAdapter } from '../adapters/claude-agent-sdk.js';
import { CodexSdkAdapter } from '../adapters/codex-sdk.js';
import { GeminiCliCoreAdapter } from '../adapters/gemini-cli-core.js';
import { OpencodeServerAdapter } from '../adapters/opencode-server.js';
import type { CodeSdkdServer } from './server.js';
import { createCodeSdkdServer } from './server.js';

export interface CodesdkdConfig {
  host: string;
  port: number;
  dataDir: string;
  workspaceRoot: string;
  runtimes: RuntimeName[];
  defaultRuntime?: RuntimeName;
  defaultPermissionMode: PermissionMode;
}

export type CodesdkdCliParseResult =
  | { kind: 'help'; message: string; exitCode: 0 }
  | { kind: 'error'; message: string; exitCode: 1 }
  | { kind: 'run'; config: CodesdkdConfig };

export function parseCodesdkdArgs(argv: string[]): CodesdkdCliParseResult {
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
    return { kind: 'help', message: codesdkdUsage(), exitCode: 0 };
  }

  const host = takeValue('--host') ?? '127.0.0.1';
  const portRaw = takeValue('--port') ?? '0';
  const dataDir = takeValue('--data-dir');
  const runtimesRaw = takeValue('--runtimes');
  const defaultRuntimeRaw = takeValue('--default-runtime');
  const defaultPermissionModeRaw = takeValue('--default-permission-mode') ?? 'auto';
  const workspaceRoot = takeValue('--workspace-root') ?? process.cwd();

  if (args.length) {
    return { kind: 'error', message: `Unknown args: ${args.join(' ')}`, exitCode: 1 };
  }

  if (!dataDir) {
    return { kind: 'error', message: 'Missing required: --data-dir', exitCode: 1 };
  }

  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port < 0) {
    return { kind: 'error', message: `Invalid --port: ${portRaw}`, exitCode: 1 };
  }

  const defaultPermissionMode = parsePermissionMode(defaultPermissionModeRaw);
  if (!defaultPermissionMode) {
    return {
      kind: 'error',
      message: `Invalid --default-permission-mode: ${defaultPermissionModeRaw} (expected auto|ask|yolo)`,
      exitCode: 1
    };
  }

  const runtimes = parseRuntimes(runtimesRaw);
  if (!runtimes.ok) {
    return { kind: 'error', message: runtimes.error, exitCode: 1 };
  }

  const defaultRuntime = defaultRuntimeRaw
    ? resolveRuntimeName(defaultRuntimeRaw)
    : undefined;
  if (defaultRuntimeRaw && !defaultRuntime) {
    return { kind: 'error', message: `Unknown --default-runtime: ${defaultRuntimeRaw}`, exitCode: 1 };
  }
  if (defaultRuntime && !runtimes.value.includes(defaultRuntime)) {
    return {
      kind: 'error',
      message: `--default-runtime ${defaultRuntime} is not in --runtimes (${runtimes.value.join(', ')})`,
      exitCode: 1
    };
  }

  return {
    kind: 'run',
    config: {
      host,
      port,
      dataDir,
      workspaceRoot,
      runtimes: runtimes.value,
      defaultRuntime,
      defaultPermissionMode
    }
  };
}

export async function startCodesdkd(config: CodesdkdConfig): Promise<{ url: string; daemon: CodeSdkdServer }> {
  mkdirSync(config.dataDir, { recursive: true });

  const eventStore = new SqliteEventStore(path.join(config.dataDir, 'events.sqlite'));
  const artifactStore = new FileArtifactStore({ rootDir: path.join(config.dataDir, 'artifacts') });

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createWorkspaceReadTool());
  toolRegistry.register(createPatchApplyTool());

  const toolExecutor = new RegistryToolExecutor(toolRegistry, { workspaceRoot: config.workspaceRoot });
  const runtimes = createAdapters(config.runtimes, artifactStore);

  const daemon = createCodeSdkdServer({
    host: config.host,
    port: config.port,
    runtimes,
    defaultRuntime: config.defaultRuntime,
    runtimeEnvBaseDir: path.join(config.dataDir, 'runtime-env'),
    createRuntimeEnvDirs: true,
    eventStore,
    artifactStore,
    toolRegistry,
    toolExecutor,
    defaultPermissionMode: config.defaultPermissionMode
  });

  const info = await daemon.listen();
  return { url: info.url, daemon };
}

function parsePermissionMode(value: string): PermissionMode | undefined {
  if (value === 'auto' || value === 'ask' || value === 'yolo') return value;
  return undefined;
}

function parseRuntimes(value: string | undefined): { ok: true; value: RuntimeName[] } | { ok: false; error: string } {
  if (!value) {
    return {
      ok: true,
      value: ['claude-agent-sdk', 'codex-sdk', 'gemini-cli-core', 'opencode-server']
    };
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return { ok: false, error: '--runtimes cannot be empty' };
  }

  const resolved: RuntimeName[] = [];
  for (const entry of entries) {
    const runtime = resolveRuntimeName(entry);
    if (!runtime) {
      return { ok: false, error: `Unknown runtime in --runtimes: ${entry}` };
    }
    if (!resolved.includes(runtime)) resolved.push(runtime);
  }
  return { ok: true, value: resolved };
}

function resolveRuntimeName(value: string): RuntimeName | undefined {
  const normalized = value.trim();
  if (
    normalized === 'claude-agent-sdk' ||
    normalized === 'codex-sdk' ||
    normalized === 'gemini-cli-core' ||
    normalized === 'opencode-server'
  ) {
    return normalized;
  }
  if (normalized === 'claude') return 'claude-agent-sdk';
  if (normalized === 'codex') return 'codex-sdk';
  if (normalized === 'gemini') return 'gemini-cli-core';
  if (normalized === 'opencode') return 'opencode-server';
  return undefined;
}

function createAdapters(runtimes: RuntimeName[], artifactStore: FileArtifactStore): RuntimeAdapter[] {
  return runtimes.map((runtime) => {
    switch (runtime) {
      case 'claude-agent-sdk':
        return new ClaudeAgentSdkAdapter({ artifactStore });
      case 'codex-sdk':
        return new CodexSdkAdapter({ artifactStore });
      case 'gemini-cli-core':
        return new GeminiCliCoreAdapter({ artifactStore });
      case 'opencode-server':
        return new OpencodeServerAdapter({
          artifactStore,
          baseUrl: process.env.OPENCODE_BASE_URL ?? process.env.OPENCODE_URL,
          directory: process.env.OPENCODE_DIRECTORY
        });
      default:
        return assertNever(runtime);
    }
  });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled runtime: ${String(value)}`);
}

function codesdkdUsage() {
  return [
    'codesdkd',
    '',
    'Usage:',
    '  codesdkd --data-dir <dir> [options]',
    '',
    'Options:',
    '  --host <host>                       Listening host (default: 127.0.0.1)',
    '  --port <port>                       Listening port, 0 = ephemeral (default: 0)',
    '  --data-dir <dir>                    Required. Root for sqlite/events + artifacts + runtime-env',
    '  --runtimes <list>                   Comma-separated runtimes (default: all)',
    '  --default-runtime <runtime>         Default runtime name',
    '  --default-permission-mode <mode>    auto|ask|yolo (default: auto)',
    '  --workspace-root <dir>              Workspace root for CodeSDK-owned tools (default: cwd)',
    '',
    'Runtimes:',
    '  claude-agent-sdk | codex-sdk | gemini-cli-core | opencode-server',
    ''
  ].join('\n');
}

