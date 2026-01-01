import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export async function replayNdjson(filePath: string): Promise<unknown[]> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const events: unknown[] = [];

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      events.push({ type: 'invalid', raw: trimmed });
    }
  }

  return events;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: codesdk-replay <path-to-ndjson>');
    process.exit(1);
  }
  const events = await replayNdjson(filePath);
  process.stdout.write(`${JSON.stringify(events, null, 2)}\n`);
}
