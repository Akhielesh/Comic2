// Client for the sandboxed learning-execution endpoints (SQL playground, …).

import { post } from './apiClient';

export interface SqlRunResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  error?: string;
}

export const runSqlExercise = (schema: string, query: string): Promise<SqlRunResult> =>
  post<{ schema: string; query: string }, SqlRunResult>('/api/learn/sql', { schema, query });
