import type { NormalizedEvent } from './types.js';

export type UpcastResult = {
  event: NormalizedEvent;
  upgraded: boolean;
};

// Placeholder upcaster: future schema changes should be handled here.
export function upcastEvent(event: NormalizedEvent, latestSchemaVersion = 1): UpcastResult {
  if (event.schema_version === latestSchemaVersion) {
    return { event, upgraded: false };
  }

  // Example: if older versions exist, transform here.
  const upgradedEvent: NormalizedEvent = {
    ...event,
    schema_version: latestSchemaVersion
  };

  return { event: upgradedEvent, upgraded: true };
}
