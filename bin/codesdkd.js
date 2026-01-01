#!/usr/bin/env node
import process from 'node:process';
import { parseCodesdkdArgs, startCodesdkd } from '../dist/index.js';

const parsed = parseCodesdkdArgs(process.argv.slice(2));
if (parsed.kind === 'help') {
  process.stdout.write(`${parsed.message}\n`);
  process.exit(parsed.exitCode);
}
if (parsed.kind === 'error') {
  process.stderr.write(`${parsed.message}\n\n${parseCodesdkdArgs(['--help']).message}\n`);
  process.exit(parsed.exitCode);
}

const { url, daemon } = await startCodesdkd(parsed.config);
process.stdout.write(`${JSON.stringify({ url })}\n`);

const shutdown = async (signal) => {
  try {
    await daemon.close();
  } finally {
    process.exit(signal === 'SIGINT' ? 130 : 0);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

