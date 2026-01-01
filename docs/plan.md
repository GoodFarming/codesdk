# CodeSDK — Implementation Plan (Agor-style SDK handlers)

## Goal

Build an application-ready, SDK-first agent runtime wrapper that:

- Exposes one stable contract for: sessions, messages, events, tool calls, artifacts, cancellation, and traceability.
- Wraps **agent runtimes** (not “model providers”) behind **unique runtime adapters** (no “false unification” of tool semantics).
- Makes tool execution **owned** (permissioning + sandboxing + auditing) instead of delegating to opaque CLIs.

This intentionally mirrors the strongest parts of Agor’s methodology:

- A small **capability-driven interface** (e.g., `supportsStreaming`, `supportsResume`, `supportsToolCalls`).
- Per-runtime “prompt service” loops that stream runtime-native events and emit **normalized events**.
- A normalization layer that preserves `raw` payloads as an escape hatch for debugging.

## Non-goals (initially)

- A production Web UI (a dev console/CLI harness is fine).
- Supporting “every runtime”. Start with: Claude, Codex, Gemini, OpenCode.
- Perfect feature parity across runtimes (capabilities + graceful degradation instead).

## Target outcomes (definition of done)

- A single API/SDK surface an app can use to:
  - create/resume a session,
  - stream tokens/blocks/events,
  - receive tool call requests,
  - approve/deny/execute tools in a sandbox,
  - persist and replay the full event log for debugging.
- A daemon (`codesdkd`) suitable for embedding as a subprocess, exposing the same contract over HTTP + SSE for apps that prefer a process boundary.
- Deterministic local test suite (mocks/fixtures) + optional live tests.
- “Support bundle” export that makes high-level debugging possible without SSH.

---

## Recommended stack

**TypeScript (Node)** is the pragmatic choice if you want “Agor-like” SDK integrations:

- Claude: `@anthropic-ai/claude-agent-sdk`
- Codex: `@openai/codex-sdk`
- Gemini: `@google/gemini-cli-core`
- OpenCode: `@opencode-ai/sdk` (talks to `opencode serve`)

If you choose Python, you’ll likely end up implementing to raw HTTP APIs instead of these agent SDKs.

---

## Architecture (layers)

### 1) `core` (runtime-agnostic contract)

Responsible for the stable “family” of types and guarantees:

- **IDs**: `session_id`, `task_id`, `event_seq` (monotonic per session), `request_id`, `client_id`.
- **Events** (append-only): normalized event types with timestamps + trace context.
- **Messages**: canonical transcript representation (text, tool_use, tool_result, attachments).
- **Tool calls**: request/response schema + registry metadata (JSON schema / zod).
- **Capabilities**: runtime feature flags + versioning (plus auth/tool/permission execution models).
- **Error model**: structured errors with `code`, `retryable`, `runtime`, `raw`.

### 2) `executor` (engine)

Owns orchestration and consistency:

- Session lifecycle: create/resume/stop.
- Task lifecycle: compile context → stream → tool loop → completion.
- Backpressure: bounded queues per session, per runtime.
- Cancellation: propagated to runtime (abort/interrupt/stop).
- Persistence hooks: every emitted event goes to the event store.

### 3) `runtimes/*` (unique adapters)

Each runtime adapter implements a minimal interface such as:

- `getAuthStatus()` (OAuth implies local state; first-class, safe metadata only)
- `checkAvailable()` (runtime readiness)
- `createSession()` (if supported)
- `startTask()` → a duplex task handle (compiled messages in; events out; tool results/denials in)
- `task.stop()` (best-effort cancellation; runtime-specific)
- `normalizeRawResponse()` (optional; emit raw in events anyway)

### 4) `auth` (credential brokerage)

OAuth and runtime-managed credential caches are a core driver, so model them explicitly:

- Query auth status per runtime (logged in? which mode?).
- Provide dev-friendly `ensureLogin()` instructions without hard-coding UI.
- Enforce “credential namespace” boundaries for multi-tenant setups.

### 5) `runtime-env` (isolation + determinism)

Agent runtimes read/write local state (HOME/XDG/config/policies/logs). Treat this as part of the system contract:

- Support shared vs namespaced vs ephemeral runtime environments.
- Make “where runtime state lives” explicit via `credentialNamespace`.
- Enable deterministic testing by pinning runtime env + settings sources.
- Explicitly model **how** the runtime is hosted for isolation: `in_process` | `subprocess` | `server_side`.
  - Multi-tenant deployments should avoid `in_process` for runtimes that use disk-based OAuth caches (prefer `subprocess` or `server_side`).
- For `subprocess`, standardize an IPC protocol that preserves duplex semantics (recommendation: JSON-RPC 2.0 over stdio with event notifications).

### 6) `tools` (owned tool execution)

Tool execution should not be runtime-owned by default. CodeSDK should:

- Receive tool call requests from runtime adapters (or via MCP).
- Apply permissioning policy and emit policy/audit events.
- Execute tools in a sandbox (see below).
- Feed tool results back to the runtime loop.

**Principle:** MCP-first tool ownership. Runtime-native tools are treated as legacy/internal and must be explicitly enabled.

### 7) `storage` (event store + artifacts)

Minimum viable storage:

- Append-only event log per session (`seq`, `ts`, `type`, `payload`, `trace`).
- Artifacts store (files/blobs) with content type and stable download semantics.
- Optional: snapshot tables for fast list views (sessions/messages).
- Design rule: normalized event rows stay small; large `raw` payloads are blobbed as artifacts and referenced (e.g., `raw_ref`).

### 8) `daemon` (embedded HTTP server)

For “daemon-first” integrations, CodeSDK provides `codesdkd`:

- HTTP endpoints for session/task lifecycle and artifact download.
- SSE streaming for normalized events.
- Durable default stores via a single `--data-dir` root (SQLite events + file artifacts + runtime-env dirs).
- Tool approval endpoints when `permissionMode=ask` (pause tool execution until approve/deny).

See `docs/daemon-api.md`.

---

## Core contracts (SSOT)

### Normalized events (suggested minimal set)

All runtime streams map into a small set, with a `raw` escape hatch:

- `session.created`
- `task.started`
- `model.input` (canonical runtime request; prefer artifact/blob refs for large payloads)
- `runtime.request.started` / `runtime.request.completed` (optional but useful)
- `model.output.delta` (typed block delta; `payload.kind` distinguishes `text_delta` vs `json_delta` vs `code_delta`)
- `model.output.completed` (final assistant blocks; stable, typed blocks suitable for transcript)
- `tool.call.requested` (name + input schema instance)
- `tool.call.policy_evaluated` (may occur multiple times; `{source, result, rule?}` where `result ∈ {allow, deny, ask}`)
- `tool.call.approved` / `tool.call.denied`
- `tool.call.started` / `tool.call.completed`
- `tool.output.delta` / `tool.output.completed` (stdout/stderr/progress streaming)
- `usage.reported` (tokens + timings, when available)
- `task.completed`
- `task.failed` (structured error)
- `task.stopped`

Every event includes:

- `schema_version` (event schema version; bump on breaking payload changes)
- `seq` (monotonic per session)
- `time` (ISO)
- `trace`: `{ client_id?, request_id?, user_id?, session_id, task_id? }`
- `runtime`: `{ name, model?, runtime_session_id?, raw? }`

Notes:

- `tool.call.policy_evaluated` can occur multiple times (runtime policy engine, CodeSDK policy, user decision).
- `tool.call.approved` / `tool.call.denied` represent the final effective decision (single terminal decision per tool call).

### Task state machine + invariants (executor SSOT)

Define task + tool-call attempt states explicitly (these are engine states, not necessarily emitted as events):

Task states:

- `running`: streaming model output and/or waiting for runtime events
- terminal: `completed | failed | stopped`

Tool-call attempt states (for `tool_call_id + attempt`):

- `waiting_for_tool_decision`: `tool.call.requested` emitted; awaiting approve/deny
- `running_tool`: tool is executing (optional `tool.output.*` streaming)
- `feeding_tool_result`: tool result/denial is being sent back into the runtime loop
- terminal: `completed | denied`

Core invariants (this prevents most race-condition bugs):

- Exactly one terminal event per task: `task.completed | task.failed | task.stopped`.
- For a given `task_id`, `task.started` is the first task-scoped event and the terminal event is the last.
- One active task per `session_id` (P0 default): the executor enforces a per-session mutex; clients must not assume task concurrency within a session.
- Event sequencing: `seq` is assigned monotonically per session and must be persisted to the event store **before** the event is emitted/streamed to clients.
- Parallel tool calls: a runtime may request multiple tools “at once”. The executor must model tool-call attempt state per `tool_call_id + attempt` and allow multiple outstanding tool calls per task (at minimum: queue + execute serially in P1).
- Tool call graph integrity: for each tool call attempt (`tool_call_id + attempt`):
  - `tool.call.requested` must exist before any other tool events for that attempt.
  - `tool.call.approved | tool.call.denied` occurs exactly once as the terminal decision for that attempt.
  - If approved: `tool.call.started` and `tool.call.completed` must occur exactly once (in that order).
  - If denied: no tool execution events occur; CodeSDK must still return a deterministic denial back to the runtime loop via `sendToolDenied(...)`.

### Event schema versioning (fixtures won’t survive without it)

- `schema_version` is on every event and bumps on breaking changes to event payload shapes/semantics.
- `session.created` should include a `contract_version` so support bundles and fixtures can be interpreted against the intended contract.
- Migration strategy: write readers as “upcasters” (old → latest in-memory shape) rather than rewriting historical logs.

### Context + transcript handling (SSOT)

**Problem:** runtime-native session/thread state is not reliable SSOT, but many runtimes depend on it for “context”. CodeSDK must own a deterministic, replayable transcript and a deterministic way to compile runtime inputs.

Design rules:

- Treat “context” as **data**: `{messages, tool_manifest, runtime_config, attachments}`.
- Never require re-running tools to resume: tool outputs must be persistable and replayable.
- Keep event rows small: store large compiled inputs/outputs as artifacts and reference them.

#### Implicit prompt/context sources (“hidden input” problem)

Many runtimes inject context you didn’t explicitly provide (project instruction files, user config/policy prompts, runtime defaults, internal tool manifests).

Per runtime, CodeSDK must choose and document one of:

1) **Disable implicit sources** (best for determinism), or
2) **Capture and include them** (best for “matches native runtime behavior”).

Regardless of choice, `model.input` must make the effective behavior observable:

- include an `implicit_sources_ref` artifact that lists sources, their precedence, and safe hashes (never secrets)
- if sources are disabled, record `{ disabled: true, reason }` in that artifact

#### Canonical transcript model (runtime-agnostic)

- Messages have a `role ∈ {system, user, assistant, tool}` and `content[]` blocks.
- Content blocks must be able to represent:
  - text
  - tool call requests (assistant `tool_use` with stable `tool_call_id`)
  - tool results (tool `tool_result` with the same `tool_call_id`)
  - artifact/attachment refs (files, images, large tool output bodies)

#### How transcript is derived from normalized events

To avoid duplication (especially when a runtime input includes the full history), derive the transcript from “delta” sources:

- `task.started`: the canonical user message(s) for the task (not the full compiled prompt).
- `tool.call.requested`: becomes an assistant `tool_use` message block.
- `tool.call.completed`: becomes a tool `tool_result` message block (prefer artifact refs for large outputs).
- `tool.call.denied`: becomes a tool `tool_result` message block with `is_error: true` (include the denial reason sent back to the runtime).
- `model.output.completed`: becomes the assistant message block(s) for the task.

#### Compiled runtime input (“what did the runtime actually see?”)

For every runtime request, compile a `RuntimeInput` (shape varies per runtime) that includes at least:

- compiled `messages[]` (full or delta, but recorded)
- `tool_manifest` (names + schema hashes for the tools that were exposed)
- `runtime_config` (model + any explicit runtime options)
- `context_window` metadata (strategy, truncation, omitted ids)

Store the full compiled input as an artifact and reference it from the `model.input` event via `input_ref` + `input_hash`.

#### Context window management (don’t ignore this)

Large tool outputs and long sessions will overflow context windows.

Minimum viable strategy (P1):

- Replace large tool outputs with `{artifact_ref + short preview}` first.
- If still too large: drop oldest turns and record what was omitted in `model.input.context_window`.
- If the runtime rejects input anyway: fail with a structured `task.failed` (`code: CONTEXT_TOO_LARGE`) and surface a “summarize/compact” recovery instruction.

Summarization/compaction can come later (P3+), but the budgeting + omission reporting must exist early for debugging.

### Capability model

Expose a structured capability object (Agor-style) so UIs/clients don’t guess:

- `supportsStreaming`
- `supportsToolCalls`
- `supportsParallelToolCalls`
- `supportsSessionCreate`
- `supportsSessionResume`
- `supportsStop`
- `supportsArtifacts`
- `supportsUsageReporting`
- `supportsNonInteractive`
- `maxOutstandingToolCalls` (number)

Add “runtime wrapper reality” fields so clients don’t make unsafe assumptions:

- `authModel`: `oauth_local` | `api_key` | `both`
- `toolExecutionModel`: `external_mcp` | `runtime_internal` | `hybrid`
- `permissionModel`: `codesdk` | `runtime` | `hybrid`
- `stateModel`: `in_process` | `local_disk` | `server_side` | `hybrid`
- `resumeModel`: `native` | `reconstruct` | `none`
- `toolReplaySafety`: `safe_replay` | `requires_reapproval` | `unknown`
- `mcpSupport`: `none` | `client_only` | `server_only` | `both`
- `mcpTransports`: `stdio` | `sse` | `http` (list of supported transports)
- `cancellationModel`: `best_effort` | `guaranteed` | `unknown`
- `supportedIsolationModes`: `in_process` | `subprocess` | `server_side` (list)

### Permission modes (cross-runtime)

Define a small canonical set and map runtime-specific modes into it:

- `ask` (always prompt before tools/edits)
- `auto` (auto-approve safe tools)
- `yolo` (auto-approve everything; strongly gated)

Runtimes that have their own modes should map, not redefine the contract.

---

## Idempotency + resume semantics (SSOT)

Wrapping agent runtimes introduces multiple “resume” forms:

- **Native resume**: the runtime has a durable session/thread id that can truly continue.
- **Reconstruct resume**: CodeSDK rebuilds runtime context from its SSOT transcript/event log.
- **None**: no meaningful resume beyond starting fresh.

Design rules:

- Treat runtime-native ids (`runtime_session_id`, `thread_id`, etc.) as **optimizations**, not SSOT.
- Make tool execution resilient to retries/resume: tool call identity must be stable and auditable.

Minimum tool-call identity fields (included on all tool call events):

- `tool_call_id` (CodeSDK stable id)
- `runtime_tool_call_id` (optional; if runtime provides one)
- `attempt` (starts at 1; increments on replay/resume)
- `input_hash` (hash of canonicalized input)

This enables “exactly-once-ish” behavior for safe tools and “at-most-once unless re-approved” behavior for risky tools.

### Canonicalization + hashing (SSOT)

Idempotency and replay depend on hashes being stable.

Minimum requirements:

- Algorithm: SHA-256 (encode as `sha256:<hex>`).
- Canonical JSON: use a deterministic canonicalization scheme (recommendation: RFC 8785 JCS) so key ordering and number formatting can’t drift across runtimes/languages.
- Artifact refs: represent large inputs/outputs by stable `{artifact_id, content_hash?}` objects; hashes must never depend on local file paths.

What to hash:

- `ToolCallIdentity.input_hash`: hash the canonical JSON form of the tool call input (including artifact refs, not artifact bytes).
- `model.input.input_hash`: hash the canonical JSON form of the compiled runtime input (compiled messages + tool manifest schema hashes + explicit runtime config + context_window omissions).

---

## Tool execution & sandboxing (application-ready)

### MCP-first tool hosting

Default design: CodeSDK hosts tools via MCP and runtimes call those tools via MCP clients whenever supported.

Benefits:

- consistent permissioning + auditing + sandboxing
- avoids fighting each runtime’s internal tool plumbing
- makes “owned tools” compatible with keeping runtime OAuth ergonomics

### Tool registry

Implement a registry with:

- tool name (namespaced): `workspace.read`, `workspace.write`, `patch.apply`, `http.fetch` (optional)
- JSON schema for inputs/outputs
- default permission classification: `read-only`, `write`, `network`, `dangerous`

Default policy:

- `workspace.exec` is **disabled by default**.
- If enabled, require Docker isolation + strict allowlist + timeout + network off by default.

### Permissioning

Permission decisions should be first-class events:

- record who approved (user/system), when, and why
- record the effective policy (session permission mode + overrides)

### Tool execution metadata (mandated in SSOT)

Support bundles are only actionable if tool execution is attributable.

Minimum required fields on `tool.call.completed` payload (in addition to tool identity):

- `name` (tool name)
- `executed_by`: `codesdk | runtime` (who actually ran it)
- `execution_env`: e.g. `codesdk_docker | codesdk_host | runtime_internal | unknown`
- `policy_snapshot`: effective `{ permission_mode, decision: allow, sources[] }` that led to execution
- `sandbox`: safe summary `{ network: boolean, timeout_ms?: number, mounts?: string[] }`
- `result_ref` (artifact ref for large outputs) and/or a small `result_preview`

If a runtime executes tools internally, adapters must still emit these fields with `executed_by: runtime` so auditing and replay stay coherent.

For denied tool calls, `tool.call.denied` should include a safe `reason` plus the same `policy_snapshot` shape (with `decision: deny`) so the transcript and support bundles explain why the runtime continued without the tool.

### Sandbox strategy (recommended)

For robust multi-tenant operation, run tools in **Docker** (or another container runtime):

- Per-session workspace mounted read/write as configured
- Network disabled by default; selectively enable per tool/policy
- CPU/memory/time limits
- Allowlist commands for `workspace.exec` (or remove `exec` entirely and use higher-level tools)

This isolates tool execution even if a runtime behaves unexpectedly.

---

## Runtime adapter plans (unique handling)

### Per-runtime harness specs (required)

In addition to implementing the adapter interface, each runtime needs a short operational spec (SSOT) describing harness quirks and default choices:

- `docs/runtimes/claude-agent-sdk.md`
- `docs/runtimes/codex-sdk.md`
- `docs/runtimes/gemini-cli-core.md`
- `docs/runtimes/opencode-server.md`

Each spec must include:

- auth state locations + how `runtime-env` isolates them
- implicit prompt/context sources (disable vs capture, and how reflected in `model.input`)
- tool restriction strategy (don’t trust allowlists without enforcement hooks)
- parallel tool call behavior + default config
- MCP transport preference + fallback order
- cancellation semantics + known failure modes
- runtime version pinning + config snapshot included in support bundles

### Claude (Claude Agent SDK)

- Use hooks (e.g., `canUseTool`) for permission gating and event emission.
- Prefer MCP-first: expose CodeSDK tools via an MCP server and only allow those tools by default.
- Resume: store `runtime_session_id` in session metadata when available.
- Stop: call SDK interrupt / abort where supported.
- Emit: tool call request events before execution; include raw SDK event payloads.

### Codex (`@openai/codex-sdk`)

- Implement thread/session continuity per SDK primitives; treat thread id as an optimization, not SSOT.
- Prefer MCP-first tools; layer any runtime exec-policy constraints as defense-in-depth.
- Stop: SDK-specific cancellation flag (or abort controller if exposed).

### Gemini (`@google/gemini-cli-core`)

- Support both auth modes (surface via `getAuthStatus()`):
  - API key (`GEMINI_API_KEY`)
  - OAuth creds (via `gemini login` on the host; store per-user path if multi-tenant)
- Use `sendMessageStream()` and map SDK event types to SSOT events.
- Tool calls: emit `tool.call.policy_evaluated` when runtime policy engine decides (ask/auto/yolo mapping).
- Prefer MCP-first tool discovery for “owned tools”.

### OpenCode (`@opencode-ai/sdk`)

- Treat OpenCode as a server runtime: CodeSDK connects to `opencode serve`.
- Support provider+model config explicitly (OpenCode has two dimensions: provider + model).
- Streaming: SSE events mapped to SSOT events.
- Prefer MCP-first external tools where supported; be explicit about transport limitations.

---

## Testing strategy (application-ready, not “demo-ready”)

### Unit tests (no network)

- Normalizers: golden fixtures per runtime → SSOT events.
- Permission mapping: canonical modes → runtime modes.
- Event store: sequencing, paging, replay.
- Tool registry validation: schema enforcement.

### Integration tests (mocked SDKs)

- Mock runtime SDK clients to simulate:
  - streaming deltas
  - tool call requests
  - failures/timeouts
  - cancellation
- Assert the engine produces the correct SSOT event order.

### Optional live tests (gated)

- Only run when env vars are present (e.g., `RUN_LIVE_TESTS=1` and runtime credentials).
- Focus on smoke-level scenarios (one prompt, one tool call).

### Fixtures

- Record representative raw SDK events (redacted) and commit as fixtures.
- Provide a “replayer” that runs the engine against fixtures to validate determinism.

### Contract tests (adapter conformance)

Every runtime adapter must pass the same conformance matrix (with mocked SDKs; optionally gated live runs). Full matrix spec: `docs/contract-tests.md`.

- streaming: `model.output.delta` → `model.output.completed` (typed blocks, stable `block_id`)
- tool loop (approve): `tool.call.requested` → approve → execute → `tool.call.completed` (with execution metadata) → `sendToolResult(...)`
- tool loop (deny): `tool.call.requested` → deny → `tool.call.denied` (with reason + policy_snapshot) → `sendToolDenied(...)`
- cancellation: `stop()` mid-stream → terminal `task.stopped` and no further tool execution
- non-interactive mode: runtime must not block on prompts; “ask” policy must degrade deterministically
- implicit sources: `model.input` includes `implicit_sources_ref` and hashes (or records explicit disablement)
- parallel tool calls: either handled (multiple outstanding tool_call_id) or explicitly disabled and asserted by config/capability
- tool restriction: forbidden tools must not execute (test behavior, not just “tool list”)
- MCP transport: adapter uses declared transport preference order; record chosen transport in support bundle

---

## Observability, traceability, and debugging

### Activity/audit log

Implement an audit stream (global + per-session):

- inbound requests (create session, prompt, tool decision)
- tool execution start/end (including sandbox parameters)
- runtime errors (rate limits, auth failures)
- storage failures

### Support bundle

A single export artifact should include:

- `/health` + `/capabilities` snapshots
- runtime versions + adapter versions
- runtime config/policy snapshot (paths + safe hashes + redaction, no secrets)
- MCP transport matrix snapshot (supported + chosen transport per runtime)
- session event log (paged)
- tool execution transcripts (stdout/stderr, exit codes)
- redacted runtime metadata (model, request IDs)

### Metrics

Expose Prometheus metrics for:

- active sessions/tasks
- runtime latency distributions
- tool execution latency/failures
- queue depth/backpressure drops

---

## Repo structure (suggested, Agor-inspired)

One workable layout:

```
CodeSDK/
  packages/
    core/
      src/
        types/
        events/
        tools/
        tracing/
    executor/
      src/
        engine/
        storage/
        auth/
        runtime-env/
        runtimes/
          claude-agent-sdk/
          codex-sdk/
          gemini-cli-core/
          opencode-server/
        normalizers/
```

If you prefer a single-package repo initially, mirror the same folder structure under `src/`.

---

## Milestones + implementation checklist

### P0 — Scaffolding + SSOT contracts

- Choose TS toolchain (pnpm + tsup/tsc + vitest) and set up CI.
- Define SSOT types: `Session`, `Task`, `Event`, `ToolCall`, `Artifact`, `Capabilities`.
- Add event schema versioning (`schema_version` + `contract_version`) and a reader migration note.
- Define executor task state machine + invariants (terminality, tool-call ordering, per-session mutex).
- Define `model.output.delta` / `model.output.completed` typed block payloads.
- Define canonicalization + hashing for `input_hash` (stable JSON + SHA-256).
- Define required tool execution metadata fields for `tool.call.completed`.
- Define runtime adapter interface as **duplex** (task handle with channels).
- Define capabilities model (include auth/tool/permission/state/resume/isolation models).
- Implement event sequencing + in-memory event store + paging.
- Create a tiny CLI harness that can run one session and print streamed events.

### P1 — One runtime vertical slice (prove OAuth + policy + 1 tool path)

- Implement `auth/` + `runtime-env/` primitives (credential namespace + isolation level).
- Implement a minimal in-process MCP tool host (1–2 tools, e.g. `workspace.read`).
- Implement one runtime end-to-end:
  - streaming → SSOT deltas/completed
  - policy/permission events (including `tool.call.policy_evaluated`)
  - at least one tool call executed via CodeSDK via MCP (prove the “owned tools” path)
- Add runtime-level “health/auth check” surfaces.

### P2 — Second runtime + cross-runtime normalization

- Add a second runtime adapter and prove the same end-to-end behavior.
- Add fixtures for both runtimes and validate deterministic replay.

### P3 — MCP-first tool host + sandboxing + persistence

- Expand MCP tool host + `ToolRegistry` + `PermissionService`.
- Implement tool call request/approval/denial events (even when runtime policy engine decides).
- Wire tool results back into runtime adapters (runtime-specific reply format).
- Add Docker sandbox runner for tools (configurable; default off).
- Add durable event store (SQLite first; optional Postgres).
- Add artifacts store with stable download semantics.

### P4 — Operational polish

- Add audit log + support bundle exporter.
- Add Prometheus metrics + structured logging.
- Add load/concurrency limits + rate limiting per runtime.

### P5 — Integration surface (choose one)

- **Library-first**: publish CodeSDK as a package for other services to embed.
- **Daemon-first**: ship `codesdkd` HTTP API (can mimic CLIwrapper’s API spec).
- Provide reference “dev console” for manual testing (not a product UI).

---

## Open questions (decide early)

1) Single-tenant (one operator) or multi-tenant (per-user creds + isolation)?
2) Is Docker available/required for tool sandboxing, or is host execution acceptable?
3) Should we standardize tool calls on MCP as the primary tool transport?
4) Do we need strict API compatibility with CLIwrapper, or can this be a new contract?
