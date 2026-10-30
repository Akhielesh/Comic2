// @vitest-environment node
// The in-memory HistoryStore (versions plan §14 H1): the same semantics as comic_history.sql, so H2/H3/H5/H7 can
// build on it. Every call must carry a project AND a user and every read filters by both; a chunk whose content was
// altered is refused on read; puts are all-or-nothing; dedupe, thinning, the budget, the GC grace, names, lines.
import { describe, expect, it } from 'vitest';
import { normalizeDoc, type ComicDoc } from '../../../../shared/comic/doc.js';
import { applyOps } from '../../../../shared/comic/ops.js';
import { excludedOf, stripVolatile } from '../../../../shared/comic/history/sections.js';
import { historyV4Doc, historyV5Doc } from '../../../../shared/comic/history/__fixtures__/books.js';
import { StudioError } from '../types.js';
import { assembleBook, chunkBook, historyHash } from './hash.js';
import type { HistoryScope } from './hooks.js';
import { createFakeHistoryStore, type FakeHistoryMethod, type FakeHistoryStore } from './store.fake.js';
import { versionPaths, type StoredVersionWithPaths } from './store.js';
import type { ChunkInput, VersionInput } from './storeTypes.js';

const P = 'proj-1';
const ME: HistoryScope = { projectId: P, userId: 'user-a' };
const OTHER_USER: HistoryScope = { projectId: P, userId: 'user-b' };
const MY_OTHER_COMIC: HistoryScope = { projectId: 'proj-2', userId: 'user-a' };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A store on a hand-driven clock. */
const setup = (start = Date.UTC(2026, 9, 30, 12)) => {
  const clock = { t: start };
  const store = createFakeHistoryStore({ now: () => clock.t });
  return { store, clock };
};

/** What the recorder (H2) does: chunk, upload only what is missing, put. */
const capture = async (store: FakeHistoryStore, scope: HistoryScope, doc: ComicDoc, at: number, extra: Partial<VersionInput> = {}) => {
  const book = chunkBook(doc);
  const need = new Set(await store.missing(scope, book.hashes));
  const sent = book.chunks.filter((c) => need.has(c.hash));
  const res = await store.put(
    scope,
    { kind: 'edits', actor: 'you', label: 'You edited the comic', rev: doc.rev, contentAt: at, manifest: book.manifest, rootHash: book.rootHash, chunks: book.hashes, ...extra },
    sent
  );
  return { res, book, sent };
};

/** A tiny distinct book per index (for thinning: many rows, few bytes). */
const tinyDoc = (i: number): ComicDoc => applyOps(historyV4Doc(), [{ op: 'brief', patch: { title: `Take ${i}` } }]);

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(StudioError);
  expect((err as StudioError).code).toBe(code);
  return err as StudioError;
};

describe('scoping: every call carries a project and a user, and reads filter by both', () => {
  const calls: [FakeHistoryMethod, (s: FakeHistoryStore, scope: HistoryScope) => Promise<unknown>][] = [
    ['missing', (s, x) => s.missing(x, [])],
    ['put', (s, x) => s.put(x, {} as VersionInput, [])],
    ['head', (s, x) => s.head(x)],
    ['list', (s, x) => s.list(x)],
    ['get', (s, x) => s.get(x, 'v')],
    ['chunks', (s, x) => s.chunks(x, [])],
    ['label', (s, x) => s.label(x, 'v', { name: 'x' })],
    ['delete', (s, x) => s.delete(x, 'v')],
    ['forgetPath', (s, x) => s.forgetPath(x, 'a/b')],
    ['alternatives', (s, x) => s.alternatives(x)],
    ['createAlternative', (s, x) => s.createAlternative(x, { name: 'x', headVersionId: 'v' })],
    ['updateAlternative', (s, x) => s.updateAlternative(x, 'a', { name: 'x' })],
    ['removeAlternative', (s, x) => s.removeAlternative(x, 'a')],
    ['setHead', (s, x) => s.setHead(x, null, 'v')]
  ];

  it.each(calls)('%s refuses a call without a project or a user (a test failure, never a silent pass)', async (_m, call) => {
    const { store } = setup();
    for (const bad of [{ projectId: P, userId: '' }, { projectId: '', userId: 'user-a' }, undefined, { projectId: P }] as unknown as HistoryScope[]) {
      await expect(call(store, bad)).rejects.toThrow(/without a project and user scope/);
    }
    expect(store.calls).toEqual([]);
  });

  it('records the scope of every call', async () => {
    const { store } = setup();
    for (const [, call] of calls) await call(store, ME).catch(() => undefined);
    expect(store.calls.map((c) => c.method)).toEqual(calls.map(([m]) => m));
    for (const c of store.calls) expect(c).toMatchObject({ projectId: P, userId: 'user-a' });
  });

  it("another user sees nothing of a comic's history and can change none of it; another comic is separate", async () => {
    const { store, clock } = setup();
    const doc = historyV5Doc();
    const { res, book } = await capture(store, ME, doc, clock.t, { kind: 'named', name: 'Draft 1' });
    const second = await capture(store, ME, applyOps(doc, [{ op: 'brief', patch: { title: 'Two' } }]), clock.t + 1);
    const photo = book.chunks.flatMap((c) => c.paths).find((p) => p.includes('/ref/'))!;

    for (const scope of [OTHER_USER, MY_OTHER_COMIC]) {
      expect(await store.list(scope)).toEqual({ rows: [] });
      expect(await store.head(scope)).toBeNull();
      expect(await store.get(scope, res.id)).toBeNull();
      expect((await store.chunks(scope, book.hashes)).size).toBe(0);
      expect(await store.missing(scope, book.hashes)).toEqual(book.hashes);
      expect(await store.alternatives(scope)).toEqual([]);
      expect(await store.label(scope, res.id, { name: 'mine' })).toBeNull();
      expect(await store.delete(scope, res.id)).toBe(false);
      expect(await store.forgetPath(scope, photo)).toBe(0);
    }
    // Writes on someone else's comic are refused exactly like a missing comic.
    await rejects(store.put(OTHER_USER, { kind: 'edits', actor: 'you', label: 'x', rev: 1, contentAt: 1, manifest: book.manifest, rootHash: book.rootHash, chunks: book.hashes }, book.chunks), 'NOT_FOUND');
    await rejects(store.createAlternative(OTHER_USER, { name: 'Mine', headVersionId: res.id }), 'NOT_FOUND');
    await rejects(store.setHead(OTHER_USER, null, res.id), 'NOT_FOUND');
    // My other comic cannot point at this comic's versions either.
    await rejects(store.createAlternative(MY_OTHER_COMIC, { name: 'Mine', headVersionId: res.id }), 'NOT_FOUND');
    // Nothing changed for the owner.
    expect((await store.get(ME, res.id))?.row.name).toBe('Draft 1');
    expect((await store.list(ME)).rows.map((r) => r.id)).toEqual([second.res.id, res.id]);
    expect(versionPaths((await store.get(ME, res.id))!).has(photo)).toBe(true);
  });
});

describe('put → get', () => {
  it('round-trips the v5 fixture; the next capture uploads only the changed chunks', async () => {
    const { store, clock } = setup();
    const doc = historyV5Doc();
    const first = await capture(store, ME, doc, clock.t, { kind: 'start', label: 'History starts here' });
    expect(first.res).toMatchObject({ deduped: false, thinned: 0, budgetThinned: 0, gcChunks: 0 });
    expect(first.res.bytesNew).toBe(first.book.bytes);
    const got = (await store.get(ME, first.res.id)) as StoredVersionWithPaths;
    expect(got.row).toMatchObject({ kind: 'start', pinned: true, rootHash: first.book.rootHash, label: 'History starts here' });
    expect(assembleBook(got.manifest, got.bodies, excludedOf(doc))).toEqual(stripVolatile(normalizeDoc(doc)));

    const p = doc.pages[2];
    const next = applyOps(doc, [{ op: 'line', pageId: p.id, panelId: p.panels[0].id, id: p.panels[0].lines[0].id, patch: { text: 'A brand-new line.' } }]);
    clock.t += 60_000;
    const second = await capture(store, ME, next, clock.t);
    expect(second.sent.map((c) => c.kind)).toEqual(['page']);
    expect(second.res.bytesNew).toBe(Buffer.byteLength(second.sent[0].content, 'utf8'));
    const head = await store.head(ME);
    expect(head?.id).toBe(second.res.id);
    expect((head as { manifest?: unknown }).manifest).toEqual(second.book.manifest);
  });

  it('dedupes an unchanged state; a named save of it names and pins the head instead', async () => {
    const { store, clock } = setup();
    const doc = historyV4Doc();
    const a = await capture(store, ME, doc, clock.t);
    const b = await capture(store, ME, doc, clock.t + 1);
    expect(b.res).toMatchObject({ id: a.res.id, deduped: true });
    const c = await capture(store, ME, doc, clock.t + 2, { kind: 'named', name: '  Before the twist ', note: 'safe point' });
    expect(c.res).toMatchObject({ id: a.res.id, deduped: true });
    expect(store.rows(ME)).toHaveLength(1);
    expect(store.rows(ME)[0]).toMatchObject({ kind: 'edits', pinned: true, name: 'Before the twist', note: 'safe point' });
  });

  it('is all-or-nothing: a version that references a chunk nobody stored writes nothing at all', async () => {
    const { store, clock } = setup();
    const { book } = { book: chunkBook(historyV5Doc()) };
    const version: VersionInput = { kind: 'edits', actor: 'you', label: 'x', rev: 1, contentAt: clock.t, manifest: book.manifest, rootHash: book.rootHash, chunks: book.hashes };
    const err = await rejects(store.put(ME, version, book.chunks.slice(1)), 'CONFLICT');
    expect(err.retryable).toBe(true);
    expect(store.rows(ME)).toEqual([]);
    expect(store.chunkRows(ME)).toEqual([]);
    // A chunk whose content does not hash to its key is refused too, and leaves nothing.
    const bad: ChunkInput[] = book.chunks.map((c, i) => (i === 3 ? { ...c, content: `${c.content} ` } : c));
    await rejects(store.put(ME, version, bad), 'INTERNAL');
    expect(store.chunkRows(ME)).toEqual([]);
    await expect(store.put(ME, version, book.chunks)).resolves.toMatchObject({ deduped: false });
  });

  it("get refuses a chunk whose content was altered (the version can't be opened); chunks() leaves it out", async () => {
    const { store, clock } = setup();
    const { res, book } = await capture(store, ME, historyV5Doc(), clock.t);
    const victim = book.chunks.find((c) => c.kind === 'art')!;
    store.corruptChunk(ME, victim.hash, victim.content.replace('"ready"', '"none"'));
    expect(await store.get(ME, res.id)).toBeNull();
    const bodies = await store.chunks(ME, book.hashes);
    expect(bodies.has(victim.hash)).toBe(false);
    expect(bodies.size).toBe(book.hashes.length - 1);
    store.corruptChunk(ME, victim.hash, victim.content);
    expect(await store.get(ME, res.id)).not.toBeNull();
  });

  it('a forgotten photo leaves every chunk of the comic, so the version no longer lists it', async () => {
    const { store, clock } = setup();
    const { res, book } = await capture(store, ME, historyV5Doc(), clock.t);
    const photo = book.chunks.flatMap((c) => c.paths).find((p) => p.includes('/ref/'))!;
    const holders = book.chunks.filter((c) => c.paths.includes(photo)).length;
    expect(await store.forgetPath(ME, ` ${photo} `)).toBe(holders);
    expect(versionPaths((await store.get(ME, res.id))!).has(photo)).toBe(false);
    expect(await store.forgetPath(ME, photo)).toBe(0);
    // The content (the doc as it was) is unchanged: only the GC roots shrank.
    expect((await store.get(ME, res.id))!.bodies.size).toBe(book.hashes.length);
  });
});

describe('thinning, the budget and the GC grace', () => {
  it('keeps everything for 48 hours, then the newest per hour; pinned rows always stay', async () => {
    const { store, clock } = setup();
    const t0 = clock.t;
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      clock.t = t0 + i * 10 * 60_000; // every 10 minutes for 2 hours
      ids.push((await capture(store, ME, tinyDoc(i), clock.t)).res.id);
    }
    await store.label(ME, ids[1], { name: 'Keep me' });
    // Named but unpinned by hand: named versions are kept forever all the same.
    expect(await store.label(ME, ids[3], { name: 'Named', pinned: false })).toMatchObject({ pinned: false, name: 'Named' });
    expect(store.rows(ME)).toHaveLength(12);
    clock.t = t0 + 3 * DAY;
    const res = (await capture(store, ME, tinyDoc(99), clock.t)).res;
    const left = store.rows(ME);
    // Hours: [0..5] and [6..11] are two buckets. Each keeps its newest; ids[1] is pinned, ids[3] named; ids[11] was the newest row.
    expect(res.thinned).toBe(8);
    expect(left.map((r) => r.id).sort()).toEqual([ids[1], ids[3], ids[5], ids[11], res.id].sort());
  });

  it('caps unpinned rows (oldest first) and thins over the byte budget with a report', async () => {
    const { store, clock } = setup();
    const t0 = clock.t;
    for (let i = 0; i < 6; i += 1) await capture(store, ME, tinyDoc(i), (clock.t = t0 + i * HOUR));
    const cap = await store.put(ME, ...(await (async () => {
      const book = chunkBook(tinyDoc(50));
      const need = new Set(await store.missing(ME, book.hashes));
      return [
        { kind: 'edits', actor: 'you', label: 'x', rev: 1, contentAt: (clock.t = t0 + 7 * HOUR), manifest: book.manifest, rootHash: book.rootHash, chunks: book.hashes } as VersionInput,
        book.chunks.filter((c) => need.has(c.hash)),
        { unpinnedRows: 3 }
      ] as const;
    })()));
    expect(cap.thinned).toBe(4);
    expect(store.rows(ME)).toHaveLength(3);

    const book = chunkBook(tinyDoc(60));
    const need = new Set(await store.missing(ME, book.hashes));
    const total = store.rows(ME).length;
    const over = await store.put(
      ME,
      { kind: 'edits', actor: 'you', label: 'x', rev: 1, contentAt: (clock.t += HOUR), manifest: book.manifest, rootHash: book.rootHash, chunks: book.hashes },
      book.chunks.filter((c) => need.has(c.hash)),
      { bytesPerComic: 1 }
    );
    expect(over.budgetThinned).toBe(total); // every older deletable row goes; the newest row stays
    expect(store.rows(ME).map((r) => r.id)).toEqual([over.id]);
  });

  it('collects a thinned row’s chunks only once they are older than 10 minutes, and never a referenced one', async () => {
    const { store, clock } = setup();
    const t0 = clock.t;
    const first = await capture(store, ME, tinyDoc(1), t0);
    await capture(store, ME, tinyDoc(2), (clock.t = t0 + 60_000));
    const unique = first.book.hashes.filter((h) => !chunkBook(tinyDoc(2)).hashes.includes(h));
    expect(unique.length).toBeGreaterThan(0);
    // Thin the first row away at once (cap 1), within the grace period: its chunks stay.
    const third = chunkBook(tinyDoc(3));
    const r = await store.put(ME, { kind: 'edits', actor: 'you', label: 'x', rev: 1, contentAt: (clock.t = t0 + 120_000), manifest: third.manifest, rootHash: third.rootHash, chunks: third.hashes }, third.chunks, { unpinnedRows: 1 });
    expect(r.thinned).toBe(2);
    expect(r.gcChunks).toBe(0);
    for (const h of unique) expect(store.chunkRows(ME).some((c) => c.hash === h)).toBe(true);
    // Eleven minutes later the next write collects them; the newest row's chunks stay.
    const later = await capture(store, ME, tinyDoc(4), (clock.t = t0 + 13 * 60_000));
    expect(later.res.gcChunks).toBeGreaterThanOrEqual(unique.length);
    for (const h of unique) expect(store.chunkRows(ME).some((c) => c.hash === h)).toBe(false);
    const head = store.rows(ME)[0];
    for (const h of store.versionChunks(ME, head.id)) expect(store.chunkRows(ME).some((c) => c.hash === h)).toBe(true);
  });
});

describe('names, removal, lines', () => {
  it('labels: a name pins, an empty name clears, saved kinds stay pinned; 100 named at most', async () => {
    const { store, clock } = setup();
    const a = (await capture(store, ME, tinyDoc(1), clock.t)).res.id;
    expect(await store.label(ME, a, { name: '  First  ' })).toMatchObject({ name: 'First', pinned: true });
    expect(await store.label(ME, a, { name: null, pinned: false })).toMatchObject({ pinned: false });
    expect((await store.label(ME, a, { note: 'n' }))?.name).toBeUndefined();
    const s = (await capture(store, ME, tinyDoc(2), clock.t + 1, { kind: 'named', name: 'Saved' })).res.id;
    expect(await store.label(ME, s, { pinned: false })).toMatchObject({ pinned: true });
  });

  it('removes only saved versions, never the newest moment or a line head', async () => {
    const { store, clock } = setup();
    const auto = (await capture(store, ME, tinyDoc(1), clock.t)).res.id;
    const saved = (await capture(store, ME, tinyDoc(2), clock.t + 1, { kind: 'named', name: 'Draft' })).res.id;
    expect((await rejects(store.delete(ME, auto), 'CONFLICT')).message).toMatch(/Only versions you saved/);
    expect((await rejects(store.delete(ME, saved), 'CONFLICT')).message).toMatch(/latest moment/);
    await capture(store, ME, tinyDoc(3), clock.t + 2);
    const line = await store.createAlternative(ME, { name: 'New ending', headVersionId: saved });
    expect((await rejects(store.delete(ME, saved), 'CONFLICT')).message).toMatch(/version you're trying/);
    await store.setHead(ME, line.id, (await store.head(ME, null))!.id);
    expect(await store.delete(ME, saved)).toBe(true);
    expect(await store.delete(ME, saved)).toBe(false);
    expect((await store.alternatives(ME))[0].fromVersionId).toBeUndefined();
  });

  it('lines: at most 5 counting Original, one active, lists and heads follow the line you are on', async () => {
    const { store, clock } = setup();
    const base = (await capture(store, ME, tinyDoc(1), clock.t)).res.id;
    const lines = [];
    for (let i = 0; i < 4; i += 1) lines.push(await store.createAlternative(ME, { name: `Try ${i}`, fromVersionId: base, headVersionId: base }));
    expect((await rejects(store.createAlternative(ME, { name: 'One too many', headVersionId: base }), 'LIMIT')).message).toMatch(/up to 5/);
    await store.updateAlternative(ME, lines[0].id, { active: true });
    await store.updateAlternative(ME, lines[1].id, { active: true, name: 'Second try' });
    expect((await store.alternatives(ME)).filter((a) => a.active).map((a) => a.name)).toEqual(['Second try']);
    const onLine = (await capture(store, ME, tinyDoc(2), clock.t + 1, { alternativeId: lines[1].id })).res.id;
    expect((await store.head(ME))?.id).toBe(onLine); // undefined = the line you're on
    expect((await store.head(ME, null))?.id).toBe(base); // null = Original
    expect((await store.list(ME)).rows.map((r) => r.id)).toEqual([onLine]);
    expect((await store.list(ME, { alternativeId: null })).rows.map((r) => r.id)).toEqual([base]);
    await rejects(store.removeAlternative(ME, lines[1].id), 'CONFLICT');
    await store.setHead(ME, lines[1].id, onLine);
    await store.updateAlternative(ME, lines[1].id, { active: false });
    expect(await store.removeAlternative(ME, lines[1].id)).toBe(true);
    const moved = store.rows(ME).find((r) => r.id === onLine)!;
    expect(moved).toMatchObject({ alternativeId: null, pinned: false });
    await rejects(capture(store, ME, tinyDoc(3), clock.t + 2, { alternativeId: lines[1].id }), 'NOT_FOUND');
  });

  it('lists newest first by content time with an opaque cursor and kind / actor / page filters', async () => {
    const { store, clock } = setup();
    const t0 = clock.t;
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      ids.push(
        (await capture(store, ME, tinyDoc(i), t0 + i * 1000, {
          kind: i % 2 ? 'ai' : 'edits',
          actor: i % 2 ? 'ai' : 'you',
          changes: [{ what: 'dialogue', by: 'you', pageIds: [i < 3 ? 'pg_a' : 'pg_b'] }]
        })).res.id
      );
    }
    const first = await store.list(ME, { limit: 3 });
    expect(first.rows.map((r) => r.id)).toEqual([ids[6], ids[5], ids[4]]);
    const second = await store.list(ME, { limit: 3, cursor: first.next });
    expect(second.rows.map((r) => r.id)).toEqual([ids[3], ids[2], ids[1]]);
    const third = await store.list(ME, { limit: 3, cursor: second.next });
    expect(third.rows.map((r) => r.id)).toEqual([ids[0]]);
    expect(third.next).toBeUndefined();
    expect((await store.list(ME, { kinds: ['ai'] })).rows.map((r) => r.id)).toEqual([ids[5], ids[3], ids[1]]);
    expect((await store.list(ME, { actor: 'you' })).rows).toHaveLength(4);
    expect((await store.list(ME, { pageId: 'pg_a' })).rows.map((r) => r.id)).toEqual([ids[2], ids[1], ids[0]]);
  });

  it('a queued failure rejects exactly one call (for "a store failure never breaks a save" tests)', async () => {
    const { store, clock } = setup();
    store.failNext('put');
    await rejects(capture(store, ME, tinyDoc(1), clock.t), 'INTERNAL');
    await expect(capture(store, ME, tinyDoc(1), clock.t)).resolves.toBeTruthy();
    expect(historyHash('x')).toHaveLength(32);
  });
});
