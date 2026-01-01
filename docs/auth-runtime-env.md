# Auth + Runtime Environment (OAuth-first reality)

If CodeSDK wraps agent runtimes to keep their OAuth ergonomics, then “where does the runtime read/write its state?” is part of the system contract.

## Problem statement

Agent runtimes typically depend on local state:

- OAuth credential caches
- config files
- policy rules
- logs

If CodeSDK does not control (or at least describe) the runtime’s HOME/XDG/config paths, you get:

- non-deterministic behavior across machines
- hard-to-debug “works on my box” issues
- multi-tenant credential leakage risk

## First-class concepts

### Credential namespace

A stable identifier describing “which user/principal’s runtime state is mounted”.

Examples:

- single-tenant: `default`
- multi-tenant: `user:<user_id>`
- CI: `ci:<job_id>`

This namespace is used to decide which directory (or volume) is mapped to the runtime’s HOME/XDG dirs.

### RuntimeEnv isolation levels

Support at least:

- `shared`: runtimes use the host’s normal HOME/XDG dirs (easy, least isolated)
- `namespaced`: per-user HOME/XDG (recommended for multi-tenant)
- `ephemeral`: per-session HOME/XDG (best isolation, may break OAuth unless creds are injected)

### Runtime isolation modes (how the runtime is hosted)

Isolation *levels* describe directory layout; isolation *modes* describe process boundaries:

- `in_process`: runtime library runs inside the CodeSDK process
  - fastest, but HOME/XDG/config state is effectively process-global
  - risky for multi-tenant when the runtime uses disk-based OAuth caches
- `subprocess`: runtime runs in a dedicated worker process with its own environment + HOME/XDG dirs
  - recommended for multi-tenant when OAuth/local caches are in play
- `server_side`: CodeSDK talks to an external runtime server (e.g., OpenCode)
  - isolation is enforced by the server boundary; CodeSDK supplies credentials/config via the server’s mechanisms

### Subprocess IPC (recommended)

If you choose `subprocess`, define the wire protocol up front so tests and failure modes are predictable.

Recommended choice: **JSON-RPC 2.0 over stdio** (line-delimited JSON works fine in practice).

Minimum methods/flows to support the duplex runtime interface:

- `runtime.startTask` → begins a task stream for a given `{session_id, task_id}` and returns a handle id
- `runtime.sendToolResult` / `runtime.sendToolDenied` → feeds tool outcomes back into the runtime loop
- `runtime.stop` → best-effort cancellation
- notifications: `runtime.event` → emits normalized events (the same shape CodeSDK stores)

Failure handling:

- if the worker exits mid-task, the executor emits `task.failed` with a retryable flag based on cause
- avoid reconnect/resume complexity in P1; prefer restarting workers and using SSOT reconstruct resume

### Runtime config/policy sources (snapshot, not secrets)

Many runtimes read implicit sources from disk (configs, policies, project instructions) that materially change:

- tool availability and approvals
- injected system instructions
- transport choices (e.g., MCP server registrations)

CodeSDK must make these sources observable and replayable:

- capture a **config/policy snapshot** (paths within the credential namespace + safe hashes + redaction flags)
- attach it to `model.input` via an `implicit_sources_ref` artifact (or explicitly record sources were disabled)
- never include raw secrets/tokens in snapshots

## Recommended implementation approach

1) Implement a `runtime-env` module that produces a `RuntimeEnv`:
   - `cwd`
   - environment variables (including HOME/XDG overrides when isolation enabled)
   - `credentialNamespace`
   - `isolationMode` (in_process | subprocess | server_side)

2) For local OAuth-based runtimes:
   - Prefer `namespaced` by default.
   - Use `ephemeral` only when you have a way to inject credentials (or accept interactive login per session in dev).
   - For multi-tenant: prefer `subprocess` isolation mode unless the runtime is explicitly safe in-process.

3) If you containerize runtimes:
   - Mount the chosen credential namespace dir into the container’s HOME/XDG.
   - Keep tool sandboxing separate (tools can be in Docker even if runtime is on-host, or vice versa).

## What CodeSDK should expose

- `GET /auth/status` (or library method) per runtime:
  - `logged_in`, `auth_model`, safe `account_label`
- `GET /runtime-env` debugging endpoint (dev-only):
  - show effective HOME/XDG/cwd and which sources are loaded (but never secrets)
- Support bundle should include:
  - runtime name + version
  - isolation level + credential namespace (safe identifiers only)
