import type { CompiledRuntimeInput } from '../core/context-compiler.js';
import { hashCanonical } from '../core/hash.js';
import type { ArtifactRef, ModelInputPayload } from '../core/types.js';
import type { ArtifactStore } from './artifact-store.js';

export function storeCompiledRuntimeInput(
  store: ArtifactStore,
  input: CompiledRuntimeInput
): { input_ref: ArtifactRef; input_hash: string } {
  const input_hash = hashCanonical(input);
  const bytes = Buffer.from(JSON.stringify(input, null, 2), 'utf8');
  const input_ref = store.put(bytes, {
    contentType: 'application/json',
    name: 'model_input.json'
  });
  return { input_ref, input_hash };
}

export function buildModelInputPayload(options: {
  store: ArtifactStore;
  compiled: CompiledRuntimeInput;
  implicitSourcesRef?: ArtifactRef;
}): ModelInputPayload {
  const stored = storeCompiledRuntimeInput(options.store, options.compiled);
  return {
    input_ref: stored.input_ref,
    input_hash: stored.input_hash,
    context_window: options.compiled.context_window,
    implicit_sources_ref: options.implicitSourcesRef
  };
}
