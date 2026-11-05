// Reader layout (contract §13.4, reader.md §15, mobile.md §10.1 table): phones, landscape phones,
// tablets, foldables (cover screen, unfolded, book posture), desktop; webtoon/strip; explicit choices;
// the cover alone on its side; page 1 opposite the inside cover; lone last page; mixed aspects.
import { describe, expect, it } from 'vitest';
import { classifyViewport, SINGLE_SEGMENT, type Segments } from '../mobile/formFactor';
import type { ReaderItem } from '../reader/readerModel';
import { bookGeometry, bookViews, decideLayout, firstItemOfView, layoutFor, layoutPrefFrom, letterbox, readerLayout, spreadFits, viewIndexOfItem, type LayoutInput } from './readerLayout';

const A23 = 2 / 3;
const at = (vw: number, vh: number, over: Partial<LayoutInput> = {}): LayoutInput => ({ vw, vh, kind: 'comic', pref: 'auto', pageAspect: A23, ...over });
const ff = (w: number, h: number, segments: Segments = SINGLE_SEGMENT) => ({ ...classifyViewport({ w, h, coarse: true, segments }), segments });
const rect = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRectReadOnly;

describe('mobile.md §10.1 device table', () => {
  const cases: [string, number, number, string, string?][] = [
    ['Fold cover 344×882', 344, 882, 'single', 'contain'],
    ['Android 360×800', 360, 800, 'single', 'contain'],
    ['iPhone 393×852', 393, 852, 'single', 'contain'],
    ['iPhone landscape 852×393', 852, 393, 'single', 'width'],
    ['iPad mini portrait 744×1133', 744, 1133, 'single', 'contain'],
    ['iPad portrait 820×1180', 820, 1180, 'single', 'contain'],
    ['iPad landscape 1180×820', 1180, 820, 'spread', 'contain'],
    ['iPad Pro portrait 1032×1376', 1032, 1376, 'single', 'contain'],
    ['iPad Pro landscape 1376×1032', 1376, 1032, 'spread', 'contain'],
    ['Fold unfolded, no segments 882×1104', 882, 1104, 'single', 'contain'],
    ['Desktop 1920×1080', 1920, 1080, 'spread', 'contain'],
    ['Laptop 1280×800', 1280, 800, 'spread', 'contain']
  ];
  it.each(cases)('%s → %s', (_label, w, h, layout, fit) => {
    const d = readerLayout(ff(w, h), { w, h }, A23, 'comic');
    expect(d.layout).toBe(layout);
    if (fit) expect(d.fit).toBe(fit);
  });

  it('dual horizontal segments (book posture) → spread, one page per segment', () => {
    const segs: Segments = { count: 2, axis: 'horizontal', rects: [rect(0, 0, 441, 1104), rect(441, 0, 441, 1104)] };
    const d = readerLayout(ff(882, 1104, segs), { w: 882, h: 1104 }, A23, 'comic');
    expect(d).toMatchObject({ layout: 'spread', perSegment: true, allowSpread: true });
  });

  it('vertical segments (tabletop) keep the window-class layout', () => {
    const segs: Segments = { count: 2, axis: 'vertical', rects: [rect(0, 0, 882, 540), rect(0, 564, 882, 540)] };
    expect(readerLayout(ff(882, 1104, segs), { w: 882, h: 1104 }, A23, 'comic').layout).toBe('single');
  });

  it('webtoon scrolls everywhere; strips use the strip layout', () => {
    for (const [w, h] of [[360, 800], [1180, 820], [1920, 1080]]) {
      expect(readerLayout(ff(w, h), { w, h }, A23, 'webtoon').layout).toBe('scroll');
      expect(readerLayout(ff(w, h), { w, h }, A23, 'strip').layout).toBe('strip');
    }
  });
});

describe('decideLayout rules', () => {
  it('spread needs w ≥ 900, w/h ≥ 1.05 and two pages ≥ 320 px', () => {
    expect(spreadFits(at(899, 700))).toBe(false);
    expect(spreadFits(at(1000, 980))).toBe(false); // ratio 1.02
    expect(spreadFits(at(932, 430))).toBe(false); // pages would be ~255 px wide
    expect(spreadFits(at(1280, 800))).toBe(true);
    expect(layoutFor(at(1280, 800))).toBe('spread');
  });

  it('an explicit choice wins; spread falls back silently when it cannot fit', () => {
    expect(layoutFor(at(1280, 800, { pref: 'single' }))).toBe('single');
    expect(layoutFor(at(390, 844, { pref: 'spread' }))).toBe('single');
    expect(decideLayout(at(390, 844, { pref: 'spread' })).allowSpread).toBe(false);
    expect(layoutFor(at(1280, 800, { pref: 'scroll' }))).toBe('scroll');
    expect(layoutFor(at(1280, 800, { kind: 'webtoon', pref: 'spread' }))).toBe('scroll');
  });

  it('maps the old stored inline values ("page" → single)', () => {
    expect(layoutPrefFrom('page')).toBe('single');
    expect(layoutPrefFrom('spread')).toBe('spread');
    expect(layoutPrefFrom('scroll')).toBe('scroll');
    expect(layoutPrefFrom(null)).toBe('auto');
    expect(layoutPrefFrom('garbage')).toBe('auto');
  });
});

const item = (i: number, kind: 'cover' | 'page' = 'page', w?: number, h?: number): ReaderItem => ({
  key: kind === 'cover' ? 'cover' : `pg_${i}`,
  kind,
  label: kind === 'cover' ? 'Cover' : `Page ${i}`,
  asset: { path: `u/${i}.webp`, source: 'generated', at: 0, ...(w && h ? { w, h } : {}) },
  ...(kind === 'page' ? { page: { id: `pg_${i}`, n: i, summary: '', layout: '', panels: [], render: { status: 'ready', history: [] }, balloons: [] } } : {})
});
const book = (pages: number, cover = true) => [...(cover ? [item(0, 'cover')] : []), ...Array.from({ length: pages }, (_, i) => item(i + 1))];

describe('bookViews', () => {
  it('single: one item per view, then the End card', () => {
    const v = bookViews(book(3), 'single');
    expect(v.map((x) => x.key)).toEqual(['i0', 'i1', 'i2', 'i3', 'end']);
  });

  it('spread: cover alone, page 1 opposite the inside cover, facing pairs, End card on the right', () => {
    const v = bookViews(book(4), 'spread');
    expect(v.map((x) => x.key)).toEqual(['blank|i0', 'ep-front|i1', 'i2|i3', 'i4|end']);
    expect(v[0].slots[0].kind).toBe('blank');
  });

  it('spread without a right-hand page 1: pairs from page 1; a full last spread gets an inside back cover + End', () => {
    const v = bookViews(book(4), 'spread', { firstPageRight: false });
    expect(v.map((x) => x.key)).toEqual(['blank|i0', 'i1|i2', 'i3|i4', 'ep-back|end']);
  });

  it('a lone last page sits on the left (End card disabled → empty right half)', () => {
    const v = bookViews(book(3, false), 'spread', { endCard: false });
    expect(v.map((x) => x.key)).toEqual(['i0|i1', 'i2|blank']);
  });

  it('keeps the same page across layout changes', () => {
    const single = bookViews(book(4), 'single');
    const spread = bookViews(book(4), 'spread');
    expect(viewIndexOfItem(spread, 3)).toBe(2);
    expect(viewIndexOfItem(single, firstItemOfView(spread, 2))).toBe(2);
    expect(firstItemOfView(spread, 3)).toBe(4);
    expect(firstItemOfView(single, single.length - 1)).toBe(4); // End card → last page
  });
});

describe('bookGeometry', () => {
  const geo = (view: ReturnType<typeof bookViews>[number], rtl = false, stage = { w: 1280, h: 800 }, aspectOf = () => A23) =>
    bookGeometry({ view, stage, layout: 'spread', rtl, aspectOf, pageAspect: A23, widthClass: 'large' });

  it('the cover sits alone on the right for LTR (data-side right) and on the left for RTL', () => {
    const [cover] = bookViews(book(2), 'spread');
    const ltr = geo(cover);
    expect(ltr.slots.find((s) => s.content.kind === 'item')!.side).toBe('right');
    expect(ltr.book.w).toBeCloseTo(2 * ltr.page.w, 6); // always two pages wide
    const rtl = geo(cover, true);
    expect(rtl.slots.find((s) => s.content.kind === 'item')!.side).toBe('left');
  });

  it('a lone last page sits on the left in LTR', () => {
    const views = bookViews(book(3, false), 'spread', { endCard: false });
    const g = geo(views[1]);
    expect(g.slots.find((s) => s.content.kind === 'item')!.side).toBe('left');
  });

  it('mixed aspects share the page box (straight spine) and letterbox inside it', () => {
    const items = [item(1, 'page', 1024, 1024), item(2, 'page', 800, 1200)];
    const [v] = bookViews(items, 'spread');
    const g = bookGeometry({ view: v, stage: { w: 1280, h: 800 }, layout: 'spread', rtl: false, aspectOf: (i) => items[i].asset.w! / items[i].asset.h!, pageAspect: A23, widthClass: 'large' });
    expect(g.slots[0].h).toBe(g.slots[1].h);
    expect(g.slots[0].w).toBe(g.slots[1].w);
    expect(g.spineX).toBeCloseTo(g.page.w, 6);
    const box = letterbox(g.slots[0].w, g.slots[0].h, g.slots[0].contentAspect);
    expect(box.w).toBeCloseTo(g.slots[0].w, 6);
    expect(box.h).toBeLessThan(g.slots[0].h);
  });

  it('fits inside the stage with desk margins; phone landscape fit:width fills the width', () => {
    const [v] = bookViews(book(2), 'single');
    const g = bookGeometry({ view: v, stage: { w: 390, h: 760 }, layout: 'single', rtl: false, aspectOf: () => A23, pageAspect: A23, widthClass: 'compact' });
    expect(g.book.w).toBeLessThanOrEqual(390 - 20 + 1e-6);
    expect(g.book.h).toBeLessThanOrEqual(760 - 20 + 1e-6);
    const wide = bookGeometry({ view: v, stage: { w: 852, h: 393 }, layout: 'single', rtl: false, aspectOf: () => A23, pageAspect: A23, fit: 'width', widthClass: 'expanded' });
    expect(wide.page.w).toBeCloseTo(852, 6);
    expect(wide.book.x).toBeCloseTo(0, 6);
    expect(wide.page.h).toBeGreaterThan(393);
  });

  it('dual-screen: the spine sits on the hinge and no page crosses it', () => {
    const v = bookViews(book(3, false), 'spread', { endCard: false })[0];
    const g = bookGeometry({ view: v, stage: { w: 882, h: 1104 }, layout: 'spread', rtl: false, aspectOf: () => A23, pageAspect: A23, widthClass: 'expanded', hinge: { start: 431, end: 451 } });
    const left = g.slots[0];
    const right = g.slots[1];
    expect(g.book.x + left.x + left.w).toBeLessThanOrEqual(431 + 1e-6);
    expect(g.book.x + right.x).toBeGreaterThanOrEqual(451 - 1e-6);
    expect(g.gap).toBe(20);
  });
});
