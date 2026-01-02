# CodeSDK

SDK-first wrapper over agent runtimes. Unifies sessions, streaming, tools, artifacts, and support bundles while keeping runtime-specific adapters and OAuth isolation.

## Highlights

- Unified session/task/event model across runtimes
- Deterministic event sourcing + replay fixtures
- MCP tool hosting + sandbox support
- Daemon-first API (`codesdkd`) for embedding

## Requirements

- Node.js 20+
- Docker (optional, for sandboxed tool execution)

## Install (from source)

```bash
npm install
npm run build
```

## Quick start (library)

```ts
import { randomUUID } from 'node:crypto';
import {
  ExecutorEngine,
  buildRuntimeEnv,
  ClaudeAgentSdkAdapter,
  createJsonLogger,
  createPrometheusMetrics
} from '@goodfarming/codesdk';

const env = buildRuntimeEnv({ credentialNamespace: 'dev' });
const runtime = new ClaudeAgentSdkAdapter({ model: 'claude-sonnet-4-5-20250929' });
const session = await runtime.createSession?.(env, { title: 'demo' });

if (!session) throw new Error('runtime does not support sessions');

const metrics = createPrometheusMetrics();
const logger = createJsonLogger({ level: 'info' });
const engine = new ExecutorEngine({ logger, metrics });

const handle = engine.startTask({
  sessionId: session.sessionId,
  taskId: randomUUID(),
  env,
  runtime,
  runtimeSession: session,
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Hello from CodeSDK.' }] }
  ]
});

await handle.completion;
```

## Embedding patterns

- Inject your own `EventStore` / `ArtifactStore` for persistence.
- Use `InProcessMcpServer` + `ToolRegistry` to host owned tools.
- Capture support bundles via `createSupportBundle(...)` when runs fail.
- Export metrics via `createPrometheusMetrics()` and logs via `createJsonLogger()`.

## Quick start (daemon)

```bash
npx codesdkd --host 127.0.0.1 --port 0 --data-dir /tmp/codesdkd --runtimes claude-agent-sdk,codex-sdk --default-permission-mode auto
```

## Testing

```bash
npm test
```

Live runtime smoke tests are gated and require OAuth logins for each runtime:

```bash
RUN_LIVE_TESTS=1 RUN_LIVE_TOOL_TESTS=1 OPENCODE_SPAWN=1 npx vitest run tests/live.test.ts
```

## Security / Secrets

- Do not commit credentials or local runtime config files.
- Support bundles redact token fields by design.
- Use `.env` for local overrides (ignored by git).

## Docs

- Plan: `docs/plan.md`
- Runtime adapter interface: `docs/runtime-adapter-interface.md`
- Auth + runtime env: `docs/auth-runtime-env.md`
- Checklist: `docs/checklist.md`
- Adapter contract tests: `docs/contract-tests.md`
- Per-runtime harness specs: `docs/runtimes/*`
- Metrics: `docs/metrics.md`
