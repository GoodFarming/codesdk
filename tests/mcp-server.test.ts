import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InProcessMcpServer } from '../src/mcp/server.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createWorkspaceReadTool } from '../src/tools/workspace.js';

describe('InProcessMcpServer', () => {
  it('lists tools and executes workspace.read when allowed', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'codesdk-workspace-'));
    const filePath = path.join(root, 'hello.txt');
    writeFileSync(filePath, 'hello world', 'utf8');

    const registry = new ToolRegistry();
    registry.register(createWorkspaceReadTool());
    const server = new InProcessMcpServer({
      registry,
      context: { workspaceRoot: root },
      permissionMode: 'auto'
    });

    const list = server.listTools();
    expect(list.tools.some((tool) => tool.name === 'workspace.read')).toBe(true);

    const result = await server.callTool('workspace.read', { path: 'hello.txt' });
    expect(result.ok).toBe(true);
    expect((result.result as { content: string }).content).toContain('hello world');
  });

  it('returns approval required in ask mode', async () => {
    const registry = new ToolRegistry();
    registry.register(createWorkspaceReadTool());
    const server = new InProcessMcpServer({
      registry,
      context: { workspaceRoot: process.cwd() },
      permissionMode: 'ask'
    });

    const result = await server.callTool('workspace.read', { path: 'any.txt' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('approval required');
    expect(result.policy_snapshot.decision).toBe('ask');
  });

  it('blocks path traversal', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'codesdk-workspace-'));
    const registry = new ToolRegistry();
    registry.register(createWorkspaceReadTool());
    const server = new InProcessMcpServer({
      registry,
      context: { workspaceRoot: root },
      permissionMode: 'auto'
    });

    const result = await server.callTool('workspace.read', { path: '../secrets.txt' });
    expect(result.ok).toBe(false);
    expect(result.is_error).toBe(true);
  });

  it('rejects invalid tool input via schema validation', async () => {
    const registry = new ToolRegistry();
    registry.register(createWorkspaceReadTool());
    const server = new InProcessMcpServer({
      registry,
      context: { workspaceRoot: process.cwd() },
      permissionMode: 'auto'
    });

    const result = await server.callTool('workspace.read', { path: 123 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid tool input');
  });
});
