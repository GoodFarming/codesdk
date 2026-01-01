import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnJsonRpcProcess } from '../src/runtime/json-rpc.js';

describe('JsonRpcClient', () => {
  it('sends requests and receives responses', async () => {
    const script = path.join(process.cwd(), 'tests', 'fixtures', 'jsonrpc-echo.js');
    const { client, process: proc } = spawnJsonRpcProcess('node', [script]);

    try {
      const result = await client.request('ping', { ok: true });
      expect(result).toEqual({ method: 'ping', echo: { ok: true } });
    } finally {
      client.close();
      proc.kill();
    }
  });
});
