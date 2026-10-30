// Comic History — an in-memory HistoryStore with the same semantics as server/sql/comic_history.sql (package H1).
// For tests and local tooling (H2 recorder, H3 restore, H5 fixtures, H7 lines). Never used in production.
//
// It behaves like the RPCs: one "transaction" per call (a refused put leaves nothing behind), chunk hashes verified on
// insert and on read, paths filtered by the GC-root rule and only ever shrinking, the presence check, dedupe on an
// equal root, thinning (48 h / hourly / daily / weekly, the row cap, the byte budget), the 10-minute chunk GC, named
// and per-hour save limits, line heads, soft-removed lines (their rows keep their line; "Original"'s head is always its
// own newest row), and the same StudioErrors as the Supabase store.
//
// Scoping is asserted, not assumed: every call must carry a project AND a user (a call without one throws — a test
// failure, never a silent pass), every call is recorded in `calls`, and every read filters by both. A project belongs
// to the first user that writes to it (or to `owners`); anyone else gets exactly what a missing comic gives.

import { randomUUID } from 'node:crypto';
import { MAX_ALTERNATIVES } from '../../../../shared/comic/limits.js';
import type { AlternativeRow, ChangeItem, HistoryActor, HistoryCodec, HistoryKind, Manifest, VersionStats, VersionThumb } from '../../../../shared/comic/history/types.js';
import { StudioError } from '../types.js';
import { CHUNK_PATHS_MAX, gcRootOf, historyHash, parseVerifiedChunk } from './hash.js';
import type { HistoryScope } from './hooks.js';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  historyStoreError,
  listLimitOf,
  preparePut,
  versionHashes,
  type HeadVersionRow,
  type HistoryPutResult,
  type HistoryVersionInput,
  type StoredVersionRow,
  type StoredVersionWithPaths
} from './store.js';
import type { ChunkInput, HistoryListFilter, HistoryPolicy, HistoryStore, PutResult, VersionInput } from './storeTypes.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** date_trunc('week') in UTC: weeks start on Monday (1970-01-05 is the first Monday after the epoch). */
const weekOf = (ms: number) => Math.floor((ms - 4 * DAY) / (7 * DAY));
const PINNED_KINDS = new Set<HistoryKind>(['start', 'named', 'publish', 'import', 'legacy']);
const GC_GRACE_MS = 10 * 60_000;
const THIN_MAX = 50;
const GC_MAX = 500;

interface FakeRow {
  id: string;
  projectId: string;
  userId: string;
  alternativeId: string | null;
  parentId?: string;
  undoId?: string;
  codec: HistoryCodec;
  kind: HistoryKind;
  actor: HistoryActor;
  label: string;
  name?: string;
  note?: string;
  pinned: boolean;
  keepUntil?: number;
  rev: number;
  contentAt: number;
  manifest: Manifest;
  rootHash: string;
  chunks: string[];
  changes: ChangeItem[];
  thumbs: VersionThumb[];
  stats: Partial<VersionStats>;
  modelId?: string;
  publishedRev?: number;
  legacyRef?: VersionInput['legacyRef'];
  bytesNew: number;
  createdAt: number;
  seq: number;
}

export interface FakeChunkRow {
  hash: string;
  kind: string;
  codec: HistoryCodec;
  content: string;
  bytes: number;
  paths: string[];
  createdAt: number;
}

interface FakeChunk extends FakeChunkRow {
  projectId: string;
  userId: string;
}

interface FakeAlt {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  fromVersionId?: string;
  headVersionId?: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  /** comic_alternatives.removed_at: a removed line is never deleted, only marked. */
  removedAt?: number;
}

export type FakeHistoryMethod = keyof HistoryStore;

export interface FakeHistoryCall {
  method: FakeHistoryMethod;
  projectId: string;
  userId: string;
}

export interface FakeHistoryStoreOptions {
  /** The clock (epoch ms) thinning, GC and created_at use. Default Date.now. */
  now?: () => number;
  /** projectId → owner userId. Unlisted projects belong to the first user that writes to them. */
  owners?: Record<string, string>;
  /** Lines per comic, counting "Original" (default MAX_ALTERNATIVES). */
  maxAlternatives?: number;
}

export interface FakeHistoryStore extends HistoryStore {
  /** Every call, with the scope it carried (tests assert project + user on each). */
  readonly calls: FakeHistoryCall[];
  /** Give a project to a user (like projects.user_id). */
  own(projectId: string, userId: string): void;
  /** The next call of `method` rejects with `error` (default: a retryable 503) — for "a store failure never…" tests. */
  failNext(method: FakeHistoryMethod, error?: Error): void;
  /** Overwrite a stored chunk's content behind the hash check (a corrupted row): get() must refuse it. */
  corruptChunk(scope: HistoryScope, hash: string, content: string): void;
  /** Every row of a comic, newest first (all lines; inspection). */
  rows(scope: HistoryScope): StoredVersionRow[];
  /** Every stored chunk of a comic (inspection). */
  chunkRows(scope: HistoryScope): FakeChunkRow[];
  /** The chunk hashes a row references (its `chunks` column). */
  versionChunks(scope: HistoryScope, versionId: string): string[];
}

const clone = <T>(v: T): T => (v === undefined ? v : (structuredClone(v) as T));

export function createFakeHistoryStore(opts: FakeHistoryStoreOptions = {}): FakeHistoryStore {
  const now = opts.now ?? (() => Date.now());
  const maxAlternatives = opts.maxAlternatives ?? MAX_ALTERNATIVES;
  const owners = new Map<string, string>(Object.entries(opts.owners || {}));
  const versions = new Map<string, FakeRow>();
  /** `${projectId} ${hash}` → chunk. */
  const chunkStore = new Map<string, FakeChunk>();
  const alts = new Map<string, FakeAlt>();
  const calls: FakeHistoryCall[] = [];
  const failures = new Map<FakeHistoryMethod, Error[]>();
  let seq = 0;
  let lastCreated = 0;

  const ck = (projectId: string, hash: string) => `${projectId} ${hash}`;

  /** Every call: a project and a user, recorded; then any queued failure. */
  const enter = (method: FakeHistoryMethod, scope: HistoryScope): void => {
    if (!scope || typeof scope.projectId !== 'string' || !scope.projectId || typeof scope.userId !== 'string' || !scope.userId) {
      throw new Error(`fake history store: ${method} was called without a project and user scope`);
    }
    calls.push({ method, projectId: scope.projectId, userId: scope.userId });
    const queued = failures.get(method);
    const err = queued?.shift();
    if (err) throw err;
  };
  /** Reads: only the owner sees anything. */
  const owns = (scope: HistoryScope) => owners.get(scope.projectId) === scope.userId;
  /** Writes: the owner (or the first writer claims it); anyone else is FORBIDDEN (= not found). */
  const lock = (scope: HistoryScope) => {
    const owner = owners.get(scope.projectId);
    if (owner === undefined) owners.set(scope.projectId, scope.userId);
    else if (owner !== scope.userId) throw historyStoreError('FORBIDDEN');
  };

  const rowsOf = (projectId: string) => [...versions.values()].filter((r) => r.projectId === projectId);
  const newestFirst = (a: FakeRow, b: FakeRow) => b.createdAt - a.createdAt || b.seq - a.seq;
  const sameLine = (r: FakeRow, line: string | null) => (line === null ? r.alternativeId === null : r.alternativeId === line);
  const newestOfLine = (projectId: string, line: string | null, userId?: string) =>
    rowsOf(projectId)
      .filter((r) => sameLine(r, line) && (userId === undefined || r.userId === userId))
      .sort(newestFirst)[0];
  const isHead = (projectId: string, id: string) => [...alts.values()].some((a) => a.projectId === projectId && a.headVersionId === id);
  /** A line still being tried, of this comic and user (a removed one is not found). */
  const liveAlt = (scope: HistoryScope, id: unknown): FakeAlt | undefined => {
    const a = typeof id === 'string' ? alts.get(id) : undefined;
    return a && a.projectId === scope.projectId && a.userId === scope.userId && a.removedAt === undefined ? a : undefined;
  };
  /** "Original" (null) or a line still being tried: the lines whose newest row is their current state. */
  const isCurrentLine = (projectId: string, line: string | null) => {
    if (line === null) return true;
    const a = alts.get(line);
    return !!a && a.projectId === projectId && a.removedAt === undefined;
  };
  const activeLine = (scope: HistoryScope) =>
    [...alts.values()].find((a) => a.projectId === scope.projectId && a.userId === scope.userId && a.active && a.removedAt === undefined)?.id ?? null;
  /** undefined = the line you're on; null = "Original"; an id must be a line still being tried (else not found). */
  const resolveLine = (scope: HistoryScope, alternativeId: string | null | undefined): { line: string | null } | null => {
    if (alternativeId === undefined) return { line: activeLine(scope) };
    if (alternativeId === null) return { line: null };
    return liveAlt(scope, alternativeId) ? { line: alternativeId } : null;
  };

  const rowOut = (r: FakeRow): StoredVersionRow => {
    const out: StoredVersionRow = {
      id: r.id,
      kind: r.kind,
      actor: r.actor,
      label: r.label,
      pinned: r.pinned,
      rev: r.rev,
      contentAt: r.contentAt,
      createdAt: r.createdAt,
      alternativeId: r.alternativeId,
      codec: r.codec,
      changes: clone(r.changes),
      thumbs: clone(r.thumbs),
      stats: { pages: 0, drawn: 0, lines: 0, langs: [], models: [], ...clone(r.stats) },
      rootHash: r.rootHash
    };
    if (r.name) out.name = r.name;
    if (r.note) out.note = r.note;
    if (r.keepUntil !== undefined) out.keepUntil = r.keepUntil;
    if (r.parentId) out.parentId = r.parentId;
    if (r.undoId) out.undoId = r.undoId;
    if (r.modelId) out.modelId = r.modelId;
    if (r.publishedRev !== undefined) out.publishedRev = r.publishedRev;
    if (r.legacyRef) {
      const { snapshotId, reason, projectId } = r.legacyRef;
      out.legacy = { ...(snapshotId ? { snapshotId } : {}), ...(reason ? { reason } : {}), ...(projectId ? { projectId } : {}) };
    }
    return out;
  };
  const altOut = (a: FakeAlt): AlternativeRow => ({
    id: a.id,
    name: a.name,
    active: a.active,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    ...(a.fromVersionId ? { fromVersionId: a.fromVersionId } : {}),
    ...(a.headVersionId ? { headVersionId: a.headVersionId } : {})
  });

  /** The comic_version_chunks_verify trigger's paths rule. */
  const pathsOf = (paths: string[]) => [...new Set(paths.map((p) => gcRootOf(p)).filter((p): p is string => !!p))].sort().slice(0, CHUNK_PATHS_MAX);

  /** Delete rows (with the `on delete set null` references). */
  const removeRows = (ids: Set<string>) => {
    for (const id of ids) versions.delete(id);
    for (const r of versions.values()) {
      if (r.parentId && ids.has(r.parentId)) delete r.parentId;
      if (r.undoId && ids.has(r.undoId)) delete r.undoId;
    }
    for (const a of alts.values()) {
      if (a.fromVersionId && ids.has(a.fromVersionId)) delete a.fromVersionId;
      if (a.headVersionId && ids.has(a.headVersionId)) delete a.headVersionId;
    }
  };

  /** comic_history_deletable: unpinned, unnamed, past keep_until, not a line's head, not the newest row of "Original"
   *  or of a line still being tried (a removed line ages out fully). */
  const deletable = (projectId: string, at: number) => {
    const newest = new Map<string, FakeRow>();
    for (const r of rowsOf(projectId).sort(newestFirst)) {
      if (!isCurrentLine(projectId, r.alternativeId)) continue;
      const line = r.alternativeId ?? '';
      if (!newest.has(line)) newest.set(line, r);
    }
    const keep = new Set([...newest.values()].map((r) => r.id));
    return rowsOf(projectId).filter(
      (r) => !r.pinned && !r.name && (r.keepUntil === undefined || r.keepUntil <= at) && !keep.has(r.id) && !isHead(projectId, r.id)
    );
  };
  const oldestFirst = (a: FakeRow, b: FakeRow) => a.contentAt - b.contentAt || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  /** comic_history_thin. */
  const thin = (projectId: string, unpinned: number, budget: number) => {
    const at = now();
    const doomed = new Set<string>();
    // (a) schedule
    const buckets = new Map<string, FakeRow[]>();
    for (const r of deletable(projectId, at)) {
      if (r.contentAt > at - 48 * HOUR) continue;
      const tier = r.contentAt > at - 7 * DAY ? 1 : r.contentAt > at - 90 * DAY ? 2 : 3;
      const bucket = tier === 1 ? Math.floor(r.contentAt / HOUR) : tier === 2 ? Math.floor(r.contentAt / DAY) : weekOf(r.contentAt);
      const key = `${r.alternativeId ?? ''}|${tier}|${bucket}`;
      buckets.set(key, [...(buckets.get(key) || []), r]);
    }
    const scheduled: FakeRow[] = [];
    for (const rows of buckets.values()) {
      rows.sort((a, b) => b.contentAt - a.contentAt || b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
      scheduled.push(...rows.slice(1));
    }
    for (const r of scheduled.sort(oldestFirst).slice(0, THIN_MAX)) doomed.add(r.id);
    // (b) row cap
    if (doomed.size < THIN_MAX) {
      const count = rowsOf(projectId).filter((r) => !r.pinned && !doomed.has(r.id)).length;
      if (count > unpinned) {
        const extra = deletable(projectId, at)
          .filter((r) => !doomed.has(r.id))
          .sort(oldestFirst)
          .slice(0, Math.min(count - unpinned, THIN_MAX - doomed.size));
        for (const r of extra) doomed.add(r.id);
      }
    }
    // (c) byte budget
    const budgetDoomed = new Set<string>();
    if (doomed.size < THIN_MAX) {
      const total = rowsOf(projectId).filter((r) => !doomed.has(r.id)).reduce((n, r) => n + r.bytesNew, 0);
      if (total > budget) {
        let cum = 0;
        for (const r of deletable(projectId, at).filter((x) => !doomed.has(x.id)).sort(oldestFirst)) {
          if (budgetDoomed.size >= THIN_MAX - doomed.size) break;
          if (total - cum > budget) budgetDoomed.add(r.id);
          else break;
          cum += r.bytesNew;
        }
      }
    }
    removeRows(new Set([...doomed, ...budgetDoomed]));
    return { thinned: doomed.size, budgetThinned: budgetDoomed.size };
  };

  /** comic_history_gc: this comic's unreferenced chunks older than 10 minutes. */
  const gc = (projectId: string) => {
    const refs = new Set(rowsOf(projectId).flatMap((r) => r.chunks));
    const cutoff = now() - GC_GRACE_MS;
    let n = 0;
    for (const [key, c] of chunkStore) {
      if (n >= GC_MAX) break;
      if (c.projectId === projectId && c.createdAt < cutoff && !refs.has(c.hash)) {
        chunkStore.delete(key);
        n += 1;
      }
    }
    return n;
  };

  const namedCount = (projectId: string) => rowsOf(projectId).filter((r) => r.kind === 'named' || !!r.name).length;

  const verifiedChunks = (scope: HistoryScope, hashes: string[]) => {
    const bodies = new Map<string, unknown>();
    const paths = new Map<string, string[]>();
    for (const h of new Set(hashes)) {
      const c = chunkStore.get(ck(scope.projectId, h));
      if (!c || c.userId !== scope.userId) continue;
      const body = parseVerifiedChunk(h, c.content);
      if (body === undefined) continue;
      bodies.set(h, body);
      paths.set(h, [...c.paths]);
    }
    return { bodies, paths };
  };

  const store: FakeHistoryStore = {
    calls,

    own(projectId, userId) {
      owners.set(projectId, userId);
    },

    failNext(method, error) {
      failures.set(method, [...(failures.get(method) || []), error ?? new StudioError('INTERNAL', "History isn't reachable right now. Nothing in your comic changed.", { status: 503, retryable: true })]);
    },

    corruptChunk(scope, hash, content) {
      const c = chunkStore.get(ck(scope.projectId, hash));
      if (c) c.content = content;
    },

    rows(scope) {
      return rowsOf(scope.projectId).filter((r) => r.userId === scope.userId).sort(newestFirst).map(rowOut);
    },

    chunkRows(scope) {
      return [...chunkStore.values()]
        .filter((c) => c.projectId === scope.projectId && c.userId === scope.userId)
        .map(({ hash, kind, codec, content, bytes, paths, createdAt }) => ({ hash, kind, codec, content, bytes, paths: [...paths], createdAt }));
    },

    versionChunks(scope, versionId) {
      const r = versions.get(versionId);
      return r && r.projectId === scope.projectId && r.userId === scope.userId ? [...r.chunks] : [];
    },

    async missing(scope, hashes) {
      enter('missing', scope);
      const wanted = [...new Set((Array.isArray(hashes) ? hashes : []).filter((h) => typeof h === 'string' && /^[0-9a-f]{32}$/.test(h)))];
      return wanted.filter((h) => {
        const c = chunkStore.get(ck(scope.projectId, h));
        return !(c && c.userId === scope.userId);
      });
    },

    async put(scope: HistoryScope, input: VersionInput, chunks: ChunkInput[], policy?: Partial<HistoryPolicy>): Promise<PutResult> {
      enter('put', scope);
      lock(scope);
      const { version, chunks: incoming } = preparePut(input as HistoryVersionInput, chunks);
      const at = now();
      const unpinned = Math.min(Math.max(Math.trunc(policy?.unpinnedRows ?? 300), 1), 100_000);
      const budget = Math.max(policy?.bytesPerComic ?? 25_000_000, 0);
      const extra = (policy || {}) as Record<string, unknown>;
      const namedCap = typeof extra.namedRows === 'number' ? extra.namedRows : 100;
      const savesCap = typeof extra.savesPerHour === 'number' ? extra.savesPerHour : 30;
      const restoreDays = typeof extra.beforeRestoreDays === 'number' ? extra.beforeRestoreDays : 30;
      const line = version.alternativeId ?? null;
      if (line !== null && !liveAlt(scope, line)) throw historyStoreError('NOT_FOUND');
      // 3. Stage the chunks (verified; one already stored is skipped). Nothing is kept unless the whole call succeeds.
      const staged = new Map<string, FakeChunk>();
      for (const c of incoming) {
        if (historyHash(c.content) !== c.hash) throw historyStoreError('HASH');
        if (chunkStore.has(ck(scope.projectId, c.hash)) || staged.has(c.hash)) continue;
        staged.set(c.hash, {
          projectId: scope.projectId,
          userId: scope.userId,
          hash: c.hash,
          kind: c.kind.slice(0, 24),
          codec: version.codec ?? 'v5',
          content: c.content,
          bytes: Buffer.byteLength(c.content, 'utf8'),
          paths: pathsOf(c.paths),
          createdAt: at
        });
      }
      // 4. Presence.
      if (version.chunks.some((h) => !staged.has(h) && !chunkStore.has(ck(scope.projectId, h)))) throw historyStoreError('MISSING_CHUNKS');
      const bytesNew = [...staged.values()].reduce((n, c) => n + c.bytes, 0);
      const commitChunks = () => {
        for (const c of staged.values()) chunkStore.set(ck(scope.projectId, c.hash), c);
      };
      const keepUntil = version.keepUntil ?? (version.kind === 'before_restore' ? at + restoreDays * DAY : undefined);
      const deduped = (id: string): PutResult => ({ id, deduped: true, thinned: 0, budgetThinned: 0, gcChunks: 0, bytesNew });

      // 5. Dedupe.
      const snapshot = version.legacyRef?.snapshotId;
      if (version.kind === 'legacy' && snapshot) {
        const known = rowsOf(scope.projectId).find((r) => r.codec === 'legacy' && r.legacyRef?.snapshotId === snapshot);
        if (known) {
          commitChunks();
          return deduped(known.id);
        }
      }
      if (version.kind === 'named' && rowsOf(scope.projectId).filter((r) => r.kind === 'named' && r.createdAt > at - HOUR).length >= savesCap) {
        throw historyStoreError('LIMIT:saves_per_hour');
      }
      if (version.kind !== 'legacy') {
        const head = newestOfLine(scope.projectId, line, scope.userId);
        if (head && head.rootHash === version.rootHash) {
          if (version.kind === 'named' && !head.name && head.kind !== 'named' && namedCount(scope.projectId) >= namedCap) throw historyStoreError('LIMIT:named');
          if (version.kind === 'start' || version.kind === 'named' || version.kind === 'publish' || version.kind === 'import') head.pinned = true;
          // A moment already saved under a name keeps it: a second save never renames it (the caller says so).
          const alreadyNamed = version.kind === 'named' && head.name ? head.name : undefined;
          if (version.kind === 'named' && !alreadyNamed) {
            if (version.name) head.name = version.name;
            if (version.note) head.note = version.note;
          }
          if (version.kind === 'publish' && typeof version.publishedRev === 'number') head.publishedRev = version.publishedRev;
          if (version.kind === 'before_restore' && keepUntil !== undefined) head.keepUntil = Math.max(head.keepUntil ?? 0, keepUntil);
          commitChunks();
          const out: HistoryPutResult = deduped(head.id);
          if (alreadyNamed) Object.assign(out, { alreadyNamed: true, name: alreadyNamed });
          return out;
        }
      }
      if (version.kind === 'named' && namedCount(scope.projectId) >= namedCap) throw historyStoreError('LIMIT:named');

      // 6. Insert.
      commitChunks();
      const ref = (id?: string) => {
        const r = id ? versions.get(id) : undefined;
        return r && r.projectId === scope.projectId && r.userId === scope.userId ? r.id : undefined;
      };
      // A classic snapshot keeps its own time (never later than now); every other row is stamped strictly in order.
      const createdAt = version.codec === 'legacy' && version.createdAt !== undefined ? Math.min(version.createdAt, at) : Math.max(at, lastCreated + 1);
      lastCreated = Math.max(lastCreated, createdAt);
      const row: FakeRow = {
        id: randomUUID(),
        projectId: scope.projectId,
        userId: scope.userId,
        alternativeId: line,
        parentId: ref(version.parentId),
        undoId: ref(version.undoId),
        codec: version.codec ?? 'v5',
        kind: version.kind,
        actor: version.actor,
        label: version.label,
        name: version.name,
        note: version.note,
        pinned: !!version.pinned || PINNED_KINDS.has(version.kind) || !!version.name,
        keepUntil,
        rev: version.rev,
        contentAt: version.contentAt,
        manifest: clone(version.manifest),
        rootHash: version.rootHash,
        chunks: [...version.chunks],
        changes: clone(version.changes ?? []),
        thumbs: clone(version.thumbs ?? []),
        stats: clone(version.stats ?? {}),
        modelId: version.modelId ? version.modelId.slice(0, 120) : undefined,
        publishedRev: version.publishedRev,
        legacyRef: clone(version.legacyRef),
        bytesNew,
        createdAt,
        seq: (seq += 1)
      };
      if (!row.parentId) delete row.parentId;
      if (!row.undoId) delete row.undoId;
      versions.set(row.id, row);
      // 7–8.
      const t = thin(scope.projectId, unpinned, budget);
      const gcChunks = gc(scope.projectId);
      return { id: row.id, deduped: false, thinned: t.thinned, budgetThinned: t.budgetThinned, gcChunks, bytesNew };
    },

    async head(scope, alternativeId) {
      enter('head', scope);
      if (!owns(scope)) return null;
      const resolved = resolveLine(scope, alternativeId);
      if (!resolved) return null;
      const r = newestOfLine(scope.projectId, resolved.line, scope.userId);
      if (!r) return null;
      const out: HeadVersionRow = { ...rowOut(r), manifest: clone(r.manifest) };
      return out;
    },

    async list(scope, filter: HistoryListFilter = {}) {
      enter('list', scope);
      if (!owns(scope)) return { rows: [] };
      const resolved = resolveLine(scope, filter.alternativeId);
      if (!resolved) return { rows: [] };
      const line = resolved.line;
      const limit = listLimitOf(filter.limit);
      const cursor = decodeHistoryCursor(filter.cursor);
      const cursorAt = cursor ? Date.parse(cursor.contentAt) : NaN;
      // "Original" also lists the rows of removed lines (each keeps its alternativeId); head(null) never sees them.
      const inList = (r: FakeRow) => sameLine(r, line) || (line === null && r.alternativeId !== null && !isCurrentLine(scope.projectId, r.alternativeId));
      const rows = rowsOf(scope.projectId)
        .filter((r) => r.userId === scope.userId && inList(r))
        .filter((r) => !filter.kinds || filter.kinds.includes(r.kind))
        .filter((r) => !filter.actor || r.actor === filter.actor)
        .filter((r) => !filter.pageId || r.changes.some((c) => c.pageIds?.includes(filter.pageId!)))
        .filter((r) => !cursor || !Number.isFinite(cursorAt) || r.contentAt < cursorAt || (r.contentAt === cursorAt && r.id < cursor.id))
        .sort((a, b) => b.contentAt - a.contentAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        rows: page.map(rowOut),
        ...(rows.length > limit && last ? { next: encodeHistoryCursor(new Date(last.contentAt).toISOString(), last.id) } : {})
      };
    },

    async get(scope, versionId) {
      enter('get', scope);
      const r = typeof versionId === 'string' ? versions.get(versionId) : undefined;
      if (!r || r.projectId !== scope.projectId || r.userId !== scope.userId) return null;
      const hashes = versionHashes(r.codec, r.manifest, r.chunks);
      if (!hashes) return null;
      const { bodies, paths } = verifiedChunks(scope, hashes);
      if (hashes.some((h) => !bodies.has(h))) return null;
      const out: StoredVersionWithPaths = { row: rowOut(r), manifest: clone(r.manifest), bodies, paths };
      return out;
    },

    async chunks(scope, hashes) {
      enter('chunks', scope);
      return verifiedChunks(scope, Array.isArray(hashes) ? hashes : []).bodies;
    },

    async label(scope, versionId, patch) {
      enter('label', scope);
      if (!owns(scope)) return null;
      const r = typeof versionId === 'string' ? versions.get(versionId) : undefined;
      if (!r || r.projectId !== scope.projectId || r.userId !== scope.userId) return null;
      const text = (v: string | null | undefined, max: number, cur: string | undefined) =>
        v === undefined ? cur : (typeof v === 'string' ? v.trim().slice(0, max) : '') || undefined;
      const name = text(patch?.name, 80, r.name);
      const note = text(patch?.note, 280, r.note);
      if (name && !r.name && r.kind !== 'named' && namedCount(scope.projectId) >= 100) throw historyStoreError('LIMIT:named');
      r.pinned = PINNED_KINDS.has(r.kind)
        ? true
        : typeof patch?.pinned === 'boolean'
          ? patch.pinned
          : name && !r.name
            ? true
            : r.pinned;
      r.name = name;
      r.note = note;
      if (!r.name) delete r.name;
      if (!r.note) delete r.note;
      return rowOut(r);
    },

    async delete(scope, versionId) {
      enter('delete', scope);
      if (!owns(scope)) return false;
      const r = typeof versionId === 'string' ? versions.get(versionId) : undefined;
      if (!r || r.projectId !== scope.projectId || r.userId !== scope.userId) return false;
      if (r.kind === 'legacy') throw historyStoreError('REFUSED:classic');
      if (r.kind !== 'named' && !r.name) throw historyStoreError('REFUSED:not_named');
      if (isCurrentLine(scope.projectId, r.alternativeId) && newestOfLine(scope.projectId, r.alternativeId)?.id === r.id) throw historyStoreError('REFUSED:newest');
      if (isHead(scope.projectId, r.id)) throw historyStoreError('REFUSED:head');
      removeRows(new Set([r.id]));
      gc(scope.projectId);
      return true;
    },

    async forgetPath(scope, path) {
      enter('forgetPath', scope);
      if (!owns(scope) || typeof path !== 'string' || !path.trim()) return 0;
      const p = path.trim();
      let n = 0;
      for (const c of chunkStore.values()) {
        if (c.projectId === scope.projectId && c.paths.includes(p)) {
          c.paths = c.paths.filter((x) => x !== p);
          n += 1;
        }
      }
      return n;
    },

    async alternatives(scope) {
      enter('alternatives', scope);
      if (!owns(scope)) return [];
      return [...alts.values()]
        .filter((a) => a.projectId === scope.projectId && a.userId === scope.userId && a.removedAt === undefined)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(altOut);
    },

    async createAlternative(scope, input) {
      enter('createAlternative', scope);
      lock(scope);
      const name = String(input?.name ?? '').trim().slice(0, 60);
      if (!name) throw historyStoreError('INVALID');
      if ([...alts.values()].filter((a) => a.projectId === scope.projectId && a.removedAt === undefined).length + 1 >= Math.max(maxAlternatives, 1)) {
        throw historyStoreError('LIMIT:alternatives');
      }
      const head = input?.headVersionId ? versions.get(input.headVersionId) : undefined;
      if (!head || head.projectId !== scope.projectId || head.userId !== scope.userId) throw historyStoreError('NOT_FOUND');
      const from = input.fromVersionId ? versions.get(input.fromVersionId) : undefined;
      const at = now();
      const alt: FakeAlt = {
        id: randomUUID(),
        projectId: scope.projectId,
        userId: scope.userId,
        name,
        headVersionId: head.id,
        active: false,
        createdAt: Math.max(at, lastCreated + 1),
        updatedAt: at
      };
      lastCreated = alt.createdAt;
      if (from && from.projectId === scope.projectId && from.userId === scope.userId) alt.fromVersionId = from.id;
      alts.set(alt.id, alt);
      head.pinned = true;
      return altOut(alt);
    },

    async updateAlternative(scope, id, patch) {
      enter('updateAlternative', scope);
      if (!owns(scope)) return null;
      const alt = liveAlt(scope, id);
      if (!alt) return null;
      const name = typeof patch?.name === 'string' ? patch.name.trim().slice(0, 60) : undefined;
      if (name === '') throw historyStoreError('INVALID');
      const at = now();
      if (patch?.active === true) {
        for (const a of alts.values()) if (a.projectId === scope.projectId && a.active && a.id !== alt.id) Object.assign(a, { active: false, updatedAt: at });
      }
      if (name) alt.name = name;
      if (typeof patch?.active === 'boolean') alt.active = patch.active;
      alt.updatedAt = at;
      return altOut(alt);
    },

    async removeAlternative(scope, id) {
      enter('removeAlternative', scope);
      if (!owns(scope)) return false;
      const alt = liveAlt(scope, id);
      if (!alt) return false;
      if (alt.active) throw historyStoreError('REFUSED:active');
      for (const r of rowsOf(scope.projectId)) {
        const headElsewhere = [...alts.values()].some((a) => a.id !== alt.id && a.projectId === scope.projectId && a.headVersionId === r.id);
        if ((r.alternativeId === alt.id || (r.id === alt.headVersionId && !headElsewhere)) && r.pinned && !PINNED_KINDS.has(r.kind) && !r.name) r.pinned = false;
      }
      // Marked, never deleted: its rows keep their line and age out; it is not found from now on.
      const at = now();
      Object.assign(alt, { removedAt: at, active: false, updatedAt: at });
      delete alt.headVersionId;
      return true;
    },

    async setHead(scope, alternativeId, versionId) {
      enter('setHead', scope);
      lock(scope);
      const v = typeof versionId === 'string' ? versions.get(versionId) : undefined;
      if (!v || v.projectId !== scope.projectId || v.userId !== scope.userId) throw historyStoreError('NOT_FOUND');
      // "Original"'s head is its newest row (never thinned): nothing to store, nothing to pin.
      if (alternativeId === null) return;
      const alt = liveAlt(scope, alternativeId);
      if (!alt) throw historyStoreError('NOT_FOUND');
      const old = alt.headVersionId;
      alt.headVersionId = v.id;
      alt.updatedAt = now();
      if (old && old !== v.id && !isHead(scope.projectId, old)) {
        const o = versions.get(old);
        if (o && !PINNED_KINDS.has(o.kind) && !o.name) o.pinned = false;
      }
      v.pinned = true;
    }
  };
  return store;
}
