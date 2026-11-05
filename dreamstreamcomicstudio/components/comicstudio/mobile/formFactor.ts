// Window classes and the studio layout rule (mobile.md §2.1; contract §13.4). Pure: no DOM access,
// so every rule here is unit-tested and shared by the studio shell, the readers and the editor.
// Owner: P1-SHELL. The hook that feeds it lives in useFormFactor.ts.

export type WidthClass = 'compact' | 'medium' | 'expanded' | 'large'; // M3: <600, 600–839, 840–1199, ≥1200
export type HeightClass = 'compact' | 'regular'; // <480 = compact (phones in landscape)
export type StudioLayout = 'single' | 'single-rail' | 'split' | 'dual-screen';

export interface Segments {
  count: 1 | 2;
  axis: 'horizontal' | 'vertical' | null;
  rects: DOMRectReadOnly[];
  hinge?: { start: number; end: number };
}

export interface FormFactor {
  width: number;
  height: number;
  widthClass: WidthClass;
  heightClass: HeightClass;
  orientation: 'portrait' | 'landscape';
  /** (pointer: coarse) — primary input; drives the composer Enter rule. */
  coarse: boolean;
  /** (any-pointer: fine) — iPad with trackpad / Pencil hover. */
  anyFine: boolean;
  /** (hover: hover) */
  hover: boolean;
  segments: Segments;
  layout: StudioLayout;
  reducedMotion: boolean;
  /** navigator.connection?.saveData */
  saveData: boolean;
  /** (navigator.deviceMemory ?? 8) <= 4 */
  lowMemory: boolean;
}

/** The studio splits into conversation | board from this width (contract §13.4). */
export const SPLIT_MIN_WIDTH = 720;
/** Below this height the phone-landscape rail layout applies. */
export const COMPACT_HEIGHT = 480;

export const SINGLE_SEGMENT: Segments = { count: 1, axis: null, rects: [] };

export const widthClassOf = (w: number): WidthClass => (w < 600 ? 'compact' : w < 840 ? 'medium' : w < 1200 ? 'expanded' : 'large');

/** Pure: window classes + layout. First match wins: dual-screen → single-rail → single → split. */
export function classifyViewport(i: { w: number; h: number; coarse: boolean; segments?: Segments }): Pick<
  FormFactor,
  'widthClass' | 'heightClass' | 'orientation' | 'layout'
> {
  const w = Number.isFinite(i.w) && i.w > 0 ? i.w : 1024;
  const h = Number.isFinite(i.h) && i.h > 0 ? i.h : 768;
  const heightClass: HeightClass = h < COMPACT_HEIGHT ? 'compact' : 'regular';
  const seg = i.segments ?? SINGLE_SEGMENT;
  const layout: StudioLayout =
    seg.count === 2 && seg.axis === 'horizontal' ? 'dual-screen' : heightClass === 'compact' ? 'single-rail' : w < SPLIT_MIN_WIDTH ? 'single' : 'split';
  return { widthClass: widthClassOf(w), heightClass, orientation: w >= h ? 'landscape' : 'portrait', layout };
}

/** Desktop defaults (SSR, tests without a window). */
export const DESKTOP_FORM_FACTOR: FormFactor = {
  width: 1024,
  height: 768,
  ...classifyViewport({ w: 1024, h: 768, coarse: false }),
  coarse: false,
  anyFine: true,
  hover: true,
  segments: SINGLE_SEGMENT,
  reducedMotion: false,
  saveData: false,
  lowMemory: false
};

/** Phones (portrait or landscape) show one pane at a time. */
export const isPhoneLayout = (layout: StudioLayout): boolean => layout === 'single' || layout === 'single-rail';

/**
 * Viewport segments from `window.viewport.segments` (Viewport Segments API) rects. Two rects side by
 * side are a book-posture foldable ('horizontal' axis, the hinge between them); two stacked rects are
 * tabletop posture ('vertical'). Anything else is one segment.
 */
export const segmentsFromRects = (rects: ArrayLike<DOMRectReadOnly> | null | undefined): Segments => {
  const list = rects ? Array.from(rects).filter((r) => r && r.width > 0 && r.height > 0) : [];
  if (list.length !== 2) return SINGLE_SEGMENT;
  const [a, b] = list[0].left <= list[1].left && list[0].top <= list[1].top ? list : [list[1], list[0]];
  const sideBySide = Math.abs(a.top - b.top) < 1 && b.left >= a.left + a.width - 1;
  const stacked = Math.abs(a.left - b.left) < 1 && b.top >= a.top + a.height - 1;
  if (sideBySide) return { count: 2, axis: 'horizontal', rects: [a, b], hinge: { start: a.left + a.width, end: b.left } };
  if (stacked) return { count: 2, axis: 'vertical', rects: [a, b], hinge: { start: a.top + a.height, end: b.top } };
  return SINGLE_SEGMENT;
};

/**
 * The side-by-side screens of a dual-screen device as x spans, so a popover can stay on one of them
 * (mobile.md §3.6). The media-query fallback — `(horizontal-viewport-segments: 2)` matched with no
 * Viewport Segments API — knows there are two screens but not their rects: the window is split in
 * half (the hinge of a book-posture device is centred). Null on one screen or stacked screens.
 */
export const sideBySideScreens = (segments: Segments, width: number): { left: number; right: number }[] | null => {
  if (segments.count !== 2 || segments.axis !== 'horizontal') return null;
  if (segments.rects.length === 2) return segments.rects.map((r) => ({ left: r.left, right: r.left + r.width }));
  if (!(Number.isFinite(width) && width > 0)) return null;
  const mid = width / 2;
  return [
    { left: 0, right: mid },
    { left: mid, right: width }
  ];
};

/** Minimum width of one split pane: 320 on small tablets (iPad mini portrait), 360 from 1024. */
export const minPanePx = (containerWidth: number): number => (containerWidth > 0 && containerWidth < 1024 ? 320 : 360);

/** Default conversation | board split (percent) for a window (mobile.md §3.3–§3.5). */
export const defaultSplitFor = (ff: Pick<FormFactor, 'width' | 'orientation' | 'coarse'>): [number, number] => {
  if (ff.width < 1024) return [42, 58];
  if (ff.coarse && ff.orientation === 'landscape' && ff.width < 1400) return [38, 62];
  return [40, 60];
};

/**
 * Touch windows narrower than this keep the medium header even from 1024: with 44 px targets AND the
 * pane switcher, the full labelled header (Share · Easy/Pro · Quality · $ · saved · usage · Read)
 * leaves an iPad Pro in portrait (1024 / 1032 wide) about 30 px for the comic's title.
 */
export const TOUCH_REGULAR_HEADER_MIN = 1100;

/**
 * How dense the studio header is:
 *  - 'compact'  phones (single / single-rail): ⋯ menu holds quality, mode, savings, settings;
 *  - 'medium'   split below 1024 (below 1100 on touch), and every dual-screen foldable (each half of
 *               the header has one screen): icon-only quality and Read, slots render their compact
 *               form, Easy/Pro in ⋯;
 *  - 'regular'  wider: today's desktop header.
 */
export type HeaderVariant = 'compact' | 'medium' | 'regular';
export const headerVariantFor = (ff: Pick<FormFactor, 'layout' | 'width'> & Partial<Pick<FormFactor, 'coarse'>>): HeaderVariant =>
  isPhoneLayout(ff.layout)
    ? 'compact'
    : ff.layout === 'dual-screen' || ff.width < 1024 || (ff.coarse === true && ff.width < TOUCH_REGULAR_HEADER_MIN)
      ? 'medium'
      : 'regular';

/** The header pane switcher (Chat | Both | Board) shows on touch tablets, foldables and narrow windows. */
export const showsPaneSwitcher = (ff: Pick<FormFactor, 'layout' | 'width' | 'coarse'>): boolean =>
  (ff.layout === 'split' || ff.layout === 'dual-screen') && (ff.coarse || ff.width < 1200);

/** Shallow equality used by the shared store so consumers only re-render on a real change. */
export const sameFormFactor = (a: FormFactor, b: FormFactor): boolean =>
  a.width === b.width &&
  a.height === b.height &&
  a.coarse === b.coarse &&
  a.anyFine === b.anyFine &&
  a.hover === b.hover &&
  a.reducedMotion === b.reducedMotion &&
  a.saveData === b.saveData &&
  a.lowMemory === b.lowMemory &&
  a.segments.count === b.segments.count &&
  a.segments.axis === b.segments.axis &&
  a.segments.hinge?.start === b.segments.hinge?.start &&
  a.segments.hinge?.end === b.segments.hinge?.end;
