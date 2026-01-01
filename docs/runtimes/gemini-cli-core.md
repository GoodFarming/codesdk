# Runtime Harness Spec — Gemini CLI Core (`gemini-cli-core`)

This spec documents harness-specific behavior that must be encoded as adapter requirements, default config choices, and contract tests.

## Identity

- Runtime name (CodeSDK): `gemini-cli-core`
- Upstream: `@google/gemini-cli-core` (Gemini CLI core)
- Expected hosting modes: `in_process` (dev), `subprocess` (multi-tenant)

## Auth + local state

Observed (from core source):

- API keys via `GEMINI_API_KEY` or `GOOGLE_API_KEY`.
- OAuth creds stored at `~/.gemini/oauth_creds.json`.
- Account cache at `~/.gemini/google_accounts.json`.
- MCP OAuth tokens at `~/.gemini/mcp-oauth-tokens.json`.
- Global settings at `~/.gemini/settings.json`; policies in `~/.gemini/policies/`.
- Workspace settings at `./.gemini/settings.json`; policies in `./.gemini/policies/`.
- System settings at `/etc/gemini-cli/settings.json` (macOS: `/Library/Application Support/GeminiCli/settings.json`, Windows: `C:\ProgramData\gemini-cli\settings.json`), override via `GEMINI_CLI_SYSTEM_SETTINGS_PATH`.

Adapter responsibilities:

- Implement `getAuthStatus(env)` safely (no secrets).
- Make HOME/XDG explicit via `RuntimeEnv` so auth/config locations are deterministic.
- Include auth/config/policy snapshot in `model.input.implicit_sources_ref` (paths + hashes; no secrets).

## Implicit prompt/context sources

Observed sources that can affect prompt/context or tool behavior:

- System prompt override: `~/.gemini/system.md` or `GEMINI_SYSTEM_MD` (boolean switch or path).
- Global memory/context: `~/.gemini/GEMINI.md` (default context filename; override via `contextFileName`).
- Project context: `./GEMINI.md`.
- Global settings/policies (see above) can change tool availability and approval policy.
- CLI/system settings files can alter defaults (model, approval mode, MCP servers, etc.).

Decision rule:

- Either disable implicit sources for determinism, or capture them and include a snapshot reference in `model.input`.

## Tool system + restriction strategy

Default posture:

- Prefer MCP-first CodeSDK-owned tools.
- Treat runtime-native tools/config as non-authoritative for security; enforce in CodeSDK.

Operational notes:

- Core tools are registered based on `coreTools` config; CodeSDK should pass an empty list and inject its own tool manifest.
- Tool allowlists/flags may behave differently in non-interactive mode; do not treat as security.

Contract tests:

- Forbidden tool must not execute (assert behavior).

## Parallel tool calls

Requirement:

- Support multiple outstanding tool calls (queue + execute serially in P1 is acceptable).

## Interactive vs non-interactive mode

Observed:

- `interactive: false` is supported and expected for automation.
- Approval policy is enforced by the policy engine; non-interactive runs should not block for prompts.

Adapter requirements:

- Run non-interactive by default for server use; never block waiting for stdin prompts.
- Emit `tool.call.policy_evaluated` events that attribute decisions to the runtime vs CodeSDK vs user.

Contract tests:

- Non-interactive run does not block.
- Policy behavior differences are explicit in the event log and do not silently flip without trace.

## MCP support

Observed:

- MCP clients are managed via `McpClientManager` with support for stdio + SSE + streamable HTTP.
- OAuth for MCP servers is supported (tokens stored in `~/.gemini/mcp-oauth-tokens.json`).

Adapter requirements:

- Treat tool invocation reliability as a capability/degradation problem (not an invariant).
- Record MCP transport selection and tool manifest hashes in `model.input`.

## Cancellation semantics

Requirement:

- Implement `stop()` as best-effort and always emit `task.stopped` when CodeSDK stops.

## Version + config snapshot

Support bundles must include:

- runtime version + adapter version
- policy/config snapshot (paths + hashes; redaction)
- MCP transport matrix snapshot (supported + chosen transport)
