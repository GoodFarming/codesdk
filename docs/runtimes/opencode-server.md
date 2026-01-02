# Runtime Harness Spec — OpenCode Server (`opencode-server`)

This spec documents harness-specific behavior that must be encoded as adapter requirements, default config choices, and contract tests.

## Identity

- Runtime name (CodeSDK): `opencode-server`
- Upstream: `@opencode-ai/sdk` (talking to `opencode serve`)
- Expected hosting mode: `server_side` (CodeSDK talks to an external runtime server)

## Base URL + directory

- CodeSDK expects the OpenCode server base URL to be provided explicitly (adapter option `baseUrl`) or via environment.
- Prefer `OPENCODE_BASE_URL` (documented by upstream SDKs); `OPENCODE_URL` is treated as a CodeSDK convenience alias only.
- Project root selection is per-request via the `x-opencode-directory` header (the adapter must send it consistently).

## Auth + local state

Observed (from SDK + server API):

- Server config is fetched via `/config` and is scoped by `x-opencode-directory` (project root).
- MCP server registration is managed via `/mcp` with local (`type: local`, command array) or remote (`type: remote`, url) configs.
- OAuth flows for MCP servers are managed by the server; CodeSDK only interacts via API (no local secrets on the CodeSDK host).

Adapter responsibilities:

- Implement `getAuthStatus(env)` as a server-side health/auth probe (no secrets).
- Record server endpoint identity + version in support bundles.

## Implicit prompt/context sources

Observed:

- Server-side config (`/config`) includes tool defaults, provider settings, and policies.
- MCP server state/status is tracked by the server (`/mcp`).

Decision rule:

- Capture the effective server-side configuration into `model.input.implicit_sources_ref` (server-reported config snapshot where possible).

## Tool system + restriction strategy

Default posture:

- Prefer CodeSDK-owned tools via MCP when supported.
- Treat server-side tools and server-side policy as non-authoritative for security; enforce tool permissions in CodeSDK.

Contract tests:

- Forbidden tool must not execute (assert behavior).

## Parallel tool calls

Requirement:

- Support multiple outstanding tool calls per task (queue + serial execution in P1 is acceptable).

## Interactive vs non-interactive mode

Requirement:

- Server-side runtime must be non-interactive from CodeSDK’s perspective (no prompts).

## MCP support + transport quirks

Observed:

- MCP configs can be local (command) or remote (URL) with OAuth support.
- Server exposes MCP status via `/mcp` and supports dynamic registration.

Adapter requirements:

- When a `toolManifest` is provided, ensure a `codesdk` MCP server is registered and connected via `/mcp`.
  - Current approach: register `codesdk` as a **local** MCP server that spawns `codesdk-mcp` over stdio (requires CodeSDK and the OpenCode server to run on the same host).
- Declare supported MCP transports and a preference/fallback order.
- Record chosen transport and any negotiation results in support bundles.

Contract tests:

- MCP transport fallback works (or fails with a deterministic, well-attributed `task.failed`).

## Cancellation semantics

Requirement:

- Implement `stop()` using server-side cancellation if available; otherwise best-effort and still emit `task.stopped` when CodeSDK stops.

## Version + config snapshot

Support bundles must include:

- OpenCode server version + adapter version
- server endpoint/config snapshot (safe; no secrets)
- MCP transport matrix snapshot (supported + chosen transport)
