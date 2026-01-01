import { describe, expect, it } from 'vitest';
import { hashCanonical } from '../src/core/hash.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createWorkspaceReadTool } from '../src/tools/workspace.js';

describe('ToolRegistry', () => {
  it('builds tool manifest with schema hashes', () => {
    const registry = new ToolRegistry();
    const tool = createWorkspaceReadTool();
    registry.register(tool);

    const manifest = registry.toManifest();
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.tools[0]?.schema_hash).toBe(hashCanonical(tool.inputSchema));
    expect(manifest.tools[0]?.output_schema_hash).toBe(hashCanonical(tool.outputSchema));
    expect(manifest.tools[0]?.permission).toBe(tool.defaultPermission);
  });

  it('rejects duplicate tool names', () => {
    const registry = new ToolRegistry();
    const tool = createWorkspaceReadTool();
    registry.register(tool);
    expect(() => registry.register(tool)).toThrow(/already registered/);
  });

  it('blocks dangerous tool registration by default', () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({
        name: 'workspace.exec',
        description: 'dangerous',
        defaultPermission: 'dangerous',
        handler: async () => ({ result: { ok: true } })
      })
    ).toThrow(/Dangerous tool registration disabled/);
  });

  it('validates tool inputs and outputs', () => {
    const registry = new ToolRegistry();
    registry.register(createWorkspaceReadTool());

    const invalidInput = registry.validateInput('workspace.read', { path: 123 });
    expect(invalidInput.ok).toBe(false);

    const validOutput = registry.validateOutput('workspace.read', {
      path: 'hello.txt',
      content: 'hello',
      truncated: false,
      bytes_read: 5,
      total_bytes: 5,
      encoding: 'utf8'
    });
    expect(validOutput.ok).toBe(true);
  });
});
