import type { ArtifactRef } from '../core/types.js';
import type { ArtifactStore } from './artifact-store.js';
import type { ImplicitSourcesSnapshot } from '../core/implicit-sources.js';

export function storeImplicitSourcesSnapshot(
  store: ArtifactStore,
  snapshot: ImplicitSourcesSnapshot
): ArtifactRef {
  const data = Buffer.from(JSON.stringify(snapshot, null, 2), 'utf8');
  return store.put(data, { contentType: 'application/json', name: 'implicit_sources.json' });
}
