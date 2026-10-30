// shared/comic/book.ts: one book order for the studio, timeline, breakdown card, exports and
// the public reader (contract §11.3, timeline.md §2.5).
import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../components/comicstudio/board/__fixtures__/sampleDoc';
import { archiveOf, coverSpecHash, normalizeDoc, type ArchivedVersion, type ComicDoc } from './doc';
import { applyOps } from './ops';
import { aspectMismatch, bookSequence, bookSpreads, clipStatus, continuityHint, coverStatus, reorderIds, versionList } from './book';
import { historyRestoreOp, isPanelSourceArchive, restoreOps } from './history/index';
import { BOOK_NOW, historyV4Doc } from './history/__fixtures__/books';

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

// A page's frame picture or overlay that a restore displaced is archived under the page ('page:<id>', apply.ts
// pathHomes, isPanelSourceArchive). It is not a drawing of the page: the ONE numbering (the director's list_versions /
// use_version, the timeline, the board's version strip) leaves it out before numbering, so v-numbers count drawings.
describe('versionList: a frame picture or overlay a restore archived is not a version of the page', () => {
  const STICKER = 'u/user-a/p/proj-v4/refs/sticker.webp';
  const FRAME = 'u/user-a/p/proj-v4/img/frame-take.webp';
  /** The real I1 net: frame picture + image overlay on page 2, then a restore of that page to the base. */
  const restored = (): { doc: ComicDoc; pageId: string } => {
    const base = normalizeDoc(historyV4Doc());
    const page = base.pages[1];
    const at = BOOK_NOW - 60_000;
    const framed = applyOps(base, [
      { op: 'page_frames', pageId: page.id, artMode: 'panels', frames: page.panels.map((pn, i) => ({ panelId: pn.id, frame: { box: { x: 0.02, y: 0.02 + i * 0.3, w: 0.96, h: 0.28 }, ...(i === 0 ? { src: { path: FRAME } } : {}) } })), moveBalloons: false },
      { op: 'layer', pageId: page.id, id: 'ly_sticker', patch: { kind: 'image', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, src: { path: STICKER }, print: false } }
    ], at);
    const doc = applyOps(framed, [historyRestoreOp(restoreOps(framed, base, { kind: 'page', pageId: page.id, mode: 'replace', part: 'all' }), { versionId: 'v', at })], at);
    return { doc, pageId: page.id };
  };

  it('leaves them out before numbering: v1..vN are the drawings, n === index + 1', () => {
    const { doc, pageId } = restored();
    const held = archiveOf(doc).filter((a) => a.targetKey === `page:${pageId}` && isPanelSourceArchive(a)).map((a) => a.path).sort();
    expect(held).toEqual([STICKER, FRAME].sort()); // the restore really archived both under the page
    const list = versionList(doc, { kind: 'page', id: pageId });
    expect(list.length).toBeGreaterThan(0);
    expect(list.map((v) => v.path)).not.toContain(STICKER);
    expect(list.map((v) => v.path)).not.toContain(FRAME);
    expect(list.map((v) => v.n)).toEqual(list.map((_, i) => i + 1));
    expect(list.filter((v) => v.current)).toHaveLength(1);
    // Every page of the book: no number past the count.
    for (const p of doc.pages) {
      const vs = versionList(doc, { kind: 'page', id: p.id });
      expect(vs.map((v) => v.n), p.id).toEqual(vs.map((_, i) => i + 1));
    }
  });

  it('a look-alike archived as the page’s own art stays a version; a shared path keeps the drawing', () => {
    const { doc, pageId } = restored();
    const key = `page:${pageId}`;
    const plain = (path: string, label: string): ArchivedVersion => ({ path, source: 'upload', at: 0, targetKey: key, label, archivedAt: BOOK_NOW });
    const LOOKALIKE = 'u/user-a/p/proj-v4/img/p2-upload.webp';
    const before = versionList(doc, { kind: 'page', id: pageId }).map((v) => v.path);
    // The label is just the page's: a drawing (an undated upload), so it is v1 and the rest move up by one.
    doc.archive = [plain(LOOKALIKE, 'Page 2'), plain(LOOKALIKE, 'Page 2 overlay'), ...archiveOf(doc)];
    const list = versionList(doc, { kind: 'page', id: pageId });
    expect(list.map((v) => v.path)).toEqual([LOOKALIKE, ...before]);
    expect(list[0]).toMatchObject({ n: 1, archived: true, version: { label: 'Page 2' } });
    // The overlay entry listed second never hides (or replaces) the drawing with the same path.
    const overlayFirst = { ...doc, archive: [plain(LOOKALIKE, 'Page 2 overlay'), plain(LOOKALIKE, 'Page 2'), ...archiveOf(doc).slice(2)] };
    expect(versionList(overlayFirst, { kind: 'page', id: pageId })[0]).toMatchObject({ n: 1, path: LOOKALIKE, version: { label: 'Page 2' } });
  });
});
