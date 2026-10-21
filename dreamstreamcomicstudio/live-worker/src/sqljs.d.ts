// Minimal types for sql.js — used only by the tests to run MonitorStore on real SQLite.
declare module 'sql.js' {
  export interface Statement {
    bind(values?: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  }
  export interface Database {
    prepare(sql: string): Statement;
  }
  export interface SqlJsStatic {
    Database: new () => Database;
  }
  export default function initSqlJs(config?: unknown): Promise<SqlJsStatic>;
}
