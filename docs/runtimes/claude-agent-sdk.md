# Runtime Harness Spec — Claude Agent SDK (`claude-agent-sdk`)

This spec documents harness-specific behavior that must be encoded as adapter requirements, default config choices, and contract tests.

## Identity

- Runtime name (CodeSDK): `claude-agent-sdk`
- Upstream: `@anthropic-ai/claude-agent-sdk`
- Expected hosting modes: `in_process` (dev), `subprocess` (multi-tenant), possibly `server_side` (if Anthropic offers it later)

## Auth + local state

Requirements:

- Treat OAuth credential caches + config dirs as runtime-owned local state.
- In multi-tenant mode, do not run `in_process` unless proven safe: use `RuntimeEnv` namespacing + `subprocess`.

Adapter responsibilities:

- Implement `getAuthStatus(env)` by probing safely (never return token values).
- Ensure `model.input` includes an `implicit_sources_ref` snapshot describing what auth/config/policy sources were in effect (paths + hashes; no secrets).

Concrete findings:

- Claude Code config dir resolves to `CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude` (SDK uses `homedir()`).
- `settingSources` controls implicit loading of filesystem settings; when omitted or empty, no settings are loaded (SDK isolation mode).

## Implicit prompt/context sources

Things to watch for (verify during implementation):

- project instruction files and/or runtime config that injects system instructions
- default policies that affect tool use

Decision rule:

- Prefer disabling implicit sources for determinism *if the runtime supports it*.
- If not disable-able, capture them and include a snapshot reference in `model.input`.

## Tool system + restriction strategy

Default posture:

- CodeSDK-owned tools via MCP are the only tools exposed by default.
- Runtime-native/internal tools are off unless explicitly enabled in the adapter.
- Adapter should set `tools: []` in SDK options to disable built-in tools unless explicitly overridden.
- Use `permissionMode: 'dontAsk'` for non-interactive runs to avoid CLI prompts.

Concrete findings:

- MCP tool names are normalized by the Claude CLI before being exposed to the model.
  - Normalization rule observed in CLI: replace any character not matching `[A-Za-z0-9_-]` with `_`.
  - Example: `mcp__codesdk__workspace.read` becomes `mcp__codesdk__workspace_read`.
  - Adapter should normalize MCP tool names when building `allowedTools` and when prompting.

Restriction strategy (defense in depth):

- Do not rely on “allowlist only” toggles; prefer a deny-by-default hook/gate if the runtime provides one.
- Even if the runtime claims tool restrictions are applied, enforce tool policy in CodeSDK and record decisions as SSOT events.

Contract tests (must pass):

- A forbidden tool must not execute (assert behavior, not tool listing).
- Denied tool calls still produce deterministic `tool.call.denied` + `sendToolDenied(...)`.

## Parallel tool calls

Requirement:

- The adapter must tolerate the runtime requesting multiple tools before any results are provided.
- CodeSDK may execute tools serially in P1, but must be able to queue multiple outstanding tool calls and feed results back by `tool_call_id`.

Capabilities:

- Set `supportsParallelToolCalls` according to observed/runtime-configured behavior.
- Set `maxOutstandingToolCalls` to the enforced limit (>= 1).

## Interactive vs non-interactive mode

Default requirement:

- CodeSDK runs runtimes in “non-interactive” mode by default (no stdin prompts).
- If the runtime requires interactive login in dev, provide `ensureLogin()` instructions instead of prompting in production.

Session notes:

- The SDK supports resuming by session id via `resume`.
- Session persistence is controlled by `persistSession`; CodeSDK defaults this to false unless overridden.

Contract tests:

- “non-interactive” run must not block on prompts.

## MCP support

Expected:

- MCP support should be strong for this runtime; prefer `stdio` transport for local.

Adapter requirements:

- Declare `mcpSupport` + `mcpTransports` accurately.
- Record chosen MCP transport in support bundles.

Concrete findings:

- SDK supports `mcpServers` config with `stdio`, `sse`, `http`, or `sdk` (in-process) servers.

## Cancellation semantics

Requirement:

- Implement `stop()` as best-effort and always emit `task.stopped` when CodeSDK stops, even if the runtime continues briefly.

Contract tests:

- Cancel mid-stream → terminal `task.stopped` and no further tool execution.

## Version + config snapshot

Support bundles must include:

- runtime version (package + resolved version)
- adapter version
- config/policy snapshot (paths + safe hashes; redaction)
