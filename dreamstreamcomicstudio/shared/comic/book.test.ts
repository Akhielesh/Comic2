// shared/comic/book.ts: one book order for the studio, timeline, breakdown card, exports and
// the public reader (contract §11.3, timeline.md §2.5).
import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../components/comicstudio/board/__fixtures__/sampleDoc';
import { coverSpecHash, normalizeDoc, type ComicDoc } from './doc';
import { applyOps } from './ops';
import { aspectMismatch, bookSequence, bookSpreads, clipStatus, continuityHint, coverStatus, reorderIds } from './book';

const sample = (): ComicDoc => normalizeDoc(makeSampleDoc());

describe('bookSequence', () => {
  it('studio: cover first, every page by n (drawn or not), plates per settings, back cover last', () => {
    let doc = sample();
    doc.pages = [...doc.pages].reverse(); // order comes from n, not array order
    expect(bookSequence(doc).map((s) => s.key)).toEqual(['cover', 'pg_1', 'pg_2', 'pg_3', 'pg_4', 'pg_5', 'pg_6']);
    doc = applyOps(doc, [{ op: 'book', patch: { titlePage: true, endPage: true, backCover: 'auto' } }]);
    const slots = bookSequence(doc);
    expect(slots.map((s) => s.kind)).toEqual(['cover', 'title', 'page', 'page', 'page', 'page', 'page', 'page', 'end', 'back_cover']);
    expect(slots.filter((s) => s.plate).every((s) => s.drawn && s.status === 'ready')).toBe(true);
    expect(slots.find((s) => s.key === 'pg_2')).toMatchObject({ drawn: false, status: 'planned', label: 'Page 2' });
  });

  it('public: only drawn pages and switched-on plates; an undrawn cover is left out', () => {
    let doc = sample();
    expect(bookSequence(doc, { audience: 'public' }).map((s) => s.key)).toEqual(['pg_1', 'pg_5']);
    doc = applyOps(doc, [{ op: 'book', patch: { endPage: true } }]);
    doc.cover = { ...doc.cover, render: { status: 'ready', history: [], asset: { path: 'u/x/cover.webp', source: 'generated', at: 1 } } };
    expect(bookSequence(doc, { audience: 'public' }).map((s) => s.key)).toEqual(['cover', 'pg_1', 'pg_5', 'end']);
  });

  it('empty pages read as empty, adopted art as custom', () => {
    const doc = sample();
    doc.pages[1].panels = [];
    expect(clipStatus(doc, doc.pages[1])).toBe('empty');
    doc.pages[1].render = { status: 'ready', history: [], origin: 'adopted', asset: { path: 'x.webp', source: 'upload', at: 1 } };
    expect(clipStatus(doc, doc.pages[1])).toBe('custom');
    expect(clipStatus(doc, doc.pages[4])).toBe('stale');
    expect(clipStatus(doc, doc.pages[5])).toBe('failed');
  });
});

describe('cover status', () => {
  it('none → planned; drawn from an older title → stale; adopted → custom; busy passes through', () => {
    const doc = sample();
    expect(coverStatus(doc)).toBe('planned');
    doc.cover = { ...doc.cover, render: { status: 'ready', history: [], asset: { path: 'c.webp', source: 'generated', at: 1 }, specHash: coverSpecHash(doc) } };
    expect(coverStatus(doc)).toBe('ready');
    expect(bookSequence(doc)[0].status).toBe('ready');
    const renamed = { ...doc, cover: { ...doc.cover, title: 'A New Title' } };
    expect(coverStatus(renamed)).toBe('stale');
    const adopted = { ...doc, cover: { ...doc.cover, render: { status: 'ready' as const, history: [], origin: 'adopted' as const, asset: { path: 'c.webp', source: 'upload' as const, at: 1 } } } };
    expect(coverStatus(adopted)).toBe('custom');
    const busy = { ...doc, cover: { ...doc.cover, render: { status: 'rendering' as const, history: [] } } };
    expect(coverStatus(busy)).toBe('rendering');
  });
});

describe('bookSpreads', () => {
  it('cover alone, first interior slot alone when the first page sits right, facing pairs, back cover alone', () => {
    const doc = applyOps(sample(), [{ op: 'book', patch: { titlePage: true, endPage: true, backCover: 'auto' } }]);
    const slots = bookSequence(doc);
    expect(bookSpreads(slots, true)).toEqual([[0], [1], [2, 3], [4, 5], [6, 7], [8], [9]]);
    expect(bookSpreads(slots, false)).toEqual([[0], [1, 2], [3, 4], [5, 6], [7, 8], [9]]);
  });

  it('works without a cover and for tiny books', () => {
    const doc = sample();
    const pub = bookSequence(doc, { audience: 'public' });
    expect(bookSpreads(pub, false)).toEqual([[0, 1]]);
    expect(bookSpreads(pub, true)).toEqual([[0], [1]]);
    expect(bookSpreads([], true)).toEqual([]);
    expect(bookSpreads(bookSequence(doc).slice(0, 1), true)).toEqual([[0]]);
  });
});

describe('aspectMismatch / reorderIds / continuityHint', () => {
  it('flags art at the wrong shape and never flags unknown sizes', () => {
    const doc = sample(); // 2:3 book
    expect(aspectMismatch(doc, { path: 'a', source: 'generated', at: 1, w: 1000, h: 1500 })).toBeNull();
    expect(aspectMismatch(doc, { path: 'a', source: 'generated', at: 1, w: 1024, h: 1024 })).toEqual({ want: doc.format.pageAspect, got: '1:1' });
    expect(aspectMismatch(doc, { path: 'a', source: 'generated', at: 1 })).toBeNull();
    expect(aspectMismatch(doc, undefined)).toBeNull();
  });

  it('reorders ids immutably and clamps', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(reorderIds(ids, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorderIds(ids, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(reorderIds(ids, 1, 99)).toEqual(['a', 'c', 'd', 'b']);
    expect(reorderIds(ids, 9, 0)).toEqual(ids);
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
  });

  it('continuity: the previous page changed since this one was drawn (info only)', () => {
    const doc = sample();
    expect(continuityHint(doc, doc.pages[1])).toBe(false); // no continuity ref recorded
    doc.pages[1].render = { ...doc.pages[1].render, continuityPath: doc.pages[0].render.asset!.path };
    expect(continuityHint(doc, doc.pages[1])).toBe(false);
    doc.pages[1].render = { ...doc.pages[1].render, continuityPath: 'u/proj/pages/p1-old.png' };
    expect(continuityHint(doc, doc.pages[1])).toBe(true);
  });
});
