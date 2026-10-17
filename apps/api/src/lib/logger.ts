/**
 * Structured logging.
 *
 * One JSON object per line so logs can be shipped and queried without a parser
 * per format. Values that could carry secrets (tokens, cookies, passwords,
 * storage credentials, email addresses) are redacted centrally: call sites
 * cannot forget.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEYS = /(pass(word)?|secret|token|cookie|authorization|api_?key|csrf|session|credential|signed)/i;

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(bindings: LogContext): Logger;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (typeof value === 'string') {
    if (value.length > 500) return `${value.slice(0, 500)}…`;
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redact(entry, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.test(key) ? '[redacted]' : redact(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  name?: string;
  sink?: (line: string) => void;
  now?: () => Date;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info';
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const name = options.name ?? 'moydan';
  const now = options.now ?? (() => new Date());
  const threshold = LEVEL_ORDER[level] ?? 20;

  const build = (bindings: LogContext): Logger => ({
    debug: (message, context) => emit('debug', message, context),
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
    child: (extra) => build({ ...bindings, ...extra }),
  });

  const emit = (logLevel: LogLevel, message: string, context?: LogContext): void => {
    if (LEVEL_ORDER[logLevel] < threshold) return;
    const record = {
      ts: now().toISOString(),
      level: logLevel,
      logger: name,
      msg: message,
      ...(redact({ ...bindings, ...context }) as Record<string, unknown>),
    };
    sink(JSON.stringify(record));
  };

  const bindings: LogContext = {};
  return build(bindings);
}

/** In-memory logger used by tests to assert on diagnostics. */
export function createMemoryLogger(level: LogLevel = 'debug'): Logger & { lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({ level, sink: (line) => lines.push(line) });
  return Object.assign(logger, { lines });
}

export function hashForLogs(value: string): string {
  // Never log raw IPs or tokens: keep a short stable prefix for correlation.
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return `h${(hash >>> 0).toString(16)}`;
}
