# CodeSDK

A unified SDK for orchestrating AI agent runtimes. CodeSDK wraps multiple agent runtimes (Claude, Codex, Gemini, OpenCode) behind a single, stable API while preserving each runtime's native OAuth flows and capabilities.

## Why CodeSDK?

Building applications on top of AI agent runtimes today means dealing with:

- **Fragmented APIs** — Each runtime has its own session model, streaming format, and tool calling conventions
- **OAuth complexity** — Agent runtimes manage their own credential caches and login flows
- **Opaque tool execution** — Runtimes often execute tools internally with limited visibility or control
- **No replay/debugging** — When things go wrong, reconstructing what happened is painful

CodeSDK solves these problems:

| Problem | CodeSDK Solution |
|---------|------------------|
| Different streaming formats | Normalized event stream across all runtimes |
| Runtime-specific sessions | Unified session/task model with deterministic replay |
| Uncontrolled tool execution | MCP-first tool hosting with sandboxing and audit trails |
| OAuth credential isolation | Per-namespace credential management for multi-tenant safety |
| Hard-to-debug failures | Support bundles with full event logs and artifacts |

## Supported Runtimes

| Runtime | SDK | Status |
|---------|-----|--------|
| Claude | `@anthropic-ai/claude-agent-sdk` | ✅ Full support |
| Codex | `@openai/codex-sdk` | ✅ Full support |
| Gemini | `@google/gemini-cli-core` | ✅ Full support |
| OpenCode | `@opencode-ai/sdk` | ✅ Full support |

## Installation

### From npm

```bash
npm install @goodfarming/codesdk
```

### From source

```bash
git clone https://github.com/goodfarming/codesdk.git
cd codesdk
npm install
npm run build
```

### Requirements

- Node.js 20+
- Docker (optional, for sandboxed tool execution)

## Quick Start

### As a Library

```ts
import { randomUUID } from 'node:crypto';
import {
  ExecutorEngine,
  buildRuntimeEnv,
  ClaudeAgentSdkAdapter,
  createJsonLogger,
  createPrometheusMetrics
} from '@goodfarming/codesdk';

// Configure runtime environment (handles credential isolation)
const env = buildRuntimeEnv({ credentialNamespace: 'dev' });

// Create a runtime adapter
const runtime = new ClaudeAgentSdkAdapter({ model: 'claude-sonnet-4-5-20250929' });

// Create a session
const session = await runtime.createSession?.(env, { title: 'demo' });
if (!session) throw new Error('runtime does not support sessions');

// Set up the executor engine
const engine = new ExecutorEngine({
  logger: createJsonLogger({ level: 'info' }),
  metrics: createPrometheusMetrics()
});

// Run a task
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

// Wait for completion
await handle.completion;
```

### As a Daemon

Run CodeSDK as an HTTP server for embedding in other applications:

```bash
npx codesdkd \
  --host 127.0.0.1 \
  --port 8080 \
  --data-dir /var/lib/codesdkd \
  --runtimes claude-agent-sdk,codex-sdk \
  --default-permission-mode auto
```

The daemon exposes:
- REST endpoints for session/task lifecycle
- SSE streaming for real-time events
- Tool approval endpoints for interactive permission flows
- Support bundle downloads for debugging

See [Daemon API docs](docs/daemon-api.md) for the full API reference.

## Key Features

### Normalized Event Streaming

All runtimes emit the same event types, making it easy to build UIs and logging:

```
session.created → task.started → model.output.delta → model.output.completed → task.completed
```

Tool calls follow a structured flow with full audit trail:

```
tool.call.requested → tool.call.policy_evaluated → tool.call.approved → tool.call.started → tool.call.completed
```

### MCP-First Tool Hosting

CodeSDK can host tools via the Model Context Protocol (MCP), giving you:

- Consistent permissioning across all runtimes
- Docker-based sandboxing for dangerous operations
- Full audit logs of tool inputs/outputs

```ts
import { ToolRegistry, InProcessMcpServer, createWorkspaceReadTool } from '@goodfarming/codesdk';

const registry = new ToolRegistry();
registry.register(createWorkspaceReadTool());

const mcpServer = new InProcessMcpServer(registry);
```

### Credential Isolation

Safe multi-tenant operation with per-namespace credential management:

```ts
const env = buildRuntimeEnv({
  credentialNamespace: `user:${userId}`,
  isolation: { mode: 'subprocess' }  // Separate process per user
});
```

### Support Bundles

When things go wrong, export everything needed to debug:

```ts
import { createSupportBundle } from '@goodfarming/codesdk';

const bundle = await createSupportBundle(sessionId, {
  eventStore,
  artifactStore,
  includeArtifacts: true
});
// Returns a tar.gz with events, artifacts, and sanitized metadata
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Your Application                        │
├─────────────────────────────────────────────────────────────┤
│                         CodeSDK                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ Executor │  │  Tools   │  │  Auth    │  │ Storage  │    │
│  │  Engine  │  │ Registry │  │ Manager  │  │  Layer   │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
│       │             │             │             │           │
│  ┌────┴─────────────┴─────────────┴─────────────┴────┐     │
│  │              Runtime Adapters                      │     │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐  │     │
│  │  │ Claude  │ │  Codex  │ │ Gemini  │ │OpenCode │  │     │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘  │     │
│  └────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

## Documentation

| Document | Description |
|----------|-------------|
| [Implementation Plan](docs/plan.md) | Architecture deep-dive and design rationale |
| [Runtime Adapter Interface](docs/runtime-adapter-interface.md) | How to implement a new runtime adapter |
| [Auth & Runtime Env](docs/auth-runtime-env.md) | Credential isolation and environment setup |
| [Daemon API](docs/daemon-api.md) | HTTP API reference for `codesdkd` |
| [Contract Tests](docs/contract-tests.md) | Adapter conformance test matrix |
| [Metrics](docs/metrics.md) | Prometheus metrics reference |

### Per-Runtime Documentation

- [Claude Agent SDK](docs/runtimes/claude-agent-sdk.md)
- [Codex SDK](docs/runtimes/codex-sdk.md)
- [Gemini CLI Core](docs/runtimes/gemini-cli-core.md)
- [OpenCode Server](docs/runtimes/opencode-server.md)

## Testing

```bash
# Run all tests
npm test

# Run contract tests only
npm run test:contract

# Run live tests (requires runtime credentials)
RUN_LIVE_TESTS=1 RUN_LIVE_TOOL_TESTS=1 npm run test:live
```

## Security

- **Credentials**: Never commit credentials or runtime config files. Use `.env` for local overrides.
- **Support Bundles**: Token fields are automatically redacted.
- **Tool Sandboxing**: Enable Docker isolation for untrusted tool execution.
- **Multi-tenant**: Use `subprocess` isolation mode when running with per-user credentials.

## Contributing

Contributions are welcome! Please read the [Implementation Plan](docs/plan.md) to understand the architecture before submitting PRs.

1. Fork the repository
2. Create a feature branch
3. Ensure tests pass: `npm test`
4. Submit a pull request

## License

MIT
