// One learner SQL run in its own worker thread (abuse-ops-2). services/sqlRunner.ts decides WHAT may
// run and how many at once; this module runs it and makes sure it ends.
//
// sql.js is SQLite compiled to WASM, and SQLite runs a statement synchronously: on the main thread a
// recursive CTE with no stopping condition (`WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x+1
// FROM r) SELECT count(*) FROM r`) pinned the event loop for every user, and `group_concat` /
// `printf('%.*c', …)` grew the container's memory without bound — no timer could fire to stop either.
// Here every run gets a FRESH worker (and so a fresh WASM heap, released when the worker ends):
//   - a hard deadline after the worker is ready, then `worker.terminate()` (terminate stops a thread
//     stuck in WASM — the main thread never waits on SQLite);
//   - memory, in layers: SQLite's own `PRAGMA hard_heap_limit` (every sqlite3_malloc — strings, sorts,
//     temp tables with temp_store=MEMORY — fails cleanly as "out of memory"; it can only be lowered from
//     SQL), `PRAGMA max_page_count` for the database file sql.js keeps in its in-memory FS, V8 heap limits
//     on the worker, and a process-RSS watchdog that terminates the run if the process grows more than
//     `rssGrowthBytes` while it runs (the backstop for anything outside the first three; it reads the
//     whole process, so a run that shares its window with a runaway one may be stopped with it);
//   - results are read with prepare/step: at most `maxRows` rows are kept (the rest are only counted),
//     strings over `maxCellChars` are cut, a blob is reported as `<blob N bytes>`, and the whole result
//     stays under `maxResultChars`, so what crosses back to the main thread is small;
//   - the worker gets an empty env (no backend secret reaches it) and nothing but sql.js.
// The program runs as CommonJS (eval: true) so `require` of sql.js works under tsx in dev and in the
// esbuild bundle (sql.js is external in Dockerfile.cloudflare and loads its .wasm from its package dir),
// the pattern services/pyodideRunner.ts uses.

import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';

export interface SqlRunResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  error?: string;
}

export interface SqlWorkerLimits {
  /** Run deadline once the engine is up (schema + query), then the worker is terminated. */
  deadlineMs: number;
  /** Time the worker may take to start sql.js before the run is abandoned. */
  initTimeoutMs: number;
  /** SQLite's hard heap limit, bytes. */
  heapLimitBytes: number;
  /** Largest database file, in pages (4 KiB each). */
  maxPageCount: number;
  /** Terminate when the process RSS grows more than this while the run is going. */
  rssGrowthBytes: number;
  maxRows: number;
  maxCellChars: number;
  maxResultChars: number;
  /** V8 heap limits for the worker. */
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
}

export const DEFAULT_SQL_WORKER_LIMITS: Readonly<SqlWorkerLimits> = Object.freeze({
  deadlineMs: 2_000,
  initTimeoutMs: 10_000,
  heapLimitBytes: 32 * 1024 * 1024,
  maxPageCount: 4_096, // 16 MiB
  rssGrowthBytes: 64 * 1024 * 1024,
  maxRows: 500,
  maxCellChars: 10_240,
  maxResultChars: 1_000_000,
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16
});

const RSS_SAMPLE_MS = 25;

export const SQL_TIMEOUT_MESSAGE = (ms: number) =>
  `The query ran longer than ${ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`} and was stopped. Add a LIMIT, or a stopping condition (for a recursive CTE, e.g. WHERE n < 100).`;
export const SQL_MEMORY_MESSAGE = 'The query used too much memory and was stopped. Try a smaller result (a LIMIT, fewer or shorter rows).';
const SQL_CRASH_MESSAGE = 'The SQL sandbox stopped unexpectedly. Please try again.';
const SQL_START_MESSAGE = 'The SQL sandbox could not start. Please try again in a moment.';

// The worker program. It posts `ready` once sql.js is loaded (the deadline starts there, so it covers
// the schema too: a request's schema is as untrusted as its query), then exactly one `result`.
const SQL_WORKER_SRC = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const initSqlJs = require(workerData.sqlJsPath);
const L = workerData.limits;

const empty = (error) => ({ columns: [], rows: [], rowCount: 0, truncated: false, error });

const cell = (v) => {
  if (v instanceof Uint8Array) return '<blob ' + v.length + ' bytes>';
  if (typeof v === 'string' && v.length > L.maxCellChars) return v.slice(0, L.maxCellChars) + '…';
  return v;
};
const size = (v) => (typeof v === 'string' ? v.length : 8);

const totalChanges = (db) => {
  const r = db.exec('SELECT total_changes()');
  return Number((r[0] && r[0].values[0] && r[0].values[0][0]) || 0);
};

(async () => {
  let SQL;
  try {
    SQL = await initSqlJs();
  } catch (err) {
    parentPort.postMessage({ type: 'init-error', error: String((err && err.message) || err) });
    return;
  }
  parentPort.postMessage({ type: 'ready' });
  const db = new SQL.Database();
  let result;
  try {
    db.run('PRAGMA hard_heap_limit = ' + L.heapLimitBytes + '; PRAGMA max_page_count = ' + L.maxPageCount + '; PRAGMA temp_store = MEMORY;');
    if (workerData.schema) db.run(workerData.schema);
    const before = totalChanges(db);
    // The final statement that has a result shape (a SELECT, a PRAGMA that answers, … RETURNING).
    let last = null;
    for (const stmt of db.iterateStatements(workerData.query)) {
      const columns = stmt.getColumnNames();
      const rows = [];
      let count = 0;
      let budget = L.maxResultChars;
      let full = false;
      while (stmt.step()) {
        count++;
        if (full || rows.length >= L.maxRows) continue;
        const row = stmt.get().map(cell);
        const cost = row.reduce((s, v) => s + size(v), 0);
        if (cost > budget) { full = true; continue; }
        budget -= cost;
        rows.push(row);
      }
      if (columns.length) last = { columns, rows, count };
    }
    if (last) {
      result = { columns: last.columns, rows: last.rows, rowCount: last.count, truncated: last.count > last.rows.length };
    } else {
      // No result set (INSERT / UPDATE / CREATE …): report what the query changed.
      const changes = Math.max(0, totalChanges(db) - before);
      result = { columns: ['result'], rows: [['OK' + (changes ? ' — ' + changes + ' row(s) affected' : '')]], rowCount: changes, truncated: false };
    }
  } catch (err) {
    result = empty(String((err && err.message) || 'SQL error'));
  } finally {
    try { db.close(); } catch {}
  }
  parentPort.postMessage({ type: 'result', result });
})();
`;

let sqlJsPath: string | null = null;
const resolveSqlJs = (): string => (sqlJsPath ||= createRequire(import.meta.url).resolve('sql.js'));

const failed = (error: string): SqlRunResult => ({ columns: [], rows: [], rowCount: 0, truncated: false, error });

/** Run `schema` then `query` in a fresh worker; always resolves (an error is a result with `error`). */
export const runSqlInWorker = (schema: string, query: string, limits: SqlWorkerLimits = DEFAULT_SQL_WORKER_LIMITS): Promise<SqlRunResult> =>
  new Promise<SqlRunResult>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(SQL_WORKER_SRC, {
        eval: true,
        env: {}, // nothing from the backend's env reaches the sandbox
        workerData: { sqlJsPath: resolveSqlJs(), schema, query, limits },
        resourceLimits: { maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb, maxYoungGenerationSizeMb: limits.maxYoungGenerationSizeMb }
      });
    } catch {
      resolve(failed(SQL_START_MESSAGE));
      return;
    }

    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    let watchdog: NodeJS.Timeout | undefined;
    const startup = setTimeout(() => finish(failed(SQL_START_MESSAGE)), limits.initTimeoutMs);
    startup.unref();

    function finish(result: SqlRunResult) {
      if (settled) return;
      settled = true;
      clearTimeout(startup);
      if (deadline) clearTimeout(deadline);
      if (watchdog) clearInterval(watchdog);
      worker.removeAllListeners('message');
      // Fresh worker per run: always end it (a no-op once it has exited on its own).
      void worker.terminate().catch(() => undefined);
      resolve(result);
    }

    worker.on('message', (m: { type?: string; result?: SqlRunResult; error?: string }) => {
      if (m?.type === 'ready') {
        clearTimeout(startup);
        const baseline = process.memoryUsage.rss();
        deadline = setTimeout(() => finish(failed(SQL_TIMEOUT_MESSAGE(limits.deadlineMs))), limits.deadlineMs);
        deadline.unref();
        watchdog = setInterval(() => {
          if (process.memoryUsage.rss() - baseline > limits.rssGrowthBytes) finish(failed(SQL_MEMORY_MESSAGE));
        }, RSS_SAMPLE_MS);
        watchdog.unref();
      } else if (m?.type === 'result' && m.result) {
        finish(m.result);
      } else if (m?.type === 'init-error') {
        finish(failed(SQL_START_MESSAGE));
      }
    });
    worker.on('error', (err: Error & { code?: string }) =>
      finish(failed(err?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? SQL_MEMORY_MESSAGE : SQL_CRASH_MESSAGE))
    );
    worker.on('exit', () => finish(failed(SQL_CRASH_MESSAGE)));
  });
