import http from 'node:http';
import { URL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type {
  McpTransport,
  PermissionMode,
  RuntimeAdapter,
  RuntimeEnv,
  RuntimeIsolationLevel,
  RuntimeIsolationMode,
  RuntimeName,
  TranscriptMessage,
  ToolManifest
} from '../core/types.js';
import type { EventStore } from '../executor/event-store.js';
import { InMemoryEventStore } from '../executor/event-store.js';
import type { ArtifactStore } from '../executor/artifact-store.js';
import { InMemoryArtifactStore } from '../executor/artifact-store.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolExecutor } from '../executor/tool-executor.js';
import type { PermissionService } from '../executor/policy.js';
import { SimplePolicyEngine } from '../executor/policy.js';
import { ExecutorEngine } from '../executor/engine.js';
import { buildRuntimeEnv } from '../runtime-env/index.js';
import { getRuntimeAuthStatus, getRuntimeCapabilities, getRuntimeHealth } from '../runtime/index.js';
import type { Logger } from '../observability/logger.js';
import { noopLogger } from '../observability/logger.js';
import type { EngineMetrics } from '../observability/metrics.js';
import { noopMetrics } from '../observability/metrics.js';
import { createSupportBundle } from '../support/bundle.js';

export interface CodeSdkdServerOptions {
  host?: string;
  port?: number;
  runtimes: RuntimeAdapter[] | Record<string, RuntimeAdapter>;
  defaultRuntime?: RuntimeName;
  runtimeEnvBaseDir?: string;
  createRuntimeEnvDirs?: boolean;
  eventStore?: EventStore;
  artifactStore?: ArtifactStore;
  toolRegistry?: ToolRegistry;
  toolExecutor?: ToolExecutor;
  policyEngine?: PermissionService;
  logger?: Logger;
  metrics?: EngineMetrics;
  maxBodyBytes?: number;
  maxInflightTasks?: number;
  maxRequestsPerMinute?: number;
  rateLimitWindowMs?: number;
  maxSseClients?: number;
  closeOnBackpressure?: boolean;
  defaultPermissionMode?: PermissionMode;
}

export interface CodeSdkdServer {
  readonly server: http.Server;
  readonly engine: ExecutorEngine;
  listen(): Promise<{ url: string }>;
  close(): Promise<void>;
}

interface SessionRecord {
  sessionId: string;
  runtime: RuntimeAdapter;
  runtimeSession: { sessionId: string; runtimeSessionId?: string };
  env: RuntimeEnv;
  createdAt: string;
  permissionMode?: PermissionMode;
}

interface TaskRecord {
  taskId: string;
  sessionId: string;
  runtime: RuntimeAdapter;
  stop: (reason?: string) => Promise<void>;
  completion: Promise<void>;
  createdAt: string;
}

interface CreateSessionRequest {
  runtime?: RuntimeName;
  credentialNamespace?: string;
  isolationLevel?: RuntimeIsolationLevel;
  isolationMode?: RuntimeIsolationMode;
  cwd?: string;
  env?: Record<string, string>;
  model?: string;
  permissionMode?: PermissionMode;
  runtimeConfig?: Record<string, unknown>;
}

interface StartTaskRequest {
  taskId?: string;
  messages: TranscriptMessage[];
  permissionMode?: PermissionMode;
  runtimeConfig?: Record<string, unknown>;
  toolManifest?: ToolManifest;
}

interface ToolCallDecisionRequest {
  attempt: number;
  input_hash: string;
  reason?: string;
}

class RateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number
  ) {}

  check(key: string) {
    const now = Date.now();
    const current = this.entries.get(key);
    if (!current || now >= current.resetAt) {
      const entry = { count: 1, resetAt: now + this.windowMs };
      this.entries.set(key, entry);
      return { ok: true, remaining: this.max - 1, resetAt: entry.resetAt };
    }
    current.count += 1;
    const remaining = Math.max(0, this.max - current.count);
    return { ok: current.count <= this.max, remaining, resetAt: current.resetAt };
  }
}

export function createCodeSdkdServer(options: CodeSdkdServerOptions): CodeSdkdServer {
  const logger = options.logger ?? noopLogger;
  const metrics = options.metrics ?? noopMetrics;
  const eventStore = options.eventStore ?? new InMemoryEventStore();
  const artifactStore = options.artifactStore ?? new InMemoryArtifactStore();
  const toolRegistry = options.toolRegistry;
  const toolExecutor = options.toolExecutor;
  const policyEngine = options.policyEngine ?? new SimplePolicyEngine();
  const engine = new ExecutorEngine({
    eventStore,
    artifactStore,
    toolRegistry,
    toolExecutor,
    policyEngine,
    logger,
    metrics
  });

  const runtimeMap = normalizeRuntimes(options.runtimes);
  const defaultRuntime =
    options.defaultRuntime && runtimeMap.has(options.defaultRuntime)
      ? options.defaultRuntime
      : runtimeMap.keys().next().value;

  if (!defaultRuntime) {
    throw new Error('codesdkd requires at least one runtime adapter');
  }

  const sessions = new Map<string, SessionRecord>();
  const tasks = new Map<string, TaskRecord>();
  let inflightTasks = 0;
  let sseClients = 0;

  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const maxInflightTasks = options.maxInflightTasks ?? 32;
  const maxSseClients = options.maxSseClients ?? 64;
  const closeOnBackpressure = options.closeOnBackpressure ?? true;
  const rateLimiter =
    options.maxRequestsPerMinute && options.maxRequestsPerMinute > 0
      ? new RateLimiter(options.maxRequestsPerMinute, options.rateLimitWindowMs ?? 60_000)
      : undefined;

  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    const requestLogger = logger.child({ request_id: requestId });
    try {
      if (rateLimiter) {
        const key = req.socket.remoteAddress ?? 'unknown';
        const limit = rateLimiter.check(key);
        if (!limit.ok) {
          metrics.recordBackpressureDrop('rate_limit');
          res.setHeader('Retry-After', Math.ceil((limit.resetAt - Date.now()) / 1000));
          return sendJson(res, 429, {
            error: 'rate_limited',
            message: 'Too many requests'
          });
        }
        res.setHeader('X-RateLimit-Remaining', Math.max(0, limit.remaining));
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const method = req.method ?? 'GET';
      const segments = url.pathname.split('/').filter(Boolean);

      if (method === 'GET' && segments.length === 0) {
        return sendJson(res, 200, {
          ok: true,
          name: 'codesdkd',
          runtimes: Array.from(runtimeMap.keys())
        });
      }

      if (method === 'GET' && segments[0] === 'health') {
        return handleHealth(res, url, runtimeMap, options, defaultRuntime);
      }

      if (method === 'GET' && segments[0] === 'capabilities') {
        return handleCapabilities(res, url, runtimeMap, defaultRuntime);
      }

      if (method === 'GET' && segments[0] === 'auth' && segments[1] === 'status') {
        return handleAuthStatus(res, url, runtimeMap, defaultRuntime, options);
      }

      if (method === 'GET' && segments[0] === 'metrics') {
        const maybeProm = metrics as EngineMetrics & { metrics?: () => Promise<string> };
        if (!maybeProm.metrics) {
          return sendJson(res, 404, { error: 'metrics_unavailable' });
        }
        const body = await maybeProm.metrics();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.end(body);
        return;
      }

      if (segments[0] === 'sessions' && segments.length === 1 && method === 'GET') {
        const limitRaw = parseNumber(url.searchParams.get('limit')) ?? 100;
        const limit = Math.max(1, Math.min(500, limitRaw));
        const after = url.searchParams.get('after');

        const entries = Array.from(sessions.values());
        let startIndex = 0;
        if (after) {
          const idx = entries.findIndex((entry) => entry.sessionId === after);
          if (idx === -1) {
            return sendJson(res, 400, { error: 'invalid_cursor', after });
          }
          startIndex = idx + 1;
        }

        const slice = entries.slice(startIndex, startIndex + limit);
        const nextAfter = slice.length === limit ? slice[slice.length - 1]?.sessionId ?? null : null;

        return sendJson(res, 200, {
          sessions: slice.map((entry) => ({
            session_id: entry.sessionId,
            runtime: entry.runtime.name,
            runtime_session_id: entry.runtimeSession.runtimeSessionId ?? null,
            created_at: entry.createdAt
          })),
          next_after: nextAfter
        });
      }

      if (segments[0] === 'sessions' && method === 'POST' && segments.length === 1) {
        const body = await readJsonBody<CreateSessionRequest>(req, maxBodyBytes);
        const runtimeName = body?.runtime ?? defaultRuntime;
        const runtime = runtimeMap.get(runtimeName);
        if (!runtime) {
          return sendJson(res, 400, { error: 'unknown_runtime', runtime: runtimeName });
        }
        const provisionalSessionId = randomUUID();
        const env = buildRuntimeEnv({
          credentialNamespace: body?.credentialNamespace ?? 'default',
          isolationLevel: body?.isolationLevel,
          isolationMode: body?.isolationMode,
          baseDir: options.runtimeEnvBaseDir,
          cwd: body?.cwd,
          env: body?.env,
          sessionId: provisionalSessionId,
          createDirs: options.createRuntimeEnvDirs
        });

        const runtimeSession = runtime.createSession
          ? await runtime.createSession(env, {
              title: body?.runtime ? `codesdkd:${runtime.name}` : 'codesdkd',
              model: body?.model,
              permissionMode: body?.permissionMode,
              runtimeConfig: body?.runtimeConfig
            })
          : { sessionId: provisionalSessionId };

        const sessionId = runtimeSession.sessionId;

        sessions.set(sessionId, {
          sessionId: sessionId,
          runtime,
          runtimeSession,
          env,
          createdAt: new Date().toISOString(),
          permissionMode: body?.permissionMode
        });

        return sendJson(res, 201, {
          session_id: sessionId,
          runtime: runtime.name,
          runtime_session_id: runtimeSession.runtimeSessionId ?? null,
          created_at: new Date().toISOString()
        });
      }

      if (segments[0] === 'sessions' && segments.length >= 2) {
        const sessionId = segments[1]!;
        const record = sessions.get(sessionId);
        if (!record) {
          return sendJson(res, 404, { error: 'session_not_found', session_id: sessionId });
        }

        if (segments.length === 2 && method === 'GET') {
          return sendJson(res, 200, {
            session_id: sessionId,
            runtime: record.runtime.name,
            created_at: record.createdAt
          });
        }

        if (segments.length === 3 && segments[2] === 'events' && method === 'GET') {
          const stream = url.searchParams.get('stream') === '1' || isEventStream(req);
          const afterSeq = parseNumber(url.searchParams.get('after_seq'));
          const fromSeq = parseNumber(url.searchParams.get('from_seq'));
          const startFrom = afterSeq ?? fromSeq;

          if (stream) {
            if (sseClients >= maxSseClients) {
              metrics.recordBackpressureDrop('max_sse_clients');
              return sendJson(res, 429, { error: 'sse_limit', message: 'Too many SSE clients' });
            }
            sseClients += 1;
            await streamEvents(req, res, eventStore, sessionId, startFrom, {
              closeOnBackpressure,
              metrics,
              onClose: () => {
                sseClients = Math.max(0, sseClients - 1);
              }
            });
            return;
          }

          const limit = parseNumber(url.searchParams.get('limit')) ?? 500;
          const events = eventStore.list(sessionId, { afterSeq: startFrom, limit });
          const nextSeq = events.length ? events[events.length - 1]?.seq : startFrom ?? 0;
          return sendJson(res, 200, { events, next_seq: nextSeq });
        }

        if (segments.length === 3 && segments[2] === 'support-bundle' && method === 'GET') {
          const taskId = url.searchParams.get('task_id') ?? undefined;
          return handleSupportBundle(res, {
            sessionId,
            taskId,
            runtime: record.runtime,
            env: record.env,
            eventStore,
            artifactStore
          });
        }

        if (
          segments.length === 5 &&
          segments[2] === 'tool-calls' &&
          segments[4] === 'approve' &&
          method === 'POST'
        ) {
          const toolCallId = segments[3]!;
          const body = await readJsonBody<ToolCallDecisionRequest>(req, maxBodyBytes);
          if (!body || typeof body.attempt !== 'number' || typeof body.input_hash !== 'string') {
            return sendJson(res, 400, {
              error: 'invalid_request',
              message: 'attempt (number) and input_hash (string) required'
            });
          }
          const decision = engine.approveToolCall(sessionId, toolCallId, {
            attempt: body.attempt,
            input_hash: body.input_hash
          });
          if (!decision.ok) {
            const status = decision.error === 'tool_call_not_pending' ? 404 : 409;
            return sendJson(res, status, { error: decision.error, tool_call_id: toolCallId });
          }
          return sendJson(res, 200, { ok: true, tool_call_id: toolCallId });
        }

        if (
          segments.length === 5 &&
          segments[2] === 'tool-calls' &&
          segments[4] === 'deny' &&
          method === 'POST'
        ) {
          const toolCallId = segments[3]!;
          const body = await readJsonBody<ToolCallDecisionRequest>(req, maxBodyBytes);
          if (!body || typeof body.attempt !== 'number' || typeof body.input_hash !== 'string') {
            return sendJson(res, 400, {
              error: 'invalid_request',
              message: 'attempt (number) and input_hash (string) required'
            });
          }
          const decision = engine.denyToolCall(sessionId, toolCallId, {
            attempt: body.attempt,
            input_hash: body.input_hash,
            reason: body.reason
          });
          if (!decision.ok) {
            const status = decision.error === 'tool_call_not_pending' ? 404 : 409;
            return sendJson(res, status, { error: decision.error, tool_call_id: toolCallId });
          }
          return sendJson(res, 200, { ok: true, tool_call_id: toolCallId });
        }

        if (segments.length === 3 && segments[2] === 'tasks' && method === 'POST') {
          if (inflightTasks >= maxInflightTasks) {
            metrics.recordBackpressureDrop('max_inflight_tasks');
            return sendJson(res, 429, { error: 'backpressure', message: 'Too many inflight tasks' });
          }
          const body = await readJsonBody<StartTaskRequest>(req, maxBodyBytes);
          if (!body?.messages || !Array.isArray(body.messages)) {
            return sendJson(res, 400, { error: 'invalid_request', message: 'messages required' });
          }
          const taskId = body.taskId ?? randomUUID();
          inflightTasks += 1;
          const handle = engine.startTask({
            sessionId,
            taskId,
            env: record.env,
            runtime: record.runtime,
            runtimeSession: record.runtimeSession,
            messages: body.messages,
            permissionMode: body.permissionMode ?? record.permissionMode ?? options.defaultPermissionMode ?? 'auto',
            toolManifest: body.toolManifest ?? toolRegistry?.toManifest(),
            runtimeConfig: body.runtimeConfig
          });
          const taskRecord: TaskRecord = {
            taskId,
            sessionId,
            runtime: record.runtime,
            stop: handle.stop,
            completion: handle.completion,
            createdAt: new Date().toISOString()
          };
          tasks.set(taskKey(sessionId, taskId), taskRecord);
          handle.completion.finally(() => {
            inflightTasks = Math.max(0, inflightTasks - 1);
            tasks.delete(taskKey(sessionId, taskId));
          });

          return sendJson(res, 202, {
            session_id: sessionId,
            task_id: taskId,
            status: 'started'
          });
        }

        if (segments.length === 4 && segments[2] === 'tasks' && method === 'GET') {
          const taskId = segments[3]!;
          const status = deriveTaskStatus(eventStore, sessionId, taskId);
          return sendJson(res, 200, status);
        }

        if (segments.length === 5 && segments[2] === 'tasks' && segments[4] === 'stop' && method === 'POST') {
          const taskId = segments[3]!;
          const recordTask = tasks.get(taskKey(sessionId, taskId));
          if (!recordTask) {
            return sendJson(res, 404, { error: 'task_not_found', task_id: taskId });
          }
          await recordTask.stop('stop requested via api');
          return sendJson(res, 200, { ok: true, task_id: taskId });
        }
      }

      if (segments[0] === 'artifacts' && segments.length === 2 && method === 'GET') {
        const artifactId = segments[1]!;
        const record = artifactStore.get(artifactId);
        if (!record) {
          return sendJson(res, 404, { error: 'artifact_not_found', artifact_id: artifactId });
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', record.content_type ?? 'application/octet-stream');
        res.setHeader('Content-Length', String(record.data.byteLength));
        res.end(Buffer.from(record.data));
        return;
      }

      if (
        segments[0] === 'artifacts' &&
        segments.length === 3 &&
        segments[2] === 'download' &&
        method === 'GET'
      ) {
        const artifactId = segments[1]!;
        const record = artifactStore.get(artifactId);
        if (!record) {
          return sendJson(res, 404, { error: 'artifact_not_found', artifact_id: artifactId });
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', record.content_type ?? 'application/octet-stream');
        res.setHeader('Content-Length', String(record.data.byteLength));
        res.end(Buffer.from(record.data));
        return;
      }

      res.statusCode = 404;
      res.end();
    } catch (error) {
      const status =
        typeof (error as { status?: number }).status === 'number'
          ? (error as { status: number }).status
          : 500;
      requestLogger.error('codesdkd.request_failed', {
        status,
        error: error instanceof Error ? error.message : String(error)
      });
      if (!res.headersSent) {
        const errorCode =
          status === 400 ? 'invalid_request' : status === 413 ? 'payload_too_large' : 'server_error';
        return sendJson(res, status, { error: errorCode });
      }
      res.end();
    }
  });

  return {
    server,
    engine,
    async listen() {
      const port = options.port ?? 3000;
      const host = options.host ?? '127.0.0.1';
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
      });
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      return { url: `http://${host}:${actualPort}` };
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  };
}

function normalizeRuntimes(
  runtimes: RuntimeAdapter[] | Record<string, RuntimeAdapter>
): Map<RuntimeName, RuntimeAdapter> {
  const map = new Map<RuntimeName, RuntimeAdapter>();
  if (Array.isArray(runtimes)) {
    for (const runtime of runtimes) {
      map.set(runtime.name, runtime);
    }
    return map;
  }
  for (const entry of Object.values(runtimes)) {
    map.set(entry.name, entry);
  }
  return map;
}

async function handleHealth(
  res: http.ServerResponse,
  url: URL,
  runtimeMap: Map<RuntimeName, RuntimeAdapter>,
  options: CodeSdkdServerOptions,
  defaultRuntime: RuntimeName
) {
  const runtimeName = (url.searchParams.get('runtime') as RuntimeName | null) ?? defaultRuntime;
  if (runtimeName) {
    const runtime = runtimeMap.get(runtimeName);
    if (!runtime) {
      return sendJson(res, 400, { error: 'unknown_runtime', runtime: runtimeName });
    }
    const env = buildRuntimeEnv({
      credentialNamespace: 'health',
      isolationLevel: 'shared',
      isolationMode: runtime.getCapabilities().recommendedIsolationMode,
      baseDir: options.runtimeEnvBaseDir,
      createDirs: options.createRuntimeEnvDirs
    });
    const health = await getRuntimeHealth(runtime, env, { includeAuth: true });
    return sendJson(res, 200, health);
  }

  const entries = await Promise.all(
    Array.from(runtimeMap.values()).map(async (runtime) => {
      const env = buildRuntimeEnv({
        credentialNamespace: 'health',
        isolationLevel: 'shared',
        isolationMode: runtime.getCapabilities().recommendedIsolationMode,
        baseDir: options.runtimeEnvBaseDir,
        createDirs: options.createRuntimeEnvDirs
      });
      const health = await getRuntimeHealth(runtime, env, { includeAuth: true });
      return [runtime.name, health] as const;
    })
  );
  return sendJson(res, 200, { runtimes: Object.fromEntries(entries) });
}

function handleCapabilities(
  res: http.ServerResponse,
  url: URL,
  runtimeMap: Map<RuntimeName, RuntimeAdapter>,
  defaultRuntime: RuntimeName
) {
  const runtimeName = (url.searchParams.get('runtime') as RuntimeName | null) ?? defaultRuntime;
  if (runtimeName) {
    const runtime = runtimeMap.get(runtimeName);
    if (!runtime) {
      return sendJson(res, 400, { error: 'unknown_runtime', runtime: runtimeName });
    }
    return sendJson(res, 200, runtime.getCapabilities());
  }
  const entries = Array.from(runtimeMap.values()).map((runtime) => [
    runtime.name,
    runtime.getCapabilities()
  ]);
  return sendJson(res, 200, { runtimes: Object.fromEntries(entries) });
}

async function handleAuthStatus(
  res: http.ServerResponse,
  url: URL,
  runtimeMap: Map<RuntimeName, RuntimeAdapter>,
  defaultRuntime: RuntimeName,
  options: CodeSdkdServerOptions
) {
  const runtimeName = (url.searchParams.get('runtime') as RuntimeName | null) ?? defaultRuntime;
  if (runtimeName) {
    const runtime = runtimeMap.get(runtimeName);
    if (!runtime) {
      return sendJson(res, 400, { error: 'unknown_runtime', runtime: runtimeName });
    }
    const env = buildRuntimeEnv({
      credentialNamespace: 'auth',
      isolationLevel: 'shared',
      isolationMode: runtime.getCapabilities().recommendedIsolationMode,
      baseDir: options.runtimeEnvBaseDir,
      createDirs: options.createRuntimeEnvDirs
    });
    const status = await getRuntimeAuthStatus(runtime, env);
    return sendJson(res, 200, status);
  }

  const entries = await Promise.all(
    Array.from(runtimeMap.values()).map(async (runtime) => {
      const env = buildRuntimeEnv({
        credentialNamespace: 'auth',
        isolationLevel: 'shared',
        isolationMode: runtime.getCapabilities().recommendedIsolationMode,
        baseDir: options.runtimeEnvBaseDir,
        createDirs: options.createRuntimeEnvDirs
      });
      const status = await getRuntimeAuthStatus(runtime, env);
      return [runtime.name, status] as const;
    })
  );
  return sendJson(res, 200, { runtimes: Object.fromEntries(entries) });
}

async function streamEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  eventStore: EventStore,
  sessionId: string,
  fromSeq: number | undefined,
  options: { closeOnBackpressure: boolean; metrics: EngineMetrics; onClose: () => void }
) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });

  const iterable = eventStore.subscribe(sessionId, { fromSeq });
  const iterator = iterable[Symbol.asyncIterator]();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    options.onClose();
    if (iterator.return) {
      void iterator.return();
    }
  };

  req.on('close', close);
  await writeSse(res, `event: ready\ndata: ${JSON.stringify({ session_id: sessionId })}\n\n`, options);

  const heartbeat = setInterval(() => {
    void writeSse(res, ':heartbeat\n\n', options);
  }, 15_000);

  try {
    while (true) {
      const { value, done } = await iterator.next();
      if (done || closed) break;
      const payload = `data: ${JSON.stringify(value)}\n\n`;
      const ok = await writeSse(res, payload, options);
      if (!ok) break;
    }
  } finally {
    clearInterval(heartbeat);
    close();
    res.end();
  }
}

async function writeSse(
  res: http.ServerResponse,
  payload: string,
  options: { closeOnBackpressure: boolean; metrics: EngineMetrics }
) {
  const ok = res.write(payload);
  if (ok) return true;
  if (options.closeOnBackpressure) {
    options.metrics.recordBackpressureDrop('sse_backpressure');
    return false;
  }
  await once(res, 'drain');
  return true;
}

async function readJsonBody<T>(req: http.IncomingMessage, limit: number): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  return new Promise((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
        resolve(data);
      } catch (error) {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function parseNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) ? num : undefined;
}

function isEventStream(req: http.IncomingMessage) {
  const accept = req.headers.accept ?? '';
  return accept.includes('text/event-stream');
}

function deriveTaskStatus(eventStore: EventStore, sessionId: string, taskId: string) {
  const events = eventStore.list(sessionId);
  let status: 'running' | 'completed' | 'failed' | 'stopped' | 'unknown' = 'unknown';
  let lastSeq: number | undefined;
  for (const event of events) {
    if (event.trace.task_id !== taskId) continue;
    lastSeq = event.seq;
    if (event.type === 'task.completed') status = 'completed';
    if (event.type === 'task.failed') status = 'failed';
    if (event.type === 'task.stopped') status = 'stopped';
    if (status === 'unknown') status = 'running';
  }
  return {
    session_id: sessionId,
    task_id: taskId,
    status,
    last_seq: lastSeq ?? null
  };
}

function taskKey(sessionId: string, taskId: string) {
  return `${sessionId}:${taskId}`;
}

async function handleSupportBundle(
  res: http.ServerResponse,
  options: {
    sessionId: string;
    taskId?: string;
    runtime: RuntimeAdapter;
    env: RuntimeEnv;
    eventStore: EventStore;
    artifactStore: ArtifactStore;
  }
) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'codesdkd-bundle-'));
  const filename = options.taskId
    ? `codesdk-support-bundle-${options.sessionId}-${options.taskId}.tar.gz`
    : `codesdk-support-bundle-${options.sessionId}.tar.gz`;
  const outputPath = path.join(tmpDir, filename);

  try {
    await createSupportBundle({
      outputPath,
      sessionId: options.sessionId,
      taskId: options.taskId,
      runtime: options.runtime,
      env: options.env,
      eventStore: options.eventStore,
      artifactStore: options.artifactStore,
      mcp: {
        chosen: inferMcpTransport(options.runtime)
      },
      maxArtifactBytes: 1024 * 1024,
      redactArtifact: redactArtifactBestEffort
    });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(outputPath);
      stream.on('error', reject);
      res.on('error', reject);
      res.on('finish', resolve);
      stream.pipe(res);
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function inferMcpTransport(runtime: RuntimeAdapter): McpTransport | undefined {
  if (runtime.name === 'codex-sdk' || runtime.name === 'opencode-server') {
    return 'stdio';
  }
  return undefined;
}

function redactArtifactBestEffort(data: Uint8Array, ref: { content_type?: string }): Uint8Array {
  const contentType = ref.content_type ?? '';
  if (!contentType.startsWith('text/') && contentType !== 'application/json') return data;
  const text = Buffer.from(data).toString('utf8');
  const redacted = text
    .replace(/Bearer\\s+[A-Za-z0-9._\\-]+/g, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9]{10,}/g, 'sk-[REDACTED]')
    .replace(/\"access_token\"\\s*:\\s*\"[^\"]+\"/g, '"access_token":"[REDACTED]"')
    .replace(/\"refresh_token\"\\s*:\\s*\"[^\"]+\"/g, '"refresh_token":"[REDACTED]"');
  return Buffer.from(redacted, 'utf8');
}
