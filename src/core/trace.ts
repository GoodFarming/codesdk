import type { TraceContext } from './types.js';

export function mergeTrace(base: TraceContext, override?: Partial<TraceContext>): TraceContext {
  return {
    session_id: override?.session_id ?? base.session_id,
    task_id: override?.task_id ?? base.task_id,
    request_id: override?.request_id ?? base.request_id,
    client_id: override?.client_id ?? base.client_id,
    user_id: override?.user_id ?? base.user_id
  };
}

export function ensureSessionId(trace: TraceContext, sessionId: string): TraceContext {
  if (trace.session_id && trace.session_id !== sessionId) {
    throw new Error(`trace.session_id mismatch: ${trace.session_id} != ${sessionId}`);
  }
  return { ...trace, session_id: sessionId };
}
