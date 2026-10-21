type Level = 'debug' | 'info' | 'warn' | 'error';

const SENSITIVE_KEY = /authorization|token|secret|password|cookie|apikey|api_key|signature/i;
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** Redacts secrets by key name and masks email local-parts in string values. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return value.replace(EMAIL, '$1***@$2');
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redact(value.message), stack: value.stack };
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(bindings: Record<string, unknown> = {}, level: Level = 'info'): Logger {
  const write = (lvl: Level, msg: string, data?: Record<string, unknown>) => {
    if (order[lvl] < order[level]) return;
    const line = JSON.stringify({
      level: lvl,
      time: new Date().toISOString(),
      msg,
      ...(redact(bindings) as object),
      ...(data ? (redact(data) as object) : {}),
    });
    if (lvl === 'error') console.error(line);
    else if (lvl === 'warn') console.warn(line);
    else console.info(line);
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    child: (b) => createLogger({ ...bindings, ...b }, level),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
