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
//     worker starts (refusedSql; the worker's limits hold without this, it just fails faster);
//   - at most MAX_CONCURRENT runs at once and MAX_WAITING queued; past that the caller is told the
//     playground is busy instead of piling up workers. A caller (routes/learn.ts passes the account)
//     holds at most one of those places, so one account cannot fill the queue for everyone else.
// The response shape ({ columns, rows, rowCount, truncated, error }) is what services/learnApi.ts reads.

import { DEFAULT_SQL_WORKER_LIMITS, runSqlInWorker, type SqlRunResult, type SqlWorkerLimits } from './sqlWorker.js';

export type { SqlRunResult } from './sqlWorker.js';

export const MAX_SCHEMA_CHARS = 20_000;
export const MAX_QUERY_CHARS = 4_000;
// The production container is 1/4 vCPU (api-proxy/wrangler.jsonc `basic`). Each run is CPU-bound on its
// own thread, so every extra concurrent run takes CPU from the main event loop that serves every other
// request: one at a time. A trivial run costs about 0.1 s of CPU (a fresh isolate plus sql.js), an
// endless one is stopped at the 2 s deadline, so a full queue waits at most ~16 s.
const MAX_CONCURRENT = 1;
const MAX_WAITING = 8;

const empty: SqlRunResult = { columns: [], rows: [], rowCount: 0, truncated: false };

// ── what may not run ────────────────────────────────────────────────────────────────────────────
// Each of these either manufactures data out of nothing (randomblob, zeroblob), or reaches past the
// limits the worker sets (ATTACH / VACUUM write other database files; the size pragmas would undo or
// resize them; load_extension). A learner never needs any of them in an exercise.
//
// They are matched on SQLite's own tokens, not on the raw text: the schema is model-written seed data
// ("Robot Vacuum", a `page_size` column, 'Attach the invoice') and a query has LIKE '%2024%' patterns,
// so a whole-text word match refused real lessons. String literals and comments never match; a
// function only where it is called (its name — bare or quoted, SQLite accepts "randomblob"(9) — then
// `(`, comments allowed between); a statement only where a statement starts (after EXPLAIN [QUERY
// PLAN] too); a pragma only as the name after PRAGMA [schema.] (bare, quoted or a string — SQLite
// accepts PRAGMA 'max_page_count' = …).
const BLOCKED_FUNCTIONS = new Set(['randomblob', 'zeroblob', 'load_extension']);
const BLOCKED_STATEMENTS = new Set(['attach', 'detach', 'vacuum']);
const BLOCKED_PRAGMAS = new Set([
  'max_page_count',
  'temp_store',
  'temp_store_directory',
  'page_size',
  'mmap_size',
  'cache_size',
  'soft_heap_limit',
  'hard_heap_limit'
]);
/**
 * printf / format: a `*` width or precision, or one of 1000 or more (`printf('%.*c', 1e9, 'x')`). A
 * leading `0` is the zero-pad flag, not part of the number, so `%0100d` (width 100) and `%.0999f`
 * (precision 999) run while `%01000d` is refused.
 *
 * The format is read one conversion at a time, as SQLite's printf reads it: flags, width, `.precision`,
 * `l` or `ll`, then the type character, which may itself be `%`. So every literal percent is a whole
 * conversion (`%%`, but also `%l%`, `%5l%`, `%.3ll%`), and it cannot pair up with the `%` that starts
 * the next one (`'%l%%1000d'` is `%l%` then `%1000d`).
 *
 * This is a fast path for a literal first argument only. A computed or parenthesised format
 * (`printf(('%.*c'), …)`, `printf(col, …)`, `printf('%' || …)`) is not read here: the worker's
 * `hard_heap_limit` is what bounds those widths (`out of memory`).
 */
const FORMAT_FUNCTIONS = new Set(['printf', 'format']);
const FORMAT_CONVERSION = /%[-+ 0#,!]*(\*|\d+)?(?:\.(\*|\d*))?l{0,2}(?:[\s\S]|$)/g;
const hugeFormat = (format: string): boolean => {
  for (const [, width, precision] of format.matchAll(FORMAT_CONVERSION)) {
    for (const n of [width, precision]) if (n === '*' || (n && Number(n) >= 1000)) return true;
  }
  return false;
};

type SqlToken = { kind: 'word' | 'quoted' | 'string' | 'punct'; text: string };

/**
 * What separates tokens (SQLite's tokenizer), and what ends a `$name(…)` suffix (sqlite3Isspace).
 * SQLite reads a U+FEFF (the UTF-8 BOM bytes) where a token starts as space (CC_BOM), so
 * `SELECT 1; \uFEFFATTACH …` is an ATTACH to it; inside a name it stays part of the name (IDENT_PART),
 * and SQL_SPACE is only tested where a token starts.
 */
const SQL_SPACE = /[ \t\n\f\r\ufeff]/;
const C_SPACE = /[ \t\n\v\f\r]/;
const IDENT_START = /[A-Za-z_\u0080-\uffff]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-\uffff]/;

/** `sql` as SQLite tokenizes it, without whitespace and comments (an unterminated one runs to the end). */
export const sqlTokens = (sql: string): SqlToken[] => {
  const out: SqlToken[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (SQL_SPACE.test(c)) {
      i += 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? n : end + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      // A doubled quote is the quote character itself; there are no backslash escapes.
      let text = '';
      let j = i + 1;
      for (;;) {
        const end = sql.indexOf(c, j);
        if (end < 0) {
          text += sql.slice(j);
          j = n;
          break;
        }
        text += sql.slice(j, end);
        if (sql[end + 1] === c) {
          text += c;
          j = end + 2;
        } else {
          j = end + 1;
          break;
        }
      }
      out.push({ kind: c === "'" ? 'string' : 'quoted', text });
      i = j;
    } else if (c === '[') {
      const end = sql.indexOf(']', i + 1);
      out.push({ kind: 'quoted', text: sql.slice(i + 1, end < 0 ? n : end) });
      i = end < 0 ? n : end + 1;
    } else if (c === '$' || c === '@' || c === '#' || c === ':') {
      // A parameter, read the way SQLite reads it: a name with Tcl's `::` and `(…)` suffixes. The
      // suffix runs to `)` or a space and may hold quotes: `$a(')` is ONE token, not a string start.
      let j = i + 1;
      let named = 0;
      while (j < n) {
        const d = sql[j];
        if (IDENT_PART.test(d)) {
          named += 1;
          j += 1;
        } else if (d === '(' && named > 0) {
          j += 1;
          while (j < n && !C_SPACE.test(sql[j]) && sql[j] !== ')') j += 1;
          if (sql[j] === ')') j += 1;
          break;
        } else if (d === ':' && sql[j + 1] === ':') {
          j += 2;
        } else {
          break;
        }
      }
      out.push({ kind: 'punct', text: sql.slice(i, j) }); // a value, never a name
      i = j;
    } else if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(sql[j])) j += 1;
      out.push({ kind: 'word', text: sql.slice(i, j) });
      i = j;
    } else {
      out.push({ kind: 'punct', text: c });
      i += 1;
    }
  }
  return out;
};

const lower = (t: SqlToken | undefined): string => (t ? t.text.toLowerCase() : '');
const isWord = (t: SqlToken | undefined, w: string) => t?.kind === 'word' && lower(t) === w;
const isPunct = (t: SqlToken | undefined, p: string) => t?.kind === 'punct' && t.text === p;
const isName = (t: SqlToken | undefined) => t?.kind === 'word' || t?.kind === 'quoted';
const notAvailable = (name: string) => `“${name.toUpperCase()}” isn’t available in this playground.`;

/** Why `sql` may not run here, or null. */
export const refusedSql = (sql: string): string | null => {
  const toks = sqlTokens(sql);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    // A statement keyword where a statement starts.
    if (i === 0 || isPunct(toks[i - 1], ';')) {
      let j = i;
      if (isWord(toks[j], 'explain')) {
        j += 1;
        if (isWord(toks[j], 'query') && isWord(toks[j + 1], 'plan')) j += 2;
      }
      if (toks[j]?.kind === 'word' && BLOCKED_STATEMENTS.has(lower(toks[j]))) return notAvailable(toks[j].text);
    }
    // PRAGMA [schema.]name
    if (isWord(t, 'pragma')) {
      const name = isPunct(toks[i + 2], '.') ? toks[i + 3] : toks[i + 1];
      if (name && name.kind !== 'punct' && BLOCKED_PRAGMAS.has(lower(name))) return notAvailable(name.text);
    }
    // A call: name ( …
    if (isName(t) && isPunct(toks[i + 1], '(')) {
      const fn = lower(t);
      if (BLOCKED_FUNCTIONS.has(fn)) return notAvailable(t.text);
      // The format is the first argument; a double-quoted one is a string too (SQLite's legacy rule).
      const fmt = toks[i + 2];
      const literal = fmt?.kind === 'string' || fmt?.kind === 'quoted';
      if (FORMAT_FUNCTIONS.has(fn) && literal && hugeFormat(fmt.text)) {
        return 'printf/format widths over 999 (or “*”) aren’t available in this playground.';
      }
    }
  }
  return null;
};

// ── concurrency gate ────────────────────────────────────────────────────────────────────────────
let running = 0;
const waiting: (() => void)[] = [];
/** Callers with a run in flight (running or queued). */
const callers = new Set<string>();
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

export const SQL_BUSY_MESSAGE = 'The SQL playground is busy right now. Try again in a moment.';
export const SQL_ONE_AT_A_TIME_MESSAGE = 'Your previous query is still running. Try again when it finishes.';

/**
 * Run `query` against a fresh database built from `schema`. `caller` (the route passes the account)
 * may have one run in flight at a time; without it (internal use, tests) there is no per-caller cap.
 */
export const runSql = async (schema: string, query: string, caller?: string): Promise<SqlRunResult> => {
  const q = String(query || '').slice(0, MAX_QUERY_CHARS).trim();
  if (!q) return { ...empty, error: 'Write a SQL query to run.' };
  const setup = String(schema || '').slice(0, MAX_SCHEMA_CHARS).trim();
  const refused = refusedSql(setup) || refusedSql(q);
  if (refused) return { ...empty, error: refused };

  if (caller) {
    if (callers.has(caller)) return { ...empty, error: SQL_ONE_AT_A_TIME_MESSAGE };
    callers.add(caller);
  }
  try {
    if (!(await acquire())) return { ...empty, error: SQL_BUSY_MESSAGE };
    try {
      return await runSqlInWorker(setup, q, limits);
    } finally {
      release();
    }
  } finally {
    if (caller) callers.delete(caller);
  }
};
