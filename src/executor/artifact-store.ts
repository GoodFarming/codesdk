import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../core/hash.js';
import type { ArtifactRef } from '../core/types.js';

export interface ArtifactRecord extends ArtifactRef {
  data: Uint8Array;
}

export interface ArtifactStore {
  put(data: Uint8Array, options?: { contentType?: string; name?: string }): ArtifactRef;
  get(artifactId: string): ArtifactRecord | undefined;
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly records = new Map<string, ArtifactRecord>();

  put(data: Uint8Array, options?: { contentType?: string; name?: string }): ArtifactRef {
    const content_hash = `sha256:${sha256Hex(data)}`;
    const artifact_id = randomUUID();
    const record: ArtifactRecord = {
      artifact_id,
      content_type: options?.contentType,
      content_hash,
      size_bytes: data.byteLength,
      name: options?.name,
      data
    };
    this.records.set(artifact_id, record);
    return {
      artifact_id,
      content_type: record.content_type,
      content_hash,
      size_bytes: record.size_bytes,
      name: record.name
    };
  }

  get(artifactId: string): ArtifactRecord | undefined {
    return this.records.get(artifactId);
  }
}
