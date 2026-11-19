// Tiny structured logger: every line is ONE JSON object with an ISO `ts`, so logs
// are timestamped and greppable wherever stdout is collected (Cloudflare / Railway).
//
// Intentionally dependency-free — no winston/pino — to match the existing
// `console.log(JSON.stringify({ event, … }))` convention in this codebase while
// guaranteeing two things the team asked for: a timestamp on every log, and a
// consistent shape (ts, level, event, …fields) that's easy to slice later.

//
// Every string in the line (the event and every field, at any depth) passes through redactSecrets
// first, so a vendor error that echoes a key never reaches the log store as text.

import { redactSecrets } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** JSON.stringify replacer: strings are redacted after any toJSON (Dates stay ISO strings). */
const redactStrings = (_key: string, value: unknown): unknown => (typeof value === 'string' ? redactSecrets(value) : value);

const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
  let line: string;
  try {
    line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }, redactStrings);
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
