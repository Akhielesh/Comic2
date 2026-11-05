// The in-memory HistoryApi (package H5): the History UI's tests and QA scenes run on it until the owner routes (H3)
// land. Same shapes as historyApi.ts; compare uses the shared diffBooks, so "what changed" is what the server will
// say. Records every call (the card-renders-from-ids test reads them). No network, no timers, nothing spends.
// Lines follow H1's store (server/src/comic/history/store.fake.ts): the list is the line you're on; "Original"'s list
// also carries the rows of removed lines (each keeps its alternativeId) but never a live line's; a removed line is
// not found (empty); the head of a line is its own newest row (store.head: newest by createdAt, then id — a pin
// keeps a row from thinning, it never moves "you're here").

import { displayAssetPaths, type ComicDoc } from '../../../shared/comic/doc';
import { diffBooks, HISTORY_MANIFEST_VERSION, type CompareRef, type Manifest, type VersionRow } from '../../../shared/comic/history/index';
import type { ClassicSnapshotRow, HistoryApi, HistoryListResponse } from './historyApi';
import { changeGroupsOf, filterRows } from './historyModel';

export interface FakeHistoryVersion {
  row: VersionRow;
  doc: ComicDoc;
}

export interface FakeHistoryOptions {
  /** The live book ("now"). */
  live: () => ComicDoc;
  /** Newest first. */
  versions: FakeHistoryVersion[];
  classic?: ClassicSnapshotRow[];
  /** Methods that reject (honest error states). */
  fail?: Partial<Record<keyof HistoryApi, Error>>;
  /** Rows per list page (default 50). */
  pageSize?: number;
  /** Lines besides "Original" (rows name theirs in row.alternativeId). Absent: Original only. */
  lines?: FakeHistoryLine[];
  /** The line you're on (default null = "Original"). */
  activeLine?: string | null;
}

/** A line ("a version you're trying"), as H1's store keeps it. */
export interface FakeHistoryLine {
  id: string;
  name?: string;
  /** comic_alternatives.removed_at: never deleted, only marked (H1). */
  removed?: boolean;
}

export interface FakeHistoryCall {
  method: keyof HistoryApi;
  args: unknown[];
}

export interface FakeHistoryApi extends HistoryApi {
  calls: FakeHistoryCall[];
}

/** A neutral placeholder image for a storage path (deterministic; never a real image). */
export const fakeImageUrl = (path: string): string =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="60" viewBox="0 0 40 60" data-path="${path.replace(/[^\w./-]/g, '')}"><rect width="40" height="60" fill="gray" fill-opacity="0.25"/></svg>`)}`;

const urlsFor = (paths: Iterable<string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const p of paths) if (p) out[p] = fakeImageUrl(p);
  return out;
};

const EMPTY_MANIFEST: Manifest = { v: HISTORY_MANIFEST_VERSION, meta: '', source: '', style: '', cover: '', places: '', glossary: '', options: [], cast: [], pages: [], editions: {}, archive: [], trash: [] };

const notFound = (): Error => Object.assign(new Error("This comic doesn't exist or you don't have access to it."), { kind: 'not_found', status: 404 });

export const createFakeHistoryApi = (opts: FakeHistoryOptions): FakeHistoryApi => {
  const calls: FakeHistoryCall[] = [];
  const record = (method: keyof HistoryApi, args: unknown[]) => {
    calls.push({ method, args });
    const err = opts.fail?.[method];
    if (err) throw err;
  };
  const find = (id: string) => opts.versions.find((v) => v.row.id === id);
  const docOf = (ref: CompareRef): { doc: ComicDoc; kind: 'version' | 'now' | 'published' | 'alt'; row?: VersionRow } => {
    if (ref === 'now') return { doc: opts.live(), kind: 'now' };
    if (ref === 'published') {
      const pub = opts.versions.find((v) => v.row.kind === 'publish');
      if (!pub) throw notFound();
      return { doc: pub.doc, kind: 'published', row: pub.row };
    }
    const v = find(ref);
    if (!v) throw notFound();
    return { doc: v.doc, kind: 'version', row: v.row };
  };
  const size = opts.pageSize ?? 50;
  const lines = opts.lines ?? [];
  const liveLine = (id: string | null | undefined): boolean => !!id && lines.some((l) => l.id === id && !l.removed);
  /** The rows the list of `line` holds (H1 store.list): Original adds the rows of removed lines, never a live line's. */
  const inLine = (row: VersionRow, line: string | null): boolean =>
    line === null ? row.alternativeId == null || !liveLine(row.alternativeId) : row.alternativeId === line;
  /**
   * H1 store.head(line): the line's own newest row (store.ts orders by created_at desc, id desc, limit 1;
   * store.fake.ts newestOfLine) — Original's own (never a removed line's), a live line's own; a removed line: null.
   */
  const headOf = (line: string | null): string | null => {
    if (line !== null && !liveLine(line)) return null;
    const own = opts.versions.map((v) => v.row).filter((r) => (line === null ? r.alternativeId == null : r.alternativeId === line));
    return [...own].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0]?.id ?? null;
  };

  const api: FakeHistoryApi = {
    calls,
    async list(projectId, query = {}) {
      record('list', [projectId, query]);
      const line = opts.activeLine ?? null;
      // A removed (or unknown) line is not found: nothing listed (a stale tab can never show it as current).
      const onLine = line === null || liveLine(line) ? opts.versions.map((v) => v.row).filter((r) => inLine(r, line)) : [];
      const rows = filterRows(onLine, query.filter ?? 'all', query.pageId);
      const start = query.cursor ? Number(query.cursor) || 0 : 0;
      const pageRows = rows.slice(start, start + (query.limit ?? size));
      const res: HistoryListResponse = {
        rows: pageRows,
        next: start + pageRows.length < rows.length ? String(start + pageRows.length) : null,
        urls: urlsFor(pageRows.flatMap((r) => r.thumbs.map((t) => t.path))),
        line,
        head: headOf(line)
      };
      return res;
    },
    async detail(projectId, versionId) {
      record('detail', [projectId, versionId]);
      const v = find(versionId);
      if (!v) throw notFound();
      return { row: v.row, manifest: EMPTY_MANIFEST, groups: changeGroupsOf(v.row.changes) };
    },
    async book(projectId, versionId) {
      record('book', [projectId, versionId]);
      const v = find(versionId);
      if (!v) throw notFound();
      return { row: v.row, doc: v.doc, urls: urlsFor(displayAssetPaths(v.doc)) };
    },
    async urls(projectId, versionId, paths) {
      record('urls', [projectId, versionId, paths]);
      return urlsFor(paths);
    },
    async compare(projectId, a, b) {
      record('compare', [projectId, a, b]);
      const A = docOf(a);
      const B = docOf(b);
      return {
        a: { ref: a, kind: A.kind, ...(A.row ? { row: A.row } : {}) },
        b: { ref: b, kind: B.kind, ...(B.row ? { row: B.row } : {}) },
        diff: diffBooks(A.doc, B.doc),
        docs: { a: A.doc, b: B.doc },
        urls: urlsFor([...displayAssetPaths(A.doc), ...displayAssetPaths(B.doc)])
      };
    },
    async classicSnapshots(projectId) {
      record('classicSnapshots', [projectId]);
      return { snapshots: (opts.classic || []).filter((s) => s.projectId === projectId) };
    },
    async startFromClassicSnapshot(fromProjectId, snapshotId) {
      record('startFromClassicSnapshot', [fromProjectId, snapshotId]);
      return { projectId: `proj_from_${snapshotId}` };
    }
  };
  return api;
};
