import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ToolExecutionOptions, ToolExecutionResult, ToolExecutor } from '../executor/tool-executor.js';
import type { ToolSandboxSummary } from '../core/types.js';

export interface DockerMount {
  source: string;
  target: string;
  readOnly?: boolean;
}

export interface DockerToolExecutorOptions {
  image?: string;
  dockerPath?: string;
  workspaceRoot: string;
  workspaceReadOnly?: boolean;
  codesdkRoot?: string;
  mounts?: DockerMount[];
  network?: boolean;
  timeoutMs?: number;
  cpuLimit?: number;
  memoryLimitMb?: number;
  allowedTools?: string[];
}

export class DockerToolExecutor implements ToolExecutor {
  private readonly options: DockerToolExecutorOptions;

  constructor(options: DockerToolExecutorOptions) {
    this.options = options;
  }

  async execute(
    toolName: string,
    input: unknown,
    options?: ToolExecutionOptions
  ): Promise<ToolExecutionResult> {
    if (toolName === 'workspace.exec') {
      if (!this.options.allowedTools || !this.options.allowedTools.includes(toolName)) {
        return { result: { error: 'workspace.exec requires explicit allowlist' }, is_error: true };
      }
      if (!this.options.timeoutMs) {
        return { result: { error: 'workspace.exec requires timeoutMs' }, is_error: true };
      }
      if (this.options.network === true) {
        return { result: { error: 'workspace.exec must run with network disabled' }, is_error: true };
      }
    }

    if (this.options.allowedTools && !this.options.allowedTools.includes(toolName)) {
      return { result: { error: `tool not allowed: ${toolName}` }, is_error: true };
    }

    const codesdkRoot = this.options.codesdkRoot ?? process.cwd();
    const runnerPath = path.join(codesdkRoot, 'scripts', 'docker-tool-runner.mjs');
    const distMarker = path.join(codesdkRoot, 'dist', 'tools', 'registry.js');
    if (!existsSync(runnerPath) || !existsSync(distMarker)) {
      return {
        result: { error: 'missing build artifacts; run npm run build before using DockerToolExecutor' },
        is_error: true
      };
    }

    const image = this.options.image ?? 'node:20';
    const docker = this.options.dockerPath ?? 'docker';
    const mounts = buildMounts(codesdkRoot, this.options);
    const sandbox = buildSandboxSummary(this.options, mounts);
    const args = buildDockerArgs(image, mounts, this.options);

    const payload = JSON.stringify({
      toolName,
      input,
      workspaceRoot: '/workspace'
    });

    const child = spawn(docker, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      options?.onOutput?.('stderr', text);
    });

    if (child.stdin) {
      child.stdin.write(payload);
      child.stdin.end();
    }

    const timeoutMs = this.options.timeoutMs;
    let timeoutHandle: NodeJS.Timeout | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
    }

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code));
      child.on('error', () => resolve(1));
    });

    if (timeoutHandle) clearTimeout(timeoutHandle);

    if (timedOut) {
      return {
        result: { error: 'tool execution timed out' },
        is_error: true,
        stderr: stderr || undefined,
        sandbox,
        executionEnv: 'codesdk_docker'
      };
    }

    if (exitCode && exitCode !== 0) {
      return {
        result: { error: `docker run failed (${exitCode})`, stderr: stderr || undefined },
        is_error: true,
        stderr: stderr || undefined,
        sandbox,
        executionEnv: 'codesdk_docker'
      };
    }

    let parsed: ToolExecutionResult | undefined;
    try {
      parsed = stdout.trim() ? (JSON.parse(stdout) as ToolExecutionResult) : undefined;
    } catch (error) {
      return {
        result: { error: error instanceof Error ? error.message : String(error), stderr: stderr || undefined },
        is_error: true,
        stderr: stderr || undefined,
        sandbox,
        executionEnv: 'codesdk_docker'
      };
    }

    if (!parsed || typeof parsed !== 'object') {
      return {
        result: { error: 'invalid tool runner response', stderr: stderr || undefined },
        is_error: true,
        stderr: stderr || undefined,
        sandbox,
        executionEnv: 'codesdk_docker'
      };
    }

    return {
      ...parsed,
      stderr: parsed.stderr ?? (stderr || undefined),
      sandbox,
      executionEnv: 'codesdk_docker'
    };
  }
}

function buildMounts(codesdkRoot: string, options: DockerToolExecutorOptions): DockerMount[] {
  const mounts: DockerMount[] = [
    { source: codesdkRoot, target: '/codesdk', readOnly: true },
    {
      source: options.workspaceRoot,
      target: '/workspace',
      readOnly: options.workspaceReadOnly ?? false
    }
  ];
  if (options.mounts) {
    mounts.push(...options.mounts);
  }
  return mounts;
}

function buildDockerArgs(image: string, mounts: DockerMount[], options: DockerToolExecutorOptions): string[] {
  const args = ['run', '--rm', '-i'];
  if (options.network === false || options.network === undefined) {
    args.push('--network', 'none');
  }
  if (options.cpuLimit) {
    args.push('--cpus', String(options.cpuLimit));
  }
  if (options.memoryLimitMb) {
    args.push('--memory', `${options.memoryLimitMb}m`);
  }
  for (const mount of mounts) {
    const readonly = mount.readOnly ? ',readonly' : '';
    args.push('--mount', `type=bind,source=${mount.source},target=${mount.target}${readonly}`);
  }
  args.push('--workdir', '/workspace');
  args.push(image, 'node', '/codesdk/scripts/docker-tool-runner.mjs');
  return args;
}

function buildSandboxSummary(
  options: DockerToolExecutorOptions,
  mounts: DockerMount[]
): ToolSandboxSummary {
  return {
    network: Boolean(options.network),
    timeout_ms: options.timeoutMs,
    mounts: mounts.map((mount) => `${mount.target}${mount.readOnly ? ':ro' : ':rw'}`)
  };
}
