# Runtime Harness Spec — Codex (`codex-sdk`)

This spec documents harness-specific behavior that must be encoded as adapter requirements, default config choices, and contract tests.

## Identity

- Runtime name (CodeSDK): `codex-sdk`
- Upstream: `@openai/codex-sdk`
- Expected hosting modes: `in_process` (dev), `subprocess` (multi-tenant)

## Auth + local state

Observed:

- Codex uses `CODEX_HOME` (or `~/.codex`) for config and sessions; set `CODEX_HOME` in the runtime env for isolation.
- Config lives at `CODEX_HOME/config.toml`; execution policy rules live under `CODEX_HOME/rules`.
- The SDK can also inject `CODEX_API_KEY` via env or `apiKey` option.

Adapter responsibilities:

- Implement `getAuthStatus(env)` without leaking secrets.
- Ensure `RuntimeEnv` is explicit about HOME/XDG so effective config sources are deterministic.
- Include a config/policy snapshot in `model.input.implicit_sources_ref` (paths + hashes; no secrets).

## MCP (owned tools) integration

Observed:

- Codex supports MCP servers as a client via `CODEX_HOME/config.toml`.
- Tool invocations appear in the event stream as `mcp_tool_call` thread items.

Adapter responsibilities:

- When CodeSDK wants Codex to use CodeSDK-owned tools, the adapter must ensure a `codesdk` MCP server is configured (ideally via a namespaced `CODEX_HOME` so we never mutate developer config).
  - Current approach: write/append a `CODEX_HOME/config.toml` entry for `[mcp_servers.codesdk]` that launches `codesdk-mcp` over stdio.

## Implicit prompt/context sources (“hidden input”)

Observed:

- `config.toml` and `rules/` are implicit inputs to policy and tool behavior.
- Project instruction files (e.g., `AGENTS.md`) are treated as implicit sources if present in the working directory.

Decision rule:

- Either disable implicit sources (preferred for determinism), or capture and include them.
- If capturing, include:
  - list of files read (path within namespace, not host-global)
  - precedence order
  - safe content hashes + redaction flags

Contract tests:

- `model.input` includes `implicit_sources_ref` and stable hashes across runs in the same namespace.

## Tool system + restriction strategy

Default posture (current adapter):

- Runtime-internal tools are treated as runtime-owned (`toolExecutionModel: runtime_internal`).
- Codex supports MCP as a client, and CodeSDK injects a `codesdk` MCP server when a `toolManifest` is provided (via a namespaced `CODEX_HOME/config.toml` entry that launches `codesdk-mcp` over stdio).

Restriction strategy:

- Default to `sandboxMode: read-only` + `approvalPolicy: never` to avoid interactive prompts and limit writes.
- Do not treat runtime configuration as a security boundary; use CodeSDK sandboxing for owned tools when MCP injection lands.

Contract tests:

- Forbidden tool cannot execute even if the runtime “knows about it”.

## Parallel tool calls

Expected (verify):

- The harness may support multiple tool calls in parallel (multiple outstanding tool_call_id).

Default choice (P1):

- CodeSDK must tolerate multiple outstanding tool calls per task.
- Tool execution may be serial initially, but the executor must queue/track by `tool_call_id + attempt`.

Adapter requirement:

- If the runtime has a config flag for parallel tool calls, pin it explicitly and record it in the config snapshot.

## Interactive vs non-interactive mode

Expected:

- CLI-ish flows differ in interactive vs automation mode.

Adapter requirement:

- Run in “non-interactive” mode by default for server use; never block on stdin prompts.
- If interactive approvals are desired, they must be mediated by CodeSDK (events + external user decision), not runtime prompts.

Contract tests:

- Non-interactive runs do not block.
- “ask” policy behaves deterministically (event trail shows where the decision came from).

## MCP support

Expected:

- Supports MCP server registration with at least `stdio` and a “streamable HTTP” style transport (verify).

Adapter requirements:

- Declare supported MCP transports and a preference/fallback order.
- Record the chosen transport in support bundles.

## Cancellation semantics

Requirement:

- Implement `stop()` as best-effort and always emit `task.stopped` when CodeSDK stops.

## Version + config snapshot

Support bundles must include:

- runtime version + adapter version
- config/policy snapshot (paths + hashes; redaction)
- MCP transport matrix snapshot (supported + chosen transport)
