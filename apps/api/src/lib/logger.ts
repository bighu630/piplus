type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function resolveMinLevel(): LogLevel {
  const env = (typeof Bun !== 'undefined' ? Bun.env.LOG_LEVEL : undefined) ?? 'info';
  return LEVEL_RANK.hasOwnProperty(env) ? (env as LogLevel) : 'info';
}

export type Logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  child: (context: Record<string, unknown>) => Logger;
};

export function createLogger(name: string): Logger {
  const minLevel = resolveMinLevel();

  function log(level: LogLevel, msg: string, meta?: Record<string, unknown>) {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      name,
      msg,
      ...(meta ?? {}),
    };
    const line = JSON.stringify(entry);
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (msg, meta) => log('debug', msg, meta),
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
    child(context: Record<string, unknown>) {
      const parent = this;
      return {
        debug: (msg, meta) => parent.debug(msg, { ...context, ...meta }),
        info: (msg, meta) => parent.info(msg, { ...context, ...meta }),
        warn: (msg, meta) => parent.warn(msg, { ...context, ...meta }),
        error: (msg, meta) => parent.error(msg, { ...context, ...meta }),
        child: (childCtx: Record<string, unknown>) => parent.child({ ...context, ...childCtx }),
      };
    },
  };
}
