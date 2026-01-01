# CodeSDK — Implementation Handover (for next agent)

This handover is for the next agent who will implement CodeSDK from the plan in `/home/adam/CodeSDK/docs/`.

## 0) What CodeSDK is (and why it exists)

CodeSDK is a new project directory at `/home/adam/CodeSDK` intended to be an **application-ready wrapper over agent runtimes** (not “model providers”).

The goal is to keep the best ergonomics of agent runtimes (notably OAuth login flows + their internal agent loops) while providing:

- a stable, app-friendly contract: sessions/messages/events/tool calls/artifacts
- owned tool execution (permissioning + auditing + sandboxing)
- event sourcing + replay for debugging/support bundles
- capability-driven behavior so clients don’t guess what’s supported

Runtimes in scope (initial):

- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- Codex SDK (`@openai/codex-sdk`)
- Gemini CLI Core (`@google/gemini-cli-core`)
- OpenCode server (`@opencode-ai/sdk`, talking to `opencode serve`)

## 1) Current state in the filesystem

Implementation is underway. Core SSOT types, event/artifact stores, executor, context compiler, MCP tool host, JSON-RPC IPC, and runtime adapters for `claude-agent-sdk`, `codex-sdk`, `gemini-cli-core`, and `opencode-server` are in place with a growing test suite. The authoritative progress tracker is `docs/checklist.md`.

Entry points:

- `/home/adam/CodeSDK/README.md`
- `/home/adam/CodeSDK/docs/plan.md` (main SSOT plan)
- `/home/adam/CodeSDK/docs/runtime-adapter-interface.md` (critical: duplex runtime interface + capability fields)
- `/home/adam/CodeSDK/docs/auth-runtime-env.md` (critical: OAuth + local caches + isolation)
- `/home/adam/CodeSDK/docs/checklist.md` (tactical checklist)
- `/home/adam/CodeSDK/docs/runtimes/*` (per-runtime harness specs; required)

Reference repo used for methodology (Agor) is currently cloned at `/tmp/agor` (not part of CodeSDK), useful for patterns:

- `/tmp/agor/packages/executor/src/sdk-handlers/*`

If `/tmp/agor` is missing later, re-clone from `https://github.com/preset-io/agor`.

## 2) Key decisions (do not “simplify away”)

These are the decisions that prevent classic “wrapper fails once tools/resume/multi-tenant shows up” problems.

### 2.1 We wrap *agent runtimes*, not providers

Agent runtimes are opinionated systems:

- they have their own tool semantics
- they have their own session/thread persistence assumptions
- they may have their own policy engines
- they may read/write local state for auth/config

So CodeSDK should not pretend everything is uniform. We unify:

- event sourcing + storage + audit + support bundles
- tool ownership via MCP + sandbox
- API surface to apps (sessions/events/messages/artifacts)

…and we keep runtime-specific adapters for everything else.

### 2.2 Runtime integration must be **duplex**

An `AsyncGenerator<events>` is insufficient because the executor must feed information back to the runtime while it’s streaming:

- tool results
- tool denials
- stop/cancel signals

So the runtime interface in `/home/adam/CodeSDK/docs/runtime-adapter-interface.md` uses:

- `startTask(...) -> RuntimeTaskHandle`
- `RuntimeTaskHandle.events()` to stream out
- `RuntimeTaskHandle.sendToolResult(...)` / `sendToolDenied(...)` to send back in
- `RuntimeTaskHandle.stop(...)` for cancellation

This prevents brittle side-channels and makes testing straightforward.

### 2.3 Idempotency + resume semantics are SSOT (P0), not a later polish

Wrapping agent runtimes means you’ll see duplicates on retries/resume:

- tool call requests can reappear
- a “resume” can cause the runtime to replay internal steps

Without stable tool identity, you will accidentally re-run tools.

So SSOT includes:

- `resumeModel`: `native | reconstruct | none`
- tool call identity fields on tool events:
  - `tool_call_id` (CodeSDK stable id)
  - `runtime_tool_call_id` (optional)
  - `attempt` (starts at 1; increments on replay/resume/retry)
  - `input_hash` (hash of canonicalized input)

### 2.4 MCP-first tool ownership is a principle (and must be proven in P1)

CodeSDK should host “owned tools” via an MCP server wherever supported by the runtime.

This ensures:

- consistent permissioning + auditing
- consistent sandboxing
- consistent tool schemas
- minimal runtime-specific tool plumbing

Because MCP-first is a principle, P1 must include a minimal MCP tool host (1–2 tools) so we prove the path early.

### 2.5 OAuth + runtime local caches are first-class (auth/ + runtime-env/)

OAuth implies:

- credential caches on disk
- config directories
- policies/rules
- logs

So we added first-class concepts:

- `auth/`: `getAuthStatus()` and dev-friendly `ensureLogin()` instructions
- `runtime-env/`: credential namespace + isolation level + isolation mode

Isolation must be explicitly modeled as:

- isolation **levels**: shared/namespaced/ephemeral (directory layout)
- isolation **modes**: in_process/subprocess/server_side (process boundary)

For multi-tenant, avoid `in_process` for runtimes that read disk-based OAuth caches (prefer subprocess or server-side).

### 2.6 Event store must stay small; blob “raw” payloads

We keep a `raw` escape hatch, but we do not want huge JSON dumps or stdout in the main event table.

Rule:

- normalized event rows stay small
- big `raw` payloads go to a blob/artifact store, referenced via `raw_ref` (or similar)
- support bundles include raw only within limits and after redaction

### 2.7 Context handling is SSOT (not “whatever the runtime remembers”)

If you can’t answer “what did the runtime actually see?” you can’t debug, replay, or reconstruct resume.

So CodeSDK must:

- own a canonical transcript (messages + tool calls/results + artifact refs)
- own a deterministic “context compiler” that produces runtime inputs from that transcript
- record compiled inputs in `model.input` (prefer artifact refs + hashes to keep rows small)
- budget/truncate tool outputs and long histories explicitly (and record omissions)
- handle implicit prompt/context sources per runtime (disable vs capture) and make them observable via `model.input`

### 2.8 Event schema versioning is required (fixtures + replay depend on it)

You will change event payloads as you integrate multiple runtimes.

So:

- include `schema_version` on every event (bump on breaking changes)
- include a `contract_version` on `session.created` so bundles/fixtures can be interpreted correctly
- prefer reader upcasters over rewriting historical logs

### 2.9 Per-runtime harness specs + contract tests are required

The core contract is runtime-agnostic, but the *operational reality* is not.

Before implementing a runtime adapter, write (and keep updated) its harness spec under:

- `/home/adam/CodeSDK/docs/runtimes/*`

Each adapter should also be validated against a shared contract test matrix (streaming, tool approve/deny, cancellation, non-interactive mode, implicit sources capture/disablement, parallel tool calls, MCP transport selection).

## 3) SSOT contracts you must implement first

### 3.1 Normalized event families

The normalized event set in `/home/adam/CodeSDK/docs/plan.md` includes:

- `model.input` (canonical “what did we send?”; prefer artifact/blob refs for large inputs + attachments)
- `model.output.delta` / `model.output.completed` (typed block deltas + final assistant blocks)
- `tool.call.*` (requested, policy_evaluated, approved/denied, started, completed)
- `tool.output.delta` / `tool.output.completed` (stream tool stdout/stderr/progress)
- `usage.reported` (tokens/timings when available)
- `runtime.request.started/completed` (optional but highly useful)

Important semantic clarification:

- `tool.call.policy_evaluated` may happen **multiple times** (runtime policy, CodeSDK policy, user approval).
- `tool.call.approved` / `tool.call.denied` is the **single terminal effective decision**.

### 3.2 Capabilities must reflect “runtime wrapper reality”

In addition to the basic booleans, capabilities must include:

- auth model (`oauth_local`/`api_key`/`both`)
- tool execution model (`external_mcp`/`runtime_internal`/`hybrid`)
- permission model (`codesdk`/`runtime`/`hybrid`)
- state model (`in_process`/`local_disk`/`server_side`/`hybrid`)
- resume model (`native`/`reconstruct`/`none`)
- tool replay safety (`safe_replay`/`requires_reapproval`/`unknown`)
- MCP support + transports (`none/client_only/server_only/both` + `stdio/sse/http`)
- cancellation model (`best_effort`/`guaranteed`/`unknown`)
- supported/recommended isolation modes (`in_process/subprocess/server_side`)
- parallel tool calls support (multiple outstanding tool calls)

Clients should be able to feature-detect safely without guessing.

### 3.3 Transcript + context compilation (replay/resume reality)

You must be able to:

- derive a canonical transcript from SSOT events (without duplication)
- compile “what we send” to each runtime deterministically (including tool manifests + runtime config)
- reconstruct resume without re-running tools by replaying tool results from stored artifacts

## 4) Tool execution model (owned tools)

Default posture:

- CodeSDK owns tools (audit + permission + sandbox).
- MCP-first tool exposure to runtimes.
- Runtime-native tools are off unless explicitly enabled.

Tool registry defaults:

- Start with: `workspace.read`, `workspace.write`, `patch.apply`
- Keep `workspace.exec` disabled by default.
  - If you ever enable it: require Docker isolation + allowlist + timeout + network off by default.

Permissioning:

- Permission decisions must be events (who/what decided, when, why).
- Support `ask/auto/yolo` but don’t assume runtimes map cleanly; record source-of-decision in `tool.call.policy_evaluated`.

## 5) Runtime environment + auth (OAuth reality)

### 5.1 Credential namespaces

The executor should treat “where runtime state lives” as a first-class parameter (even for single-tenant).

Recommended convention:

- `credentialNamespace = "default"` (single-tenant)
- `credentialNamespace = "user:<user_id>"` (multi-tenant)

### 5.2 Isolation mode policy

If you plan to support multi-tenant:

- do not run disk-cached OAuth runtimes `in_process` unless proven safe
- use:
  - `subprocess` workers (set HOME/XDG vars per worker)
  - or `server_side` runtimes when available (OpenCode)

### 5.3 What “getAuthStatus” should do

Auth probes must:

- never return secrets/token values
- return safe metadata only (e.g., “logged in” boolean, account label if safe, auth mode)
- point to dev instructions if login is missing

## 6) Recommended implementation sequence (don’t skip the vertical slice)

This aligns with `/home/adam/CodeSDK/docs/checklist.md`.

### P0 (foundation)

Deliverables:

- repo skeleton (TS toolchain + tests)
- SSOT types + capability model
- normalized event schema + schema versioning
- canonical transcript model + deterministic context compiler
- canonicalization + stable hashing rules
- in-memory event store with paging + replay
- CLI viewer that streams events
- duplex runtime adapter interface as code (not just docs)

### P1 (one runtime end-to-end)

Deliverables:

- `auth/` + `runtime-env/` primitives
- minimal in-process MCP tool host (1–2 tools, e.g., `workspace.read`)
- one runtime integrated end-to-end:
  - stream model output
  - request tool calls (including multiple outstanding calls if the runtime emits them)
  - execute tools via MCP tool host
  - feed tool results/denials back to runtime
  - emit policy/approval events + tool.output streaming
  - capture implicit sources + runtime config snapshot into `model.input`
- adapter contract test matrix passing (mocked; optional live gated)

Pick the first runtime:

- **Claude Agent SDK** is a good first choice because hooks + MCP are strong.
- **Gemini CLI core** is also a good first choice because policy/tool architecture is explicit.

### P2 (second runtime + cross-runtime proof)

Deliverables:

- second runtime adapter with same end-to-end behavior
- fixtures + deterministic replay tests across both

### P3+ (persistence + sandbox + ops)

Deliverables:

- expand MCP tool host + ToolRegistry schema validation
- Docker sandbox runner for tools
- durable event store (SQLite) + artifact store
- support bundle export
- metrics + rate limiting + backpressure

## 7) Implementation gotchas (read before coding)

### Tool call duplication on retry/resume

Assume you will see tool call repeats; implement:

- stable `tool_call_id`
- input hash + attempt tracking
- policy: “safe tools may be replayed” vs “requires re-approval”

### Concurrency on the same runtime session

Do not allow concurrent tasks to drive the same runtime session/thread unless the runtime explicitly supports it.

You likely need:

- per-session mutex (engine-level)
- or separate runtime session per task for some runtimes

P0 default: **one active task per session** (make this a hard guard in the executor so clients don’t assume concurrency).

### Cancellation semantics vary

Some runtimes provide clean cancellation, others are best-effort.

Expose `cancellationModel` and always emit `task.stopped` when CodeSDK stops, even if the runtime might continue briefly.

### Context window overflow is a real failure mode

Large tool outputs + long sessions will blow past context windows.

Implement early:

- tool output truncation/compaction (prefer artifact refs)
- explicit omission reporting in `model.input` (what was dropped, why)
- a structured `task.failed` path for “context too large” with a recovery hint

### Hidden inputs + non-interactive quirks will surprise you if you don’t encode them

Real runtimes often:

- read implicit prompt/config/policy sources from disk (project instructions, user config)
- behave differently when stdin is not interactive (e.g., “ask” policies can become “deny”)
- claim to restrict tools but still expose/execute them unless you gate at runtime hooks + CodeSDK policy
- request multiple tool calls before any results are provided (parallel tool calls)
- support different MCP transports with real compatibility differences across runtimes

Treat these as harness-spec requirements + contract tests, not “later polish”.

### Don’t bloat the event store

Blob raw payloads + stdout/stderr into artifacts; keep event rows small.

### Runtime policy engines can conflict with CodeSDK policy

Record all policy evaluations (source + result) and be explicit about final effective decision.

### In-process isolation is often fake isolation

If the runtime reads global config early or caches auth state in module scope, you can’t safely isolate per-tenant in the same process.

## 8) Open questions the implementer should resolve early

These are listed in the plan; they are implementation-shaping:

1) Single-tenant vs multi-tenant?
2) Do we need strict API compatibility with CLIwrapper or can CodeSDK define a new contract?
3) Is MCP the primary tool transport for all runtimes (preferred), or do we allow runtime-native tools broadly?
4) Do we containerize tools only, runtimes only, or both?

## 9) Where to look (SSOT + pointers)

- Main plan: `/home/adam/CodeSDK/docs/plan.md`
- Runtime adapter interface: `/home/adam/CodeSDK/docs/runtime-adapter-interface.md`
- Auth/runtime-env: `/home/adam/CodeSDK/docs/auth-runtime-env.md`
- Tactical checklist: `/home/adam/CodeSDK/docs/checklist.md`
- Adapter contract tests: `/home/adam/CodeSDK/docs/contract-tests.md`
- Per-runtime harness specs: `/home/adam/CodeSDK/docs/runtimes/*`
- Agor reference patterns: `/tmp/agor/packages/executor/src/sdk-handlers/*`
