import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { create as createTar } from 'tar';
import type { ArtifactRef, McpTransport, NormalizedEvent, RuntimeAdapter, RuntimeEnv } from '../core/types.js';
import { resolveCodesdkPackageRoot } from '../core/package.js';
import type { ArtifactStore } from '../executor/artifact-store.js';
import type { EventStore } from '../executor/event-store.js';
import { getRuntimeHealth } from '../runtime/index.js';

export interface SupportBundleOptions {
  outputPath: string;
  sessionId: string;
  taskId?: string;
  runtime: RuntimeAdapter;
  env: RuntimeEnv;
  eventStore: EventStore;
  artifactStore?: ArtifactStore;
  mcp?: { supported?: McpTransport[]; chosen?: McpTransport };
  maxArtifactBytes?: number;
  redactArtifact?: (data: Uint8Array, ref: ArtifactRef) => Uint8Array;
  cleanup?: boolean;
}

export interface SupportBundleManifest {
  session_id: string;
  task_id?: string;
  generated_at: string;
  artifacts: {
    included: number;
    skipped: number;
  };
  notes?: string[];
}

export async function createSupportBundle(options: SupportBundleOptions): Promise<SupportBundleManifest> {
  const cleanup = options.cleanup ?? true;
  const bundleDir = await mkdtemp(path.join(os.tmpdir(), 'codesdk-bundle-'));
  const artifactsDir = path.join(bundleDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });

  const health = await getRuntimeHealth(options.runtime, options.env, { includeAuth: true });
  await writeJson(path.join(bundleDir, 'health.json'), health);
  await writeJson(path.join(bundleDir, 'capabilities.json'), health.capabilities);

  const versions = await collectVersions(options.runtime.name);
  await writeJson(path.join(bundleDir, 'versions.json'), versions);

  await writeJson(path.join(bundleDir, 'runtime-env.json'), sanitizeEnv(options.env));

  await writeJson(path.join(bundleDir, 'mcp-transports.json'), {
    supported: options.mcp?.supported ?? options.runtime.getCapabilities().mcpTransports ?? [],
    chosen: options.mcp?.chosen ?? null
  });

  const events = collectEvents(options.eventStore, options.sessionId);
  await writeJsonLines(path.join(bundleDir, 'events.jsonl'), events);

  const runtimeConfig = collectImplicitSources(events);
  await writeJson(path.join(bundleDir, 'runtime-config.json'), runtimeConfig);

  const toolTranscript = buildToolTranscript(events);
  await writeJson(path.join(bundleDir, 'tool-transcripts.json'), toolTranscript);

  const artifactRefs = collectArtifactRefs(events);
  const artifactsManifest = await writeArtifacts({
    refs: artifactRefs,
    artifactStore: options.artifactStore,
    dir: artifactsDir,
    maxBytes: options.maxArtifactBytes ?? 1024 * 1024,
    redact: options.redactArtifact
  });

  const manifest: SupportBundleManifest = {
    session_id: options.sessionId,
    task_id: options.taskId,
    generated_at: new Date().toISOString(),
    artifacts: {
      included: artifactsManifest.included.length,
      skipped: artifactsManifest.skipped.length
    }
  };
  await writeJson(path.join(bundleDir, 'manifest.json'), manifest);

  await createTar(
    {
      gzip: true,
      file: options.outputPath,
      cwd: bundleDir
    },
    ['.']
  );

  if (cleanup) {
    await rm(bundleDir, { recursive: true, force: true });
  }

  return manifest;
}

async function collectVersions(runtimeName: string) {
  const packages = [
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
    '@google/gemini-cli-core',
    '@opencode-ai/sdk'
  ];
  const versions: Record<string, string> = {};
  const root = resolveCodesdkPackageRoot();
  versions.codesdk = await readPackageVersion(path.join(root, 'package.json'));

  for (const pkg of packages) {
    const pkgPath = resolveNodeModulesPackageJson(root, pkg);
    versions[pkg] = pkgPath ? await readPackageVersion(pkgPath) : 'unknown';
  }
  versions.runtime = runtimeName;
  return versions;
}

async function readPackageVersion(filePath: string): Promise<string> {
  try {
    const data = await readJsonFile(filePath);
    return typeof data.version === 'string' ? data.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  const data = await readFile(filePath, 'utf8');
  return JSON.parse(data) as Record<string, unknown>;
}

function resolveNodeModulesPackageJson(startDir: string, pkg: string): string | undefined {
  const segments = pkg.split('/').filter(Boolean);
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, 'node_modules', ...segments, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function sanitizeEnv(env: RuntimeEnv) {
  return {
    cwd: env.cwd,
    credentialNamespace: env.credentialNamespace,
    isolation: env.isolation
      ? {
          level: env.isolation.level,
          mode: env.isolation.mode,
          homeDir: env.isolation.homeDir,
          xdgConfigHome: env.isolation.xdgConfigHome,
          xdgStateHome: env.isolation.xdgStateHome,
          xdgCacheHome: env.isolation.xdgCacheHome
        }
      : undefined
  };
}

function collectEvents(store: EventStore, sessionId: string): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  let afterSeq: number | undefined = undefined;
  while (true) {
    const batch = store.list(sessionId, { afterSeq, limit: 500 });
    if (batch.length === 0) break;
    events.push(...batch);
    afterSeq = batch[batch.length - 1]?.seq;
  }
  return events;
}

function buildToolTranscript(events: NormalizedEvent[]) {
  type ToolTranscriptEntry = {
    tool_call_id: string;
    name?: string;
    input?: unknown;
    attempt?: number;
    input_hash?: string;
    result_preview?: unknown;
    result_ref?: unknown;
    is_error?: boolean;
    executed_by?: unknown;
    execution_env?: unknown;
    policy_snapshot?: unknown;
    sandbox?: unknown;
    stdout?: string;
    stderr?: string;
  };

  const transcript = new Map<string, ToolTranscriptEntry>();
  for (const event of events) {
    if (event.type === 'tool.call.requested') {
      const payload = event.payload as any;
      transcript.set(payload.tool_call_id, {
        tool_call_id: payload.tool_call_id,
        name: payload.name,
        input: payload.input,
        attempt: payload.attempt,
        input_hash: payload.input_hash
      });
    }
    if (event.type === 'tool.call.completed') {
      const payload = event.payload as any;
      const entry: ToolTranscriptEntry = transcript.get(payload.tool_call_id) ?? {
        tool_call_id: payload.tool_call_id
      };
      entry.result_preview = payload.result_preview;
      entry.result_ref = payload.result_ref;
      entry.is_error = payload.is_error;
      entry.executed_by = payload.executed_by;
      entry.execution_env = payload.execution_env;
      entry.policy_snapshot = payload.policy_snapshot;
      entry.sandbox = payload.sandbox;
      transcript.set(payload.tool_call_id, entry);
    }
    if (event.type === 'tool.output.completed') {
      const payload = event.payload as any;
      const entry: ToolTranscriptEntry = transcript.get(payload.tool_call_id) ?? {
        tool_call_id: payload.tool_call_id
      };
      entry.stdout = payload.stdout;
      entry.stderr = payload.stderr;
      transcript.set(payload.tool_call_id, entry);
    }
  }
  return Array.from(transcript.values());
}

function collectImplicitSources(events: NormalizedEvent[]) {
  const entries: Array<{ seq: number; ref: ArtifactRef | null }> = [];
  for (const event of events) {
    if (event.type !== 'model.input') continue;
    const payload = event.payload as { implicit_sources_ref?: ArtifactRef };
    entries.push({ seq: event.seq, ref: payload.implicit_sources_ref ?? null });
  }
  return { implicit_sources: entries };
}

function collectArtifactRefs(events: NormalizedEvent[]): ArtifactRef[] {
  const refs = new Map<string, ArtifactRef>();
  const visit = (value: unknown) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (typeof obj.artifact_id === 'string') {
        refs.set(obj.artifact_id, obj as unknown as ArtifactRef);
        return;
      }
      for (const entry of Object.values(obj)) {
        visit(entry);
      }
    }
  };
  for (const event of events) {
    visit(event.payload);
  }
  return Array.from(refs.values());
}

async function writeArtifacts(options: {
  refs: ArtifactRef[];
  artifactStore?: ArtifactStore;
  dir: string;
  maxBytes: number;
  redact?: (data: Uint8Array, ref: ArtifactRef) => Uint8Array;
}) {
  const included: ArtifactRef[] = [];
  const skipped: Array<{ ref: ArtifactRef; reason: string }> = [];

  if (!options.artifactStore) {
    return { included, skipped };
  }

  for (const ref of options.refs) {
    const record = options.artifactStore.get(ref.artifact_id);
    if (!record) {
      skipped.push({ ref, reason: 'missing' });
      continue;
    }
    if (record.size_bytes && record.size_bytes > options.maxBytes) {
      skipped.push({ ref, reason: 'size_limit' });
      continue;
    }
    const data = options.redact ? options.redact(record.data, ref) : record.data;
    const dataPath = path.join(options.dir, `${record.artifact_id}.bin`);
    const metaPath = path.join(options.dir, `${record.artifact_id}.json`);
    await writeFile(dataPath, data);
    await writeJson(metaPath, {
      artifact_id: record.artifact_id,
      content_type: record.content_type,
      content_hash: record.content_hash,
      size_bytes: record.size_bytes,
      name: record.name
    });
    included.push(ref);
  }

  await writeJson(path.join(options.dir, 'manifest.json'), { included, skipped });
  return { included, skipped };
}

async function writeJson(filePath: string, data: unknown) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function writeJsonLines(filePath: string, entries: NormalizedEvent[]) {
  const payload = entries.map((event) => JSON.stringify(event)).join('\n');
  await writeFile(filePath, `${payload}\n`, 'utf8');
}
