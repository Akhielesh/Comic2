// Comic History — the client of the owner routes (versions plan §5, §14 H3; package H5).
//
// The exact route shapes H3 serves (server/src/routes/comicHistory.ts HISTORY_PATHS; H6 serves the classic ones
// through routes/comicLegacyHistory.ts, mounted first so "legacy" is never read as a version id):
//
//   GET  /api/comic/projects/:id/history?cursor=&filter=&pageId=&limit=
//          → { rows: VersionRow[], next: string | null, urls: { [path]: signedUrl } }       (thumbs signed)
//   GET  /api/comic/projects/:id/history/compare?a=&b=
//          → CompareResult { a, b, diff, docs: { a, b }, urls }        (a/b: a version id, 'now', 'published', 'alt:<id>')
//   GET  /api/comic/projects/:id/history/:vid
//          → VersionDetail { row, manifest, groups }                    ("what changed")
//   GET  /api/comic/projects/:id/history/:vid/book
//          → { row, doc: ComicDoc (reassembled, normalized), urls }      (the read-only reader)
//   POST /api/comic/projects/:id/history/:vid/urls   { paths: string[] }
//          → { urls: { [path]: signedUrl } }                             (lazy: history/archive images of that version)
//   GET  /api/comic/projects/:id/history/legacy
//          → { snapshots: ClassicSnapshotRow[] }                          (H6: an imported classic comic's snapshots)
//   POST /api/comic/projects { importFromProjectId, fromVersionId }
//          → { projectId, doc, urls }                                    ("Start a new comic from this snapshot")
//
// Owner-only and private: every call goes through services/apiClient (the user's own token). Every failure becomes a
// StudioApiError whose message is safe to show. Free: nothing here spends; restores, saves and undo go through the
// studio's stream actions (history_restore, history_save, history_undo_ai), never these routes.
//
// The UI never calls these functions directly: it reads the HistoryApi from HistoryApiContext, so tests and QA scenes
// run the same components on the in-memory fake (historyApi.fake.ts) until H3 lands.

import React, { createContext, useContext } from 'react';
import { get, post } from '../../../services/apiClient';
import { normalizeDoc, type ComicDoc } from '../../../shared/comic/doc';
import type { CompareRef, CompareResult, CompareSide, VersionDetail, VersionRow } from '../../../shared/comic/history/types';
import { HISTORY_KINDS } from '../../../shared/comic/history/types';
import { toStudioApiError } from '../studioApi';

// ── Routes ───────────────────────────────────────────────────────────────────

const enc = encodeURIComponent;
const base = (projectId: string) => `/api/comic/projects/${enc(projectId)}/history`;

/** Every history path the client calls (relative to the API origin). */
export const HISTORY_ROUTES = {
  list: (projectId: string) => base(projectId),
  compare: (projectId: string) => `${base(projectId)}/compare`,
  detail: (projectId: string, versionId: string) => `${base(projectId)}/${enc(versionId)}`,
  book: (projectId: string, versionId: string) => `${base(projectId)}/${enc(versionId)}/book`,
  urls: (projectId: string, versionId: string) => `${base(projectId)}/${enc(versionId)}/urls`,
  legacy: (projectId: string) => `${base(projectId)}/legacy`,
  createProject: () => '/api/comic/projects'
} as const;

// ── Wire shapes (beyond shared/comic/history/types.ts) ───────────────────────

/** The list filter chips: All · Saved by you · AI changes · This page. */
export type HistoryFilter = 'all' | 'saved' | 'ai' | 'page';
export const HISTORY_FILTERS: readonly HistoryFilter[] = ['all', 'saved', 'ai', 'page'];

export interface HistoryListQuery {
  /** The `next` of the previous page. */
  cursor?: string | null;
  filter?: HistoryFilter;
  /** filter 'page': the page. */
  pageId?: string;
  limit?: number;
}

export interface HistoryListResponse {
  /** Newest first. */
  rows: VersionRow[];
  /** Cursor of the next (older) page, null at the end. */
  next: string | null;
  /** Signed thumbnail URLs by storage path. */
  urls: Record<string, string>;
  /**
   * The line this list is (H1 store.list): null = "Original". Absent = not said, read as Original (before H7 the
   * creator is always on Original). Original's list also carries the rows of lines the creator removed — each keeps
   * its own non-null alternativeId (historyModel isRemovedLineRow).
   */
  line?: string | null;
  /**
   * "You're here": the listed line's head (H1 store.head(line)?.id) — Original's own newest row, never a removed
   * line's row and never simply rows[0]. null = the line has no row yet; absent = not said (historyModel hereRowId).
   */
  head?: string | null;
}

export interface VersionBookResponse {
  row?: VersionRow;
  /** The reassembled book, normalized (read-only). */
  doc: ComicDoc;
  urls: Record<string, string>;
}

/** One classic snapshot kept on the server (H6; read-only here). */
export interface ClassicSnapshotRow {
  id: string;
  name: string;
  reason?: string;
  createdAt: number;
  /** The classic project it belongs to. */
  projectId: string;
  pages?: number;
}

export interface ClassicSnapshotsResponse {
  snapshots: ClassicSnapshotRow[];
}

/** Page size of the moment list. */
export const HISTORY_PAGE_SIZE = 50;
/** Paths per lazy-URL request (the server signs at most this many at once). */
export const HISTORY_URL_BATCH = 100;

export interface HistoryApi {
  list(projectId: string, query?: HistoryListQuery, opts?: { signal?: AbortSignal }): Promise<HistoryListResponse>;
  detail(projectId: string, versionId: string, opts?: { signal?: AbortSignal }): Promise<VersionDetail>;
  book(projectId: string, versionId: string, opts?: { signal?: AbortSignal }): Promise<VersionBookResponse>;
  urls(projectId: string, versionId: string, paths: string[]): Promise<Record<string, string>>;
  compare(projectId: string, a: CompareRef, b: CompareRef, opts?: { signal?: AbortSignal }): Promise<CompareResult>;
  classicSnapshots(projectId: string, opts?: { signal?: AbortSignal }): Promise<ClassicSnapshotsResponse>;
  /** A NEW comic from a classic snapshot (free); resolves the new project id. */
  startFromClassicSnapshot(fromProjectId: string, snapshotId: string): Promise<{ projectId: string }>;
}

// ── Parsing (tolerant: a malformed row is dropped, never rendered half-way) ───

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const KINDS: ReadonlySet<string> = new Set(HISTORY_KINDS);
const ACTORS: ReadonlySet<string> = new Set(['you', 'ai', 'editor', 'system']);

export const asUrlMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!isObj(v)) return out;
  for (const [k, u] of Object.entries(v)) if (typeof u === 'string' && /^(https?:|blob:|data:image\/)/.test(u)) out[k] = u;
  return out;
};

/** A VersionRow from the wire, or null when it lacks what the list needs. */
export const asVersionRow = (v: unknown): VersionRow | null => {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const kind = str(v.kind);
  const contentAt = num(v.contentAt);
  if (!id || !kind || !KINDS.has(kind) || contentAt === undefined) return null;
  const actor = str(v.actor);
  const stats = isObj(v.stats) ? v.stats : {};
  const spend = isObj(stats.spend) && num(stats.spend.usd) !== undefined ? { usd: num(stats.spend.usd)!, byok: stats.spend.byok === true, estimated: stats.spend.estimated === true } : undefined;
  return {
    ...(v as unknown as VersionRow),
    id,
    kind: kind as VersionRow['kind'],
    actor: (actor && ACTORS.has(actor) ? actor : 'system') as VersionRow['actor'],
    label: str(v.label) ?? '',
    pinned: v.pinned === true,
    rev: num(v.rev) ?? 0,
    contentAt,
    createdAt: num(v.createdAt) ?? contentAt,
    codec: v.codec === 'legacy' ? 'legacy' : 'v5',
    changes: Array.isArray(v.changes) ? (v.changes.filter((c) => isObj(c) && typeof c.what === 'string') as unknown as VersionRow['changes']) : [],
    thumbs: Array.isArray(v.thumbs) ? (v.thumbs.filter((t) => isObj(t) && typeof t.key === 'string' && typeof t.path === 'string') as unknown as VersionRow['thumbs']) : [],
    stats: {
      pages: num(stats.pages) ?? 0,
      drawn: num(stats.drawn) ?? 0,
      lines: num(stats.lines) ?? 0,
      langs: Array.isArray(stats.langs) ? stats.langs.filter((l): l is string => typeof l === 'string') : [],
      models: Array.isArray(stats.models) ? stats.models.filter((m): m is string => typeof m === 'string') : [],
      ...(spend ? { spend } : {})
    }
  };
};

/** An optional id field: a string, null when the wire says null, absent otherwise (never a made-up value). */
const optId = (o: Record<string, unknown>, key: string): { [k: string]: string | null } => {
  if (!(key in o)) return {};
  const v = o[key];
  if (v === null) return { [key]: null };
  const s = str(v);
  return s ? { [key]: s } : {};
};

export const asListResponse = (v: unknown): HistoryListResponse => {
  const o = isObj(v) ? v : {};
  return {
    rows: (Array.isArray(o.rows) ? o.rows : []).map(asVersionRow).filter((r): r is VersionRow => !!r),
    next: str(o.next) ?? null,
    urls: asUrlMap(o.urls),
    ...optId(o, 'line'),
    ...optId(o, 'head')
  };
};

const asSide = (v: unknown, fallback: CompareRef): CompareSide => {
  const o = isObj(v) ? v : {};
  const kind = o.kind === 'now' || o.kind === 'published' || o.kind === 'alt' ? o.kind : 'version';
  const row = asVersionRow(o.row);
  return { ref: str(o.ref) ?? fallback, kind, ...(row ? { row } : {}) };
};

const asDoc = (v: unknown): ComicDoc => {
  if (!isObj(v)) throw new Error('This version came back incomplete.');
  return normalizeDoc(v as unknown as ComicDoc);
};

// ── The HTTP client ──────────────────────────────────────────────────────────

const call = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    throw toStudioApiError(err, 'project');
  }
};

const queryString = (q: HistoryListQuery = {}): string => {
  const p = new URLSearchParams();
  if (q.cursor) p.set('cursor', q.cursor);
  if (q.filter && q.filter !== 'all') p.set('filter', q.filter);
  if (q.filter === 'page' && q.pageId) p.set('pageId', q.pageId);
  p.set('limit', String(q.limit ?? HISTORY_PAGE_SIZE));
  return `?${p.toString()}`;
};

export const httpHistoryApi: HistoryApi = {
  list: (projectId, query, opts) => call(async () => asListResponse(await get<unknown>(`${HISTORY_ROUTES.list(projectId)}${queryString(query)}`, { signal: opts?.signal }))),
  detail: (projectId, versionId, opts) =>
    call(async () => {
      const res = await get<unknown>(HISTORY_ROUTES.detail(projectId, versionId), { signal: opts?.signal });
      const o = isObj(res) ? res : {};
      const row = asVersionRow(o.row);
      if (!row) throw new Error('This moment came back incomplete.');
      return { row, manifest: o.manifest as VersionDetail['manifest'], groups: Array.isArray(o.groups) ? (o.groups.filter((g) => isObj(g) && typeof g.title === 'string') as unknown as VersionDetail['groups']) : [] };
    }),
  book: (projectId, versionId, opts) =>
    call(async () => {
      const res = await get<unknown>(HISTORY_ROUTES.book(projectId, versionId), { signal: opts?.signal });
      const o = isObj(res) ? res : {};
      const row = asVersionRow(o.row);
      return { ...(row ? { row } : {}), doc: asDoc(o.doc), urls: asUrlMap(o.urls) };
    }),
  urls: (projectId, versionId, paths) =>
    call(async () => {
      const unique = [...new Set(paths.filter((p) => typeof p === 'string' && p))];
      const out: Record<string, string> = {};
      for (let i = 0; i < unique.length; i += HISTORY_URL_BATCH) {
        const res = await post<{ paths: string[] }, unknown>(HISTORY_ROUTES.urls(projectId, versionId), { paths: unique.slice(i, i + HISTORY_URL_BATCH) });
        Object.assign(out, asUrlMap(isObj(res) ? res.urls : undefined));
      }
      return out;
    }),
  compare: (projectId, a, b, opts) =>
    call(async () => {
      const res = await get<unknown>(`${HISTORY_ROUTES.compare(projectId)}?a=${enc(a)}&b=${enc(b)}`, { signal: opts?.signal });
      const o = isObj(res) ? res : {};
      const docs = isObj(o.docs) ? o.docs : {};
      if (!isObj(o.diff)) throw new Error('This comparison came back incomplete.');
      return { a: asSide(o.a, a), b: asSide(o.b, b), diff: o.diff as unknown as CompareResult['diff'], docs: { a: asDoc(docs.a), b: asDoc(docs.b) }, urls: asUrlMap(o.urls) };
    }),
  classicSnapshots: (projectId, opts) =>
    call(async () => {
      const res = await get<unknown>(HISTORY_ROUTES.legacy(projectId), { signal: opts?.signal });
      const list = isObj(res) && Array.isArray(res.snapshots) ? res.snapshots : [];
      const snapshots: ClassicSnapshotRow[] = [];
      for (const s of list) {
        if (!isObj(s) || !str(s.id) || !str(s.projectId)) continue;
        snapshots.push({ id: str(s.id)!, name: str(s.name) ?? 'Classic snapshot', projectId: str(s.projectId)!, createdAt: num(s.createdAt) ?? 0, ...(str(s.reason) ? { reason: str(s.reason) } : {}), ...(num(s.pages) !== undefined ? { pages: num(s.pages) } : {}) });
      }
      return { snapshots };
    }),
  startFromClassicSnapshot: (fromProjectId, snapshotId) =>
    call(async () => {
      const res = await post<{ importFromProjectId: string; fromVersionId: string }, unknown>(HISTORY_ROUTES.createProject(), { importFromProjectId: fromProjectId, fromVersionId: snapshotId });
      const o = isObj(res) ? res : {};
      const projectId = str(o.projectId) ?? (isObj(o.doc) ? str(o.doc.id) : undefined);
      if (!projectId) throw new Error("Couldn't start the new comic. Nothing was changed.");
      return { projectId };
    })
};

// ── Injection (tests and QA scenes run the same UI on the fake) ──────────────

export const HistoryApiContext = createContext<HistoryApi>(httpHistoryApi);

export const HistoryApiProvider: React.FC<{ api: HistoryApi; children: React.ReactNode }> = ({ api, children }) =>
  React.createElement(HistoryApiContext.Provider, { value: api }, children);

/** The HistoryApi in scope (the HTTP client unless a provider set the fake). */
export const useHistoryApi = (): HistoryApi => useContext(HistoryApiContext);

/** The list route answered 404: History as a whole can't be read for this comic. */
export const HISTORY_UNAVAILABLE = "History isn't available for this comic yet.";
/** A moment, its book or its compare answered 404 (thinned, or never there) — that moment only, never the comic. */
export const HISTORY_MOMENT_GONE = "This moment isn't kept any more (older automatic saves are thinned). Nothing in your comic changed.";

/**
 * A calm sentence for a failed history request. A 404 means the whole History only for the list (`about` 'comic',
 * the default); a moment, its book or a compare (`about` 'moment') says that moment is gone and nothing changed.
 */
export const historyErrorText = (err: unknown, fallback = "Couldn't load History. Nothing in your comic changed.", about: 'comic' | 'moment' = 'comic'): string => {
  const e = err as { kind?: string; message?: string } | null;
  if (e?.kind === 'not_found') return about === 'moment' ? HISTORY_MOMENT_GONE : HISTORY_UNAVAILABLE;
  if (e?.kind === 'aborted') return '';
  return typeof e?.message === 'string' && e.message.trim() && e.kind ? e.message : fallback;
};
