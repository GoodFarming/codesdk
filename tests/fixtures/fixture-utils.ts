import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NormalizedEvent } from '../../src/core/types.js';

export type FixtureMeta = {
  runtime: string;
  scenario: string;
  captured_at: string;
  cwd: string;
  messages: Array<{ role: string; content: Array<{ type: string; [key: string]: unknown }> }>;
  tool_manifest?: unknown;
  runtime_config?: Record<string, unknown>;
  adapter_options?: Record<string, unknown>;
  notes?: string;
};

export type FixtureBundle = {
  meta: FixtureMeta;
  raw: unknown;
  normalized: NormalizedEvent[];
};

export type Redaction = { from: string; to: string };

export async function writeFixtureBundle(baseDir: string, bundle: FixtureBundle, redactions: Redaction[]) {
  const dir = path.join(baseDir, bundle.meta.runtime, bundle.meta.scenario);
  await mkdir(dir, { recursive: true });
  const meta = applyRedactions(bundle.meta, redactions);
  const raw = applyRedactions(bundle.raw, redactions);
  const normalized = normalizeEvents(bundle.normalized, redactions);
  await writeJson(path.join(dir, 'meta.json'), meta);
  await writeJson(path.join(dir, 'raw.json'), raw);
  await writeJson(path.join(dir, 'normalized.json'), normalized);
}

export async function readJson<T = unknown>(filePath: string): Promise<T> {
  const data = await readFile(filePath, 'utf8');
  return JSON.parse(data) as T;
}

export function normalizeEvents(events: NormalizedEvent[], redactions: Redaction[]): NormalizedEvent[] {
  const artifactMap = new Map<string, string>();
  let artifactCounter = 1;

  const normalizeArtifact = (value: Record<string, unknown>) => {
    const artifactId = typeof value.artifact_id === 'string' ? value.artifact_id : undefined;
    if (!artifactId) return value;
    const contentHash = typeof value.content_hash === 'string' ? value.content_hash : undefined;
    const key = contentHash ?? artifactId;
    let mapped = artifactMap.get(key);
    if (!mapped) {
      mapped = `artifact-${artifactCounter++}`;
      artifactMap.set(key, mapped);
    }
    return { ...value, artifact_id: mapped };
  };

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map((entry) => walk(entry));
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (typeof obj.artifact_id === 'string') {
        return normalizeArtifact(obj);
      }
      const next: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(obj)) {
        if (entry === undefined) continue;
        next[key] = walk(entry);
      }
      return next;
    }
    if (typeof value === 'string') {
      return applyRedactions(value, redactions);
    }
    return value;
  };

  return events.map((event) => {
    const normalized = walk(event) as NormalizedEvent;
    const runtime = { ...normalized.runtime };
    const copy: NormalizedEvent = {
      ...normalized,
      trace: normalized.trace,
      runtime
    };
    delete (copy as Partial<NormalizedEvent>).seq;
    delete (copy as Partial<NormalizedEvent>).time;
    delete (runtime as { runtime_session_id?: string }).runtime_session_id;
    return copy;
  });
}

export function applyRedactions(value: unknown, redactions: Redaction[]): unknown {
  if (typeof value === 'string') {
    return applyRedactionsToString(value, redactions);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => applyRedactions(entry, redactions));
  }
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      next[key] = applyRedactions(entry, redactions);
    }
    return next;
  }
  return value;
}

function applyRedactionsToString(value: string, redactions: Redaction[]): string {
  let next = value;
  for (const { from, to } of redactions) {
    if (!from) continue;
    next = next.split(from).join(to);
  }
  return next;
}

async function writeJson(filePath: string, data: unknown) {
  const serialized = JSON.stringify(data, null, 2);
  await writeFile(filePath, `${serialized}\n`, 'utf8');
}
