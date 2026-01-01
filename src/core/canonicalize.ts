// Deterministic JSON serialization for hashing and idempotency checks.
// This is not a full RFC 8785 JCS implementation, but it is stable for
// typical JSON payloads used in tool inputs and runtime requests.

export function canonicalizeJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Cannot canonicalize non-finite number');
    }
    // JSON.stringify handles -0 as 0.
    return JSON.stringify(value);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'bigint') {
    throw new TypeError('Cannot canonicalize bigint');
  }
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(',')}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') {
        continue;
      }
      parts.push(`${JSON.stringify(key)}:${serialize(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  // undefined, function, symbol are not valid JSON.
  return 'null';
}
