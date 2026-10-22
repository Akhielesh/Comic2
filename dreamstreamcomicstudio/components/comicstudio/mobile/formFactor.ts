// Window classes and the studio layout rule (mobile.md §2.1; contract §13.4).
// Owner: P1-SHELL (wave 1). Wave 0 (P0-C): final types plus the pure classifier; the hook
// (useFormFactor.ts) is a minimal width-based version until P1-SHELL adds the shared store,
// segments, keyboard and media-query wiring.

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
