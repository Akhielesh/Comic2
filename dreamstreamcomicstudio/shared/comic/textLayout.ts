// Text measure / wrap / fit engine (contract §10.3). WAVE-0 STUB with the final signatures:
// Latin space-wrap plus today's Latin estimates (byte-identical to balloonGeometry.ts
// balloonWidthForText / estimateBalloonHeight). P1-LETTER-ENGINE replaces the implementation
// with script-aware units (Intl.Segmenter, viramas, kinsoku) and calibrated estimates.

import type { LineKind } from './doc.js';
import type { FontId } from './lettering/style.js';
import { LETTER_METRICS } from './lettering/style.js';

export interface WrapUnit { text: string; breakBefore: boolean; spaced: boolean }

const clean = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);

/** Server auto-size bounds (vision.ts MIN/MAX_BALLOON_W). */
const AUTO_MIN_W = 0.16;
const AUTO_MAX_W = 0.34;
const PAD_W = 0.03;
const PAD_H = 0.026;

/** Stub: space-separated words (every script treated as spaced). */
export const wrapUnits = (text: string, _lang: string): WrapUnit[] =>
  clean(text).split(' ').filter(Boolean).map((w, i) => ({ text: w, breakBefore: i > 0, spaced: true }));

type SegmenterLike = { segment(input: string): Iterable<{ segment: string }> };
/** Grapheme clusters (Intl.Segmenter when available, else code points). */
export const graphemes = (text: string, lang?: string): string[] => {
  const t = typeof text === 'string' ? text : '';
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => SegmenterLike }).Segmenter;
  if (Seg) {
    try {
      return Array.from(new Seg(lang || undefined, { granularity: 'grapheme' }).segment(t), (s) => s.segment);
    } catch {
      /* fall through */
    }
  }
  return Array.from(t);
};

/** Greedy wrap; a unit longer than the line is broken at grapheme boundaries. */
export const wrapLines = (text: string, lang: string, maxWidth: number, measure: (s: string) => number): string[] => {
  const units = wrapUnits(text, lang);
  if (!units.length) return [];
  const lines: string[] = [];
  let current = '';
  const pushLong = (word: string) => {
    let chunk = '';
    for (const g of graphemes(word, lang)) {
      if (chunk && measure(chunk + g) > maxWidth) {
        lines.push(chunk);
        chunk = g;
      } else chunk += g;
    }
    return chunk;
  };
  for (const { text: word } of units) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = measure(word) > maxWidth ? pushLong(word) : word;
  }
  if (current) lines.push(current);
  return lines;
};

/** Narrowest width that keeps the greedy line count (CSS text-wrap: balance). */
export const wrapBalancedLines = (text: string, lang: string, maxWidth: number, measure: (s: string) => number): string[] => {
  const greedy = wrapLines(text, lang, maxWidth, measure);
  if (greedy.length <= 1) return greedy;
  let lo = maxWidth * 0.4;
  let hi = maxWidth;
  for (let i = 0; i < 10; i += 1) {
    const mid = (lo + hi) / 2;
    if (wrapLines(text, lang, mid, measure).length <= greedy.length) hi = mid;
    else lo = mid;
  }
  return wrapLines(text, lang, hi, measure);
};

/** Balloon width (page-width fraction) from text length. lang 'en' + Latin font ⇒ today's numbers exactly. */
export const estimateWidthForText = (text: string, _lang: string, _fontId?: FontId): number => {
  const len = clean(text).length;
  const t = clamp((len - 12) / (110 - 12), 0, 1);
  return round4(AUTO_MIN_W + t * (AUTO_MAX_W - AUTO_MIN_W));
};

/** Estimated balloon height as a fraction of the page HEIGHT (word-wrapped at width w). */
export const estimateTextHeight = (text: string, w: number, pageAspect: number, _lang: string, _fontId?: FontId): number => {
  const perLine = Math.max(6, Math.floor((w - PAD_W) / LETTER_METRICS.charW));
  let lines = 1;
  let current = 0;
  for (const word of clean(text).split(' ')) {
    if (!word) continue;
    const len = word.length;
    if (current === 0) current = Math.min(len, perLine);
    else if (current + 1 + len <= perLine) current += 1 + len;
    else {
      lines += 1 + Math.floor(Math.max(0, len - 1) / perLine);
      current = len % perLine || perLine;
    }
  }
  return round4((lines * LETTER_METRICS.lineH + PAD_H) * pageAspect);
};

export interface FitInput {
  text: string; lang: string; kind: LineKind;
  balloon: { x: number; y: number; w: number; fontScale?: number; pinned?: boolean };
  panel: { x: number; y: number; w: number; h: number }; pageW: number; pageH: number; baseFontPx: number;
  measure: (s: string, fontPx: number) => number;
  sourceHeightPx?: number;
}
export interface FitResult { w: number; fontPx: number; lines: string[]; heightPx: number; overflow: boolean; grew: boolean; shrank: boolean }

/** Stub: wraps at the stored width and font; never grows/shrinks; never clips. */
export const fitBalloonText = (input: FitInput): FitResult => {
  const fontPx = input.baseFontPx * (input.balloon.fontScale ?? 1);
  const innerW = Math.max(1, input.balloon.w * input.pageW - 2 * LETTER_METRICS.padX * input.pageW);
  const lines = wrapLines(input.text, input.lang, innerW, (s) => input.measure(s, fontPx));
  const heightPx = lines.length * fontPx * LETTER_METRICS.lineHeight + 2 * LETTER_METRICS.padY * input.pageW;
  return { w: input.balloon.w, fontPx, lines, heightPx, overflow: false, grew: false, shrank: false };
};
