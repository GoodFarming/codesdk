export type ErrorCode =
  | 'CONTEXT_TOO_LARGE'
  | 'RUNTIME_ERROR'
  | 'TOOL_ERROR'
  | 'AUTH_ERROR'
  | 'CANCELLED'
  | 'INVALID_EVENT'
  | 'INTERNAL';

export interface ErrorDetails {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  runtime?: string;
  raw?: unknown;
}

export class CodeSdkError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly runtime?: string;
  readonly raw?: unknown;

  constructor(details: ErrorDetails) {
    super(details.message);
    this.name = 'CodeSdkError';
    this.code = details.code;
    this.retryable = details.retryable;
    this.runtime = details.runtime;
    this.raw = details.raw;
  }
}
