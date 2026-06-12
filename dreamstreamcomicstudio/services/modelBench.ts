// Client for the admin model-bench API (/api/admin/model-bench) — the in-app
// "test every model" trigger. Types mirror server/src/services/modelBenchRunner.ts.

import { get, post } from './apiClient';

export type BenchSource = 'openrouter' | 'nvidia';
export type BenchPhase = 'echo' | 'context' | 'reasoning';

export interface BenchOptions {
  source: BenchSource | 'all';
  freeOnly: boolean;
  match: string;
  limit: number;
  phases: BenchPhase[];
  budgetUsd: number;
  maxPerModelUsd: number;
  concurrency: number;
  timeoutMs: number;
  maxTokens: number;
  contextTokens: number;
}

export interface BenchRecord {
  ts: string;
  source: BenchSource;
  model: string;
  phase: BenchPhase;
  ok: boolean;
  pass: boolean | null;
  httpStatus: number | null;
  ttftMs: number | null;
  totalMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  tokensPerSec: number | null;
  costUsd: number | null;
  servedModel: string | null;
  finishReason: string | null;
  errorClass: string | null;
  errorDetail: string | null;
  promptPreview: string;
  textPreview: string | null;
}

export interface BenchRunSummary {
  id: string;
  state: 'running' | 'done' | 'error';
  startedAt: string;
  finishedAt: string | null;
  options: BenchOptions;
  planned: number;
  tested: number;
  healthy: number;
  spendUsd: number;
  anomalyCount: number;
  error?: string;
}

export interface BenchRun extends BenchRunSummary {
  results: BenchRecord[];
  anomalies: string[];
}

export const startBench = (options: Partial<BenchOptions>): Promise<{ run: BenchRunSummary }> =>
  post<Partial<BenchOptions>, { run: BenchRunSummary }>('/api/admin/model-bench/start', options);

export const listBenchRuns = (): Promise<{ runs: BenchRunSummary[] }> =>
  get<{ runs: BenchRunSummary[] }>('/api/admin/model-bench/runs');

export const getBenchRunById = (id: string): Promise<{ run: BenchRun }> =>
  get<{ run: BenchRun }>(`/api/admin/model-bench/runs/${encodeURIComponent(id)}`);

// ── Client-side export of a finished run (no server round-trip) ─────────────────

export const benchRunToCsv = (run: BenchRun): string => {
  const cols: (keyof BenchRecord)[] = [
    'ts', 'source', 'model', 'phase', 'ok', 'pass', 'httpStatus', 'ttftMs', 'totalMs',
    'promptTokens', 'completionTokens', 'tokensPerSec', 'costUsd', 'servedModel',
    'finishReason', 'errorClass', 'errorDetail', 'promptPreview', 'textPreview'
  ];
  const escape = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(',')]
    .concat(run.results.map((r) => cols.map((c) => escape(r[c])).join(',')))
    .join('\n');
};

export const downloadBlob = (content: string, filename: string, type: string): void => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};
