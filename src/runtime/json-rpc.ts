import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export class JsonRpcClient extends EventEmitter {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private nextId = 1;
  private closed = false;

  constructor(proc: ChildProcessWithoutNullStreams) {
    super();
    this.proc = proc;
    this.attach();
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('JSON-RPC client is closed'));
    }
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const payload = `${JSON.stringify(message)}\n`;
    this.proc.stdin.write(payload);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const message: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) {
      reject(new Error('JSON-RPC client closed'));
    }
    this.pending.clear();
    this.proc.kill();
  }

  private attach() {
    const rl = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message: JsonRpcResponse | JsonRpcNotification | null = null;
      try {
        message = JSON.parse(trimmed);
      } catch {
        this.emit('error', new Error(`Invalid JSON-RPC message: ${trimmed}`));
        return;
      }
      if (typeof (message as JsonRpcResponse).id !== 'undefined') {
        this.handleResponse(message as JsonRpcResponse);
      } else if ((message as JsonRpcNotification).method) {
        this.emit('notification', message as JsonRpcNotification);
      }
    });

    this.proc.on('exit', (code) => {
      if (this.closed) return;
      this.closed = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error(`JSON-RPC process exited with code ${code ?? 'unknown'}`));
      }
      this.pending.clear();
    });

    this.proc.on('error', (err) => {
      this.emit('error', err);
    });
  }

  private handleResponse(response: JsonRpcResponse) {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.error) {
      const err = new Error(response.error.message);
      (err as Error & { data?: unknown }).data = response.error.data;
      pending.reject(err);
      return;
    }
    pending.resolve(response.result);
  }
}

export function spawnJsonRpcProcess(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): { client: JsonRpcClient; process: ChildProcessWithoutNullStreams } {
  const proc = spawn(command, args, {
    cwd: options?.cwd,
    env: options?.env,
    stdio: 'pipe'
  });
  const client = new JsonRpcClient(proc);
  return { client, process: proc };
}
