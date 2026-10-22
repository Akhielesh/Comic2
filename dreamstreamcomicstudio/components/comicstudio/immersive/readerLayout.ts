// Reader layout (contract §13.4, reader.md §4, mobile.md §7.1). Pure: one decision used by the inline
// reader and the immersive reader, plus the book's view grouping and slot geometry.
//
// Rules (first match wins):
//   webtoon → scroll; an explicit "scroll" choice → scroll; strip → strip
//   explicit spread → spread when it fits, else single (silent fallback, as today)
//   explicit single (old stored 'page' maps here) → single
//   dual horizontal segments (foldable in book posture) → spread, one page per segment
//   phones (compact width) → single
//   phone landscape (compact height) → single, fit: 'width'
//   w ≥ 900 && w/h ≥ 1.05 && two pages ≥ 320 px wide each → spread
//   otherwise → single
// A spread shows the cover alone on its side (right for LTR, left for RTL) — the book box is always two
// page-widths wide, the empty half is the dark room — and, when the book's first page is a right-hand
// page, page 1 faces the inside cover (endpaper, carrying the dedication). The End card closes the book.

import type { ComicKind } from '../../../shared/comic/doc';
import type { FormFactor, HeightClass, Segments, WidthClass } from '../mobile/formFactor';
import { widthClassOf } from '../mobile/formFactor';
import type { ReaderItem } from '../reader/readerModel';

export type ReaderLayout = 'single' | 'spread' | 'scroll' | 'strip';
export type LayoutPref = 'auto' | 'single' | 'spread' | 'scroll';
export type ReaderFit = 'contain' | 'width';

/** Minimum page width in a spread, the minimum viewport width and landscape ratio for spreads. */
export const SPREAD_MIN_PAGE_W = 320;
export const SPREAD_MIN_VW = 900;
export const SPREAD_MIN_RATIO = 1.05;
/** Margin between the book and the edges of the room (inside the safe areas). */
export const deskMargin = (widthClass: WidthClass): number => (widthClass === 'compact' ? 10 : 24);

export interface LayoutInput {
  /** Stage size inside the safe areas (CSS px). */
  vw: number;
  vh: number;
  kind: ComicKind;
  pref: LayoutPref;
  /** Page width / height. */
  pageAspect: number;
  widthClass?: WidthClass;
  heightClass?: HeightClass;
  segments?: Segments;
}

export interface LayoutDecision {
  layout: ReaderLayout;
  fit: ReaderFit;
  /** Facing pages would fit here (the Spread option is offered). */
  allowSpread: boolean;
  /** Each page sits in its own screen segment (dual-screen foldables). */
  perSegment: boolean;
}

const finite = (n: number, fallback: number) => (Number.isFinite(n) && n > 0 ? n : fallback);

/** Map a stored layout choice (incl. the old inline values) to a preference. */
export const layoutPrefFrom = (stored: string | null | undefined): LayoutPref =>
  stored === 'spread' ? 'spread' : stored === 'page' || stored === 'single' ? 'single' : stored === 'scroll' ? 'scroll' : 'auto';

/** Two pages fit at ≥ 320 px wide each with desk margins, on a landscape viewport ≥ 900 px wide. */
export const spreadFits = (i: LayoutInput): boolean => {
  const vw = finite(i.vw, 0);
  const vh = finite(i.vh, 0);
  if (vw < SPREAD_MIN_VW || vh <= 0 || vw / vh < SPREAD_MIN_RATIO) return false;
  const margin = deskMargin(i.widthClass ?? widthClassOf(vw));
  const aspect = finite(i.pageAspect, 2 / 3);
  const pageH = Math.min(vh - 2 * margin, (vw - 2 * margin) / (2 * aspect));
  return pageH * aspect >= SPREAD_MIN_PAGE_W;
};

const dualHorizontal = (s?: Segments) => !!s && s.count === 2 && s.axis === 'horizontal';

export const decideLayout = (i: LayoutInput): LayoutDecision => {
  const widthClass = i.widthClass ?? widthClassOf(finite(i.vw, 1024));
  const heightClass = i.heightClass ?? (finite(i.vh, 768) < 480 ? 'compact' : 'regular');
  const dual = dualHorizontal(i.segments);
  const fits = spreadFits({ ...i, widthClass });
  const allowSpread = dual || (widthClass !== 'compact' && fits);
  const base = { allowSpread, perSegment: false, fit: 'contain' as ReaderFit };
  if (i.kind === 'webtoon' || i.pref === 'scroll') return { ...base, layout: 'scroll', allowSpread: false };
  if (i.kind === 'strip') return { ...base, layout: 'strip', allowSpread: false };
  const phoneLandscape = heightClass === 'compact' && !dual;
  const single = (): LayoutDecision => ({ ...base, layout: 'single', fit: phoneLandscape ? 'width' : 'contain' });
  const spread = (): LayoutDecision => ({ ...base, layout: 'spread', perSegment: dual });
  if (i.pref === 'spread') return allowSpread ? spread() : single();
  if (i.pref === 'single') return single();
  if (dual) return spread();
  if (widthClass === 'compact') return single();
  if (phoneLandscape) return single();
  return fits ? spread() : single();
};

export const layoutFor = (i: LayoutInput): ReaderLayout => decideLayout(i).layout;

/** mobile.md §7.1 signature: the decision for a measured stage on a classified device. */
export function readerLayout(
  ff: Pick<FormFactor, 'widthClass' | 'heightClass' | 'segments'>,
  stage: { w: number; h: number },
  pageAspect: number,
  kind: ComicKind,
  pref: LayoutPref = 'auto'
): LayoutDecision {
  return decideLayout({ vw: stage.w, vh: stage.h, kind, pref, pageAspect, widthClass: ff.widthClass, heightClass: ff.heightClass, segments: ff.segments });
}

// ── Views ────────────────────────────────────────────────────────────────────

export type SlotContent =
  | { kind: 'item'; index: number }
  /** Inside cover (front: may carry the dedication; back: plain). */
  | { kind: 'endpaper'; side: 'front' | 'back' }
  | { kind: 'end' }
  /** The dark room (empty half of a spread). */
  | { kind: 'blank' };

export interface BookView {
  /** Reading order: [first, second] for spreads, [only] otherwise. */
  slots: SlotContent[];
  /** Item indexes on this view (reading order). */
  items: number[];
  /** Stable key (React + resume). */
  key: string;
}

export interface BookViewOptions {
  /** Close with the End card (default true). */
  endCard?: boolean;
  /** Spreads: page 1 is a right-hand page facing the inside cover (BookSettings.firstPageRight). */
  firstPageRight?: boolean;
}

const slotKey = (s: SlotContent) => (s.kind === 'item' ? `i${s.index}` : s.kind === 'endpaper' ? `ep-${s.side}` : s.kind);

const viewOf = (slots: SlotContent[]): BookView => ({
  slots,
  items: slots.flatMap((s) => (s.kind === 'item' ? [s.index] : [])),
  key: slots.map(slotKey).join('|')
});

/**
 * Group reader items into views. Single-page layouts: one item per view. Spreads: the cover alone on
 * its side, then facing pairs (page 1 opposite the inside cover when it is a right-hand page), the End
 * card on the right of the last page (or opposite the inside back cover).
 */
export const bookViews = (items: ReaderItem[], layout: ReaderLayout, opts: BookViewOptions = {}): BookView[] => {
  const endCard = opts.endCard !== false;
  const views: BookView[] = [];
  if (layout !== 'spread') {
    items.forEach((_, i) => views.push(viewOf([{ kind: 'item', index: i }])));
    if (endCard && items.length) views.push(viewOf([{ kind: 'end' }]));
    return views;
  }
  let i = 0;
  const hasCover = items[0]?.kind === 'cover';
  if (hasCover) {
    views.push(viewOf([{ kind: 'blank' }, { kind: 'item', index: 0 }]));
    i = 1;
    if (opts.firstPageRight !== false && i < items.length) {
      views.push(viewOf([{ kind: 'endpaper', side: 'front' }, { kind: 'item', index: i }]));
      i += 1;
    }
  }
  for (; i < items.length; i += 2) {
    if (i + 1 < items.length) views.push(viewOf([{ kind: 'item', index: i }, { kind: 'item', index: i + 1 }]));
    else views.push(viewOf([{ kind: 'item', index: i }, endCard ? { kind: 'end' } : { kind: 'blank' }]));
  }
  const last = views[views.length - 1];
  const endShown = !!last?.slots.some((s) => s.kind === 'end');
  if (endCard && items.length && !endShown) views.push(viewOf([{ kind: 'endpaper', side: 'back' }, { kind: 'end' }]));
  return views;
};

/** The view showing an item (stay on the same page across layout changes). */
export const viewIndexOfItem = (views: BookView[], itemIndex: number): number => {
  const v = views.findIndex((view) => view.items.includes(itemIndex));
  return v >= 0 ? v : 0;
};

/** The first item of a view, or the nearest earlier one (End card / endpaper views). */
export const firstItemOfView = (views: BookView[], view: number): number => {
  for (let v = Math.min(view, views.length - 1); v >= 0; v -= 1) {
    const first = views[v]?.items[0];
    if (first !== undefined) return first;
  }
  return 0;
};

// ── Geometry ─────────────────────────────────────────────────────────────────

export type SlotSide = 'left' | 'right' | 'center';

export interface SlotRect {
  content: SlotContent;
  /** Book-box coordinates (CSS px). */
  x: number;
  y: number;
  w: number;
  h: number;
  side: SlotSide;
  /** Aspect of the content drawn letterboxed inside the slot. */
  contentAspect: number;
}

export interface BookGeometry {
  /** Book box size and its position in the stage (centered; may exceed the stage height with fit: width). */
  book: { x: number; y: number; w: number; h: number };
  /** Page box (one slot) size. */
  page: { w: number; h: number };
  /** Spine x in book coordinates (spreads), or the page's inner edge (single: left for LTR, right for RTL). */
  spineX: number;
  /** Slots in SCREEN order (left, right) for spreads. */
  slots: SlotRect[];
  /** Gap between the two pages (dual-screen hinge), 0 otherwise. */
  gap: number;
}

export interface GeometryInput {
  view: BookView;
  /** Stage size inside safe areas. */
  stage: { w: number; h: number };
  layout: ReaderLayout;
  rtl: boolean;
  /** Aspect (w/h) of an item. */
  aspectOf: (itemIndex: number) => number;
  /** Aspect for non-item slots (endpaper, End card, blank) — the book's page aspect. */
  pageAspect: number;
  fit?: ReaderFit;
  widthClass?: WidthClass;
  /** Dual-screen hinge in stage coordinates (perSegment spreads). */
  hinge?: { start: number; end: number };
  /** Extra scale (guided crisp settle / zoom): the book is laid out at s× its fit size. */
  scale?: number;
}

const contentAspect = (c: SlotContent, aspectOf: (i: number) => number, pageAspect: number) =>
  c.kind === 'item' ? finite(aspectOf(c.index), pageAspect) : pageAspect;

export const bookGeometry = (g: GeometryInput): BookGeometry => {
  const stageW = finite(g.stage.w, 1);
  const stageH = finite(g.stage.h, 1);
  const margin = deskMargin(g.widthClass ?? widthClassOf(stageW));
  const availW = Math.max(1, stageW - 2 * margin);
  const availH = Math.max(1, stageH - 2 * margin);
  const scale = finite(g.scale ?? 1, 1);
  const pageAspect = finite(g.pageAspect, 2 / 3);
  const aspects = g.view.slots.map((s) => contentAspect(s, g.aspectOf, pageAspect));
  // The page box is the book's trim for EVERY view (stable geometry: turns between views line up);
  // pages of another shape are letterboxed on paper inside it.
  if (g.layout !== 'spread') {
    const a = pageAspect;
    let pw: number;
    let ph: number;
    if (g.fit === 'width') {
      pw = availW;
      ph = pw / a;
    } else {
      ph = Math.min(availH, availW / a);
      pw = ph * a;
    }
    pw *= scale;
    ph *= scale;
    const x = (stageW - pw) / 2;
    const y = g.fit === 'width' ? Math.max(margin, (stageH - ph) / 2) : (stageH - ph) / 2;
    return {
      book: { x, y, w: pw, h: ph },
      page: { w: pw, h: ph },
      spineX: g.rtl ? pw : 0,
      slots: [{ content: g.view.slots[0] ?? { kind: 'blank' }, x: 0, y: 0, w: pw, h: ph, side: 'center', contentAspect: aspects[0] ?? a }],
      gap: 0
    };
  }
  // Spread: both slots share the trim page box (straight spine); each page is letterboxed inside its slot.
  const a = pageAspect;
  const hinge = g.hinge && g.hinge.end > g.hinge.start ? g.hinge : undefined;
  const gap = hinge ? Math.max(0, hinge.end - hinge.start) : 0;
  let ph: number;
  let pw: number;
  if (hinge) {
    // One page per segment: each page fits its own segment, the spine sits on the hinge.
    const segW = Math.max(1, Math.min(hinge.start, stageW - hinge.end) - margin);
    ph = Math.min(availH, segW / a);
    pw = ph * a;
  } else {
    ph = Math.min(availH, availW / (2 * a));
    pw = ph * a;
  }
  pw *= scale;
  ph *= scale;
  const bookW = 2 * pw + gap;
  const x = hinge ? (hinge.start + hinge.end) / 2 - bookW / 2 : (stageW - bookW) / 2;
  const y = (stageH - ph) / 2;
  const [first, second] = [g.view.slots[0] ?? { kind: 'blank' as const }, g.view.slots[1] ?? { kind: 'blank' as const }];
  const [firstA, secondA] = [aspects[0] ?? a, aspects[1] ?? a];
  const leftC = g.rtl ? second : first;
  const rightC = g.rtl ? first : second;
  const leftA = g.rtl ? secondA : firstA;
  const rightA = g.rtl ? firstA : secondA;
  return {
    book: { x, y, w: bookW, h: ph },
    page: { w: pw, h: ph },
    spineX: pw + gap / 2,
    slots: [
      { content: leftC, x: 0, y: 0, w: pw, h: ph, side: 'left', contentAspect: leftA },
      { content: rightC, x: pw + gap, y: 0, w: pw, h: ph, side: 'right', contentAspect: rightA }
    ],
    gap
  };
};

/** Content box of a slot (letterboxed at its aspect, centered), relative to the slot. */
export const letterbox = (slotW: number, slotH: number, aspect: number): { x: number; y: number; w: number; h: number } => {
  const a = finite(aspect, slotW / Math.max(1, slotH));
  let w = slotW;
  let h = w / a;
  if (h > slotH) {
    h = slotH;
    w = h * a;
  }
  return { x: (slotW - w) / 2, y: (slotH - h) / 2, w, h };
};
