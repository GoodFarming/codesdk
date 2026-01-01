# CodeSDK Metrics (Prometheus)

CodeSDK ships a Prometheus metrics helper that you can wire into your own HTTP server or metrics exporter.

## Usage

```ts
import { ExecutorEngine, createPrometheusMetrics } from 'codesdk';

const metrics = createPrometheusMetrics();
const engine = new ExecutorEngine({ metrics });

// Expose from your HTTP server.
const body = await metrics.metrics();
```

## Metric list

- `codesdk_active_tasks` (gauge): tasks currently in progress.
- `codesdk_active_sessions` (gauge): sessions with an active task.
- `codesdk_task_queue_depth` (gauge): tasks waiting behind the per-session lock.
- `codesdk_tasks_started_total` (counter, labels: `runtime`).
- `codesdk_tasks_finished_total` (counter, labels: `runtime`, `status`).
- `codesdk_task_duration_seconds` (histogram, labels: `runtime`, `status`).
- `codesdk_tool_executions_total` (counter, labels: `runtime`, `tool`, `status`, `execution_env`).
- `codesdk_tool_duration_seconds` (histogram, labels: `runtime`, `tool`, `status`, `execution_env`).
- `codesdk_backpressure_drops_total` (counter, labels: `reason`).

## Dashboard guidance (PromQL examples)

- Active load:
  - `codesdk_active_tasks`
  - `codesdk_active_sessions`
  - `codesdk_task_queue_depth`
- Task latency (p50/p95):
  - `histogram_quantile(0.5, sum(rate(codesdk_task_duration_seconds_bucket[5m])) by (le, runtime))`
  - `histogram_quantile(0.95, sum(rate(codesdk_task_duration_seconds_bucket[5m])) by (le, runtime))`
- Task outcomes:
  - `sum(rate(codesdk_tasks_finished_total[5m])) by (runtime, status)`
- Tool failures:
  - `sum(rate(codesdk_tool_executions_total{status="error"}[5m])) by (runtime, tool)`
- Tool latency (p95):
  - `histogram_quantile(0.95, sum(rate(codesdk_tool_duration_seconds_bucket[5m])) by (le, runtime, tool))`
- Backpressure drops:
  - `sum(rate(codesdk_backpressure_drops_total[5m])) by (reason)`
