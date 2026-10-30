// @vitest-environment node
// Comic History chunking (versions plan §3.1 "Hashing", §14 H1 tests; H0 fix-round note: hash and store
// sectionContent RAW — semanticSectionContent is for comparisons only):
//   * joinSections(chunkBook(doc)) is the normalized book on the v4 / v5 / empty fixtures, through JSON;
//   * the manifest is buildManifest(splitSections(doc), sha256/128 of sectionContent): raw, never semantic;
//   * an unchanged page gives an identical hash and the identity cache is hit; the cache never changes a result;
//   * property: collectAssetPaths(doc) ⊆ ⋃ chunk.paths (excluded records aside); data:/http(s):/blob: never;
//   * a chunk whose content was altered never parses; excluded records never reach a chunk.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { collectAssetPaths, normalizeDoc, pageSpecHash, type ComicDoc, type DocOp } from '../../../../shared/comic/doc.js';
import { applyOps } from '../../../../shared/comic/ops.js';
import { stableStringify } from '../../../../shared/comic/hash.js';
import { semanticSectionContent } from '../../../../shared/comic/history/diff.js';
import {
  buildManifest,
  excludedOf,
  joinSections,
  sectionChunks,
  sectionContent,
  splitSections,
  stripVolatile,
  versionFrame
} from '../../../../shared/comic/history/sections.js';
import { historyEmptyDoc, historyV4Doc, historyV5Doc } from '../../../../shared/comic/history/__fixtures__/books.js';
import { evolveBook, randomBook, rngOf, type Rng } from '../../../../shared/comic/history/__fixtures__/random.js';
import {
  CHUNK_PATHS_MAX,
  ChunkCache,
  assembleBook,
  chunkBook,
  chunkPaths,
  gcRootOf,
  historyHash,
  manifestHashes,
  parseVerifiedChunk,
  rootHashOf,
  type ChunkedBook
} from './hash.js';

const fixtures: [string, () => ComicDoc][] = [
  ['v4', historyV4Doc],
  ['v5', historyV5Doc],
  ['empty', historyEmptyDoc]
];

const sha128 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex').slice(0, 32);
/** What the database hands back: every chunk's content, parsed (JSON drops undefined; jsonb reorders keys). */
const bodiesOf = (book: ChunkedBook) => new Map(book.chunks.map((c) => [c.hash, JSON.parse(c.content) as unknown]));
const plain = (book: ChunkedBook) => ({ manifest: book.manifest, rootHash: book.rootHash, chunks: book.chunks, bytes: book.bytes });

describe('chunkBook → assemble', () => {
  it.each(fixtures)('reassembles the %s fixture to its normalized book (through stored JSON)', (_name, make) => {
    const doc = make();
    const book = chunkBook(doc, { cache: false });
    const back = assembleBook(book.manifest, bodiesOf(book), excludedOf(doc));
    expect(back).not.toBeNull();
    expect(back).toEqual(joinSections(splitSections(doc), excludedOf(doc)));
    expect(back).toEqual(stripVolatile(normalizeDoc(doc)));
    // pageSpecHash is invariant (R2): a reassembled page is never "out of date".
    for (const p of doc.pages) expect(pageSpecHash(back!, back!.pages.find((x) => x.id === p.id)!)).toBe(pageSpecHash(doc, p));
    // A standalone read (no live doc) reassembles too.
    expect(assembleBook(book.manifest, bodiesOf(book), versionFrame(doc.id, 1))?.pages.map((p) => p.id)).toEqual(doc.pages.map((p) => p.id));
  });

  it('is null when a chunk is missing (the caller says the version cannot be opened)', () => {
    const doc = historyV5Doc();
    const book = chunkBook(doc, { cache: false });
    const bodies = bodiesOf(book);
    bodies.delete(book.manifest.pages[0][2]);
    expect(assembleBook(book.manifest, bodies, excludedOf(doc))).toBeNull();
  });

  it.each(fixtures)('hashes and stores sectionContent RAW on the %s fixture (H0 fix round), one chunk per distinct hash', (_name, make) => {
    const doc = make();
    const book = chunkBook(doc, { cache: false });
    const sections = splitSections(doc);
    expect(book.manifest).toEqual(buildManifest(sections, (c) => sha128(sectionContent(c.body))));
    const byHash = new Map(book.chunks.map((c) => [c.hash, c]));
    for (const c of sectionChunks(sections)) {
      const content = sectionContent(c.body);
      const chunk = byHash.get(sha128(content));
      expect(chunk, c.key).toBeDefined();
      expect(chunk!.content).toBe(content);
      expect(chunk!.keys).toContain(c.key);
    }
    for (const c of book.chunks) expect(historyHash(c.content)).toBe(c.hash);
    expect(new Set(book.hashes).size).toBe(book.hashes.length);
    expect([...book.hashes].sort()).toEqual(manifestHashes(book.manifest));
    expect(book.rootHash).toBe(sha128(stableStringify(book.manifest)));
    expect(book.bytes).toBe(book.chunks.reduce((n, c) => n + Buffer.byteLength(c.content, 'utf8'), 0));
  });

  it('never stores the semantic form: a QC-only change is a new hash (comparisons hide it, storage keeps it)', () => {
    const doc = historyV5Doc();
    const page = doc.pages.find((p) => p.render.asset)!;
    const before = chunkBook(doc, { cache: false });
    const next = applyOps(doc, [{ op: 'asset_meta', path: page.render.asset!.path, patch: { variants: [{ path: `${page.render.asset!.path}_w1080.webp`, w: 1080, h: 1620 }] } }]);
    const after = chunkBook(next, { cache: false });
    const art = (b: ChunkedBook) => b.manifest.pages.find(([id]) => id === page.id)![2];
    expect(art(after)).not.toBe(art(before));
    const nextPage = next.pages.find((p) => p.id === page.id)!;
    const artBody = (p: typeof page) => ({ render: stripVolatile({ ...doc, pages: [p] } as ComicDoc).pages[0].render, balloons: p.balloons });
    expect(semanticSectionContent(artBody(nextPage))).toBe(semanticSectionContent(artBody(page)));
    expect(after.chunks.find((c) => c.hash === art(after))!.content).toBe(sectionContent(artBody(nextPage)));
  });

  it('gives the same root after a jsonb round trip (key order never matters) and a different root for a real edit', () => {
    const doc = historyV5Doc();
    const book = chunkBook(doc, { cache: false });
    const reordered = JSON.parse(JSON.stringify(book.manifest, Object.keys(book.manifest).reverse()));
    expect(rootHashOf(JSON.parse(JSON.stringify(book.manifest)))).toBe(book.rootHash);
    expect(rootHashOf({ ...reordered, ...book.manifest })).toBe(book.rootHash);
    const reloaded = normalizeDoc(JSON.parse(JSON.stringify(doc)));
    expect(chunkBook(reloaded, { cache: false }).rootHash).toBe(chunkBook(normalizeDoc(doc), { cache: false }).rootHash);
    const edited = applyOps(doc, [{ op: 'brief', patch: { title: 'A new title' } }]);
    expect(chunkBook(edited, { cache: false }).rootHash).not.toBe(book.rootHash);
  });

  it('a reorder changes only the manifest, never a chunk', () => {
    const doc = historyV5Doc();
    const before = chunkBook(doc, { cache: false });
    const order = doc.pages.map((p) => p.id).reverse();
    const after = chunkBook(applyOps(doc, [{ op: 'pages_reorder', order }]), { cache: false });
    expect(after.rootHash).not.toBe(before.rootHash);
    expect(new Set(after.hashes)).toEqual(new Set(before.hashes));
  });

  it('never puts an excluded record into a chunk (conversation, memory, spend, settings, publication…)', () => {
    const doc = historyV5Doc();
    const marked = applyOps(doc, [
      { op: 'message', msg: { id: 'm_secret', role: 'user', text: 'SECRET-CONVERSATION', at: 1 } },
      { op: 'memory', text: 'SECRET-MEMORY' }
    ] as DocOp[]);
    const all = chunkBook(marked, { cache: false }).chunks.map((c) => c.content).join('\n');
    expect(all).not.toContain('SECRET-CONVERSATION');
    expect(all).not.toContain('SECRET-MEMORY');
    expect(all).not.toContain('"spend"');
    expect(all).not.toContain('"conversation"');
    expect(all).not.toContain('"settings"');
  });
});

describe('the identity cache', () => {
  it('re-hashes nothing for an unchanged page: identical hashes, cache hits, and the same result as no cache', () => {
    const doc = historyV5Doc();
    const cache = new ChunkCache();
    const first = chunkBook(doc, { cache });
    expect(cache.hits).toBe(0);
    const p2 = doc.pages[1];
    const line = p2.panels[0].lines[0];
    const next = applyOps(doc, [{ op: 'line', pageId: p2.id, panelId: p2.panels[0].id, id: line.id, patch: { text: 'Completely new words.' } }]);
    for (const [i, p] of doc.pages.entries()) if (p.id !== p2.id) expect(next.pages[i]).toBe(p); // applyOps shares them
    const hits = cache.hits;
    const second = chunkBook(next, { cache });
    // page:/art: of every unchanged page are hits (plus the other untouched sections).
    expect(cache.hits - hits).toBeGreaterThanOrEqual(2 * (doc.pages.length - 1));
    for (const [i, [id, text, art]] of first.manifest.pages.entries()) {
      if (id === p2.id) {
        expect(second.manifest.pages[i][1]).not.toBe(text);
        expect(second.manifest.pages[i][2]).toBe(art);
      } else {
        expect(second.manifest.pages[i]).toEqual([id, text, art]);
      }
    }
    expect(plain(second)).toEqual(plain(chunkBook(next, { cache: false })));
  });

  it('a whole unchanged book is all hits except meta (it has no single source object)', () => {
    const doc = historyV5Doc();
    const cache = new ChunkCache();
    chunkBook(doc, { cache });
    const misses = cache.misses;
    const again = chunkBook(doc, { cache });
    expect(cache.misses).toBe(misses);
    expect(plain(again)).toEqual(plain(chunkBook(doc, { cache: false })));
  });

  /** One random real edit (the shapes a session commits), through applyOps: unchanged objects stay shared. */
  const randomEdit = (doc: ComicDoc, r: Rng, i: number): DocOp | null => {
    const pick = <T>(xs: T[]): T | undefined => (xs.length ? xs[Math.floor(r() * xs.length)] : undefined);
    const page = pick(doc.pages);
    const panel = page && pick(page.panels);
    const line = panel && pick(panel.lines);
    const lang = pick(Object.keys(doc.i18n?.editions || {}));
    switch (Math.floor(r() * 10)) {
      case 0:
        return page && panel && line ? { op: 'line', pageId: page.id, panelId: panel.id, id: line.id, patch: { text: `edit ${i}` } } : null;
      case 1:
        return page && line ? { op: 'balloon', pageId: page.id, lineId: line.id, patch: { y: r() } } : null;
      case 2:
        return { op: 'pages_reorder', order: [...doc.pages.map((p) => p.id)].reverse() };
      case 3:
        return page ? { op: 'page', id: page.id, patch: { summary: `summary ${i}` } } : null;
      case 4: {
        const c = pick(doc.cast);
        return c ? { op: 'character', id: c.id, patch: { look: { summary: `look ${i}` } } } : null;
      }
      case 5:
        return lang && line ? { op: 'translation', lang, lineId: line.id, patch: { text: `tr ${i}`, status: 'edited', sourceHash: 'x', at: i } } : null;
      case 6:
        return page && doc.pages.length > 1 ? { op: 'page_delete', id: page.id, deletedAt: 1_000 + i } : null;
      case 7:
        return { op: 'page_insert', id: `pg_new_${i}`, after: 0, patch: { summary: `new ${i}` } };
      case 8:
        return { op: 'cover', patch: { title: `Cover ${i}` } };
      default:
        return page && panel && line ? { op: 'line', pageId: page.id, panelId: panel.id, id: `l_new_${i}`, patch: { kind: 'dialogue', text: `added ${i}` } } : null;
    }
  };

  it('property: along random edit chains a shared cache always gives exactly the uncached result', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const r = rngOf(seed * 7919);
      const cache = new ChunkCache();
      let doc = randomBook(seed);
      for (let i = 0; i < 12; i += 1) {
        const op = randomEdit(doc, r, i);
        if (op) doc = applyOps(doc, [op], 2_000 + i);
        expect(plain(chunkBook(doc, { cache })), `seed ${seed} step ${i}`).toEqual(plain(chunkBook(doc, { cache: false })));
      }
      expect(cache.hits, `seed ${seed}`).toBeGreaterThan(0);
    }
  });
});

describe('the paths rule', () => {
  const withoutExcluded = (doc: ComicDoc) => collectAssetPaths({ ...doc, conversation: [], refInbox: [] });
  const unionOf = (book: ChunkedBook) => new Set(book.chunks.flatMap((c) => c.paths));

  it.each(fixtures)('every asset path of the %s fixture is a GC root of some chunk', (_name, make) => {
    const doc = make();
    const roots = unionOf(chunkBook(doc, { cache: false }));
    for (const p of withoutExcluded(doc)) expect(roots.has(p), p).toBe(true);
  });

  it('property: collectAssetPaths(doc) ⊆ ⋃ chunk.paths over random and evolved books; every root is in its chunk', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const doc = seed % 2 ? randomBook(seed) : evolveBook(randomBook(seed), seed, 8);
      const book = chunkBook(doc, { cache: false });
      const roots = unionOf(book);
      for (const p of withoutExcluded(doc)) expect(roots.has(p), `seed ${seed}: ${p}`).toBe(true);
      for (const c of book.chunks) {
        expect(c.paths.length).toBeLessThanOrEqual(CHUNK_PATHS_MAX);
        for (const p of c.paths) expect(c.content.includes(JSON.stringify(p).slice(1, -1)), p).toBe(true);
      }
    }
  });

  it('data:, http(s): and blob: strings never become paths; whitespace is trimmed; over-long strings are not paths', () => {
    expect(gcRootOf('data:image/png;base64,AAAA/BBBB')).toBeNull();
    expect(gcRootOf(' DATA:image/png;base64,AAAA/BBBB')).toBeNull();
    expect(gcRootOf('https://cdn.example.com/a/b.png')).toBeNull();
    expect(gcRootOf('http://cdn.example.com/a/b.png')).toBeNull();
    expect(gcRootOf('blob:https://studio.example/1234')).toBeNull();
    expect(gcRootOf('no-slash.webp')).toBeNull();
    expect(gcRootOf(`u/${'x'.repeat(600)}/a.webp`)).toBeNull();
    expect(gcRootOf('  u/a/p/b/img/c.webp  ')).toBe('u/a/p/b/img/c.webp');

    const doc = historyV5Doc();
    const p = doc.pages[0];
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo/AAAA+BBBB/CCCC==';
    const next = applyOps(doc, [
      { op: 'line', pageId: p.id, panelId: p.panels[0].id, id: p.panels[0].lines[0].id, patch: { text: dataUrl } },
      { op: 'brief', patch: { notes: ['https://example.com/inspiration/board.png', 'blob:https://studio.example/9'] } }
    ]);
    const roots = unionOf(chunkBook(next, { cache: false }));
    for (const r of roots) expect(r).not.toMatch(/^(data|https?|blob):/i);
    expect(roots.has(dataUrl)).toBe(false);
  });

  it('keeps at most 400 roots per chunk, storage-path-shaped strings first', () => {
    const prose = Array.from({ length: 450 }, (_, i) => `this and/or that ${i}`);
    const real = Array.from({ length: 20 }, (_, i) => `u/a/p/b/img/${i}.webp`);
    const paths = chunkPaths({ lines: prose, refs: real.map((path) => ({ path })) });
    expect(paths).toHaveLength(CHUNK_PATHS_MAX);
    for (const p of real) expect(paths).toContain(p);
    expect(paths).toEqual([...paths].sort());
  });
});

describe('read-side verification', () => {
  it('parses a chunk only when its content still hashes to its hash', () => {
    const content = sectionContent({ id: 'pg_1', summary: 'A quiet morning' });
    const hash = historyHash(content);
    expect(parseVerifiedChunk(hash, content)).toEqual({ id: 'pg_1', summary: 'A quiet morning' });
    expect(parseVerifiedChunk(hash, content.replace('quiet', 'loud!'))).toBeUndefined();
    expect(parseVerifiedChunk(hash.toUpperCase(), content)).toBeUndefined();
    expect(parseVerifiedChunk('not-a-hash', content)).toBeUndefined();
    expect(parseVerifiedChunk(hash, undefined)).toBeUndefined();
    const broken = '{"unterminated": ';
    expect(parseVerifiedChunk(historyHash(broken), broken)).toBeUndefined();
  });

  it('hashes UTF-8 exactly as Postgres digest(text) does (multi-byte text, escaped control characters)', () => {
    const content = sectionContent({ text: 'నమస్తే — “quotes” \u0000 and an emoji 🎨', lone: '\uD800' });
    expect(content).not.toContain('\u0000'); // JSON escapes it: Postgres text accepts the chunk
    expect(historyHash(content)).toBe(sha128(content));
  });
});
