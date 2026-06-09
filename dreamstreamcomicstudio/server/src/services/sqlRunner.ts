// Runs a learner's SQL against an EPHEMERAL in-memory SQLite (sql.js / WASM) for the
// interactive SQL playground. Each call gets a fresh DB seeded from the exercise's
// schema, runs the user's query, and returns the rows or the SQLite error message.
//
// Safety: sql.js is pure WASM — it cannot touch the filesystem or network, so user SQL
// is sandboxed to its own throwaway database. Inputs are size-capped and results are
// row-capped. (Execution is synchronous; learning queries are tiny and SQLite bounds
// recursion, but a worker-thread + hard timeout is a sensible future hardening.)

// eslint-disable-next-line @typescript-eslint/no-var-requires
import initSqlJs from 'sql.js';

export interface SqlRunResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  error?: string;
}

export const MAX_SCHEMA_CHARS = 20_000;
export const MAX_QUERY_CHARS = 4_000;
const MAX_ROWS = 500;

let sqlPromise: Promise<Awaited<ReturnType<typeof initSqlJs>>> | null = null;
const getSql = () => (sqlPromise ||= initSqlJs());

export const runSql = async (schema: string, query: string): Promise<SqlRunResult> => {
  const empty: SqlRunResult = { columns: [], rows: [], rowCount: 0, truncated: false };
  const q = String(query || '').slice(0, MAX_QUERY_CHARS).trim();
  if (!q) return { ...empty, error: 'Write a SQL query to run.' };

  const SQL = await getSql();
  const db = new SQL.Database();
  try {
    const setup = String(schema || '').slice(0, MAX_SCHEMA_CHARS).trim();
    if (setup) db.run(setup);
    const res = db.exec(q);
    // No result set (e.g. INSERT/UPDATE/CREATE) → report success with affected rows.
    if (!res.length) {
      const changes = db.getRowsModified();
      return { ...empty, error: undefined, rowCount: changes, columns: ['result'], rows: [[`OK${changes ? ` — ${changes} row(s) affected` : ''}`]] };
    }
    const last = res[res.length - 1]; // surface the final statement's results
    const rows = last.values.slice(0, MAX_ROWS);
    return { columns: last.columns, rows, rowCount: last.values.length, truncated: last.values.length > MAX_ROWS };
  } catch (e) {
    return { ...empty, error: (e as Error)?.message || 'SQL error' };
  } finally {
    db.close();
  }
};
