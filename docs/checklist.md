# CodeSDK — Implementation Checklist (start → finish)

This is the start-to-finish checklist aligned with:

- `docs/plan.md` (SSOT architecture + contracts)
- `docs/runtime-adapter-interface.md` (adapter contract)
- `docs/contract-tests.md` (full adapter conformance test matrix)
- `docs/runtimes/*` (per-runtime harness specs)

Use this file as the “work queue”: clear items as you implement.

## 0 — Repo Bootstrap (tooling + CI)

- [x] Choose repo shape: `packages/*` monorepo vs single package.
- [x] Initialize Node/TS toolchain (package manager + lockfile).
- [x] Add TypeScript config + build config (library output, types output).
- [x] Add test runner (recommendation: vitest) + coverage config.
- [x] Define scripts: `build`, `typecheck`, `test`, `test:unit`, `test:contract`, `test:live` (gated), `lint` (optional), `format` (optional).
- [x] Add formatter/linter (explicitly decided "no lint" for now; scripts are no-op).
- [x] Add a CI workflow that runs: typecheck + tests (+ lint if enabled).
- [x] Add “optional live tests” gating convention (e.g., `RUN_LIVE_TESTS=1`).

## P0 — SSOT Contracts + In-Memory Engine (no real runtimes yet)

### P0.A — Core types + versioning

- [x] Implement SSOT types (`Session`, `Task`, `NormalizedEvent`, `Artifact`, `Capabilities`, `ToolCallIdentity`).
- [x] Implement `schema_version` on every event and `contract_version` on `session.created`.
- [x] Write an upcaster strategy for reading old events (old → latest in-memory shape).
- [x] Define trace context fields + propagation rules (`client_id`, `request_id`, `user_id`, `session_id`, `task_id`).
- [x] Define the error model + codes (include `CONTEXT_TOO_LARGE`) and `retryable` semantics for `task.failed`.

### P0.B — Event store + artifacts (in-memory)

- [x] Implement an in-memory event store with:
  - [x] monotonic `seq` assignment per session
  - [x] “persist before emit” guarantee
  - [x] paging + replay
- [x] Implement an artifact store interface (in-memory first) with:
  - [x] `artifact_id` generation + content addressing (`content_hash`)
  - [x] size limits + redaction rules (safe defaults)
  - [x] stable refs for `model.input` and tool results

### P0.C — Canonicalization + hashing

- [x] Implement canonical JSON serialization (recommendation: RFC 8785 JCS).
- [x] Implement SHA-256 hashing (`sha256:<hex>`) utilities.
- [x] Define and implement `input_hash` rules for:
  - [x] tool inputs (`ToolCallIdentity.input_hash`)
  - [x] compiled runtime inputs (`model.input.input_hash`)

### P0.D — Transcript + context compiler

- [x] Implement canonical transcript model (roles + typed content blocks).
- [x] Implement transcript derivation from normalized events (no duplication).
- [x] Implement a context compiler that produces:
  - [x] compiled `messages[]`
  - [x] `tool_manifest` (schema hashes)
  - [x] `runtime_config`
  - [x] `context_window` metadata (budgeting, omissions)
- [x] Implement implicit sources capture/disablement model:
  - [x] `implicit_sources_ref` artifact format (sources, precedence, safe hashes; no secrets)
  - [x] per-runtime decision point: disable vs capture

### P0.E — Executor skeleton (no real runtime yet)

- [x] Implement task + tool-call attempt state machine (see `docs/plan.md`).
- [x] Enforce “one active task per session” via a per-session mutex.
- [x] Support multiple outstanding tool calls per task (queueing required; serial execution acceptable initially).
- [x] Implement tool decision flow:
  - [x] emit `tool.call.requested` → `tool.call.policy_evaluated` → `tool.call.approved|denied`
  - [x] deny path sends deterministic denial back to runtime handle
- [x] Implement cancellation semantics:
  - [x] `stop()` produces terminal `task.stopped`
  - [x] no further tool execution after stop is requested

### P0.F — CLI harness (debuggable dev loop)

- [x] Implement a CLI “viewer” that streams events for a session/task.
- [x] Add a “fixture replayer” mode (read event log + render deterministically).

### P0.G — Tests (P0 gate)

- [x] Unit tests: event sequencing + paging + replay.
- [x] Unit tests: canonicalization + hashing stability across runs.
- [x] Unit tests: transcript derivation correctness (golden fixtures).
- [x] Unit tests: context compiler omissions/budgeting + `CONTEXT_TOO_LARGE` failure.
- [x] Unit tests: tool-call graph invariants (requested → approved/denied → started/completed).
- [x] Unit tests: cancellation invariants (stop mid-stream).

## P1 — One Runtime Vertical Slice (auth + policy + 1 tool path)

### P1.A — Runtime env + auth primitives

- [x] Implement `runtime-env` builder (shared/namespaced/ephemeral) + explicit HOME/XDG/cwd mapping.
- [x] Implement `auth` facade:
  - [x] `getAuthStatus(env)` per runtime (safe metadata only)
  - [x] `ensureLogin()` instructions (dev-only; no production prompting)
- [x] Implement runtime-level health/capability surfaces (library methods or endpoints): `/health`, `/capabilities`, `/auth/status`.
- [x] If supporting `subprocess`, implement JSON-RPC over stdio IPC and worker-exit failure handling.

### P1.B — Minimal MCP tool host (owned tools proof)

- [x] Implement an in-process MCP server exposing at least:
  - [x] `workspace.read`
  - [x] `patch.apply` (optional in P1; ok to defer)
- [x] Implement tool registry metadata (schema + schema_hash).
- [x] Implement permission modes (`ask|auto|yolo`) and emit auditable policy events.

### P1.C — First runtime adapter end-to-end

- [x] Pick the first runtime (`claude-agent-sdk` or `gemini-cli-core`) and pin the version.
- [x] Update that runtime’s harness spec in `docs/runtimes/*` with concrete findings (paths, defaults, transport behavior).
- [x] Implement adapter:
  - [x] `getCapabilities()` (including `supportsParallelToolCalls`, `supportsNonInteractive`, `maxOutstandingToolCalls`)
  - [x] `getAuthStatus(env)` (+ `ensureLogin` if needed)
  - [x] `createSession`/`resumeSession` as supported
  - [x] `startTask` with `interactionMode: non_interactive` default
- [x] Implement `model.input` capture:
  - [x] compiled input artifact (`input_ref` + `input_hash`)
  - [x] `implicit_sources_ref` artifact (disable vs capture; safe hashes; no secrets)
  - [x] tool manifest snapshot (schema hashes)
- [x] Implement tool-loop duplexing:
  - [x] `tool.call.requested` events with stable `tool_call_id/attempt/input_hash`
  - [x] approvals/denials mapped to runtime loop (`sendToolResult` / `sendToolDenied`)
  - [x] tool execution attribution in `tool.call.completed` (`executed_by`, `execution_env`, `policy_snapshot`, `sandbox`, refs/previews)
- [x] Implement context budgeting/truncation (tool outputs + long histories) + omission reporting.

### P1.D — Tests (P1 gate)

- [x] Implement the adapter contract test runner and keep it in sync with `docs/contract-tests.md`.
- [x] Mocked adapter conformance tests for the chosen runtime:
  - [x] streaming deltas → completed (typed blocks + stable `block_id`)
  - [x] tool approve path (including execution metadata)
  - [x] tool deny path (denial reason + policy_snapshot + `sendToolDenied`)
  - [x] cancellation mid-stream
  - [x] non-interactive behavior (no blocking; attributable policy behavior)
  - [x] implicit sources snapshot present + stable hashes
  - [x] multiple outstanding tool calls handled (or explicitly disabled + asserted)
  - [x] forbidden tool cannot execute (behavioral test, not tool listing)
- [ ] Optional live smoke tests (gated):
  - [x] one prompt → streaming output
  - [x] one tool call executed via MCP host and fed back to runtime

## P2 — Remaining Runtimes + Cross-Runtime Replay Proof

### P2.A — Implement the remaining runtime adapters (repeat P1 gates)

- [x] `claude-agent-sdk`: harness spec updated + adapter implemented + contract tests pass (+ optional live).
- [x] `codex-sdk`: harness spec updated + adapter implemented + contract tests pass (+ optional live).
  - [x] Harness spec updated with concrete CODEX_HOME/config/rules details.
  - [x] Adapter implemented (runtime-internal tool execution).
  - [x] Contract test matrix coverage expanded.
- [x] `gemini-cli-core`: harness spec updated + adapter implemented + contract tests pass (+ optional live).
- [x] `opencode-server`: harness spec updated + adapter implemented + contract tests pass (+ optional live).

### P2.B — Fixtures + deterministic replay

- [x] Add redacted raw fixtures for each runtime (per scenario).
- [x] Add golden normalized-event fixtures (expected SSOT stream) for each scenario.
- [x] Implement deterministic replay tests per runtime (same fixtures → same normalized output).
- [x] Implement cross-runtime replay tests where possible (same logical scenario → comparable SSOT shapes).
- [x] Confirm capability flags prevent clients from assuming unavailable features.

## P3 — Tool Host Expansion + Sandbox + Durable Storage

### P3.A — Tool system hardening

- [x] Expand MCP tool host + registry:
  - [x] JSON schema validation for tool inputs/outputs
  - [x] tool classification (`read-only|write|network|dangerous`)
- [x] Implement PermissionService with auditable decisions (ask/auto/yolo + overrides).
- [x] Keep `workspace.exec` disabled by default; if enabled, require Docker + allowlist + timeout + network off by default.

### P3.B — Tool sandbox runner (Docker)

- [x] Implement Docker tool runner:
  - [x] mounts + readonly/readwrite modes
  - [x] network toggle (default off)
  - [x] cpu/memory/time limits
  - [x] stdout/stderr streaming → `tool.output.*` events
- [x] Add tests for sandbox parameter summary capture (support bundle + tool completion metadata).

### P3.C — Durable event store + artifact store

- [x] Implement SQLite event store with:
  - [x] schema versioning + migrations
  - [x] paging + replay
  - [x] indexing for session/task queries
- [x] Implement durable artifact store (filesystem or SQLite blobs) with size limits + redaction policy.
- [x] Add tests for persistence + replay equivalence vs in-memory store.

## P4 — Support Bundles + Observability

- [x] Implement support bundle export (single archive):
  - [x] `/health` + `/capabilities` snapshot
  - [x] runtime versions + adapter versions
  - [x] runtime config/policy snapshot (paths + safe hashes; no secrets)
  - [x] MCP transport matrix snapshot (supported + chosen)
  - [x] session event log (paged)
  - [x] tool execution transcripts
  - [x] runtime env isolation metadata (safe)
  - [x] raw payloads only via blob refs + size limits + redaction
- [x] Implement structured logging.
- [x] Implement Prometheus metrics + basic dashboards guidance.

## P5 — Productization (pick one integration surface)

- [x] Decide integration surface: library-first vs daemon-first.

### Option A — Library-first

- [x] Package and publishable build outputs (types + ESM/CJS as needed).
- [x] Document embedding patterns + example app snippet.

### Option B — Daemon-first

- [x] Implement `codesdkd` HTTP API (can mimic CLIwrapper if desired).
- [x] Add auth/capability endpoints + session/task endpoints + SSE/websocket streaming.
- [x] Add rate limiting + backpressure defaults.
- [x] Add `codesdkd` CLI binary (`npm bin`) with required flags and JSON URL output.
- [x] Default daemon CLI persistence to `SqliteEventStore` + `FileArtifactStore` under `--data-dir`.
- [x] Add `GET /sessions` list endpoint (pagination).
- [x] Add `GET /sessions/<sessionId>/support-bundle` (tar.gz) using `createSupportBundle()`.
- [x] Fix support-bundle package version resolution when installed as a dependency (no `process.cwd()` assumptions).
- [x] Implement real `permissionMode=ask` (pause tool execution) + approve/deny endpoints.
- [x] Add `/artifacts/<artifactId>/download` alias endpoint.
- [x] Document daemon API (`docs/daemon-api.md`).

## P6 — Runtime Parity Closeout (Codex + OpenCode owned-tools)

This phase closes the remaining parity gaps so all runtimes can:

- stream coherently in live mode
- execute **CodeSDK-owned** tools (via MCP) end-to-end
- run the same “prompt + tool path” smoke tests without skips (when env is configured)

### P6.A — External MCP tool host (`codesdk-mcp`)

- [x] Implement a standalone MCP server binary `codesdk-mcp` for CodeSDK-owned tools.
  - [x] Support `stdio` transport (required for Codex + OpenCode local MCP registration).
  - [ ] Optional: support HTTP/SSE (useful for remote server-side registration / proxies).
- [x] Add CLI/env configuration for:
  - [x] `workspaceRoot`
  - [x] permission mode (`ask|auto|yolo`) + overrides
  - [x] sandbox runner selection (host vs Docker) + network/timeout defaults
- [x] Add a smoke test that spawns `codesdk-mcp` and exercises `tools/list` + `tools/call`.

### P6.B — Codex: MCP injection + tool-path live test

- [x] Clarify scope: Codex CLI/IDE support MCP as a **client**; CodeSDK’s gap is MCP *registration management* for the Codex adapter.
- [x] Decide the injection mechanism (avoid CLI dependency; use `CODEX_HOME` + minimal TOML writes):
  - [x] Write/append a minimal `CODEX_HOME/config.toml` with `[mcp_servers.<id>]` for stdio `codesdk-mcp`.
  - [ ] Optional: use `CODEX_HOME=<temp>` + `codex mcp add ...` (idempotent, but requires the CLI binary in PATH).
  - [ ] Optional: use `codex -c key=value ...` overrides for one-off tests (only if workable for nested MCP config).
- [x] Implement Codex adapter MCP “injection”:
  - [x] If `toolManifest` is provided, ensure a `codesdk` MCP server is available to Codex (prefer stdio `codesdk-mcp`).
  - [x] Prefer namespaced `CODEX_HOME` so adapter tests don’t mutate the user’s real Codex config.
  - [x] Record the effective MCP config snapshot (paths + safe hashes; no secrets) in `model.input.implicit_sources_ref`.
- [x] Add mocked tests asserting:
  - [x] A configured MCP server produces `mcp_tool_call` items and CodeSDK maps them to `tool.call.*`.
  - [x] Tool naming is stable and matches what the model sees (server + tool).
- [x] Add gated live test: `codex-sdk tool path` (CodeSDK tool executed via MCP; stream completes).
- [x] Update `docs/runtimes/codex-sdk.md` with concrete findings (config locations, tool naming, and how CodeSDK injects MCP).

### P6.C — OpenCode: MCP registration + tool-path live test

- [x] Add an OpenCode server harness for tests:
  - [x] Start `opencode serve` on a free port (default is `127.0.0.1:4096`; choose a port and pass `--port`).
  - [x] Export `OPENCODE_BASE_URL` for the live test suite (preferred; documented by OpenCode).
  - [x] Isolate OpenCode config/state for tests (temp config dir/file) so we don’t mutate developer state.
  - [x] Shutdown/cleanup after tests.
- [x] Implement OpenCode MCP registration:
  - [x] Register the `codesdk` MCP server with OpenCode via `/mcp` (local stdio command or remote URL).
  - [x] Verify status via `/mcp` and capture MCP state in implicit sources.
  - [x] Optional: record chosen MCP transport in support bundles (`mcp-transports.json`).
- [x] Add mocked tests asserting:
  - [x] MCP registration requests are well-formed and idempotent.
  - [x] Tool call events from OpenCode map to SSOT `tool.call.*` with stable identities.
- [x] Add gated live test: `opencode-server tool path` (CodeSDK tool executed via MCP; stream completes).
- [x] Document required env vars and defaults:
  - [x] `OPENCODE_BASE_URL` (preferred); `OPENCODE_URL` (CodeSDK alias; not an official OpenCode knob)
  - [x] directory selection (`x-opencode-directory` header; verify in live smoke test)
  - [x] provider/model selection (provider/model IDs)

### P6.D — Closeout gates (parity)

- [x] Live suite runs with **no runtime skips** when required env vars are present (Codex + OpenCode included).
- [x] Codex + OpenCode both demonstrate “prompt + CodeSDK-owned tool path” end-to-end using OAuth state on this machine.
- [x] Support bundles include chosen MCP transport + config snapshots for Codex/OpenCode MCP integrations.

## Final gates (release readiness)

- [x] All adapters pass the contract test matrix (mocked) in CI.
- [x] Live tests pass for supported runtimes (when enabled).
- [x] Support bundle export works on a real failing run and is actionable.
- [x] Docs are consistent: `docs/plan.md`, `docs/runtime-adapter-interface.md`, `docs/runtimes/*`, `docs/contract-tests.md`.
