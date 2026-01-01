import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export async function streamNdjson(filePath: string, onEvent: (event: unknown) => void): Promise<void> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      onEvent(event);
    } catch {
      onEvent({ type: 'invalid', raw: trimmed });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: codesdk-viewer <path-to-ndjson>');
    process.exit(1);
  }
  await streamNdjson(filePath, (event) => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  });
}
