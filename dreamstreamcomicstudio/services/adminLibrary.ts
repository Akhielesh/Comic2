// Admin-only client for the platform asset library console (/api/comic/admin/library/*).
// Same shape as services/adminCosts.ts. The server re-checks requireAdmin on every call.
// Nothing here spends money by itself: quotes are dry runs, a run is created only by an explicit
// "Build" click (confirm: true), and each `step` advances ≤ 3 assets while the console is open.

import { get, post } from './apiClient';
import type {
  LibraryBuildRequest,
  LibraryEntryView,
  LibraryManifestView,
  LibraryQuote,
  LibraryRunSummary,
  LibraryRunView,
  LibraryStepView
} from '../shared/comic/library';

export type {
  LibraryBuildRequest,
  LibraryCandidateView,
  LibraryEntryView,
  LibraryManifestView,
  LibraryQuote,
  LibraryRunSummary,
  LibraryRunView,
  LibraryStepView
} from '../shared/comic/library';

const BASE = '/api/comic/admin/library';
const enc = encodeURIComponent;

export interface LibraryStartResult {
  run: LibraryRunView | null;
  quote: LibraryQuote;
  message: string;
}

export const getLibraryManifest = (signal?: AbortSignal): Promise<LibraryManifestView> => get<LibraryManifestView>(`${BASE}/manifest`, { signal });

export const quoteLibraryBuild = (req: LibraryBuildRequest, signal?: AbortSignal): Promise<{ quote: LibraryQuote; tableReady: boolean }> =>
  post<LibraryBuildRequest, { quote: LibraryQuote; tableReady: boolean }>(`${BASE}/quote`, req, { signal });

/** Create a run (the admin's explicit click). Spends nothing until it is stepped. */
export const startLibraryBuild = (req: LibraryBuildRequest): Promise<LibraryStartResult> =>
  post<LibraryBuildRequest & { confirm: true }, LibraryStartResult>(`${BASE}/runs`, { ...req, confirm: true });

export const listLibraryRuns = (limit = 10): Promise<{ runs: LibraryRunSummary[] }> => get<{ runs: LibraryRunSummary[] }>(`${BASE}/runs?limit=${Math.max(1, Math.min(50, limit))}`);

export const getLibraryRun = (runId: string, signal?: AbortSignal): Promise<LibraryRunView> => get<LibraryRunView>(`${BASE}/runs/${enc(runId)}`, { signal });

/** Advance a run by ≤ n (1–3) assets. Idempotent: a concurrent step answers `busy`. */
export const stepLibraryRun = (runId: string, n = 3, signal?: AbortSignal): Promise<LibraryStepView> =>
  post<{ n: number }, LibraryStepView>(`${BASE}/runs/${enc(runId)}/step`, { n: Math.max(1, Math.min(3, Math.floor(n))) }, { signal });

export const cancelLibraryRun = (runId: string): Promise<LibraryRunView> => post<Record<string, never>, LibraryRunView>(`${BASE}/runs/${enc(runId)}/cancel`, {});

export const publishLibraryAsset = (id: string, rev?: number): Promise<LibraryEntryView> =>
  post<{ rev?: number }, LibraryEntryView>(`${BASE}/assets/${enc(id)}/publish`, rev === undefined ? {} : { rev });

export const rejectLibraryAsset = (id: string, note?: string): Promise<LibraryEntryView> =>
  post<{ note?: string }, LibraryEntryView>(`${BASE}/assets/${enc(id)}/reject`, note ? { note } : {});

export const regenerateLibraryAsset = (id: string, opts: { note?: string; budgetUsd?: number } = {}): Promise<LibraryStartResult> =>
  post<{ note?: string; budgetUsd?: number; confirm: true }, LibraryStartResult>(`${BASE}/assets/${enc(id)}/regenerate`, { ...opts, confirm: true });

export const purgeLibraryCandidates = (dryRun: boolean): Promise<{ dryRun: boolean; objects: number; bytes: number }> =>
  post<{ dryRun: boolean }, { dryRun: boolean; objects: number; bytes: number }>(`${BASE}/assets/purge-candidates`, { dryRun });
