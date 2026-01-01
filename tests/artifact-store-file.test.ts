import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileArtifactStore } from '../src/executor/artifact-store-file.js';

describe('FileArtifactStore', () => {
  it('persists and retrieves artifacts', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'codesdk-artifacts-'));
    const store = new FileArtifactStore({ rootDir: dir });
    const ref = store.put(Buffer.from('hello', 'utf8'), {
      contentType: 'text/plain',
      name: 'hello.txt'
    });

    const record = store.get(ref.artifact_id);
    expect(record).toBeDefined();
    expect(Buffer.from(record!.data).toString('utf8')).toBe('hello');
    expect(record?.content_type).toBe('text/plain');
  });

  it('enforces maxBytes', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'codesdk-artifacts-'));
    const store = new FileArtifactStore({ rootDir: dir, maxBytes: 1 });
    expect(() => store.put(Buffer.from('too big', 'utf8'))).toThrow(/maxBytes/);
  });

  it('applies redaction before writing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'codesdk-artifacts-'));
    const store = new FileArtifactStore({
      rootDir: dir,
      redact: () => Buffer.from('redacted', 'utf8')
    });
    const ref = store.put(Buffer.from('secret', 'utf8'));
    const record = store.get(ref.artifact_id);
    expect(Buffer.from(record!.data).toString('utf8')).toBe('redacted');
  });
});
