// @vitest-environment node
// The declared store contract (storeTypes.ts) carries what both stores already return, so H2/H3/H6/H7 read it through
// HistoryStore alone, without a cast: put()'s alreadyNamed/name, VersionInput.createdAt (classic snapshots), get()'s
// per-chunk paths, and head()'s rootHash and manifest.
//
// These checks are compile-time first: `npm run build:server` typechecks this file, and without the declarations in
// storeTypes.ts every typed access below (`res.alreadyNamed`, `{ createdAt }` on a VersionInput, `got.paths`,
// `head.rootHash`, `head.manifest`) is a type error. The runtime assertions pin that the fake fills them.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { applyOps } from '../../../../shared/comic/ops.js';
import { historyV4Doc } from '../../../../shared/comic/history/__fixtures__/books.js';
import type { Manifest, VersionRow } from '../../../../shared/comic/history/types.js';
import { chunkBook, historyHash } from './hash.js';
import type { HistoryScope } from './hooks.js';
import { createFakeHistoryStore } from './store.fake.js';
import { versionPaths, type HeadVersionRow, type HistoryPutResult, type HistoryVersionInput, type StoredVersionWithPaths } from './store.js';
import type { ChunkInput, HistoryStore, PutResult, StoredVersion, VersionInput } from './storeTypes.js';

const ME: HistoryScope = { projectId: 'proj-1', userId: 'user-a' };

/** The store as every consumer sees it: only the declared interface (never the fake's own types). */
const setup = (start = Date.UTC(2026, 9, 30, 12)) => {
  const clock = { t: start };
  const store: HistoryStore = createFakeHistoryStore({ now: () => clock.t });
  return { store, clock };
};

const versionOf = (doc: ComicDoc, at: number, extra: Partial<VersionInput> = {}) => {
  const book = chunkBook(doc);
  const version: VersionInput = { kind: 'edits', actor: 'you', label: 'You edited the comic', rev: doc.rev, contentAt: at, manifest: book.manifest, rootHash: book.rootHash, chunks: book.hashes, ...extra };
  return { book, version };
};

describe('storeTypes: the declared contract carries what the stores return', () => {
  it('declares the extra fields, and the store.ts names stay exported as aliases of the declared shapes', () => {
    expectTypeOf<PutResult['alreadyNamed']>().toEqualTypeOf<true | undefined>();
    expectTypeOf<PutResult['name']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<VersionInput['createdAt']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<StoredVersion['paths']>().toEqualTypeOf<Map<string, string[]> | undefined>();
    type Head = NonNullable<Awaited<ReturnType<HistoryStore['head']>>>;
    expectTypeOf<Head['rootHash']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Head['manifest']>().toEqualTypeOf<Manifest | undefined>();
    expectTypeOf<Head>().toMatchTypeOf<VersionRow>();
    // The local names keep working for existing imports.
    expectTypeOf<HistoryPutResult>().toEqualTypeOf<PutResult>();
    expectTypeOf<HistoryVersionInput>().toEqualTypeOf<VersionInput>();
    expectTypeOf<HeadVersionRow>().toMatchTypeOf<Head>();
    expectTypeOf<StoredVersionWithPaths>().toMatchTypeOf<StoredVersion>();
  });

  it('put(): a named save of a moment already saved under a name answers alreadyNamed and that name', async () => {
    const { store, clock } = setup();
    const doc = historyV4Doc();
    const first = versionOf(doc, clock.t, { kind: 'named', name: 'Before the twist' });
    const a: PutResult = await store.put(ME, first.version, first.book.chunks);
    expect(a.alreadyNamed).toBeUndefined();
    const again = versionOf(doc, clock.t + 1, { kind: 'named', name: 'Draft 2' });
    const b: PutResult = await store.put(ME, again.version, []);
    expect(b.deduped).toBe(true);
    expect(b.id).toBe(a.id);
    expect(b.alreadyNamed).toBe(true);
    expect(b.name).toBe('Before the twist');
  });

  it("VersionInput.createdAt: a classic snapshot keeps its own time; a v5 row is stamped by the store", async () => {
    const { store, clock } = setup();
    const old = Date.UTC(2026, 0, 2, 3, 4, 5);
    const content = JSON.stringify({ panels: [{ id: 's1-p1' }] });
    const hash = historyHash(content);
    const manifest = { state: { panels: hash } } as unknown as Manifest;
    const legacy: VersionInput = {
      kind: 'legacy',
      actor: 'you',
      label: 'Auto - Before Restore',
      rev: 0,
      contentAt: old,
      manifest,
      rootHash: historyHash(JSON.stringify(manifest)),
      chunks: [hash],
      codec: 'legacy',
      legacyRef: { snapshotId: 's1' },
      createdAt: old
    };
    const chunks: ChunkInput[] = [{ hash, kind: 'state', content, paths: [] }];
    const res = await store.put(ME, legacy, chunks);
    expect((await store.get(ME, res.id))?.row.createdAt).toBe(old);
    const v5 = versionOf(applyOps(historyV4Doc(), [{ op: 'brief', patch: { title: 'Take 2' } }]), clock.t, { createdAt: old });
    const r5 = await store.put(ME, v5.version, v5.book.chunks);
    expect((await store.get(ME, r5.id))?.row.createdAt).toBeGreaterThanOrEqual(clock.t);
  });

  it("get(): each chunk's GC roots are on the declared StoredVersion; head(): rootHash and manifest", async () => {
    const { store, clock } = setup();
    const { book, version } = versionOf(historyV4Doc(), clock.t);
    const res = await store.put(ME, version, book.chunks);
    const got: StoredVersion | null = await store.get(ME, res.id);
    expect(got?.paths).toBeInstanceOf(Map);
    expect([...got!.paths!.keys()].sort()).toEqual([...book.hashes].sort());
    const roots = new Set([...got!.paths!.values()].flat());
    expect(versionPaths(got!)).toEqual(roots);
    expect(roots.size).toBeGreaterThan(0);

    const head = await store.head(ME);
    expect(head?.id).toBe(res.id);
    expect(head?.rootHash).toBe(book.rootHash);
    expect(head?.manifest).toEqual(book.manifest);
  });
});
