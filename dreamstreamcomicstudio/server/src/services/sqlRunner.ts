// Runs a learner's SQL against an EPHEMERAL in-memory SQLite (sql.js / WASM) for the
// interactive SQL playground (POST /api/learn/sql). Each call gets a fresh DB seeded from the
// exercise's schema, runs the user's query, and returns the rows or the SQLite error message.
//
// Safety: sql.js is pure WASM — it cannot touch the filesystem or network, so user SQL is
// sandboxed to its own throwaway database. But SQLite runs synchronously, so the run happens in
// its own worker thread with a hard deadline and memory caps (services/sqlWorker.ts, abuse-ops-2):
// the main thread never runs user SQL and never blocks on it. This module is the policy around it:
//   - inputs are size-capped; an empty query never starts a worker;
//   - functions and statements whose only use here is to exhaust the sandbox are refused before a
//     worker starts (BLOCKED_SQL; the worker's limits hold without this, it just fails faster);
//   - at most MAX_CONCURRENT runs at once and MAX_WAITING queued; past that the caller is told the
//     playground is busy instead of piling up workers.
// The response shape ({ columns, rows, rowCount, truncated, error }) is what services/learnApi.ts reads.

import { DEFAULT_SQL_WORKER_LIMITS, runSqlInWorker, type SqlRunResult, type SqlWorkerLimits } from './sqlWorker.js';

export type { SqlRunResult } from './sqlWorker.js';

export const MAX_SCHEMA_CHARS = 20_000;
export const MAX_QUERY_CHARS = 4_000;
const MAX_CONCURRENT = 2;
const MAX_WAITING = 16;

const empty: SqlRunResult = { columns: [], rows: [], rowCount: 0, truncated: false };

/**
 * Refused anywhere in the schema or query (whole words, so `attachments` is fine; a keyword cannot be
 * split by a comment in SQLite, so this cannot be dodged by spelling). Each one either manufactures data
 * out of nothing (randomblob, zeroblob), or reaches past the limits the worker sets (ATTACH / VACUUM
 * write other database files; max_page_count, temp_store, page_size, mmap_size, cache_size and the heap
 * limit pragmas would undo or resize them). A learner never needs any of them in an exercise.
 */
const BLOCKED_SQL =
  /\b(randomblob|zeroblob|attach|detach|vacuum|max_page_count|temp_store|temp_store_directory|page_size|mmap_size|cache_size|soft_heap_limit|hard_heap_limit|load_extension)\b/i;
/** printf / format with a `*` width or precision, or one of 4+ digits (`printf('%.*c', 1e9, 'x')`). */
const HUGE_FORMAT = /\b(printf|format)\s*\(/i;
const HUGE_FORMAT_SPEC = /%[-+ 0#,!]*(\*|\d{4,}|\d*\.(\*|\d{4,}))/;

/** Why `sql` may not run here, or null. */
export const refusedSql = (sql: string): string | null => {
  const blocked = BLOCKED_SQL.exec(sql);
  if (blocked) return `“${blocked[1].toUpperCase()}” isn’t available in this playground.`;
  if (HUGE_FORMAT.test(sql) && HUGE_FORMAT_SPEC.test(sql)) return 'printf/format widths over 999 (or “*”) aren’t available in this playground.';
  return null;
};

// ── concurrency gate ────────────────────────────────────────────────────────────────────────────
let running = 0;
const waiting: (() => void)[] = [];
const acquire = (): Promise<boolean> => {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return Promise.resolve(true);
  }
  if (waiting.length >= MAX_WAITING) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => waiting.push(() => resolve(true)));
};
const release = () => {
  const next = waiting.shift();
  if (next) next(); // the slot passes straight to the next caller
  else running -= 1;
};

let limits: SqlWorkerLimits = DEFAULT_SQL_WORKER_LIMITS;
/** Tests only: shorter deadlines / tighter caps. Pass nothing to restore the defaults. */
export const __setSqlLimitsForTests = (patch?: Partial<SqlWorkerLimits>) => {
  limits = patch ? { ...DEFAULT_SQL_WORKER_LIMITS, ...patch } : DEFAULT_SQL_WORKER_LIMITS;
};
/** Tests only: runs in flight and queued. */
export const __sqlRunnerLoad = () => ({ running, waiting: waiting.length });

export const runSql = async (schema: string, query: string): Promise<SqlRunResult> => {
  const q = String(query || '').slice(0, MAX_QUERY_CHARS).trim();
  if (!q) return { ...empty, error: 'Write a SQL query to run.' };
  const setup = String(schema || '').slice(0, MAX_SCHEMA_CHARS).trim();
  const refused = refusedSql(setup) || refusedSql(q);
  if (refused) return { ...empty, error: refused };

  if (!(await acquire())) return { ...empty, error: 'The SQL playground is busy right now. Try again in a moment.' };
  try {
    return await runSqlInWorker(setup, q, limits);
  } finally {
    release();
  }
};
