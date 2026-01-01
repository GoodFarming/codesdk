# CodeSDK Daemon API (`codesdkd`)

`codesdkd` is a local HTTP daemon intended to be embedded as a subprocess (e.g. by GoodFarmingAI Control Hub) and proxied under a single origin.

All JSON fields use `snake_case`.

## Base URL

The daemon binds to `http://<host>:<port>`. When started with `--port 0`, it prints the actual URL as JSON to stdout:

```json
{"url":"http://127.0.0.1:12345"}
```

## Endpoints

### `GET /health`

Returns runtime health for the selected runtime (default runtime unless `?runtime=<name>` is provided).

### `GET /capabilities`

Returns runtime capability flags for the selected runtime (default runtime unless `?runtime=<name>` is provided).

### `GET /auth/status`

Returns safe auth status metadata for the selected runtime (default runtime unless `?runtime=<name>` is provided).

### `GET /sessions`

Lists sessions created since daemon start.

Query params:

- `limit` (default `100`, max `500`)
- `after` (optional `session_id` cursor)

Response:

```json
{
  "sessions":[
    {"session_id":"...","runtime":"codex-sdk","runtime_session_id":null,"created_at":"..."}
  ],
  "next_after":"..."
}
```

### `POST /sessions`

Creates a session.

Request body (all optional unless noted):

- `runtime` (string runtime name)
- `credentialNamespace` (default: `"default"`)
- `isolationLevel` / `isolationMode`
- `cwd`, `env`
- `model`
- `permissionMode` (`auto|ask|yolo`)
- `runtimeConfig` (runtime-specific object)

Response:

```json
{"session_id":"...","runtime":"codex-sdk","runtime_session_id":null,"created_at":"..."}
```

### `GET /sessions/<sessionId>`

Returns basic session metadata:

```json
{"session_id":"...","runtime":"codex-sdk","created_at":"..."}
```

### `GET /sessions/<sessionId>/events`

Returns normalized SSOT events.

Query params:

- `after_seq` (or `from_seq`): start after this `seq`
- `limit` (default `500`)
- `stream=1` to stream via SSE

SSE:

- Set `Accept: text/event-stream` or `?stream=1`.
- Sends a `ready` event first, then `data: <event-json>` frames.

### `POST /sessions/<sessionId>/tasks`

Starts a task.

Request body:

- `messages` (**required**) transcript messages
- `taskId` (optional; default generated)
- `permissionMode` (optional; default from session or daemon default)
- `runtimeConfig` (optional)
- `toolManifest` (optional; defaults to daemon tool registry manifest when present)

Response:

```json
{"session_id":"...","task_id":"...","status":"started"}
```

### `GET /sessions/<sessionId>/tasks/<taskId>`

Returns task status derived from terminal events:

```json
{"session_id":"...","task_id":"...","status":"running","last_seq":123}
```

### `POST /sessions/<sessionId>/tasks/<taskId>/stop`

Requests best-effort task cancellation and emits `task.stopped`.

### `POST /sessions/<sessionId>/tool-calls/<toolCallId>/approve`

Used when `permissionMode=ask` (pauses tool execution until a decision).

Request body:

```json
{"attempt":1,"input_hash":"sha256:..."}
```

### `POST /sessions/<sessionId>/tool-calls/<toolCallId>/deny`

Request body:

```json
{"attempt":1,"input_hash":"sha256:...","reason":"optional human reason"}
```

### `GET /sessions/<sessionId>/support-bundle`

Downloads a `tar.gz` support bundle for the session.

Query params:

- `task_id` (optional; included in the bundle manifest filename/metadata only)

Notes:

- Artifacts are capped (size-limited).
- Environment metadata is sanitized; no raw env vars are included.

### `GET /artifacts/<artifactId>`

Returns the artifact bytes with the stored content type.

### `GET /artifacts/<artifactId>/download`

Alias for `/artifacts/<artifactId>`.

### `GET /metrics`

Returns Prometheus metrics (only if metrics are enabled for the daemon instance).

