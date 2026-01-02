#!/usr/bin/env node
import process from 'node:process';
import { parseCodesdkMcpArgs, startCodesdkMcp } from '../dist/index.js';

const parsed = parseCodesdkMcpArgs(process.argv.slice(2));
if (parsed.kind === 'help') {
  process.stdout.write(`${parsed.message}\n`);
  process.exit(parsed.exitCode);
}
if (parsed.kind === 'error') {
  process.stderr.write(`${parsed.message}\n\n${parseCodesdkMcpArgs(['--help']).message}\n`);
  process.exit(parsed.exitCode);
}

const mcp = await startCodesdkMcp(parsed.config);

const shutdown = async (signal) => {
  try {
    await mcp.close();
  } finally {
    process.exit(signal === 'SIGINT' ? 130 : 0);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

