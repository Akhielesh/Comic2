// Tiny structured logger: every line is ONE JSON object with an ISO `ts`, so logs
// are timestamped and greppable wherever stdout is collected (Railway / Cloudflare).
//
// Intentionally dependency-free — no winston/pino — to match the existing
// `console.log(JSON.stringify({ event, … }))` convention in this codebase while
// guaranteeing two things the team asked for: a timestamp on every log, and a
// consistent shape (ts, level, event, …fields) that's easy to slice later.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
  let line: string;
  try {
    line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  } catch {
    // A field wasn't serializable (circular ref, BigInt, …) — never let logging throw.
    line = JSON.stringify({ ts: new Date().toISOString(), level, event, note: 'unserializable_fields' });
  }
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
};

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => emit('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit('error', event, fields)
};
