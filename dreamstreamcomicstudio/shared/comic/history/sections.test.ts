// Book sections (versions plan §3.1; H0): split → join → normalizeDoc is the identity on the v4, v5 and empty
// fixtures; every top-level key is assigned or excluded; new page/panel fields are captured by exclusion; a reorder
// changes no section and a text edit changes exactly one page section.
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, normalizeDoc, pageSpecHash, type ComicDoc } from '../doc';
import { applyOps } from '../ops';
import { historyEmptyDoc, historyV4Doc, historyV5Doc } from './__fixtures__/books';
import { randomBook } from './__fixtures__/random';
import {
  ARCHIVE_BLOCK,
  EXCLUDED_TOP_LEVEL_KEYS,
  TOP_LEVEL_SECTIONS,
  TYPED_META_KEYS,
  buildManifest,
  excludedOf,
  extraMetaKeys,
  isExtraMetaKey,
  joinSections,
  manifestKeyHashes,
  parseSectionKey,
  sectionChunks,
  sectionContent,
  sectionSignatures,
  sectionsFromManifest,
  splitSections,
  stripVolatile,
  unassignedKeys
} from './sections';

const fixtures: [string, () => ComicDoc][] = [
  ['v4 (f8312c86-shaped)', historyV4Doc],
  ['v5 (b4b5774f-shaped)', historyV5Doc],
  ['empty', historyEmptyDoc]
];

const roundTrip = (doc: ComicDoc): ComicDoc => joinSections(splitSections(doc), excludedOf(doc));

describe('split → join → normalizeDoc', () => {
  it.each(fixtures)('is the identity on the %s fixture (volatile render fields aside)', (_name, make) => {
    const doc = normalizeDoc(make());
    expect(roundTrip(doc)).toEqual(stripVolatile(doc));
    // Exactly the identity once the volatile fields (updatedAt, attempts, error…) are gone.
    const stable = stripVolatile(doc);
    expect(roundTrip(stable)).toEqual(stable);
    // pageSpecHash never changes through history (R2).
    const back = roundTrip(doc);
    for (const p of doc.pages) expect(pageSpecHash(back, back.pages.find((x) => x.id === p.id)!)).toBe(pageSpecHash(doc, p));
  });

  it('a raw stored v4 doc (no v5 keys at all) reconstructs to the same normalized doc', () => {
    const raw = historyV4Doc();
    expect('letterStyle' in raw || 'i18n' in raw || 'archive' in raw).toBe(false);
    expect(roundTrip(normalizeDoc(raw))).toEqual(stripVolatile(normalizeDoc(raw)));
  });

  it('is the identity on random books', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const doc = randomBook(seed);
      expect(roundTrip(doc), `seed ${seed}`).toEqual(stripVolatile(doc));
    }
  });

  it('round-trips through a manifest and a chunk store; a missing chunk refuses to assemble', () => {
    const doc = normalizeDoc(historyV5Doc());
    const s = splitSections(doc);
    const store = new Map<string, string>();
    const manifest = buildManifest(s, (c) => {
      const content = sectionContent(c.body);
      store.set(c.key, content);
      return c.key; // a stand-in hash: the key (H1 uses sha256 of the content)
    });
    const back = sectionsFromManifest(manifest, (h) => (store.has(h) ? JSON.parse(store.get(h)!) : undefined));
    expect(back).not.toBeNull();
    expect(joinSections(back!, excludedOf(doc))).toEqual(stripVolatile(doc));
    store.delete('page:pg_3');
    expect(sectionsFromManifest(manifest, (h) => (store.has(h) ? JSON.parse(store.get(h)!) : undefined))).toBeNull();
    // Flat key → hash covers every chunk.
    expect(Object.keys(manifestKeyHashes(manifest)).sort()).toEqual(sectionChunks(s).map((c) => c.key).sort());
  });
});

describe('every top-level key is assigned or excluded', () => {
  it('lists every key a fully populated doc carries, and nothing else', () => {
    const full = normalizeDoc(historyV5Doc());
    expect(unassignedKeys(full)).toEqual([]);
    expect(unassignedKeys(createEmptyDoc('x'))).toEqual([]);
    // Every key a v5 doc can carry is in the table (the fixture sets every optional top-level field).
    expect(Object.keys(full).sort()).toEqual(Object.keys(TOP_LEVEL_SECTIONS).sort());
  });

  it('fails on a new, unassigned top-level key (and still keeps it in meta, so nothing is lost)', () => {
    const doc = { ...normalizeDoc(historyV5Doc()), scenesFromTheFuture: [{ id: 'sc_1', name: 'Market' }] } as ComicDoc;
    expect(unassignedKeys(doc)).toEqual(['scenesFromTheFuture']);
    const s = splitSections(doc);
    expect(s.meta.scenesFromTheFuture).toEqual([{ id: 'sc_1', name: 'Market' }]);
    expect((roundTrip(doc) as unknown as Record<string, unknown>).scenesFromTheFuture).toEqual([{ id: 'sc_1', name: 'Market' }]);
  });

  it('every meta key without a typed restore field is an "extra" meta key, which a restore brings back generically', () => {
    // The typed fields are exactly today's 'meta' keys; K2a's scenes/consistency (listed as 'meta') become extra keys.
    const metaKeys = (Object.keys(TOP_LEVEL_SECTIONS) as (keyof ComicDoc)[]).filter((k) => TOP_LEVEL_SECTIONS[k] === 'meta');
    for (const k of metaKeys) expect(TYPED_META_KEYS.includes(k) || isExtraMetaKey(k), k).toBe(true);
    for (const k of TYPED_META_KEYS) expect(TOP_LEVEL_SECTIONS[k], k).toBe('meta');
    expect(isExtraMetaKey('scenesFromTheFuture')).toBe(true);
    // Never an excluded, typed or other-section key, and never a prototype key.
    for (const k of [...EXCLUDED_TOP_LEVEL_KEYS, ...TYPED_META_KEYS, 'pages', 'cast', 'style', 'i18n', 'archive', 'trash', 'cover', 'source', '__proto__', 'constructor', 'prototype', ''])
      expect(isExtraMetaKey(k), k).toBe(false);
    const doc = { ...normalizeDoc(historyV5Doc()), scenesFromTheFuture: [], gone: undefined } as ComicDoc;
    expect(extraMetaKeys(doc)).toEqual(['scenesFromTheFuture']);
  });

  it('never holds an excluded record (spend, conversation, memory, settings, safety, publication, the lock, the inbox)', () => {
    const doc = normalizeDoc(historyV5Doc());
    const content = sectionChunks(splitSections(doc)).map((c) => sectionContent(c.body)).join('\n');
    for (const k of EXCLUDED_TOP_LEVEL_KEYS) expect(Object.keys(splitSections(doc).meta)).not.toContain(k);
    for (const secret of ['The user wants a playful chase.', 'Make it a chase', 'sp_a', 'first_render', 'inbox1.webp', 'budgetUsd']) expect(content).not.toContain(secret);
  });
});

describe('future-proof by exclusion', () => {
  it('an unknown page field and an unknown panel field survive split → join', () => {
    const doc = normalizeDoc(historyV5Doc());
    const page = doc.pages[2] as unknown as Record<string, unknown>;
    page.frameStyle = { gutter: 0.02, margin: 0.03 };
    const panel = doc.pages[2].panels[1] as unknown as Record<string, unknown>;
    panel.frame = { box: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 } };
    const back = roundTrip(doc);
    expect((back.pages[2] as unknown as Record<string, unknown>).frameStyle).toEqual({ gutter: 0.02, margin: 0.03 });
    expect((back.pages[2].panels[1] as unknown as Record<string, unknown>).frame).toEqual({ box: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 } });
    // …and they live in the page TEXT section, never in the art section.
    expect(sectionSignatures(doc)['page:pg_3']).toContain('frameStyle');
    expect(sectionSignatures(doc)['art:pg_3']).not.toContain('frameStyle');
  });
});

describe('what changes which section', () => {
  const changedKeys = (a: ComicDoc, b: ComicDoc): string[] => {
    const sa = sectionSignatures(a);
    const sb = sectionSignatures(b);
    return [...new Set([...Object.keys(sa), ...Object.keys(sb)])].filter((k) => sa[k] !== sb[k]).sort();
  };

  it('a page reorder changes no section (only the manifest order)', () => {
    const doc = normalizeDoc(historyV5Doc());
    const moved = applyOps(doc, [{ op: 'pages_reorder', order: ['pg_3', 'pg_1', 'pg_2', 'pg_4', 'pg_5', 'pg_6'] }], 5);
    expect(moved.pages.map((p) => p.id)).toEqual(['pg_3', 'pg_1', 'pg_2', 'pg_4', 'pg_5', 'pg_6']);
    expect(changedKeys(doc, moved)).toEqual([]);
    const ma = buildManifest(splitSections(doc), (c) => sectionContent(c.body));
    const mb = buildManifest(splitSections(moved), (c) => sectionContent(c.body));
    expect(mb.pages.map(([id]) => id)).toEqual(['pg_3', 'pg_1', 'pg_2', 'pg_4', 'pg_5', 'pg_6']);
    expect(ma.pages).not.toEqual(mb.pages);
  });

  it('a text edit changes exactly one page section', () => {
    const doc = normalizeDoc(historyV5Doc());
    const edited = applyOps(doc, [{ op: 'line', pageId: 'pg_4', panelId: 'pg_4_p3', id: 'pg_4_l3', patch: { text: 'Talk later, Maya.' } }], 5);
    expect(changedKeys(doc, edited)).toEqual(['page:pg_4']);
  });

  it('a redraw changes that page’s art section (and the archive only on overflow), never its text', () => {
    const doc = normalizeDoc(historyV5Doc());
    const redrawn = applyOps(doc, [{ op: 'render', target: { kind: 'page', id: 'pg_3' }, patch: { status: 'ready', asset: { path: 'u/user-b/p/proj-v5/img/p3-new.webp', source: 'generated', at: 9 } } }], 9);
    expect(changedKeys(doc, redrawn)).toEqual(['art:pg_3']);
  });

  it('a busy status, a retry counter or an error never makes a section change', () => {
    const doc = normalizeDoc(historyV5Doc());
    const busy = applyOps(doc, [{ op: 'render', target: { kind: 'page', id: 'pg_2' }, patch: { status: 'rendering', attempts: 2, updatedAt: 99 } }], 99);
    expect(changedKeys(doc, busy)).toEqual([]);
  });

  it('archive blocks are counted from the oldest end, so a new eviction touches only the newest block', () => {
    let doc = normalizeDoc(historyV5Doc());
    doc = { ...doc, archive: Array.from({ length: ARCHIVE_BLOCK + 5 }, (_, i) => ({ path: `a/${i}.webp`, source: 'generated' as const, at: i, targetKey: 'page:pg_1', label: 'Page 1', archivedAt: 1000 - i })) };
    const grown = { ...doc, archive: [{ path: 'a/new.webp', source: 'generated' as const, at: 2000, targetKey: 'page:pg_1', label: 'Page 1', archivedAt: 2000 }, ...doc.archive!] };
    expect(changedKeys(doc, grown)).toEqual(['archive:1']);
  });

  it('section keys parse back', () => {
    for (const key of ['meta', 'page:pg_1', 'art:pg_1', 'edp:te:pg_1', 'ed:hi', 'archive:3', 'trash:pg_9', 'char:c_1', 'option:so_1']) expect(parseSectionKey(key), key).not.toBeNull();
    expect(parseSectionKey('edp:te:')).toBeNull();
    expect(parseSectionKey('nope:1')).toBeNull();
  });
});
