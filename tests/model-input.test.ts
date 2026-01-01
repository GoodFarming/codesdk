import { describe, expect, it } from 'vitest';
import { compileRuntimeInput } from '../src/core/context-compiler.js';
import { hashCanonical } from '../src/core/hash.js';
import { buildImplicitSourcesSnapshot } from '../src/core/implicit-sources.js';
import { InMemoryArtifactStore } from '../src/executor/artifact-store.js';
import { storeImplicitSourcesSnapshot } from '../src/executor/implicit-sources.js';
import { buildModelInputPayload, storeCompiledRuntimeInput } from '../src/executor/model-input.js';
import type { TranscriptMessage } from '../src/core/types.js';

describe('model input storage', () => {
  it('stores compiled input with canonical hash', () => {
    const messages: TranscriptMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'world' }] }
    ];
    const compiled = compileRuntimeInput(messages, { maxChars: 100 });
    const store = new InMemoryArtifactStore();

    const stored = storeCompiledRuntimeInput(store, compiled);
    expect(stored.input_hash).toBe(hashCanonical(compiled));

    const record = store.get(stored.input_ref.artifact_id);
    expect(record).toBeDefined();
    const parsed = JSON.parse(Buffer.from(record!.data).toString('utf8')) as typeof compiled;
    expect(parsed.context_window).toEqual(compiled.context_window);
  });

  it('builds payload with implicit sources ref', () => {
    const messages: TranscriptMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] }
    ];
    const compiled = compileRuntimeInput(messages, { maxChars: 100 });
    const store = new InMemoryArtifactStore();
    const snapshot = buildImplicitSourcesSnapshot({ disabled: true, reason: 'disabled' });
    const implicitRef = storeImplicitSourcesSnapshot(store, snapshot);

    const payload = buildModelInputPayload({
      store,
      compiled,
      implicitSourcesRef: implicitRef
    });

    expect(payload.input_hash).toBe(hashCanonical(compiled));
    expect(payload.context_window).toEqual(compiled.context_window);
    expect(payload.implicit_sources_ref?.artifact_id).toBe(implicitRef.artifact_id);
  });
});
