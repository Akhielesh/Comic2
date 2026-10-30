// Persistence for the platform library (assets.md §5): `library_assets`, `library_runs` and the
// platform cost ledger (`generation_cost_events`, billable 0). Server-only: the tables are not
// writable by clients (server/sql/comic_library.sql). Conditional updates (claim a pending row,
// take the run's step lease) make every step idempotent across retries and instances.

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  LibraryAssetStatus,
  LibraryKind,
  LibraryQuote,
  LibraryRefineStrategy,
  LibraryRunView,
  LibraryTheme
} from '../../../../shared/comic/library.js';
import { getSupabaseAdmin } from '../../services/supabase.js';
import { logger } from '../../lib/logger.js';
import { StudioError } from '../types.js';
import type { NextAttempt } from './refine.js';

export interface LibraryCandidate {
  rev: number;
  path: string;
  thumbs: { 320?: string; 640?: string };
  w: number;
  h: number;
  bytes: number;
  score: number;
  issues: string[];
  codes: string[];
  strategy: LibraryRefineStrategy;
  /** prompt_hash the candidate was drawn from (only current-hash candidates can win automatically). */
  hash: string;
  /** The run that drew it (a run settles on its own best candidate). */
  runId?: string;
  at: number;
  caption?: string;
  alt?: string;
  tags?: string[];
  palette?: string[];
  textFound?: string[];
  costUsd?: number;
}

/** What the public index serves (kept live while a rebuild runs, until a better candidate replaces it). */
export interface LibraryPublishedSnapshot {
  rev: number;
  path: string;
  thumbs: { 320?: string; 640?: string };
  w: number;
  h: number;
  alt: string;
  caption?: string;
  tags: string[];
  palette: string[];
  at: number;
}

export interface LibraryAssetRow {
  manifest_version: number;
  id: string;
  kind: LibraryKind;
  status: LibraryAssetStatus;
  theme: LibraryTheme;
  preset_id: string | null;
  genre: string | null;
  prompt: string;
  prompt_hash: string;
  final_prompt: string | null;
  model: string;
  resolution: string;
  aspect: string;
  rev: number;
  /** Last revision number handed out (claimed atomically with the attempt, so a dead step's rev is never reused). */
  rev_seq: number;
  path: string | null;
  thumb_paths: { 320?: string; 640?: string };
  width: number | null;
  height: number | null;
  bytes: number | null;
  alt: string;
  caption: string | null;
  tags: string[];
  palette: string[];
  score: number | null;
  analysis: Record<string, unknown>;
  candidates: LibraryCandidate[];
  attempts: number;
  cost_usd: number;
  error: string | null;
  run_id: string | null;
  next_step: NextAttempt | null;
  published: LibraryPublishedSnapshot | null;
  reviewed_by: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

export interface LibraryRunRequest {
  ids?: string[];
  kinds?: LibraryKind[];
  force?: boolean;
  includeOptional?: boolean;
  maxRetries: 0 | 1 | 2;
  /** Regenerate with an art-director note (one-asset runs). */
  note?: string;
}

export interface LibraryRunRow {
  id: string;
  manifest_version: number;
  started_by: string;
  status: LibraryRunView['status'];
  budget_usd: number;
  spent_usd: number;
  request: LibraryRunRequest;
  quote: LibraryQuote | Record<string, never>;
  asset_ids: string[];
  counts: Partial<LibraryRunView['counts']>;
  lease_until: string | null;
  steps: number;
  error: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface LibraryCostEvent {
  userId: string;
  stage: 'library_image' | 'library_vision' | 'library_rewrite';
  provider: string;
  model: string;
  costUsd: number;
  metadata: Record<string, unknown>;
}

export interface AssetWhere {
  status?: LibraryAssetStatus[];
  runId?: string;
}

export interface LibraryRepo {
  listAssets(version: number): Promise<LibraryAssetRow[]>;
  getAsset(version: number, id: string): Promise<LibraryAssetRow | null>;
  /** Rows whose published snapshot is live (the public index). Rejecting the live revision clears the snapshot. */
  listPublished(version: number): Promise<LibraryAssetRow[]>;
  upsertAsset(row: LibraryAssetRow): Promise<void>;
  /** Conditional update; false when no row matched (someone else moved it first). */
  updateAsset(version: number, id: string, patch: Partial<LibraryAssetRow>, where?: AssetWhere): Promise<boolean>;
  /** Reset rows of a run stuck in generating/analyzing since before `olderThanIso`. Returns how many. */
  resetStuck(version: number, runId: string, olderThanIso: string): Promise<number>;
  /** Insert a run; throws StudioError CONFLICT (409) when another run is already running (unique index). */
  insertRun(row: LibraryRunRow): Promise<void>;
  getRun(id: string): Promise<LibraryRunRow | null>;
  activeRun(version: number): Promise<LibraryRunRow | null>;
  listRuns(version: number, limit: number): Promise<LibraryRunRow[]>;
  updateRun(id: string, patch: Partial<LibraryRunRow>, where?: { status?: LibraryRunView['status'] }): Promise<boolean>;
  /** Take the run's step lease when it is running and the lease is free or expired. */
  acquireLease(id: string, nowIso: string, untilIso: string): Promise<boolean>;
  releaseLease(id: string): Promise<void>;
  /** Platform spend ledger. Never throws (a ledger failure is logged and swallowed). */
  recordCost(event: LibraryCostEvent): Promise<void>;
}

export const TABLE_MISSING_MESSAGE = "The library tables aren't installed yet. Apply server/sql/comic_library.sql, then reload.";

/** 42P01 (undefined table) or PostgREST's schema-cache miss. */
export const isTableMissing = (err: unknown): boolean => {
  const e = err as { code?: string; message?: string } | null;
  return !!e && (e.code === '42P01' || e.code === 'PGRST205' || /relation .* does not exist|could not find the table/i.test(String(e.message || '')));
};

export const tableMissingError = (cause?: unknown): StudioError =>
  new StudioError('NOT_AVAILABLE', TABLE_MISSING_MESSAGE, { status: 503, cause });

const dbError = (what: string, err: unknown): StudioError => {
  if (isTableMissing(err)) return tableMissingError(err);
  logger.error('comic_library_db_error', { what, code: (err as { code?: string })?.code, message: (err as Error)?.message });
  return new StudioError('INTERNAL', "The library database didn't answer. Please try again.", { status: 503, retryable: true, cause: err });
};

const num = (v: unknown, d = 0): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : d;
};

/** numeric columns arrive as strings from PostgREST. */
const assetFromDb = (r: Record<string, unknown>): LibraryAssetRow =>
  ({
    ...(r as unknown as LibraryAssetRow),
    rev: num(r.rev),
    rev_seq: num(r.rev_seq),
    score: r.score === null || r.score === undefined ? null : num(r.score),
    attempts: num(r.attempts),
    cost_usd: num(r.cost_usd),
    tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    palette: Array.isArray(r.palette) ? (r.palette as string[]) : [],
    candidates: Array.isArray(r.candidates) ? (r.candidates as LibraryCandidate[]) : [],
    thumb_paths: (r.thumb_paths && typeof r.thumb_paths === 'object' ? r.thumb_paths : {}) as LibraryAssetRow['thumb_paths'],
    analysis: (r.analysis && typeof r.analysis === 'object' ? r.analysis : {}) as Record<string, unknown>
  }) as LibraryAssetRow;

const runFromDb = (r: Record<string, unknown>): LibraryRunRow =>
  ({
    ...(r as unknown as LibraryRunRow),
    budget_usd: num(r.budget_usd),
    spent_usd: num(r.spent_usd),
    steps: num(r.steps),
    asset_ids: Array.isArray(r.asset_ids) ? (r.asset_ids as string[]) : [],
    request: (r.request && typeof r.request === 'object' ? r.request : { maxRetries: 2 }) as LibraryRunRequest,
    counts: (r.counts && typeof r.counts === 'object' ? r.counts : {}) as LibraryRunRow['counts']
  }) as LibraryRunRow;

const ASSETS = 'library_assets';
const RUNS = 'library_runs';

/** Supabase (service role) implementation. */
export function createSupabaseLibraryRepo(admin: () => SupabaseClient = getSupabaseAdmin): LibraryRepo {
  return {
    async listAssets(version) {
      const { data, error } = await admin().from(ASSETS).select('*').eq('manifest_version', version);
      if (error) throw dbError('listAssets', error);
      return (data || []).map((r) => assetFromDb(r as Record<string, unknown>));
    },
    async getAsset(version, id) {
      const { data, error } = await admin().from(ASSETS).select('*').eq('manifest_version', version).eq('id', id).maybeSingle();
      if (error) throw dbError('getAsset', error);
      return data ? assetFromDb(data as Record<string, unknown>) : null;
    },
    async listPublished(version) {
      const { data, error } = await admin()
        .from(ASSETS)
        .select('id,kind,theme,preset_id,genre,aspect,published,manifest_version,status')
        .eq('manifest_version', version)
        .not('published', 'is', null);
      if (error) throw dbError('listPublished', error);
      return (data || []).map((r) => assetFromDb(r as Record<string, unknown>));
    },
    async upsertAsset(row) {
      const { error } = await admin().from(ASSETS).upsert(row, { onConflict: 'manifest_version,id' });
      if (error) throw dbError('upsertAsset', error);
    },
    async updateAsset(version, id, patch, where) {
      let q = admin().from(ASSETS).update(patch).eq('manifest_version', version).eq('id', id);
      if (where?.status?.length) q = q.in('status', where.status);
      if (where?.runId) q = q.eq('run_id', where.runId);
      const { data, error } = await q.select('id');
      if (error) throw dbError('updateAsset', error);
      return Array.isArray(data) && data.length > 0;
    },
    async resetStuck(version, runId, olderThanIso) {
      const { data, error } = await admin()
        .from(ASSETS)
        .update({ status: 'pending', error: 'Reset after an interrupted step.' })
        .eq('manifest_version', version)
        .eq('run_id', runId)
        .in('status', ['generating', 'analyzing'])
        .lt('updated_at', olderThanIso)
        .select('id');
      if (error) throw dbError('resetStuck', error);
      return Array.isArray(data) ? data.length : 0;
    },
    async insertRun(row) {
      const { error } = await admin().from(RUNS).insert(row);
      if (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new StudioError('CONFLICT', 'A library build is already running. Resume or cancel it first.', { status: 409 });
        }
        throw dbError('insertRun', error);
      }
    },
    async getRun(id) {
      const { data, error } = await admin().from(RUNS).select('*').eq('id', id).maybeSingle();
      if (error) throw dbError('getRun', error);
      return data ? runFromDb(data as Record<string, unknown>) : null;
    },
    async activeRun(version) {
      const { data, error } = await admin().from(RUNS).select('*').eq('manifest_version', version).eq('status', 'running').limit(1);
      if (error) throw dbError('activeRun', error);
      return data && data[0] ? runFromDb(data[0] as Record<string, unknown>) : null;
    },
    async listRuns(version, limit) {
      const { data, error } = await admin()
        .from(RUNS)
        .select('*')
        .eq('manifest_version', version)
        .order('started_at', { ascending: false })
        .limit(Math.max(1, Math.min(50, limit)));
      if (error) throw dbError('listRuns', error);
      return (data || []).map((r) => runFromDb(r as Record<string, unknown>));
    },
    async updateRun(id, patch, where) {
      let q = admin().from(RUNS).update(patch).eq('id', id);
      if (where?.status) q = q.eq('status', where.status);
      const { data, error } = await q.select('id');
      if (error) throw dbError('updateRun', error);
      return Array.isArray(data) && data.length > 0;
    },
    async acquireLease(id, nowIso, untilIso) {
      const { data, error } = await admin()
        .from(RUNS)
        .update({ lease_until: untilIso })
        .eq('id', id)
        .eq('status', 'running')
        .or(`lease_until.is.null,lease_until.lt."${nowIso}"`)
        .select('id');
      if (error) throw dbError('acquireLease', error);
      return Array.isArray(data) && data.length > 0;
    },
    async releaseLease(id) {
      const { error } = await admin().from(RUNS).update({ lease_until: null }).eq('id', id);
      if (error) logger.warn('comic_library_release_lease_failed', { id, message: error.message });
    },
    async recordCost(e) {
      try {
        if (!(e.costUsd > 0)) return;
        const { error } = await admin().from('generation_cost_events').insert({
          user_id: e.userId,
          project_id: null,
          comic_id: null,
          operation: 'comic_library_build',
          stage: e.stage,
          provider: e.provider || 'platform',
          model: e.model || 'unknown',
          provider_cost_usd: e.costUsd,
          billable_usd: 0,
          is_byok: false,
          status: 'SETTLED',
          metadata: { platformPaid: true, ...e.metadata }
        });
        if (error) logger.warn('comic_library_cost_ledger_failed', { message: error.message });
      } catch (err) {
        logger.warn('comic_library_cost_ledger_failed', { message: (err as Error)?.message });
      }
    }
  };
}

// ── In-memory repo (tests, local dev without Supabase) ───────────────────────

export interface MemoryLibraryRepo extends LibraryRepo {
  assets: Map<string, LibraryAssetRow>;
  runs: Map<string, LibraryRunRow>;
  costs: LibraryCostEvent[];
  /** Simulate a missing table (42P01). */
  missing: boolean;
  /** The clock the repo stamps updated_at with (tests move it). */
  now: () => number;
}

export function createMemoryLibraryRepo(opts: { now?: () => number } = {}): MemoryLibraryRepo {
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const key = (v: number, id: string) => `${v}:${id}`;
  const repo: MemoryLibraryRepo = {
    assets: new Map(),
    runs: new Map(),
    costs: [],
    missing: false,
    now: opts.now || (() => Date.now()),
    async listAssets(version) {
      if (repo.missing) throw tableMissingError();
      return [...repo.assets.values()].filter((r) => r.manifest_version === version).map(clone);
    },
    async getAsset(version, id) {
      if (repo.missing) throw tableMissingError();
      const r = repo.assets.get(key(version, id));
      return r ? clone(r) : null;
    },
    async listPublished(version) {
      if (repo.missing) throw tableMissingError();
      return [...repo.assets.values()].filter((r) => r.manifest_version === version && r.published).map(clone);
    },
    async upsertAsset(row) {
      if (repo.missing) throw tableMissingError();
      repo.assets.set(key(row.manifest_version, row.id), clone({ ...row, updated_at: new Date(repo.now()).toISOString() }));
    },
    async updateAsset(version, id, patch, where) {
      if (repo.missing) throw tableMissingError();
      const r = repo.assets.get(key(version, id));
      if (!r) return false;
      if (where?.status?.length && !where.status.includes(r.status)) return false;
      if (where?.runId && r.run_id !== where.runId) return false;
      repo.assets.set(key(version, id), clone({ ...r, ...patch, updated_at: new Date(repo.now()).toISOString() }));
      return true;
    },
    async resetStuck(version, runId, olderThanIso) {
      if (repo.missing) throw tableMissingError();
      let n = 0;
      for (const [k, r] of repo.assets) {
        if (r.manifest_version === version && r.run_id === runId && (r.status === 'generating' || r.status === 'analyzing') && r.updated_at < olderThanIso) {
          repo.assets.set(k, { ...r, status: 'pending', error: 'Reset after an interrupted step.', updated_at: new Date(repo.now()).toISOString() });
          n += 1;
        }
      }
      return n;
    },
    async insertRun(row) {
      if (repo.missing) throw tableMissingError();
      if (row.status === 'running' && [...repo.runs.values()].some((r) => r.manifest_version === row.manifest_version && r.status === 'running')) {
        throw new StudioError('CONFLICT', 'A library build is already running. Resume or cancel it first.', { status: 409 });
      }
      repo.runs.set(row.id, clone(row));
    },
    async getRun(id) {
      if (repo.missing) throw tableMissingError();
      const r = repo.runs.get(id);
      return r ? clone(r) : null;
    },
    async activeRun(version) {
      if (repo.missing) throw tableMissingError();
      const r = [...repo.runs.values()].find((x) => x.manifest_version === version && x.status === 'running');
      return r ? clone(r) : null;
    },
    async listRuns(version, limit) {
      if (repo.missing) throw tableMissingError();
      return [...repo.runs.values()]
        .filter((r) => r.manifest_version === version)
        .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
        .slice(0, limit)
        .map(clone);
    },
    async updateRun(id, patch, where) {
      if (repo.missing) throw tableMissingError();
      const r = repo.runs.get(id);
      if (!r) return false;
      if (where?.status && r.status !== where.status) return false;
      repo.runs.set(id, clone({ ...r, ...patch, updated_at: new Date(repo.now()).toISOString() }));
      return true;
    },
    async acquireLease(id, nowIso, untilIso) {
      const r = repo.runs.get(id);
      if (!r || r.status !== 'running') return false;
      if (r.lease_until && r.lease_until >= nowIso) return false;
      repo.runs.set(id, { ...r, lease_until: untilIso });
      return true;
    },
    async releaseLease(id) {
      const r = repo.runs.get(id);
      if (r) repo.runs.set(id, { ...r, lease_until: null });
    },
    async recordCost(e) {
      if (e.costUsd > 0) repo.costs.push(clone(e));
    }
  };
  return repo;
}
