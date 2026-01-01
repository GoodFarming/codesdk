export type TaskState = 'running' | 'completed' | 'failed' | 'stopped';

export type ToolCallAttemptState =
  | 'waiting_for_tool_decision'
  | 'running_tool'
  | 'feeding_tool_result'
  | 'completed'
  | 'denied';

export interface TaskStateSnapshot {
  state: TaskState;
  toolAttempts: Record<string, ToolCallAttemptState>;
}

export const TERMINAL_TASK_STATES: TaskState[] = ['completed', 'failed', 'stopped'];

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}
