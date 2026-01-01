import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../core/hash.js';
import type { ArtifactRecord, ArtifactStore } from './artifact-store.js';
import type { ArtifactRef } from '../core/types.js';

export interface FileArtifactStoreOptions {
  rootDir: string;
  maxBytes?: number;
  redact?: (data: Uint8Array) => Uint8Array;
}

export class FileArtifactStore implements ArtifactStore {
  private readonly rootDir: string;
  private readonly dataDir: string;
  private readonly metaDir: string;
  private readonly maxBytes?: number;
  private readonly redact?: (data: Uint8Array) => Uint8Array;

  constructor(options: FileArtifactStoreOptions) {
    this.rootDir = options.rootDir;
    this.dataDir = path.join(this.rootDir, 'data');
    this.metaDir = path.join(this.rootDir, 'meta');
    this.maxBytes = options.maxBytes;
    this.redact = options.redact;
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.metaDir, { recursive: true });
  }

  put(data: Uint8Array, options?: { contentType?: string; name?: string }): ArtifactRef {
    const payload = this.redact ? this.redact(data) : data;
    if (this.maxBytes && payload.byteLength > this.maxBytes) {
      throw new Error(`artifact exceeds maxBytes (${payload.byteLength} > ${this.maxBytes})`);
    }

    const content_hash = `sha256:${sha256Hex(payload)}`;
    const artifact_id = randomUUID();
    const record: ArtifactRecord = {
      artifact_id,
      content_type: options?.contentType,
      content_hash,
      size_bytes: payload.byteLength,
      name: options?.name,
      data: payload
    };

    writeFileSync(this.dataPath(artifact_id), payload);
    writeFileSync(this.metaPath(artifact_id), JSON.stringify(record, null, 2), 'utf8');

    return {
      artifact_id,
      content_type: record.content_type,
      content_hash: record.content_hash,
      size_bytes: record.size_bytes,
      name: record.name
    };
  }

  get(artifactId: string): ArtifactRecord | undefined {
    try {
      const metaRaw = readFileSync(this.metaPath(artifactId), 'utf8');
      const meta = JSON.parse(metaRaw) as ArtifactRecord;
      const data = readFileSync(this.dataPath(artifactId));
      return { ...meta, data };
    } catch {
      return undefined;
    }
  }

  private dataPath(artifactId: string) {
    return path.join(this.dataDir, `${artifactId}.bin`);
  }

  private metaPath(artifactId: string) {
    return path.join(this.metaDir, `${artifactId}.json`);
  }
}
