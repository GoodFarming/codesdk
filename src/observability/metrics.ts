import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { RuntimeName } from '../core/types.js';

export type TaskStatus = 'completed' | 'failed' | 'stopped';
export type ToolStatus = 'success' | 'error';

export interface EngineMetrics {
  taskStarted(runtime: RuntimeName): void;
  taskFinished(runtime: RuntimeName, status: TaskStatus, durationSeconds?: number): void;
  setActiveTasks(count: number): void;
  setActiveSessions(count: number): void;
  setQueueDepth(count: number): void;
  toolExecution(runtime: RuntimeName, tool: string, status: ToolStatus, durationSeconds?: number, executionEnv?: string): void;
  recordBackpressureDrop(reason: string): void;
}

export interface PrometheusMetricsOptions {
  registry?: Registry;
  prefix?: string;
  collectDefaultMetrics?: boolean;
}

export interface PrometheusMetrics extends EngineMetrics {
  registry: Registry;
  metrics(): Promise<string>;
}

const DEFAULT_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];

export function createPrometheusMetrics(options: PrometheusMetricsOptions = {}): PrometheusMetrics {
  const registry = options.registry ?? new Registry();
  const prefix = options.prefix ?? 'codesdk_';

  if (options.collectDefaultMetrics) {
    collectDefaultMetrics({ register: registry });
  }

  const activeTasks = new Gauge({
    name: `${prefix}active_tasks`,
    help: 'Number of tasks currently in progress.',
    registers: [registry]
  });

  const activeSessions = new Gauge({
    name: `${prefix}active_sessions`,
    help: 'Number of sessions with an active task.',
    registers: [registry]
  });

  const queueDepth = new Gauge({
    name: `${prefix}task_queue_depth`,
    help: 'Number of tasks waiting behind the per-session lock.',
    registers: [registry]
  });

  const tasksStarted = new Counter({
    name: `${prefix}tasks_started_total`,
    help: 'Total number of tasks started.',
    labelNames: ['runtime'] as const,
    registers: [registry]
  });

  const tasksFinished = new Counter({
    name: `${prefix}tasks_finished_total`,
    help: 'Total number of tasks finished.',
    labelNames: ['runtime', 'status'] as const,
    registers: [registry]
  });

  const taskDuration = new Histogram({
    name: `${prefix}task_duration_seconds`,
    help: 'Task runtime latency in seconds.',
    labelNames: ['runtime', 'status'] as const,
    buckets: DEFAULT_BUCKETS,
    registers: [registry]
  });

  const toolExecutions = new Counter({
    name: `${prefix}tool_executions_total`,
    help: 'Total number of tool executions.',
    labelNames: ['runtime', 'tool', 'status', 'execution_env'] as const,
    registers: [registry]
  });

  const toolDuration = new Histogram({
    name: `${prefix}tool_duration_seconds`,
    help: 'Tool execution latency in seconds.',
    labelNames: ['runtime', 'tool', 'status', 'execution_env'] as const,
    buckets: DEFAULT_BUCKETS,
    registers: [registry]
  });

  const backpressureDrops = new Counter({
    name: `${prefix}backpressure_drops_total`,
    help: 'Number of tasks dropped due to backpressure.',
    labelNames: ['reason'] as const,
    registers: [registry]
  });

  return {
    registry,
    metrics: () => registry.metrics(),
    taskStarted: (runtime) => {
      tasksStarted.inc({ runtime });
    },
    taskFinished: (runtime, status, durationSeconds) => {
      tasksFinished.inc({ runtime, status });
      if (durationSeconds !== undefined) {
        taskDuration.observe({ runtime, status }, durationSeconds);
      }
    },
    setActiveTasks: (count) => {
      activeTasks.set(count);
    },
    setActiveSessions: (count) => {
      activeSessions.set(count);
    },
    setQueueDepth: (count) => {
      queueDepth.set(count);
    },
    toolExecution: (runtime, tool, status, durationSeconds, executionEnv) => {
      const env = executionEnv ?? 'unknown';
      toolExecutions.inc({ runtime, tool, status, execution_env: env });
      if (durationSeconds !== undefined) {
        toolDuration.observe({ runtime, tool, status, execution_env: env }, durationSeconds);
      }
    },
    recordBackpressureDrop: (reason) => {
      backpressureDrops.inc({ reason });
    }
  };
}

export const noopMetrics: EngineMetrics = {
  taskStarted: () => {},
  taskFinished: () => {},
  setActiveTasks: () => {},
  setActiveSessions: () => {},
  setQueueDepth: () => {},
  toolExecution: () => {},
  recordBackpressureDrop: () => {}
};
