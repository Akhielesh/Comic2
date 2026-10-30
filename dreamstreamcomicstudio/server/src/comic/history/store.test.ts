// @vitest-environment node
// The Supabase HistoryStore (versions plan §3.2, §12; H1), through the real supabase-js client and a recording fetch
// that plays PostgREST over in-memory rows:
//   * every table read filters by project_id AND user_id, and every RPC carries p_project AND p_user;
//   * a non-uuid scope or id makes no request at all and answers exactly like a missing comic;
//   * put sends the VersionInput the RPC reads (trimmed, capped, policy defaults) and maps its answer;
//   * get re-verifies every chunk: an altered one makes the version unopenable (and is logged);
//   * lists page by an opaque (content_at, id) cursor quoted for PostgREST; page filter is jsonb containment;
//   * a removed line is not found (head, list, the line list) and Original's list also carries its rows, merged in
//     the database's order; a classic-editor row opens from its `chunks` column;
//   * database refusals become honest StudioErrors.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { normalizeDoc } from '../../../../shared/comic/doc.js';
import { HISTORY_LIMITS } from '../../../../shared/comic/limits.js';
import { excludedOf, stripVolatile } from '../../../../shared/comic/history/sections.js';
import { historyV5Doc } from '../../../../shared/comic/history/__fixtures__/books.js';
import { logger } from '../../lib/logger.js';
import { StudioError } from '../types.js';
import type { Manifest } from '../../../../shared/comic/history/types.js';
import { assembleBook, chunkBook, historyHash, manifestHashes } from './hash.js';
import type { HistoryScope } from './hooks.js';
import {
  createSupabaseHistoryStore,
  decodeHistoryCursor,
  encodeHistoryCursor,
  mapHistoryDbError,
  versionRowFromDb,
  type StoredVersionWithPaths
} from './store.js';
import type { HistoryStore, VersionInput } from './storeTypes.js';

const P = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const V1 = '33333333-3333-4333-8333-333333333331';
const V2 = '33333333-3333-4333-8333-333333333332';
const V3 = '33333333-3333-4333-8333-333333333333';
const ALT = '44444444-4444-4444-8444-444444444444';
const ME: HistoryScope = { projectId: P, userId: U };

type Row = Record<string, unknown>;
interface Req {
  method: string;
  path: string;
  params: URLSearchParams;
  body: Record<string, unknown> | null;
}

/** A PostgREST look-alike over in-memory tables: eq / in / is / not.is / not.in filters, order desc on one column, limit. */
const makeDb = () => {
  const tables: Record<string, Row[]> = { comic_versions: [], comic_version_chunks: [], comic_alternatives: [] };
  const rpcs: Record<string, (body: Record<string, unknown>) => { status: number; body: unknown }> = {};
  const requests: Req[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method || 'GET';
    const body = typeof init?.body === 'string' && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const path = url.pathname.replace(/^\/rest\/v1\//, '');
    requests.push({ method, path, params: url.searchParams, body });
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
    if (path.startsWith('rpc/')) {
      const handler = rpcs[path.slice(4)];
      if (!handler) return json(404, { code: 'PGRST202', message: `Could not find the function public.${path.slice(4)}`, details: null, hint: null });
      const r = handler(body || {});
      return json(r.status, r.body);
    }
    let rows = [...(tables[path] || [])];
    for (const [key, value] of url.searchParams) {
      if (['select', 'order', 'limit', 'or'].includes(key)) continue;
      for (const one of url.searchParams.getAll(key)) {
        if (one.startsWith('eq.')) rows = rows.filter((r) => String(r[key]) === one.slice(3));
        else if (one.startsWith('in.(')) {
          const set = new Set(one.slice(4, -1).split(',').map((x) => x.replace(/^"|"$/g, '')));
          rows = rows.filter((r) => set.has(String(r[key])));
        } else if (one.startsWith('not.in.(')) {
          const set = new Set(one.slice(8, -1).split(',').map((x) => x.replace(/^"|"$/g, '')));
          rows = rows.filter((r) => !set.has(String(r[key])));
        } else if (one === 'is.null') rows = rows.filter((r) => r[key] === null || r[key] === undefined);
        else if (one === 'not.is.null') rows = rows.filter((r) => r[key] !== null && r[key] !== undefined);
      }
    }
    const order = url.searchParams.get('order');
    if (order) {
      const col = order.split(',')[0].split('.')[0];
      rows.sort((a, b) => (String(a[col]) < String(b[col]) ? 1 : String(a[col]) > String(b[col]) ? -1 : 0));
    }
    const limit = url.searchParams.get('limit');
    if (limit) rows = rows.slice(0, Number(limit));
    return json(200, rows);
  };
  const client = createClient('https://placeholder.supabase.co', 'service-role-placeholder', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetch as typeof globalThis.fetch }
  }) as unknown as SupabaseClient;
  return { tables, rpcs, requests, client };
};

const dbRow = (id: string, over: Row = {}): Row => ({
  id,
  project_id: P,
  user_id: U,
  kind: 'edits',
  actor: 'you',
  label: 'You edited page 2',
  name: null,
  note: null,
  pinned: false,
  keep_until: null,
  rev: 3,
  content_at: '2026-10-30T07:00:00.123456+00:00',
  created_at: '2026-10-30T07:00:01.5+00:00',
  parent_id: null,
  undo_id: null,
  alternative_id: null,
  model_id: null,
  published_rev: null,
  codec: 'v5',
  changes: [],
  thumbs: [],
  stats: {},
  legacy_ref: null,
  root_hash: 'a'.repeat(32),
  ...over
});

const storeOn = (db: ReturnType<typeof makeDb>): HistoryStore => createSupabaseHistoryStore({ admin: () => db.client });

const versionOf = (book: ReturnType<typeof chunkBook>, over: Partial<VersionInput> = {}): VersionInput => ({
  kind: 'edits',
  actor: 'you',
  label: 'You edited page 2',
  rev: 3,
  contentAt: Date.UTC(2026, 9, 30, 7),
  manifest: book.manifest,
  rootHash: book.rootHash,
  chunks: book.hashes,
  ...over
});

afterEach(() => vi.restoreAllMocks());

describe('scoping', () => {
  /** Every method, once, with ids that exist. */
  const exercise = async (store: HistoryStore, book: ReturnType<typeof chunkBook>) => {
    await store.missing(ME, book.hashes);
    await store.put(ME, versionOf(book), book.chunks);
    await store.head(ME);
    await store.head(ME, null);
    await store.list(ME, { pageId: 'pg_1', kinds: ['edits'], actor: 'you' });
    await store.get(ME, V1);
    await store.chunks(ME, book.hashes);
    await store.label(ME, V1, { name: 'Draft 1' });
    await store.delete(ME, V1);
    await store.forgetPath(ME, 'u/a/p/b/ref/face.webp');
    await store.alternatives(ME);
    await store.createAlternative(ME, { name: 'New ending', headVersionId: V1 });
    await store.updateAlternative(ME, ALT, { active: true });
    await store.removeAlternative(ME, ALT);
    await store.setHead(ME, ALT, V1);
  };

  const ready = () => {
    const db = makeDb();
    const book = chunkBook(historyV5Doc());
    db.tables.comic_versions.push(dbRow(V1, { manifest: book.manifest }));
    db.tables.comic_version_chunks.push(...book.chunks.map((c) => ({ project_id: P, user_id: U, hash: c.hash, content: c.content, paths: c.paths })));
    db.tables.comic_alternatives.push({ id: ALT, project_id: P, user_id: U, name: 'New ending', is_active: true, created_at: '2026-10-30T07:00:00+00:00', updated_at: '2026-10-30T07:00:00+00:00' });
    const ok = (body: unknown) => () => ({ status: 200, body });
    Object.assign(db.rpcs, {
      comic_history_put: ok({ id: V2, deduped: false, thinned: 0, budgetThinned: 0, gcChunks: 0, bytesNew: 1 }),
      comic_history_label: ok(dbRow(V1, { name: 'Draft 1', pinned: true })),
      comic_history_delete: ok(true),
      comic_history_forget_path: ok(2),
      comic_history_alternative_create: ok({ id: ALT, name: 'New ending', is_active: false, head_version_id: V1, created_at: '2026-10-30T07:00:00+00:00', updated_at: '2026-10-30T07:00:00+00:00' }),
      comic_history_alternative_update: ok({ id: ALT, name: 'New ending', is_active: true, created_at: '2026-10-30T07:00:00+00:00', updated_at: '2026-10-30T07:00:00+00:00' }),
      comic_history_alternative_remove: ok(true),
      comic_history_set_head: ok(true)
    });
    return { db, book };
  };

  it('filters every table read by project_id AND user_id, and every RPC carries p_project AND p_user', async () => {
    const { db, book } = ready();
    await exercise(storeOn(db), book);
    const tablesRead = new Set<string>();
    const rpcsCalled = new Set<string>();
    expect(db.requests.length).toBeGreaterThanOrEqual(15);
    for (const r of db.requests) {
      if (r.path.startsWith('rpc/')) {
        rpcsCalled.add(r.path);
        expect(r.body, r.path).toMatchObject({ p_project: P, p_user: U });
      } else {
        tablesRead.add(r.path);
        expect(r.method, r.path).toBe('GET'); // the service role only reads tables; writes are RPCs
        expect(r.params.get('project_id'), `${r.path}?${r.params}`).toBe(`eq.${P}`);
        expect(r.params.get('user_id'), `${r.path}?${r.params}`).toBe(`eq.${U}`);
      }
    }
    expect([...tablesRead].sort()).toEqual(['comic_alternatives', 'comic_version_chunks', 'comic_versions']);
    expect(rpcsCalled.size).toBe(8);
  });

  it('a non-uuid scope or id makes no request at all and answers like a missing comic', async () => {
    const { db, book } = ready();
    const store = storeOn(db);
    const bad: HistoryScope = { projectId: 'proj-1', userId: U };
    expect(await store.missing(bad, book.hashes)).toEqual(book.hashes);
    await expect(store.put(bad, versionOf(book), book.chunks)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(await store.head(bad)).toBeNull();
    expect(await store.list(bad)).toEqual({ rows: [] });
    expect(await store.get(bad, V1)).toBeNull();
    expect((await store.chunks(bad, book.hashes)).size).toBe(0);
    expect(await store.label(bad, V1, { name: 'x' })).toBeNull();
    expect(await store.delete(bad, V1)).toBe(false);
    expect(await store.forgetPath(bad, 'a/b')).toBe(0);
    expect(await store.alternatives(bad)).toEqual([]);
    await expect(store.createAlternative(bad, { name: 'x', headVersionId: V1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await store.updateAlternative(bad, ALT, { name: 'x' })).toBeNull();
    expect(await store.removeAlternative(bad, ALT)).toBe(false);
    await expect(store.setHead(bad, null, V1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // A uuid scope with a non-uuid version id: the same.
    expect(await store.get(ME, 'pg_1')).toBeNull();
    expect(await store.label(ME, "1' or '1'='1", { name: 'x' })).toBeNull();
    expect(await store.delete(ME, '')).toBe(false);
    expect(db.requests).toEqual([]);
  });
});

describe('put', () => {
  it('sends what the RPC reads: trimmed and capped, the manifest’s hashes, only the given chunks, the policy', async () => {
    const db = makeDb();
    let seen: Record<string, unknown> = {};
    db.rpcs.comic_history_put = (body) => {
      seen = body;
      return { status: 200, body: { id: V2, deduped: false, thinned: 2, budgetThinned: 1, gcChunks: 3, bytesNew: 10 } };
    };
    const book = chunkBook(historyV5Doc());
    const changes = Array.from({ length: 75 }, (_, i) => ({ what: 'dialogue' as const, by: 'you' as const, pageIds: [`pg_${i}`] }));
    const res = await storeOn(db).put(
      ME,
      versionOf(book, { label: 'x'.repeat(400), name: '   Draft 1  ', note: '  ', chunks: [], changes, thumbs: Array.from({ length: 12 }, (_, i) => ({ key: `page:${i}`, path: `u/a/p/b/img/${i}.webp` })), parentId: 'not-a-uuid', undoId: V1 }),
      [...book.chunks.slice(0, 3), book.chunks[0]],
      { unpinnedRows: 5 }
    );
    expect(res).toEqual({ id: V2, deduped: false, thinned: 2, budgetThinned: 1, gcChunks: 3, bytesNew: 10 });
    const v = seen.p_version as Record<string, unknown>;
    expect(v).toMatchObject({ kind: 'edits', actor: 'you', name: 'Draft 1', rev: 3, rootHash: book.rootHash, undoId: V1, codec: 'v5' });
    expect(v.label).toHaveLength(HISTORY_LIMITS.labelChars);
    expect('note' in v).toBe(false);
    expect('parentId' in v).toBe(false); // never a non-uuid
    expect(v.chunks).toEqual(manifestHashes(book.manifest)); // the manifest's hashes even when the caller forgot them
    expect(v.changes).toHaveLength(HISTORY_LIMITS.changesPerRow);
    expect(v.thumbs).toHaveLength(HISTORY_LIMITS.thumbsPerRow);
    expect(v.manifest).toEqual(book.manifest);
    expect(seen.p_chunks).toEqual(book.chunks.slice(0, 3).map(({ hash, kind, content, paths }) => ({ hash, kind, content, paths })));
    expect(seen.p_policy).toEqual({
      unpinnedRows: 5,
      bytesPerComic: HISTORY_LIMITS.bytesPerComic,
      namedRows: HISTORY_LIMITS.namedRows,
      savesPerHour: HISTORY_LIMITS.savesPerHour,
      beforeRestoreDays: HISTORY_LIMITS.beforeRestoreDays
    });
  });

  it('sends createdAt only for a classic snapshot, and maps "already saved under a name"', async () => {
    const db = makeDb();
    const seen: Record<string, unknown>[] = [];
    db.rpcs.comic_history_put = (body) => {
      seen.push(body.p_version as Record<string, unknown>);
      return { status: 200, body: { id: V1, deduped: true, thinned: 0, budgetThinned: 0, gcChunks: 0, bytesNew: 0, alreadyNamed: true, name: 'Draft 1' } };
    };
    const book = chunkBook(historyV5Doc());
    const store = storeOn(db);
    const at = Date.UTC(2026, 0, 2, 3, 4, 5);
    const res = await store.put(ME, { ...versionOf(book, { kind: 'named', name: 'Draft 2' }), createdAt: at } as VersionInput, []);
    expect(res).toEqual({ id: V1, deduped: true, thinned: 0, budgetThinned: 0, gcChunks: 0, bytesNew: 0, alreadyNamed: true, name: 'Draft 1' });
    await store.put(ME, { ...versionOf(book, { kind: 'legacy', codec: 'legacy', legacyRef: { snapshotId: 's1' } }), createdAt: at } as VersionInput, []);
    await store.put(ME, { ...versionOf(book, { kind: 'legacy', codec: 'legacy' }), createdAt: 1e300 } as VersionInput, []);
    expect('createdAt' in seen[0]).toBe(false); // a v5 row is stamped by the database
    expect(seen[1].createdAt).toBe(at);
    expect('createdAt' in seen[2]).toBe(false); // no time at all
  });

  it('refuses malformed input before any request', async () => {
    const db = makeDb();
    const store = storeOn(db);
    const book = chunkBook(historyV5Doc());
    await expect(store.put(ME, versionOf(book, { rootHash: 'nope' }), [])).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(store.put(ME, versionOf(book, { kind: 'whatever' as VersionInput['kind'] }), [])).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(store.put(ME, versionOf(book), [{ hash: 'zz', kind: 'page', content: '{}', paths: [] }])).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const huge = 'x'.repeat(1_048_577);
    await expect(store.put(ME, versionOf(book), [{ hash: 'a'.repeat(32), kind: 'page', content: huge, paths: [] }])).rejects.toMatchObject({ code: 'LIMIT' });
    await expect(store.put(ME, versionOf(book, { alternativeId: 'line-1' }), [])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.requests).toEqual([]);
  });
});

describe('get', () => {
  const stored = () => {
    const db = makeDb();
    const doc = historyV5Doc();
    const book = chunkBook(doc);
    db.tables.comic_versions.push(dbRow(V1, { manifest: JSON.parse(JSON.stringify(book.manifest)), kind: 'named', name: 'Draft 1', pinned: true }));
    db.tables.comic_version_chunks.push(...book.chunks.map((c) => ({ project_id: P, user_id: U, hash: c.hash, content: c.content, paths: c.paths })));
    return { db, doc, book };
  };

  it('loads, verifies and reassembles a version (with each chunk’s paths)', async () => {
    const { db, doc, book } = stored();
    const got = (await storeOn(db).get(ME, V1)) as StoredVersionWithPaths;
    expect(got.row).toMatchObject({ id: V1, kind: 'named', name: 'Draft 1', pinned: true, rootHash: 'a'.repeat(32) });
    expect(got.bodies.size).toBe(book.hashes.length);
    expect(assembleBook(got.manifest, got.bodies, excludedOf(doc))).toEqual(stripVolatile(normalizeDoc(doc)));
    expect(got.paths.get(book.chunks[0].hash)).toEqual(book.chunks[0].paths);
    // More hashes than one request carries are fetched in batches, all scoped.
    const chunkReqs = db.requests.filter((r) => r.path === 'comic_version_chunks');
    expect(chunkReqs.length).toBe(Math.ceil(book.hashes.length / 120));
  });

  it('refuses a version whose chunk content was altered, and logs it; chunks() leaves that chunk out', async () => {
    const { db, book } = stored();
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const victim = db.tables.comic_version_chunks[0];
    victim.content = `${victim.content as string} `;
    const store = storeOn(db);
    expect(await store.get(ME, V1)).toBeNull();
    expect(error).toHaveBeenCalledWith('comic_history_chunk_corrupt', expect.objectContaining({ projectId: P, hash: victim.hash }));
    const bodies = await store.chunks(ME, book.hashes);
    expect(bodies.has(victim.hash as string)).toBe(false);
    expect(bodies.size).toBe(book.hashes.length - 1);
  });

  it('opens a classic-editor row (codec legacy) from its chunks column: its manifest is not v5-shaped', async () => {
    const db = makeDb();
    const parts = [JSON.stringify({ pages: [{ id: 'p1' }] }), JSON.stringify('A classic title')];
    const hashes = parts.map((c) => historyHash(c));
    const manifest = { state: { pages: hashes[0], title: hashes[1] } } as unknown as Manifest;
    db.tables.comic_versions.push(dbRow(V1, { kind: 'legacy', codec: 'legacy', manifest, chunks: hashes, legacy_ref: { snapshotId: 's1' } }));
    db.tables.comic_version_chunks.push(...parts.map((content, i) => ({ project_id: P, user_id: U, hash: hashes[i], content, paths: [] })));
    const got = await storeOn(db).get(ME, V1);
    expect(got?.row).toMatchObject({ kind: 'legacy', codec: 'legacy', legacy: { snapshotId: 's1' } });
    expect(got?.manifest).toEqual(manifest);
    expect(got?.bodies.get(hashes[0])).toEqual({ pages: [{ id: 'p1' }] });
    expect(got?.bodies.get(hashes[1])).toBe('A classic title');
    expect(db.requests.find((r) => r.path === 'comic_versions')!.params.get('select')).toMatch(/,manifest,chunks$/);
    // A missing classic chunk still makes it unopenable.
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    db.tables.comic_version_chunks.pop();
    expect(await storeOn(db).get(ME, V1)).toBeNull();
  });

  it('is null for a missing chunk, a missing row, or a row without a manifest', async () => {
    const { db } = stored();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    db.tables.comic_version_chunks.pop();
    expect(await storeOn(db).get(ME, V1)).toBeNull();
    expect(await storeOn(db).get(ME, V2)).toBeNull();
  });
});

describe('lists and heads', () => {
  it('page newest first by an opaque (content_at, id) cursor, quoted for PostgREST; filters are scoped and safe', async () => {
    const db = makeDb();
    db.tables.comic_versions.push(
      dbRow(V3, { content_at: '2026-10-30T07:00:03.000003+00:00' }),
      dbRow(V2, { content_at: '2026-10-30T07:00:02.000002+00:00' }),
      dbRow(V1, { content_at: '2026-10-30T07:00:01.000001+00:00' })
    );
    const store = storeOn(db);
    const versionsReqs = () => db.requests.filter((r) => r.path === 'comic_versions');
    const first = await store.list(ME, { limit: 2, alternativeId: null, pageId: 'pg_"1"', kinds: ['edits', 'ai'], actor: 'you' });
    expect(first.rows.map((r) => r.id)).toEqual([V3, V2]);
    expect(decodeHistoryCursor(first.next)).toEqual({ contentAt: '2026-10-30T07:00:02.000002+00:00', id: V2 });
    expect(versionsReqs()).toHaveLength(1); // no removed line: one query
    const q = versionsReqs()[0].params;
    expect(q.get('alternative_id')).toBe('is.null');
    expect(q.get('changes')).toBe(`cs.${JSON.stringify([{ pageIds: ['pg_"1"'] }])}`);
    expect(q.get('kind')).toBe('in.(edits,ai)');
    expect(q.get('actor')).toBe('eq.you');
    expect(q.get('limit')).toBe('3');
    expect(q.get('order')).toBe('content_at.desc,id.desc');
    await store.list(ME, { limit: 2, alternativeId: null, cursor: first.next });
    expect(versionsReqs()[1].params.get('or')).toBe(
      `(content_at.lt."2026-10-30T07:00:02.000002+00:00",and(content_at.eq."2026-10-30T07:00:02.000002+00:00",id.lt.${V2}))`
    );
    // A forged cursor is ignored, never pasted into the filter.
    await store.list(ME, { alternativeId: null, cursor: encodeHistoryCursor('2026-10-30T07:00:00Z),id.gt.(0', V1) });
    expect(versionsReqs()[2].params.get('or')).toBeNull();
    expect(decodeHistoryCursor('not base64 json')).toBeNull();
    // Unknown kinds / actors match nothing (and make no request).
    const before = db.requests.length;
    expect(await store.list(ME, { alternativeId: null, kinds: ['nope' as never] })).toEqual({ rows: [] });
    expect(await store.list(ME, { alternativeId: null, actor: 'nobody' as never })).toEqual({ rows: [] });
    expect(db.requests.length).toBe(before);
  });

  it('head and list default to the line you are on (null is Original); head carries the manifest', async () => {
    const db = makeDb();
    const book = chunkBook(historyV5Doc());
    db.tables.comic_alternatives.push({ id: ALT, project_id: P, user_id: U, is_active: true });
    db.tables.comic_versions.push(dbRow(V2, { alternative_id: ALT, manifest: book.manifest }), dbRow(V1, { manifest: book.manifest }));
    const store = storeOn(db);
    const head = await store.head(ME);
    expect(head?.id).toBe(V2);
    expect((head as { manifest?: unknown }).manifest).toEqual(book.manifest);
    expect(db.requests[0].path).toBe('comic_alternatives');
    expect(db.requests[1].params.get('alternative_id')).toBe(`eq.${ALT}`);
    expect((await store.head(ME, null))?.id).toBe(V1);
    expect((await store.list(ME)).rows.map((r) => r.id)).toEqual([V2]);
  });

  it('a removed line is not found; Original keeps its own head, and its list also carries the removed line’s rows in order', async () => {
    const db = makeDb();
    const book = chunkBook(historyV5Doc());
    const LIVE = '44444444-4444-4444-8444-444444444445';
    const at = (s: string) => `2026-10-30T07:00:${s}+00:00`;
    db.tables.comic_alternatives.push(
      { id: ALT, project_id: P, user_id: U, name: 'B', is_active: false, removed_at: '2026-10-30T08:00:00+00:00' },
      { id: LIVE, project_id: P, user_id: U, name: 'C', is_active: true, removed_at: null }
    );
    const V4 = '33333333-3333-4333-8333-333333333334';
    const V5 = '33333333-3333-4333-8333-333333333335';
    db.tables.comic_versions.push(
      dbRow(V1, { content_at: at('01'), created_at: at('01'), manifest: book.manifest }), // Original
      dbRow(V2, { content_at: at('02.000002'), created_at: at('05'), alternative_id: ALT, manifest: book.manifest }), // removed B, newer
      dbRow(V3, { content_at: at('02.000001'), created_at: at('06'), alternative_id: ALT, manifest: book.manifest }), // removed B, newest written
      dbRow(V4, { content_at: at('03'), created_at: at('07'), alternative_id: LIVE, manifest: book.manifest }), // C, live
      dbRow(V5, { content_at: at('02.5'), created_at: at('02'), manifest: book.manifest }) // Original
    );
    const store = storeOn(db);
    // head(null) reads only alternative_id is null: B's newer rows never become Original's head.
    expect((await store.head(ME, null))?.id).toBe(V5);
    // A removed line is not found for head and list (no versions query at all); the line list leaves it out.
    db.requests.length = 0;
    expect(await store.head(ME, ALT)).toBeNull();
    expect(await store.list(ME, { alternativeId: ALT })).toEqual({ rows: [] });
    expect(db.requests.map((r) => r.path)).toEqual(['comic_alternatives', 'comic_alternatives']);
    for (const r of db.requests) expect(r.params.get('removed_at')).toBe('is.null');
    expect((await store.alternatives(ME)).map((a) => a.id)).toEqual([LIVE]);
    expect(db.requests.at(-1)!.params.get('removed_at')).toBe('is.null');
    expect(db.requests.at(-1)!.params.get('select')).toContain('removed_at');
    expect((await store.head(ME, LIVE))?.id).toBe(V4);
    // Original's list = its own rows + the removed line's rows (alternativeId kept), merged by (content_at, id) desc
    // to the microsecond; a live line's rows never.
    db.requests.length = 0;
    const page1 = await store.list(ME, { alternativeId: null, limit: 2 });
    expect(page1.rows.map((r) => [r.id, r.alternativeId])).toEqual([[V5, null], [V2, ALT]]);
    const removedReq = db.requests.filter((r) => r.path === 'comic_versions')[1];
    expect(removedReq.params.getAll('alternative_id')).toEqual(['not.is.null', `not.in.(${LIVE})`]);
    expect(removedReq.params.get('project_id')).toBe(`eq.${P}`);
    expect(removedReq.params.get('user_id')).toBe(`eq.${U}`);
    expect(decodeHistoryCursor(page1.next)).toEqual({ contentAt: at('02.000002'), id: V2 });
  });
});

describe('rows and errors', () => {
  it('maps a database row to the wire row (microsecond timestamps, nulls dropped, legacy, stats defaults)', () => {
    const row = versionRowFromDb(
      dbRow(V1, {
        kind: 'legacy',
        codec: 'legacy',
        keep_until: '2026-11-29T07:00:00+00:00',
        legacy_ref: { snapshotId: 's1', snapshotHash: 'x', reason: 'Auto - Before Restore' },
        stats: { pages: 6, spend: { usd: 0.24, byok: true } },
        published_rev: 4,
        parent_id: V2
      })
    );
    expect(row).toEqual({
      id: V1,
      kind: 'legacy',
      actor: 'you',
      label: 'You edited page 2',
      pinned: false,
      rev: 3,
      contentAt: Date.UTC(2026, 9, 30, 7, 0, 0, 123),
      createdAt: Date.UTC(2026, 9, 30, 7, 0, 1, 500),
      alternativeId: null,
      codec: 'legacy',
      changes: [],
      thumbs: [],
      stats: { pages: 6, drawn: 0, lines: 0, langs: [], models: [], spend: { usd: 0.24, byok: true, estimated: false } },
      rootHash: 'a'.repeat(32),
      keepUntil: Date.UTC(2026, 10, 29, 7),
      parentId: V2,
      publishedRev: 4,
      legacy: { snapshotId: 's1', reason: 'Auto - Before Restore' }
    });
  });

  it('turns database refusals into honest StudioErrors', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const err = (code: string, message: string) => mapHistoryDbError({ code, message }, 'save a moment');
    expect(err('23503', 'COMIC_HISTORY_MISSING_CHUNKS: 1 chunk(s) not stored')).toMatchObject({ code: 'CONFLICT', status: 409, retryable: true });
    expect(err('42501', 'COMIC_HISTORY_FORBIDDEN')).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(err('P0002', 'COMIC_HISTORY_NOT_FOUND: line')).toMatchObject({ code: 'NOT_FOUND' });
    expect(err('54000', 'COMIC_HISTORY_LIMIT:named')).toMatchObject({ code: 'LIMIT', status: 409, userMessage: expect.stringMatching(/100 saved versions/) });
    expect(err('54000', 'COMIC_HISTORY_LIMIT:saves_per_hour')).toMatchObject({ code: 'LIMIT', status: 429, retryable: true });
    expect(err('55000', 'COMIC_HISTORY_REFUSED:newest')).toMatchObject({ code: 'CONFLICT', userMessage: "The latest moment can't be removed." });
    expect(err('55000', 'COMIC_HISTORY_REFUSED:classic')).toMatchObject({ code: 'CONFLICT', status: 409, userMessage: expect.stringMatching(/classic editor/) });
    expect(err('55000', 'COMIC_HISTORY_REFUSED:not_named')).toMatchObject({ userMessage: expect.stringMatching(/saved or named/) });
    expect(err('42883', 'function public.comic_history_put does not exist')).toMatchObject({ code: 'NOT_AVAILABLE', status: 503 });
    expect(err('PGRST205', 'Could not find the table')).toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(err('22000', 'comic_version_chunks: the hash does not match the content')).toMatchObject({ code: 'INTERNAL' });
    expect(err('08006', 'connection failure')).toMatchObject({ code: 'INTERNAL', status: 503, retryable: true });
    for (const e of [err('42501', 'COMIC_HISTORY_FORBIDDEN'), err('55000', 'COMIC_HISTORY_REFUSED:head'), err('55000', 'COMIC_HISTORY_REFUSED:classic')]) {
      expect(e.userMessage).not.toMatch(/\b(commit|branch|merge|diff|checkout|HEAD)\b/);
    }
  });

  it('a refusal from the RPC reaches the caller as that StudioError; a foreign comic reads as missing', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const db = makeDb();
    db.rpcs.comic_history_put = () => ({ status: 400, body: { code: '23503', message: 'COMIC_HISTORY_MISSING_CHUNKS: 2 chunk(s) not stored', details: null, hint: null } });
    db.rpcs.comic_history_label = () => ({ status: 403, body: { code: '42501', message: 'COMIC_HISTORY_FORBIDDEN', details: null, hint: null } });
    db.rpcs.comic_history_delete = () => ({ status: 400, body: { code: '55000', message: 'COMIC_HISTORY_REFUSED:newest', details: null, hint: null } });
    const store = storeOn(db);
    const book = chunkBook(historyV5Doc());
    const e = await store.put(ME, versionOf(book), book.chunks).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StudioError);
    expect(e).toMatchObject({ code: 'CONFLICT', retryable: true });
    expect(await store.label(ME, V1, { name: 'x' })).toBeNull();
    await expect(store.delete(ME, V1)).rejects.toMatchObject({ code: 'CONFLICT', userMessage: "The latest moment can't be removed." });
    // Not applied yet: honest NOT_AVAILABLE, nothing else.
    await expect(store.forgetPath(ME, 'a/b')).rejects.toMatchObject({ code: 'NOT_AVAILABLE', status: 503 });
  });
});
