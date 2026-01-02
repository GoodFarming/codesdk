import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export function resolveCodesdkPackageRoot(): string {
  const modulePath = resolveModuleFilePath();
  const start = modulePath ? path.dirname(modulePath) : process.cwd();
  let dir = start;
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function resolveCodesdkBinPath(binFile: string): string {
  return path.join(resolveCodesdkPackageRoot(), 'bin', binFile);
}

export async function readCodesdkPackageVersion(): Promise<string> {
  try {
    const root = resolveCodesdkPackageRoot();
    const data = await readFile(path.join(root, 'package.json'), 'utf8');
    const parsed = JSON.parse(data) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function resolveModuleFilePath(): string | undefined {
  if (typeof __filename === 'string' && __filename.length > 0) return __filename;
  const url = (import.meta as unknown as { url?: unknown }).url;
  if (typeof url === 'string' && url.startsWith('file:')) {
    return fileURLToPath(url);
  }
  return undefined;
}

