# Runtime Adapter Contract Tests (conformance matrix)

These tests are the “runtime harness safety net”: they encode harness quirks as executable expectations so adapters don’t silently drift.

## What this suite is

- A shared set of tests every runtime adapter must pass.
- Mostly mocked/offline (no network), with optional gated live smoke tests.
- Focused on **contract invariants** (event ordering, tool-loop duplexing, determinism, and observability), not model quality.

## Test matrix (minimum)

### Streaming

- `model.output.delta` emits typed `ModelOutputDeltaPayload` blocks with stable `block_id`.
- `model.output.completed` emits final typed assistant blocks.
- `model.input` exists and references compiled input artifacts for large payloads.

### Tool loop — approve

- Runtime requests a tool (`tool.call.requested`).
- CodeSDK emits policy events and approves (`tool.call.policy_evaluated` → `tool.call.approved`).
- Tool executes and completes (`tool.call.started` → `tool.call.completed`) with required metadata:
  - `executed_by`, `execution_env`, `policy_snapshot`, `sandbox` summary, result refs/previews
- CodeSDK feeds result back via `sendToolResult(tool_call_id, ...)`.

### Tool loop — deny

- Runtime requests a tool (`tool.call.requested`).
- CodeSDK denies (`tool.call.policy_evaluated` → `tool.call.denied`) with:
  - deterministic `reason`
  - `policy_snapshot` with `decision: deny`
- CodeSDK feeds denial back via `sendToolDenied(tool_call_id, ...)`.

### Cancellation

- `stop()` mid-stream produces a terminal `task.stopped`.
- No additional tool execution occurs after stop is requested (best-effort but enforced by executor/tool runner).

### Non-interactive mode

- Adapter runs without blocking for stdin prompts.
- Runtime “ask user” semantics (if any) degrade deterministically and are attributable in `tool.call.policy_evaluated`.

### Implicit sources (“hidden input”)

- `model.input` includes an `implicit_sources_ref` artifact describing:
  - what implicit sources were used (or explicitly disabled)
  - precedence
  - safe hashes (never secrets)
- Hashes are stable across runs in the same `credentialNamespace`.

### Parallel tool calls

- Adapter/executor tolerates multiple outstanding tool calls (multiple `tool_call_id` before any results).
- If the runtime cannot be configured to avoid this, the executor must queue and process safely (serial execution is acceptable in P1).
- Tool output streaming events are attributable by `tool_call_id`.

### Tool restriction reliability

- A forbidden tool cannot execute even if the runtime would otherwise try.
- The test asserts behavior (no tool execution events / no `sendToolResult` from execution), not “tool list” output.

### MCP transport selection

- Adapter declares supported MCP transports and a preference order (per harness spec).
- Chosen transport (and fallback, if used) is recorded in support bundle metadata.

## Live tests (optional, gated)

Only run when explicitly enabled (e.g., `RUN_LIVE_TESTS=1`) and credentials are present.

Smoke scenarios:

- one prompt → streaming output
- one tool call → approve → execute via MCP host → feed result back

