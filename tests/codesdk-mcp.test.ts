import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('codesdk-mcp (stdio)', () => {
  it('lists tools and executes workspace.read', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'codesdk-mcp-'));
    writeFileSync(path.join(root, 'hello.txt'), 'hello world', 'utf8');

    const transport = new StdioClientTransport({
      command: 'node',
      args: [
        path.join(process.cwd(), 'bin', 'codesdk-mcp.js'),
        '--workspace-root',
        root,
        '--permission-mode',
        'auto',
        '--tools',
        'workspace.read'
      ],
      stderr: 'pipe'
    });

    const client = new Client(
      { name: 'codesdk-mcp-test', version: '0.0.0' },
      { capabilities: {} }
    );

    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === 'workspace.read')).toBe(true);

    const result = await client.callTool({
      name: 'workspace.read',
      arguments: { path: 'hello.txt' }
    });

    const contentText =
      'content' in result && Array.isArray(result.content) && result.content[0]?.type === 'text'
        ? result.content[0].text
        : '';
    expect(contentText).toContain('hello world');

    await client.close();
  });
});

