import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message && typeof message.id !== 'undefined') {
    const response = {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        method: message.method,
        echo: message.params ?? null
      }
    };
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
});
