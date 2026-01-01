import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from '../src/core/canonicalize.js';
import { hashCanonical } from '../src/core/hash.js';

describe('canonicalizeJson', () => {
  it('stably orders object keys', () => {
    const a = { b: 1, a: 2 };
    const b = { a: 2, b: 1 };
    expect(canonicalizeJson(a)).toBe(canonicalizeJson(b));
  });

  it('ignores undefined values', () => {
    const v = { a: 1, b: undefined };
    expect(canonicalizeJson(v)).toBe('{"a":1}');
  });
});

describe('hashCanonical', () => {
  it('produces stable hash for equivalent objects', () => {
    const a = { b: 1, a: 2 };
    const b = { a: 2, b: 1 };
    expect(hashCanonical(a)).toBe(hashCanonical(b));
  });
});
