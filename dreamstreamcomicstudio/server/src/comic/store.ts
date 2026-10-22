// Persistence for Comic Studio (v4) documents.
//
// The ComicDoc lives in public.comic_docs (server/sql/comic_docs.sql): one row per
// project, written only by the server (service role), owner-readable under RLS. The
// existing public.projects row stays the listing record the dashboard reads, so every
// save mirrors the title, updated_at and a minimal legacy-compatible `state`
// (studioVersion: 4, empty legacy arrays, cover path, logline) onto it. The legacy
// client can then list, open (→ redirect to v4), publish and GC-scan v4 projects
// without understanding the new document.
//
// Safety properties:
//  - every read/write is owner-scoped; a save can never re-home another user's row,
//  - a stale writer (lower rev than stored) never clobbers a newer document,
//  - the projects mirror is best-effort and throttled — the doc row is the truth.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '../services/supabase.js';
import { logger } from '../lib/logger.js';
import { hashString, normalizeDoc, type ComicDoc, type RenderState } from '../../../shared/comic/doc.js';
import { StudioError, type DocStore, type ProjectRowSummary } from './types.js';

const PROJECT_NAME_MAX = 200;
/** Re-mirror an unchanged listing state at most this often (keeps projects.updated_at fresh). */
const DEFAULT_MIRROR_INTERVAL_MS = 60_000;
const MIRROR_CACHE_MAX = 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const projectName = (title?: string): string => {
  const name = (title || '').replace(/\s+/g, ' ').trim();
  return (name || 'Untitled comic').slice(0, PROJECT_NAME_MAX);
};

/**
 * Minimal legacy ComicState the classic client can read without crashing: every array
 * it maps over is present (empty), the dashboard gets a cover + overview, and
 * `studioVersion: 4` routes opens/reads to the v4 studio.
 */
export function buildLegacyProjectState(doc: ComicDoc): Record<string, unknown> {
  const pages = Array.isArray(doc?.pages) ? doc.pages : [];
  const readyPages = pages.filter((p) => p?.render?.status === 'ready' && p.render.asset?.path);
  const firstReady = [...readyPages].sort((a, b) => (a.n || 0) - (b.n || 0))[0];
  const coverImageId = doc?.cover?.render?.asset?.path || firstReady?.render.asset?.path || undefined;
  const state: Record<string, unknown> = {
    studioVersion: 4,
    pipelineMode: 'classic',
    step: 0,
    maxStepReached: 0,
    script: '',
    scenes: [],
    panels: [],
    characters: [],
    items: [],
    locations: [],
    styleVariants: [],
    stylePrompt: doc?.style?.spec || '',
    styleCategory: doc?.style?.name || '',
    styleAspectRatio: doc?.format?.pageAspect,
    imageResolution: '2K',
    layoutType: 'classic',
    overview: doc?.brief?.logline || '',
    studioPages: pages.length,
    studioRendered: readyPages.length
  };
  if (coverImageId) state.coverImageId = coverImageId;
  return state;
}

/**
 * Reduce a RenderState to what a public reader needs: its status and current asset.
 * Drops the render `history` (holds discarded drafts whose paths are fetchable from
 * the public bucket), plus qc/error/model and other private render internals.
 */
const publicRender = (r: RenderState): RenderState => ({
  status: r.status,
  ...(r.asset ? { asset: r.asset } : {}),
  history: []
});

/**
 * Strip everything private from a published doc: the conversation (and its
 * attachments), spend, gate, director memory, pasted source, and the user's own
 * reference uploads (often personal photos). Pages, cover, cast sheets and style stay,
 * but every render is reduced to its status + current asset — the draft history, QC
 * notes and model metadata never reach the public payload (those storage paths are
 * directly fetchable from the public comic-assets bucket). The unchosen style options
 * are dropped too, since the reader only renders the locked style.
 */
export function sanitizePublicDoc(doc: ComicDoc): ComicDoc {
  const settings = { ...doc.settings };
  delete settings.budgetUsd;
  delete settings.imageModelOverride;
  const clean: ComicDoc = {
    ...doc,
    conversation: [],
    spend: { totalUsd: 0, byKind: {}, entries: [] },
    gate: null,
    source: {},
    settings,
    style: { ...doc.style, refs: [], options: [] },
    cast: doc.cast.map((c) => ({ ...c, refs: [], sheet: publicRender(c.sheet) })),
    places: doc.places.map((p) => ({ ...p, refs: [], sheet: publicRender(p.sheet) })),
    pages: doc.pages.map((p) => ({ ...p, render: publicRender(p.render) })),
    cover: { ...doc.cover, render: publicRender(doc.cover.render) }
  };
  delete clean.memory;
  return clean;
}

/** Stored row → normalized doc (the row's project id and rev are authoritative). */
const hydrateDoc = (projectId: string, rawDoc: unknown, rawRev: unknown): ComicDoc | null => {
  if (!isRecord(rawDoc)) return null;
  const storedRev = typeof rawRev === 'number' && Number.isFinite(rawRev) ? rawRev : 0;
  const docRev = typeof rawDoc.rev === 'number' && Number.isFinite(rawDoc.rev) ? rawDoc.rev : 0;
  return normalizeDoc({ ...(rawDoc as Partial<ComicDoc>), id: projectId, rev: Math.max(storedRev, docRev) });
};

type PgError = { code?: string; message?: string; details?: string };

const pgCode = (err: unknown): string => String((err as PgError)?.code || '').toUpperCase();
/** Not-a-UUID project ids are simply "not found". */
const isInvalidId = (err: unknown) => pgCode(err) === '22P02';
const isMissingTable = (err: unknown) => pgCode(err) === '42P01' || pgCode(err) === 'PGRST205';

const storeError = (err: unknown, action: string): StudioError => {
  if (err instanceof StudioError) return err;
  const missing = isMissingTable(err);
  logger.error('comic_store_error', {
    action,
    code: pgCode(err),
    message: (err as PgError)?.message,
    hint: missing ? 'apply server/sql/comic_docs.sql' : undefined
  });
  return new StudioError(
    'INTERNAL',
    missing ? "Comic Studio storage isn't available right now." : `Couldn't ${action} your comic right now. Please try again.`,
    { status: 503, retryable: !missing, cause: err }
  );
};

// ── Supabase store ───────────────────────────────────────────────────────────

export interface SupabaseDocStoreOptions {
  admin?: () => SupabaseClient;
  mirrorIntervalMs?: number;
  now?: () => number;
}

export function createSupabaseDocStore(opts: SupabaseDocStoreOptions = {}): DocStore {
  const admin = opts.admin || getSupabaseAdmin;
  const mirrorIntervalMs = opts.mirrorIntervalMs ?? DEFAULT_MIRROR_INTERVAL_MS;
  const now = opts.now || (() => Date.now());
  /** projectId → last mirrored fingerprint (skips redundant projects writes). */
  const mirrored = new Map<string, { fingerprint: string; at: number }>();

  const rememberMirror = (projectId: string, fingerprint: string) => {
    if (mirrored.size >= MIRROR_CACHE_MAX) {
      const oldest = mirrored.keys().next().value as string | undefined;
      if (oldest !== undefined) mirrored.delete(oldest);
    }
    mirrored.delete(projectId);
    mirrored.set(projectId, { fingerprint, at: now() });
  };

  /** Best-effort projects-row mirror; preserves state keys other flows wrote (e.g. publishedAt). */
  const mirrorProject = async (projectId: string, userId: string, doc: ComicDoc, summary?: ProjectRowSummary) => {
    const name = projectName(summary?.title || doc.brief.title);
    const legacy = buildLegacyProjectState(doc);
    const coverPath = summary?.coverPath || (legacy.coverImageId as string | undefined);
    if (coverPath) legacy.coverImageId = coverPath;
    if (summary?.logline !== undefined) legacy.overview = summary.logline || '';
    const fingerprint = hashString(JSON.stringify([name, legacy]));
    const last = mirrored.get(projectId);
    if (last && last.fingerprint === fingerprint && now() - last.at < mirrorIntervalMs) return;

    try {
      const db = admin();
      const { data: row, error: readError } = await db
        .from('projects')
        .select('state')
        .eq('id', projectId)
        .eq('user_id', userId)
        .maybeSingle();
      if (readError) throw readError;
      if (!row) {
        logger.warn('comic_project_row_missing', { projectId });
        return;
      }
      const existing = isRecord((row as { state?: unknown }).state) ? ((row as { state: Record<string, unknown> }).state) : {};
      const state: Record<string, unknown> = { ...existing, ...legacy };
      if (!coverPath) delete state.coverImageId;
      const { error: updateError } = await db
        .from('projects')
        .update({ name, state, updated_at: new Date(now()).toISOString() })
        .eq('id', projectId)
        .eq('user_id', userId);
      if (updateError) throw updateError;
      rememberMirror(projectId, fingerprint);
    } catch (err) {
      logger.warn('comic_project_mirror_failed', { projectId, code: pgCode(err), message: (err as PgError)?.message });
    }
  };

  const load: DocStore['load'] = async (projectId, userId) => {
    if (!projectId || !userId) return null;
    const { data, error } = await admin()
      .from('comic_docs')
      .select('project_id, doc, rev')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      if (isInvalidId(error)) return null;
      throw storeError(error, 'load');
    }
    if (!data) return null;
    return hydrateDoc(projectId, (data as { doc?: unknown }).doc, (data as { rev?: unknown }).rev);
  };

  const create: DocStore['create'] = async ({ projectId, userId, doc }) => {
    const db = admin();
    const stamp = new Date(now()).toISOString();
    const name = projectName(doc.brief?.title);
    const state = buildLegacyProjectState(doc);
    const { error: projectError } = await db.from('projects').insert({
      id: projectId,
      user_id: userId,
      name,
      state,
      is_public: false,
      created_at: stamp,
      updated_at: stamp
    });
    if (projectError) {
      if (pgCode(projectError) === '23505') {
        throw new StudioError('BAD_REQUEST', 'A project with this id already exists.', { status: 409, cause: projectError });
      }
      throw storeError(projectError, 'create');
    }
    const { error: docError } = await db.from('comic_docs').insert({
      project_id: projectId,
      user_id: userId,
      doc: { ...doc, id: projectId },
      rev: doc.rev || 0,
      created_at: stamp,
      updated_at: stamp
    });
    if (docError) {
      // Roll back the listing row so the dashboard never shows a comic with no document.
      try {
        await db.from('projects').delete().eq('id', projectId).eq('user_id', userId);
      } catch (cleanupError) {
        logger.error('comic_create_rollback_failed', { projectId, message: (cleanupError as Error)?.message });
      }
      throw storeError(docError, 'create');
    }
    rememberMirror(projectId, hashString(JSON.stringify([name, state])));
  };

  const save: DocStore['save'] = async ({ projectId, userId, doc, summary }) => {
    const db = admin();
    const rev = typeof doc.rev === 'number' ? doc.rev : 0;
    const stamp = new Date(now()).toISOString();
    const payload = { doc: { ...doc, id: projectId }, rev, updated_at: stamp };

    // Owner-scoped, never-backwards update. Zero rows → missing, stale, or not ours.
    const { data: updated, error } = await db
      .from('comic_docs')
      .update(payload)
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .lte('rev', rev)
      .select('project_id');
    if (error) throw storeError(error, 'save');

    if (!Array.isArray(updated) || updated.length === 0) {
      const { data: existing, error: readError } = await db
        .from('comic_docs')
        .select('user_id, rev')
        .eq('project_id', projectId)
        .maybeSingle();
      if (readError) throw storeError(readError, 'save');
      if (existing) {
        if ((existing as { user_id?: string }).user_id !== userId) {
          throw new StudioError('FORBIDDEN', "You don't have access to this comic.", { status: 403 });
        }
        logger.warn('comic_doc_stale_save_skipped', { projectId, rev, storedRev: (existing as { rev?: number }).rev });
        return;
      }
      const { error: insertError } = await db
        .from('comic_docs')
        .insert({ project_id: projectId, user_id: userId, ...payload, created_at: stamp });
      if (insertError) {
        if (pgCode(insertError) === '23503') {
          throw new StudioError('NOT_FOUND', 'This comic no longer exists.', { status: 404, cause: insertError });
        }
        throw storeError(insertError, 'save');
      }
    }

    await mirrorProject(projectId, userId, doc, summary);
  };

  const loadPublic: DocStore['loadPublic'] = async (projectId) => {
    if (!projectId) return null;
    const db = admin();
    let project: { is_public?: boolean | null; is_forced_private?: boolean | null } | null = null;
    const first = await db.from('projects').select('id, is_public, is_forced_private').eq('id', projectId).maybeSingle();
    if (first.error) {
      if (isInvalidId(first.error)) return null;
      if (pgCode(first.error) !== '42703') throw storeError(first.error, 'load');
      // Moderation columns not migrated on this database — visibility is is_public alone.
      const fallback = await db.from('projects').select('id, is_public').eq('id', projectId).maybeSingle();
      if (fallback.error) throw storeError(fallback.error, 'load');
      project = fallback.data as typeof project;
    } else {
      project = first.data as typeof project;
    }
    if (!project || project.is_public !== true || project.is_forced_private === true) return null;

    const { data, error } = await db.from('comic_docs').select('project_id, doc, rev').eq('project_id', projectId).maybeSingle();
    if (error) throw storeError(error, 'load');
    if (!data) return null;
    const doc = hydrateDoc(projectId, (data as { doc?: unknown }).doc, (data as { rev?: unknown }).rev);
    return doc ? sanitizePublicDoc(doc) : null;
  };

  const loadLegacyState: DocStore['loadLegacyState'] = async (projectId, userId) => {
    if (!projectId || !userId) return null;
    const { data, error } = await admin()
      .from('projects')
      .select('name, state')
      .eq('id', projectId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      if (isInvalidId(error)) return null;
      throw storeError(error, 'load');
    }
    if (!data) return null;
    const row = data as { name?: unknown; state?: unknown };
    return { name: typeof row.name === 'string' ? row.name : '', state: isRecord(row.state) ? row.state : {} };
  };

  return { load, create, save, loadPublic, loadLegacyState };
}

// ── In-memory store (tests, local tooling) ───────────────────────────────────

export interface MemoryProjectRow {
  userId: string;
  name: string;
  state: Record<string, unknown>;
  isPublic: boolean;
  forcedPrivate: boolean;
  /** Stored document (absent for legacy-only projects). */
  doc?: ComicDoc;
  rev: number;
}

export interface MemoryDocStore extends DocStore {
  /** Raw rows (projects + comic_docs merged), keyed by project id. */
  readonly rows: Map<string, MemoryProjectRow>;
  /** Number of successful save() calls. */
  readonly saveCount: number;
  setVisibility(projectId: string, visibility: { isPublic?: boolean; forcedPrivate?: boolean }): void;
  /** Seed a classic (pre-v4) project for import tests. */
  seedLegacyProject(args: { projectId: string; userId: string; name: string; state: Record<string, unknown> }): void;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function createMemoryDocStore(): MemoryDocStore {
  const rows = new Map<string, MemoryProjectRow>();
  let saveCount = 0;

  return {
    rows,
    get saveCount() {
      return saveCount;
    },
    setVisibility(projectId, visibility) {
      const row = rows.get(projectId);
      if (!row) return;
      if (visibility.isPublic !== undefined) row.isPublic = visibility.isPublic;
      if (visibility.forcedPrivate !== undefined) row.forcedPrivate = visibility.forcedPrivate;
    },
    seedLegacyProject({ projectId, userId, name, state }) {
      rows.set(projectId, { userId, name, state: clone(state), isPublic: false, forcedPrivate: false, rev: 0 });
    },
    async load(projectId, userId) {
      const row = rows.get(projectId);
      if (!row || row.userId !== userId || !row.doc) return null;
      return hydrateDoc(projectId, clone(row.doc), row.rev);
    },
    async create({ projectId, userId, doc }) {
      if (rows.has(projectId)) throw new StudioError('BAD_REQUEST', 'A project with this id already exists.', { status: 409 });
      rows.set(projectId, {
        userId,
        name: projectName(doc.brief?.title),
        state: buildLegacyProjectState(doc),
        isPublic: false,
        forcedPrivate: false,
        doc: clone({ ...doc, id: projectId }),
        rev: doc.rev || 0
      });
    },
    async save({ projectId, userId, doc, summary }) {
      const row = rows.get(projectId);
      if (!row) throw new StudioError('NOT_FOUND', 'This comic no longer exists.', { status: 404 });
      if (row.userId !== userId) throw new StudioError('FORBIDDEN', "You don't have access to this comic.", { status: 403 });
      const rev = doc.rev || 0;
      if (row.doc && row.rev > rev) return; // stale writer never clobbers a newer doc
      row.doc = clone({ ...doc, id: projectId });
      row.rev = rev;
      row.name = projectName(summary?.title || doc.brief.title);
      const legacy = buildLegacyProjectState(doc);
      if (summary?.coverPath) legacy.coverImageId = summary.coverPath;
      if (summary?.logline !== undefined) legacy.overview = summary.logline || '';
      const state = { ...row.state, ...legacy };
      if (!legacy.coverImageId) delete state.coverImageId;
      row.state = state;
      saveCount += 1;
    },
    async loadPublic(projectId) {
      const row = rows.get(projectId);
      if (!row || !row.isPublic || row.forcedPrivate || !row.doc) return null;
      const doc = hydrateDoc(projectId, clone(row.doc), row.rev);
      return doc ? sanitizePublicDoc(doc) : null;
    },
    async loadLegacyState(projectId, userId) {
      const row = rows.get(projectId);
      if (!row || row.userId !== userId) return null;
      return { name: row.name, state: clone(row.state) };
    }
  };
}
