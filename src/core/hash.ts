import { createHash } from 'node:crypto';
import { canonicalizeJson } from './canonicalize.js';

export function sha256Hex(data: string | Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(data);
  return hash.digest('hex');
}

export function hashCanonical(value: unknown): string {
  const canonical = canonicalizeJson(value);
  return `sha256:${sha256Hex(canonical)}`;
}
