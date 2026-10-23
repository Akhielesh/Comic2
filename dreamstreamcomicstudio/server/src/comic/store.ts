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
//  - the projects mirror is best-effort and throttled — the doc row is the truth,
//  - every write is jsonb-safe (jsonbSafe): one \u0000 or half an emoji anywhere in the doc can
//    never make this and every later save of the project fail.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '../services/supabase.js';
import { logger } from '../lib/logger.js';
import { hashString, normalizeDoc, type AssetRef, type ComicDoc, type RenderState } from '../../../shared/comic/doc.js';
import { StudioError, type DocStore, type ProjectRowSummary } from './types.js';

const PROJECT_NAME_MAX = 200;
/** Re-mirror an unchanged listing state at most this often (keeps projects.updated_at fresh). */
const DEFAULT_MIRROR_INTERVAL_MS = 60_000;
const MIRROR_CACHE_MAX = 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ── jsonb safety ─────────────────────────────────────────────────────────────

/** A NUL or a UTF-16 surrogate: the only characters that need a second look. */
const JSONB_SUSPECT = /[\u0000\uD800-\uDFFF]/;
/** A high surrogate with no low one after it, or a low surrogate with no high one before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** One string as Postgres text/jsonb accepts it: NULs removed, lone surrogates → U+FFFD (pairs kept). */
export const jsonbSafeText = (s: string): string =>
  JSONB_SUSPECT.test(s) ? s.replace(/\u0000/g, '').replace(LONE_SURROGATE, '\uFFFD') : s;

/**
 * A value as Postgres jsonb accepts it (P2-GATE L5). jsonb rejects `\u0000` (22P05) and an unpaired
 * surrogate (22P02) anywhere — in a string or an object key — and a rejected doc write fails EVERY
 * later save of that project too (the bad character stays in the live doc), so edits are lost when
 * the session is evicted. Every comic_docs / projects write goes through this: NULs are removed and
 * lone surrogates become U+FFFD (whole emoji and other valid pairs are kept).
 *
 * Copy-on-write: a value with nothing to fix is returned as is (same reference, nothing copied), so
 * the common save pays one regex test per string; only the branches holding a bad character are
 * copied, and the caller's doc is never mutated. Non-plain objects (a Date, a Buffer) and values JSON
 * drops (functions, undefined) are left exactly as they were.
 */
export function jsonbSafe<T>(value: T): T {
  return cleanJsonb(value, 0) as T;
}

/** Deeper than any real doc; a pathological structure is left for the database to judge. */
const MAX_JSONB_DEPTH = 200;

function cleanJsonb(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return jsonbSafeText(value);
  if (!value || typeof value !== 'object' || depth > MAX_JSONB_DEPTH) return value;
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i += 1) {
      const next = cleanJsonb(value[i], depth + 1);
      if (next !== value[i]) {
        out ??= value.slice();
        out[i] = next;
      }
    }
    return out ?? value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const entries = Object.entries(value as Record<string, unknown>);
  let out: Record<string, unknown> | undefined;
  for (let i = 0; i < entries.length; i += 1) {
    const [key, v] = entries[i];
    const k = jsonbSafeText(key);
    const next = cleanJsonb(v, depth + 1);
    if (!out && (k !== key || next !== v)) {
      // First change: copy the untouched entries before it (original key order kept).
      out = {};
      for (let j = 0; j < i; j += 1) out[entries[j][0]] = entries[j][1];
    }
    if (out) out[k] = next;
  }
  return out ?? value;
}

const projectName = (title?: string): string => {
  const name = (title || '').replace(/\s+/g, ' ').trim();
  return (name || 'Untitled comic').slice(0, PROJECT_NAME_MAX);
};

/**
 * Minimal legacy ComicState the classic client can read without crashing: every array
 * it maps over is present (empty), the dashboard gets a cover + overview, and
 * `studioVersion: 4` routes opens/reads to the v4 studio.
 *
 * `projects.state` of a public row is readable by anyone (gallery RLS), so for a public
 * row (`opts.isPublic`) the live draft cover path and the private style spec are never
 * mirrored: `coverImageId` is written only while the row is private (the publish flow
 * writes the opaque `pub/` cover instead).
 */
export function buildLegacyProjectState(doc: ComicDoc, opts: { isPublic?: boolean } = {}): Record<string, unknown> {
  const pages = Array.isArray(doc?.pages) ? doc.pages : [];
  const readyPages = pages.filter((p) => p?.render?.status === 'ready' && p.render.asset?.path);
  const firstReady = [...readyPages].sort((a, b) => (a.n || 0) - (b.n || 0))[0];
  const coverImageId = opts.isPublic ? undefined : doc?.cover?.render?.asset?.path || firstReady?.render.asset?.path || undefined;
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
    stylePrompt: opts.isPublic ? '' : doc?.style?.spec || '',
    styleCategory: doc?.style?.name || '',
    styleAspectRatio: doc?.format?.pageAspect,
    imageResolution: '2K',
    layoutType: 'classic',
    overview: doc?.brief?.logline || '',
    studioPages: pages.length,
    studioRendered: readyPages.length
  };
  if (coverImageId) state.coverImageId = coverImageId;
  // Server-written share mirror (P1-PUBLISH): re-asserted on every save so a racing listing
  // write can never drop it. Unlisted slugs stay owner-only (projects RLS hides private rows).
  const pub = doc?.publication;
  if (pub && pub.status === 'live' && typeof pub.slug === 'string' && /^[A-Za-z0-9]{17}$/.test(pub.slug)) state.shareSlug = pub.slug;
  return state;
}

/** Opaque published-asset paths (written by the publish flow) are safe on a public row. */
const isPublishedAssetPath = (value: unknown): value is string => typeof value === 'string' && value.startsWith('pub/');

/**
 * Merge a freshly built legacy state over the stored one. On a public row any live
 * (non-`pub/`) coverImageId is removed, so the gallery mirror never exposes a draft path,
 * and the blurb (`overview`) stays the PUBLISHED logline the publish flow wrote: a later,
 * unreviewed edit of the live doc never reaches the public gallery (P1-PUBLISH).
 */
export function mergeLegacyProjectState(
  existing: Record<string, unknown>,
  legacy: Record<string, unknown>,
  isPublic: boolean
): Record<string, unknown> {
  const state: Record<string, unknown> = { ...existing, ...legacy };
  if (isPublic) {
    if (isPublishedAssetPath(existing.coverImageId)) state.coverImageId = existing.coverImageId;
    else delete state.coverImageId;
    state.stylePrompt = '';
    if (typeof existing.overview === 'string') state.overview = existing.overview;
    else delete state.overview;
  } else if (!legacy.coverImageId) {
    delete state.coverImageId;
  }
  return state;
}

/**
 * Reduce a RenderState to what a public reader needs: its status and current asset.
 * Drops the render `history` (holds discarded drafts whose paths are fetchable from
 * the public bucket), plus qc/error/model and other private render internals.
 */
const publicRender = (r: RenderState | undefined): RenderState => ({
  status: r?.status || 'none',
  ...(r?.asset ? { asset: publicAsset(r.asset) } : {}),
  ...(r?.withheld ? { withheld: r.withheld } : {}),
  history: []
});

/**
 * Allow-list an asset for readers: the image path, its size and its published downscales.
 * Everything else is private — `derivedFrom` is the storage path of the draft it was made
 * from (directly fetchable from the public bucket), plus the producing model, the
 * content-safety verdict and the library id.
 */
const publicAsset = (a: AssetRef): AssetRef => {
  const out: AssetRef = { path: a.path, source: a.source, at: a.at };
  if (typeof a.w === 'number') out.w = a.w;
  if (typeof a.h === 'number') out.h = a.h;
  if (Array.isArray(a.variants) && a.variants.length) {
    out.variants = a.variants
      .filter((v) => v && typeof v.path === 'string')
      .map((v) => ({ path: v.path, w: v.w, h: v.h }));
  }
  return out;
};

/** A translation as a reader sees it: the text only (no linguist gloss/finding, no model). */
const publicTranslation = (t: unknown): unknown => {
  if (!isRecord(t)) return t;
  const out: Record<string, unknown> = { text: t.text, status: t.status, sourceHash: t.sourceHash, at: t.at };
  return out;
};

const publicI18n = (i18n: unknown): unknown => {
  if (!isRecord(i18n)) return undefined;
  const editions: Record<string, unknown> = {};
  const source = isRecord(i18n.editions) ? i18n.editions : {};
  for (const [lang, raw] of Object.entries(source)) {
    if (!isRecord(raw)) continue;
    const lines: Record<string, unknown> = {};
    for (const [lineId, t] of Object.entries(isRecord(raw.lines) ? raw.lines : {})) lines[lineId] = publicTranslation(t);
    const pick = (group: unknown) => {
      if (!isRecord(group)) return undefined;
      const outGroup: Record<string, unknown> = {};
      for (const [k, t] of Object.entries(group)) outGroup[k] = publicTranslation(t);
      return outGroup;
    };
    editions[lang] = {
      ...raw,
      lines,
      ...(raw.cover !== undefined ? { cover: pick(raw.cover) } : {}),
      ...(raw.brief !== undefined ? { brief: pick(raw.brief) } : {})
    };
  }
  // The glossary (translation policy + author notes) is an authoring tool, not reader content.
  return { ...i18n, editions, glossary: [] };
};

/**
 * Doc keys that never reach a public payload: director memory, the version archive, page
 * trash, unsorted ref uploads, the server-only safety record (moderation categories, notes,
 * source screening), the server-only publication mirror and the planner fingerprint.
 */
const PRIVATE_DOC_KEYS = ['memory', 'archive', 'trash', 'refInbox', 'safety', 'publication', 'planInputHash'] as const;

/**
 * Strip everything private from a published doc (idempotent; the input is not mutated).
 *
 * Interim allow-by-strip until the publication snapshot lands (P1-PUBLISH):
 *  - removed: the conversation (and its attachments), spend, gate, director memory,
 *    pasted source, budget/model settings, every reference upload (often personal
 *    photos), unchosen style tests, the style board, cast/place model sheets, and the
 *    version archive / page trash / ref inbox, the server-only safety record and
 *    publication mirror, page turn hooks, the cover art direction, the translation
 *    glossary and every translation's linguist gloss/finding/model;
 *  - blanked: the style spec, cast looks/personality/voice, place looks, panel actions,
 *    page summaries and the private brief fields (premise, notes);
 *  - every remaining render (pages, cover) keeps only its status + current asset, and the
 *    asset only its path/size/downscales — the draft history, `derivedFrom` draft path,
 *    QC notes, safety verdicts and model metadata never reach the public payload.
 * Newer optional fields are read with optional chaining so older/newer docs both work.
 */
export function sanitizePublicDoc(doc: ComicDoc): ComicDoc {
  const settings = { ...doc.settings };
  delete settings.budgetUsd;
  delete settings.imageModelOverride;
  const style = { ...doc.style, refs: [], options: [], spec: '' } as ComicDoc['style'];
  delete style.board;
  const brief = { ...doc.brief, notes: [] } as ComicDoc['brief'];
  delete brief.premise;
  const clean: ComicDoc = {
    ...doc,
    brief,
    conversation: [],
    spend: { totalUsd: 0, byKind: {}, entries: [] },
    gate: null,
    source: {},
    settings,
    style,
    cast: (doc.cast || []).map((c) => {
      const out = { ...c, look: { summary: '' }, refs: [], sheet: publicRender(undefined) };
      delete out.personality;
      delete out.voice;
      return out;
    }),
    places: (doc.places || []).map((p) => ({ ...p, look: '', refs: [], sheet: publicRender(undefined) })),
    pages: (doc.pages || []).map(({ turnHook: _turnHook, ...p }) => ({
      ...p,
      summary: '',
      panels: (p.panels || []).map((panel) => ({ ...panel, action: '' })),
      render: publicRender(p.render)
    })),
    // `direction` is the private art-direction prompt for the cover render.
    cover: (({ direction: _direction, ...cover }) => ({ ...cover, render: publicRender(cover.render) }))(doc.cover || ({ render: { status: 'none', history: [] } } as ComicDoc['cover']))
  };
  if (doc.i18n !== undefined) clean.i18n = publicI18n(doc.i18n) as ComicDoc['i18n'];
  const loose = clean as unknown as Record<string, unknown>;
  for (const key of PRIVATE_DOC_KEYS) delete loose[key];
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

/**
 * True when the project is a Comic Studio v4 project (it has a comic_docs row) — the same
 * test the database guard (`projects_guard_client_writes`) uses. Bad ids and databases
 * without the comic_docs table read as "not v4"; other errors propagate.
 */
export async function projectHasComicDoc(db: SupabaseClient, projectId: string): Promise<boolean> {
  if (!projectId) return false;
  const { data, error } = await db.from('comic_docs').select('project_id').eq('project_id', projectId).maybeSingle();
  if (error) {
    if (isInvalidId(error) || isMissingTable(error)) return false;
    throw error;
  }
  return !!data;
}

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

  /**
   * Best-effort projects-row mirror; preserves state keys other flows wrote (e.g. publishedAt).
   * The gallery can read `state` of public rows, so a live draft cover path is written only
   * while the row is private — and the write itself is conditioned on `is_public=false`, so a
   * row that turns public between the read and the write never receives one.
   */
  const mirrorProject = async (projectId: string, userId: string, doc: ComicDoc, summary?: ProjectRowSummary) => {
    const name = jsonbSafeText(projectName(summary?.title || doc.brief.title));
    const built = buildLegacyProjectState(doc);
    const coverPath = summary?.coverPath || (built.coverImageId as string | undefined);
    if (coverPath) built.coverImageId = coverPath;
    else delete built.coverImageId;
    if (summary?.logline !== undefined) built.overview = summary.logline || '';
    const legacy = jsonbSafe(built);
    const fingerprint = hashString(JSON.stringify([name, legacy]));
    const last = mirrored.get(projectId);
    if (last && last.fingerprint === fingerprint && now() - last.at < mirrorIntervalMs) return;

    try {
      const db = admin();
      const { data: row, error: readError } = await db
        .from('projects')
        .select('state, is_public')
        .eq('id', projectId)
        .eq('user_id', userId)
        .maybeSingle();
      if (readError) throw readError;
      if (!row) {
        logger.warn('comic_project_row_missing', { projectId });
        return;
      }
      const stored = row as { state?: unknown; is_public?: boolean | null };
      // Keys other flows wrote are kept; a bad character already stored there can't fail this write either.
      const existing = isRecord(stored.state) ? jsonbSafe(stored.state) : {};
      const updatedAt = new Date(now()).toISOString();

      if (stored.is_public !== true) {
        // `.not(is, true)` also matches a NULL is_public (the column is nullable).
        const state = mergeLegacyProjectState(existing, legacy, false);
        const { data: hit, error: updateError } = await db
          .from('projects')
          .update({ name, state, updated_at: updatedAt })
          .eq('id', projectId)
          .eq('user_id', userId)
          .not('is_public', 'is', true)
          .select('id');
        if (updateError) throw updateError;
        if (Array.isArray(hit) && hit.length > 0) {
          rememberMirror(projectId, fingerprint);
          return;
        }
        // Zero rows: the row became public (or vanished) since the read — fall through and
        // write the public-safe state instead.
      }

      // Public row: the listing name is the PUBLISHED title (written by the publish flow), so a
      // live rename never reaches the gallery without passing the publish gate.
      const state = mergeLegacyProjectState(existing, legacy, true);
      const { error: updateError } = await db
        .from('projects')
        .update({ state, updated_at: updatedAt })
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
    const name = jsonbSafeText(projectName(doc.brief?.title));
    const state = jsonbSafe(buildLegacyProjectState(doc));
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
      doc: jsonbSafe({ ...doc, id: projectId }),
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
    // Between the two inserts the owner's own RLS can still flip is_public on the listing
    // row (the database guard only treats a row as v4 once comic_docs exists). Re-assert
    // private now that it is v4 — a new comic is published only from the studio.
    try {
      const { error: privateError } = await db
        .from('projects')
        .update({ is_public: false })
        .eq('id', projectId)
        .eq('user_id', userId)
        .eq('is_public', true);
      if (privateError) throw privateError;
    } catch (privateError) {
      logger.error('comic_create_reassert_private_failed', { projectId, message: (privateError as Error)?.message });
    }
    rememberMirror(projectId, hashString(JSON.stringify([name, state])));
  };

  const save: DocStore['save'] = async ({ projectId, userId, doc, summary }) => {
    const db = admin();
    const rev = typeof doc.rev === 'number' ? doc.rev : 0;
    const stamp = new Date(now()).toISOString();
    const payload = { doc: jsonbSafe({ ...doc, id: projectId }), rev, updated_at: stamp };

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

  /**
   * Public read by project id: ONLY the frozen, allow-listed snapshot of a live + PUBLIC
   * publication of a project that is not force-private (P1-PUBLISH). The live doc is never
   * served to readers any more; unlisted comics are reachable only by their slug at the edge.
   * Fails closed: any lookup error or an unmigrated database serves nothing.
   */
  const loadPublic: DocStore['loadPublic'] = async (projectId) => {
    if (!projectId) return null;
    const db = admin();
    const pub = await db
      .from('comic_publications')
      .select('snapshot, status, visibility')
      .eq('project_id', projectId)
      .eq('status', 'live')
      .eq('visibility', 'public')
      .maybeSingle();
    if (pub.error) {
      if (isInvalidId(pub.error) || isMissingTable(pub.error)) return null;
      throw storeError(pub.error, 'load');
    }
    const snapshot = (pub.data as { snapshot?: unknown } | null)?.snapshot;
    if (!isRecord(snapshot)) return null;
    const flags = await db.from('projects').select('id, is_forced_private').eq('id', projectId).maybeSingle();
    if (flags.error) {
      if (pgCode(flags.error) !== '42703') return null;
    } else if (!flags.data || (flags.data as { is_forced_private?: boolean | null }).is_forced_private === true) {
      return null;
    }
    return normalizeDoc({ ...(snapshot as Partial<ComicDoc>), id: String((snapshot as { id?: unknown }).id || 'publication') });
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
        name: jsonbSafeText(projectName(doc.brief?.title)),
        state: jsonbSafe(buildLegacyProjectState(doc)),
        isPublic: false,
        forcedPrivate: false,
        doc: clone(jsonbSafe({ ...doc, id: projectId })),
        rev: doc.rev || 0
      });
    },
    async save({ projectId, userId, doc, summary }) {
      const row = rows.get(projectId);
      if (!row) throw new StudioError('NOT_FOUND', 'This comic no longer exists.', { status: 404 });
      if (row.userId !== userId) throw new StudioError('FORBIDDEN', "You don't have access to this comic.", { status: 403 });
      const rev = doc.rev || 0;
      if (row.doc && row.rev > rev) return; // stale writer never clobbers a newer doc
      // The same jsonb-safe write as the Supabase store, so tests read back what production stores.
      row.doc = clone(jsonbSafe({ ...doc, id: projectId }));
      row.rev = rev;
      row.name = jsonbSafeText(projectName(summary?.title || doc.brief.title));
      const legacy = buildLegacyProjectState(doc);
      if (summary?.coverPath) legacy.coverImageId = summary.coverPath;
      if (summary?.logline !== undefined) legacy.overview = summary.logline || '';
      row.state = mergeLegacyProjectState(row.state, jsonbSafe(legacy), row.isPublic);
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
