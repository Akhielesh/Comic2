// One text measure / wrap / fit engine (contract §10.3, i18n.md §5) shared by the board, print,
// PNG/PDF/motion exports and the server's balloon sizing. Pure: no DOM, no canvas — callers pass a
// `measure` function (canvas measureText in the browser, registry estimates on the server/tests).
//
// Wrapping is script-aware:
//  - Normalization: NFC; ASCII spaces/tabs collapse; NBSP (U+00A0) / narrow NBSP (U+202F) stay glued
//    (French « Oui » / « Quoi ? » never split); an explicit "\n" is a hard break (Pro manual breaks).
//  - Spaced scripts (Latin, Indic, Arabic, Hangul): word units; a word longer than the line breaks
//    only at grapheme-cluster boundaries (Intl.Segmenter; fallback \P{M}\p{M}* + virama/ZWJ merge),
//    so a Hindi or Telugu conjunct (क्ष, స్కా) is never split.
//  - Unspaced scripts (Japanese, Chinese): Intl.Segmenter word units joined without spaces, then
//    kinsoku (。、ー… never start a line, 「（… never end one). Never inserts spaces, never hyphenates.
//
// Estimates: lang 'en' with the classic font reproduces the pre-v5 numbers exactly
// (balloonGeometry.ts balloonWidthForText / estimateBalloonHeight and server vision.ts).

import type { Box, LineKind } from './doc.js';
import { scriptOf, type ScriptSpec } from './languages.js';
import { FONT_REGISTRY } from './lettering/fonts.js';
import type { FontId } from './lettering/style.js';
import { LETTER_METRICS } from './lettering/style.js';

export interface WrapUnit {
  text: string;
  /** May break before this unit. */
  breakBefore: boolean;
  /** Join with a space when on the same line as the previous unit. */
  spaced: boolean;
  /** Explicit "\n" before this unit: always starts a new line. */
  hard?: boolean;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);

/** Server auto-size bounds (vision.ts MIN/MAX_BALLOON_W). */
const AUTO_MIN_W = 0.16;
const AUTO_MAX_W = 0.34;
/** Total horizontal / vertical padding of the estimates (2 × padX, 2 × padY). */
const PAD_W = 0.03;
const PAD_H = 0.026;
/** Never letter smaller than this many CSS px (balloonGeometry LETTERING.minFontPx). */
export const MIN_LETTER_FONT_PX = 9;
/** Auto-fit never grows a balloon wider than this fraction of the page. */
export const MAX_FIT_BALLOON_W = 0.42;
/** Auto-fit font floor relative to the base size (translations never become unreadable). */
export const FIT_FONT_FLOOR = 0.82;

// ── Normalization ────────────────────────────────────────────────────────────

/**
 * Lettering text normalization: NFC, CRLF → LF, ASCII spaces/tabs collapsed, NBSP/U+202F kept,
 * each explicit line trimmed, blank lines dropped (so "\n\n" is one hard break).
 */
export const normalizeLetteringText = (value: unknown): string => {
  if (typeof value !== 'string' || !value) return '';
  let t = value;
  try {
    t = t.normalize('NFC');
  } catch {
    /* keep as typed */
  }
  return t
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .split('\n')
    .map((s) => s.replace(/^ +| +$/g, ''))
    .filter(Boolean)
    .join('\n');
};

// ── Graphemes ────────────────────────────────────────────────────────────────

type SegmentLike = { segment: string; isWordLike?: boolean };
type SegmenterLike = { segment(input: string): Iterable<SegmentLike> };
type SegmenterCtor = new (locale?: string, opts?: { granularity: 'grapheme' | 'word' }) => SegmenterLike;

/** Read at call time so tests can remove Intl.Segmenter to exercise the fallback. */
const segmenterCtor = (): SegmenterCtor | undefined => (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;

const segmenterCache = new Map<string, { ctor: SegmenterCtor; seg: SegmenterLike }>();
const segmenterFor = (lang: string | undefined, granularity: 'grapheme' | 'word'): SegmenterLike | undefined => {
  const Ctor = segmenterCtor();
  if (typeof Ctor !== 'function') return undefined;
  const key = `${granularity}|${lang || ''}`;
  const hit = segmenterCache.get(key);
  if (hit && hit.ctor === Ctor) return hit.seg;
  try {
    const seg = new Ctor(lang || undefined, { granularity });
    segmenterCache.set(key, { ctor: Ctor, seg });
    return seg;
  } catch {
    try {
      const seg = new Ctor(undefined, { granularity });
      segmenterCache.set(key, { ctor: Ctor, seg });
      return seg;
    } catch {
      return undefined;
    }
  }
};

/** Indic viramas (Deva, Beng, Guru, Gujr, Taml, Telu, Knda, Mlym): a cluster ending in one joins the next. */
const VIRAMAS = new Set(['्', '্', '੍', '્', '்', '్', '್', '്']);
const JOINERS = new Set(['‍', '‌']);
const LETTER_START = /^\p{L}/u;
const SPACE_START = /^\s/u;

const lastChar = (s: string): string => {
  const chars = Array.from(s);
  return chars[chars.length - 1] ?? '';
};

/**
 * Merge conjunct clusters: a cluster ending in a virama joins a following letter cluster; a cluster
 * ending in (or consisting of) ZWJ/ZWNJ joins its neighbours. Reproduces Unicode 15.1 conjunct
 * clusters on engines without them and extends them to scripts ICU leaves split (e.g. Kannada).
 */
const mergeConjuncts = (clusters: string[]): string[] => {
  const out: string[] = [];
  for (const c of clusters) {
    const prev = out.length ? out[out.length - 1] : undefined;
    if (prev !== undefined) {
      const tail = lastChar(prev);
      const first = Array.from(c)[0] ?? '';
      const joinVirama = VIRAMAS.has(tail) && LETTER_START.test(c);
      const joinZwj = (JOINERS.has(tail) || JOINERS.has(first)) && !SPACE_START.test(c);
      if (joinVirama || joinZwj) {
        out[out.length - 1] = prev + c;
        continue;
      }
    }
    out.push(c);
  }
  return out;
};

/** Grapheme clusters (Intl.Segmenter when available, else base+marks with virama/ZWJ merging). */
export const graphemes = (text: string, lang?: string): string[] => {
  const t = typeof text === 'string' ? text : '';
  if (!t) return [];
  const seg = segmenterFor(lang, 'grapheme');
  let clusters: string[] | undefined;
  if (seg) {
    try {
      clusters = Array.from(seg.segment(t), (s) => s.segment);
    } catch {
      clusters = undefined;
    }
  }
  if (!clusters) clusters = t.match(/\P{M}\p{M}*|\p{M}+/gu) ?? [];
  return mergeConjuncts(clusters);
};

const graphemeCount = (text: string, lang?: string): number => {
  // ASCII fast path (most dialogue): one grapheme per char.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(text)) return text.length;
  return graphemes(text, lang).length;
};

// ── Units ────────────────────────────────────────────────────────────────────

/** Kinsoku: never at the start of a line (small kana, closing brackets/quotes, punctuation, no-break spaces). */
const NO_LINE_START = new Set(
  Array.from('、。，．・：；！？!?）」』】〉》〕］｝〟’”%％,.;:)]}»›ー々ゝゞヽヾぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ…‥〜～\u00a0\u202f')
);
/** Kinsoku: never at the end of a line (opening brackets). */
const NO_LINE_END = new Set(Array.from('（「『【〈《〔［｛〝‘“([{'));

const LATIN_RUN = /^[\p{Script=Latin}\p{N}_'’-]$/u;

/** Word-ish segments for unspaced scripts (no Segmenter: graphemes, keeping Latin/digit runs together). */
const unspacedSegments = (para: string, lang: string): string[] => {
  const seg = segmenterFor(lang, 'word');
  if (seg) {
    try {
      return Array.from(seg.segment(para), (s) => s.segment);
    } catch {
      /* fall through */
    }
  }
  const out: string[] = [];
  let latin = false;
  for (const g of graphemes(para, lang)) {
    const isLatin = LATIN_RUN.test(g);
    if (isLatin && latin && out.length) out[out.length - 1] += g;
    else out.push(g);
    latin = isLatin;
  }
  return out;
};

const kinsoku = (units: { text: string; spaced: boolean }[], lang: string): { text: string; spaced: boolean }[] => {
  const out: { text: string; spaced: boolean }[] = [];
  // Line-start-forbidden characters attach to the previous unit.
  for (const u of units) {
    if (out.length && !u.spaced) {
      const gs = graphemes(u.text, lang);
      let k = 0;
      while (k < gs.length && NO_LINE_START.has(gs[k])) k += 1;
      if (k > 0) {
        out[out.length - 1] = { ...out[out.length - 1], text: out[out.length - 1].text + gs.slice(0, k).join('') };
        const rest = gs.slice(k).join('');
        if (rest) out.push({ text: rest, spaced: false });
        continue;
      }
    }
    out.push({ ...u });
  }
  // A unit ending in an opening bracket attaches to the next unit.
  for (let i = 0; i < out.length - 1; ) {
    const gs = graphemes(out[i].text, lang);
    if (NO_LINE_END.has(gs[gs.length - 1] ?? '') && !out[i + 1].spaced) {
      out[i] = { ...out[i], text: out[i].text + out[i + 1].text };
      out.splice(i + 1, 1);
      continue;
    }
    i += 1;
  }
  return out;
};

const paragraphUnits = (para: string, lang: string, spec: ScriptSpec): { text: string; spaced: boolean }[] => {
  if (spec.spaced) return para.split(' ').filter(Boolean).map((text) => ({ text, spaced: true }));
  const raw: { text: string; spaced: boolean }[] = [];
  let space = false;
  for (const s of unspacedSegments(para, lang)) {
    if (s === ' ' || /^ +$/.test(s)) {
      space = raw.length > 0;
      continue;
    }
    raw.push({ text: s, spaced: space });
    space = false;
  }
  return kinsoku(raw, lang);
};

/** Break opportunities for lettering in `lang`. */
export const wrapUnits = (text: string, lang: string): WrapUnit[] => {
  const t = normalizeLetteringText(text);
  if (!t) return [];
  const spec = scriptOf(lang);
  const out: WrapUnit[] = [];
  t.split('\n').forEach((para, pi) => {
    paragraphUnits(para, lang, spec).forEach((u, i) => {
      const first = i === 0;
      out.push({
        text: u.text,
        breakBefore: out.length > 0,
        spaced: first ? false : u.spaced,
        ...(first && pi > 0 ? { hard: true } : {})
      });
    });
  });
  return out;
};

// ── Wrap ─────────────────────────────────────────────────────────────────────

const wrapUnitList = (units: WrapUnit[], lang: string, maxWidth: number, measure: (s: string) => number): string[] => {
  if (!units.length) return [];
  const lines: string[] = [];
  let current = '';
  const pushLong = (word: string) => {
    let chunk = '';
    for (const g of graphemes(word, lang)) {
      // Kinsoku also holds inside a broken word: a forbidden mark hangs on the line it follows.
      if (chunk && measure(chunk + g) > maxWidth && !NO_LINE_START.has(g)) {
        lines.push(chunk);
        chunk = g;
      } else chunk += g;
    }
    return chunk;
  };
  for (const unit of units) {
    if (unit.hard && current) {
      lines.push(current);
      current = '';
    }
    const candidate = current ? `${current}${unit.spaced ? ' ' : ''}${unit.text}` : unit.text;
    if (measure(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = measure(unit.text) > maxWidth ? pushLong(unit.text) : unit.text;
  }
  if (current) lines.push(current);
  return lines;
};

const balancedUnitList = (units: WrapUnit[], lang: string, maxWidth: number, measure: (s: string) => number): string[] => {
  const greedy = wrapUnitList(units, lang, maxWidth, measure);
  if (greedy.length <= 1) return greedy;
  let lo = maxWidth * 0.4;
  let hi = maxWidth;
  for (let i = 0; i < 10; i += 1) {
    const mid = (lo + hi) / 2;
    if (wrapUnitList(units, lang, mid, measure).length <= greedy.length) hi = mid;
    else lo = mid;
  }
  return wrapUnitList(units, lang, hi, measure);
};

/** Greedy wrap; a unit longer than the line is broken at grapheme boundaries (never inside a cluster). */
export const wrapLines = (text: string, lang: string, maxWidth: number, measure: (s: string) => number): string[] =>
  wrapUnitList(wrapUnits(text, lang), lang, maxWidth, measure);

/** Narrowest width that keeps the greedy line count (CSS text-wrap: balance). */
export const wrapBalancedLines = (text: string, lang: string, maxWidth: number, measure: (s: string) => number): string[] =>
  balancedUnitList(wrapUnits(text, lang), lang, maxWidth, measure);

// ── Estimates (no canvas: server, tests, first paint) ────────────────────────

const CN_EM = FONT_REGISTRY['comic-neue'].avgAdvanceEm;

/** Grapheme advance relative to the classic calibration (charW): face ratio for Latin, script factor otherwise. */
const advanceFactor = (spec: ScriptSpec, fontId: FontId | undefined): number => {
  if (spec.id !== 'Latn') return spec.widthFactor;
  if (!fontId || !Object.prototype.hasOwnProperty.call(FONT_REGISTRY, fontId)) return 1;
  return FONT_REGISTRY[fontId].avgAdvanceEm / CN_EM;
};

/** Balloon width (page-width fraction) from text length. lang 'en' + Latin font ⇒ today's numbers exactly. */
export const estimateWidthForText = (text: string, lang: string, fontId?: FontId): number => {
  const spec = scriptOf(lang);
  const len = graphemeCount(normalizeLetteringText(text), lang) * advanceFactor(spec, fontId);
  const t = clamp((len - 12) / (110 - 12), 0, 1);
  return round4(AUTO_MIN_W + t * (AUTO_MAX_W - AUTO_MIN_W));
};

/**
 * Estimated balloon height as a fraction of the page HEIGHT (word-wrapped at width w).
 * Counted in graphemes over wrap units; Latin keeps the historical counter (byte-identical numbers,
 * including its first-word quirk), other scripts also count the extra lines of a long first unit.
 */
export const estimateTextHeight = (text: string, w: number, pageAspect: number, lang: string, fontId?: FontId): number => {
  const spec = scriptOf(lang);
  const legacy = spec.id === 'Latn';
  const charW = LETTER_METRICS.charW * advanceFactor(spec, fontId);
  const perLine = Math.max(6, Math.floor((w - PAD_W) / charW));
  let lines = 1;
  let current = 0;
  for (const unit of wrapUnits(text, lang)) {
    const len = graphemeCount(unit.text, lang);
    if (!len) continue;
    if (unit.hard && current > 0) {
      lines += 1;
      current = 0;
    }
    const sep = unit.spaced ? 1 : 0;
    if (current === 0) {
      if (legacy) current = Math.min(len, perLine);
      else {
        lines += Math.floor(Math.max(0, len - 1) / perLine);
        current = len % perLine || perLine;
      }
    } else if (current + sep + len <= perLine) current += sep + len;
    else {
      lines += 1 + Math.floor(Math.max(0, len - 1) / perLine);
      current = len % perLine || perLine;
    }
  }
  const lineFactor = spec.lineHeight / LETTER_METRICS.lineHeight;
  return round4((lines * LETTER_METRICS.lineH * lineFactor * spec.fontScale + PAD_H) * pageAspect);
};

// ── Auto-fit ─────────────────────────────────────────────────────────────────

export interface FitInput {
  text: string;
  lang: string;
  kind: LineKind;
  balloon: { x: number; y: number; w: number; fontScale?: number; pinned?: boolean };
  panel: Box;
  pageW: number;
  pageH: number;
  baseFontPx: number;
  measure: (s: string, fontPx: number) => number;
  /** Source-language height of this balloon (page px) — growth is bounded relative to it. */
  sourceHeightPx?: number;
  /** Line height in em, already script-adjusted (default: the script's lineHeight). */
  lineHeight?: number;
  /** Padding per side as page-WIDTH fractions (default LETTER_METRICS.padX / padY). */
  padX?: number;
  padY?: number;
}
export interface FitResult {
  w: number;
  fontPx: number;
  lines: string[];
  heightPx: number;
  overflow: boolean;
  grew: boolean;
  shrank: boolean;
}

/**
 * Deterministic auto-fit (board, print, PNG/PDF and motion agree because it depends only on the text,
 * font and page size): grow the width (unpinned, within the panel, ≤ 0.42) in 0.02 steps → shrink the
 * font in 4 % steps down to max(9px, 0.82 × base) → otherwise `overflow: true`. Never clips: an
 * overflowing result keeps every line (the balloon simply grows past the panel).
 */
export const fitBalloonText = (input: FitInput): FitResult => {
  const spec = scriptOf(input.lang);
  const pageW = Math.max(1, Number.isFinite(input.pageW) ? input.pageW : 1);
  const pageH = Math.max(1, Number.isFinite(input.pageH) ? input.pageH : pageW);
  const base = Math.max(1, (Number.isFinite(input.baseFontPx) ? input.baseFontPx : 16) * spec.fontScale * (input.balloon.fontScale ?? 1));
  const lineHeight = input.lineHeight && input.lineHeight > 0 ? input.lineHeight : spec.lineHeight;
  const padXpx = (input.padX ?? LETTER_METRICS.padX) * pageW;
  const padYpx = (input.padY ?? LETTER_METRICS.padY) * pageW;
  const units = wrapUnits(input.text, input.lang);
  const wrapAt = (wFrac: number, fontPx: number) =>
    balancedUnitList(units, input.lang, Math.max(1, wFrac * pageW - 2 * padXpx), (s) => input.measure(s, fontPx));
  const heightOf = (lines: string[], fontPx: number) => Math.max(1, lines.length) * fontPx * lineHeight + 2 * padYpx;

  const b = input.balloon;
  const panel = input.panel;
  const y = clamp(b.y, 0, 1);
  let room = (panel.y + panel.h - y) * pageH;
  if (!(room > 0)) room = (1 - y) * pageH; // balloon below its panel: the page bottom bounds it
  let maxH = room;
  if (typeof input.sourceHeightPx === 'number' && input.sourceHeightPx > 0) maxH = Math.min(maxH, input.sourceHeightPx * 1.45);

  let w = clamp(b.w, 0.02, 1);
  let fontPx = round2(base);
  let lines = wrapAt(w, fontPx);
  const done = (overflow: boolean, grew: boolean, shrank: boolean): FitResult => ({
    w: round4(w),
    fontPx,
    lines,
    heightPx: round2(heightOf(lines, fontPx)),
    overflow,
    grew,
    shrank
  });
  if (heightOf(lines, fontPx) <= maxH) return done(false, false, false);

  let grew = false;
  if (!b.pinned) {
    const limit = Math.min(MAX_FIT_BALLOON_W, Math.max(w, panel.x + panel.w - b.x), 1 - Math.max(0, b.x));
    while (w + 1e-9 < limit) {
      w = Math.min(limit, round4(w + 0.02));
      lines = wrapAt(w, fontPx);
      grew = true;
      if (heightOf(lines, fontPx) <= maxH) return done(false, true, false);
    }
  }

  const floor = round2(Math.max(MIN_LETTER_FONT_PX, FIT_FONT_FLOOR * base));
  let shrank = false;
  while (fontPx > floor + 1e-9) {
    fontPx = round2(Math.max(floor, fontPx * 0.96));
    lines = wrapAt(w, fontPx);
    shrank = true;
    if (heightOf(lines, fontPx) <= maxH) return done(false, grew, true);
  }
  return done(true, grew, shrank);
};
