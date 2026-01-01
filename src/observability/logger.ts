export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  base?: Record<string, unknown>;
  stream?: NodeJS.WritableStream;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export function createJsonLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const base = options.base ?? {};
  const stream = options.stream ?? process.stdout;
  const min = LEVEL_ORDER[level];

  const log = (lvl: LogLevel, message: string, context?: Record<string, unknown>) => {
    if (LEVEL_ORDER[lvl] < min) return;
    const payload = {
      time: new Date().toISOString(),
      level: lvl,
      message,
      ...base,
      ...(context ?? {})
    };
    stream.write(`${JSON.stringify(stripUndefined(payload))}\n`);
  };

  const child = (context: Record<string, unknown>): Logger => {
    return createJsonLogger({
      level,
      base: { ...base, ...context },
      stream
    });
  };

  return {
    debug: (message, context) => log('debug', message, context),
    info: (message, context) => log('info', message, context),
    warn: (message, context) => log('warn', message, context),
    error: (message, context) => log('error', message, context),
    child
  };
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger
};

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    next[key] = entry;
  }
  return next;
}
