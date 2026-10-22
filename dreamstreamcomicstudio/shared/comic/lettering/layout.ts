// THE renderer contract (contract §10.2): board SVG, canvas export, print and motion all draw LetterPlans.
// WAVE-0 STUB: planLettering returns [] and renderers keep their current code until wave 2.

import type { ComicDoc, LineKind, Page } from '../doc.js';
import type { FontId, LetterStyle } from './style.js';
import type { BubbleGeometry } from './shapes.js';

export type Measure = (text: string, font: string) => number; // width in page units (W = 1000)
export interface GlyphRun { text: string; x: number; y: number; xs?: number[]; rotates?: number[] }
export interface LetterPlan {
  lineId: string; kind: LineKind; panelN: number; lang: string; dir: 'ltr' | 'rtl'; fallback: boolean;
  style: LetterStyle; fontId: FontId;
  x: number; y: number; w: number; h: number; // text box, page units (W = 1000, H = 1000/aspect)
  font: string; fontSize: number; lineHeight: number; pad: { x: number; y: number };
  runs: GlyphRun[]; // explicit lines/glyphs — never re-wrapped by a renderer
  geometry: BubbleGeometry; stroke: number;
  transform?: { rotate: number; skewX: number; cx: number; cy: number };
  z: number; locked: boolean; linkTo?: string;
  outOfSafeArea: boolean; // inspector warning
  overflow: boolean; // text did not fit even at the floor (never clipped)
}

/** Pure; memoized by (text, font, width, style hash). Uses textLayout wrap + fit. Works on a localized doc. */
export function planLettering(_doc: ComicDoc, _page: Page, _aspect: number, _measure: Measure): LetterPlan[] {
  return [];
}
