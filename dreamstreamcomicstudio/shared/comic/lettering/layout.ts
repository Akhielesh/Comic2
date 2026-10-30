// THE renderer contract (contract §10.2, lettering.md §6.1): the board SVG, canvas export, print and
// motion all draw LetterPlans. Renderers never re-wrap, re-measure or re-place anything — every line,
// glyph, outline and tail comes from here, so what the user arranges is exactly what exports.
//
// Units: page width W = 1000u, height H = 1000/aspect. The classic speech font is 17u, the base stroke
// 2.8u (renderers keep it ≥ 1.25 px at their scale). `measure(text, font)` returns a width in u for the
// font shorthand (whose px value is in u): canvas measureText in the browser once fonts are ready,
// `estimateMeasure` on the server, in tests and for the first paint.
//
// Pass a STABLE `measure` function (module-level or memoized): fit results are memoized per measure
// function (LRU 500), so re-rendering a page re-uses every wrap instead of re-measuring.
//
// Text runs: `x` is the anchor for `style.align` (center → middle, left → start, right → end) and `y` is
// the alphabetic baseline. When `xs` is present each glyph is drawn left-anchored at xs[i] (with
// ys/rotates/scales when present) — used for letter spacing and the SFX arched/pop effects.

import type { Balloon, Box, ComicDoc, Line, LineKind, Page } from '../doc.js';
import { SCRIPTS, scriptOf, type ScriptId, type ScriptSpec } from '../languages.js';
import { panelBoxesFor } from '../pageGeometry.js';
import { composeAspect, pageSpaceQc, type ComposePageShape } from '../panelize/space.js';
import { PUBLIC_QC_CHECKED_AT } from '../publication.js';
import { PANEL_LIMITS, panelWords, textBudget, textUnitFor } from '../panelRules.js';
import { isKidsAudience } from '../safety.js';
import { FIT_FONT_FLOOR, fitBalloonText, graphemes, normalizeLetteringText, wrapBalancedLines, wrapLines, wrapUnits, type FitResult, type WrapUnit } from '../textLayout.js';
import { FONT_REGISTRY, fontByFamily, fontString, resolveLetteringFont } from './fonts.js';
import { balloonFootprint, coverageOf, placeBalloonsDetailed, ROW_TOLERANCE, safeAreaBox, settleBalloons, type SettleItem, type SizedLine } from './place.js';
import { bubbleGeometry, hashSeed, resolveTailStyle, type BubbleGeometry } from './shapes.js';
import {
  DEFAULT_LETTERING,
  DEFAULT_SAFE_MARGIN,
  KIND_FONT_SCALE,
  LETTER_METRICS,
  resolveLetterStyle,
  type BubbleShape,
  type FontId,
  type LetterStyle,
  type TextCase
} from './style.js';

export type Measure = (text: string, font: string) => number; // width in page units (W = 1000)
export interface GlyphRun {
  text: string;
  x: number;
  y: number;
  xs?: number[];
  rotates?: number[];
  /** Per-glyph baselines (arched SFX). */
  ys?: number[];
  /** Per-glyph vertical scale (SFX 'pop' ramp 0.85 → 1.15). */
  scales?: number[];
}
export interface LetterPlan {
  lineId: string;
  kind: LineKind;
  panelN: number;
  lang: string;
  dir: 'ltr' | 'rtl';
  fallback: boolean;
  style: LetterStyle;
  fontId: FontId;
  x: number;
  y: number;
  w: number;
  h: number; // text box, page units (W = 1000, H = 1000/aspect)
  font: string;
  fontSize: number;
  lineHeight: number;
  pad: { x: number; y: number };
  runs: GlyphRun[]; // explicit lines/glyphs — never re-wrapped by a renderer
  geometry: BubbleGeometry;
  stroke: number;
  transform?: { rotate: number; skewX: number; cx: number; cy: number };
  z: number;
  locked: boolean;
  linkTo?: string;
  outOfSafeArea: boolean; // inspector warning
  /**
   * The text does not fit: not even at the floor (never clipped), or only by breaking a word across lines
   * ("EXPLANATI / ON" in a balloon stored too narrow). The editor says so and offers Widen.
   */
  overflow: boolean;
  /** Absolute tail tip (page units) after the render-time page fit; absent when the balloon has no tail (P2-AMEND). */
  tip?: { x: number; y: number };
  /** A software-placed line that could not avoid an overlap / face / the safe area (the editor's free-fix chip).
   *  Set only when true (P2-AMEND). */
  crowded?: boolean;
  /** Dense page: this (software-placed) balloon is lettered at this fraction of its size so the page fits. Set only when < 1. */
  densityScale?: number;
  /**
   * Why a crowded balloon is flagged (set with `crowded`): 'overlap' — it still overlaps another balloon (a
   * page with no free room left); 'order' — the only free room is where the reader meets it out of turn
   * (before its turn, or after a later line the owner fixed in its panel); 'outside' — no room in its
   * panel, so it sits beside it; 'moved' — moved to make room; 'cover' — moved (in memory) so its panel's lettering
   * covers less of the picture (the coverage cap; Keep here keeps it where it is drawn).
   */
  crowdedReason?: CrowdedReason;
  /**
   * Too much text for this panel (FX2): set on every plan of a panel whose lettering covers more of its picture
   * than the cap (coverCapFor) even at full size where the engine placed it best, and on every plan of a panel the
   * cap lettered smaller (`scale`). Absent under the cap, so a page whose panels all fit plans exactly as before.
   */
  dense?: LetterDensity;
}

export type CrowdedReason = 'overlap' | 'order' | 'outside' | 'moved' | 'cover';

/** What `LetterPlan.dense` says about a panel with more text than its picture can carry. */
export interface LetterDensity {
  /** The panel's number (panel.n). */
  panelN: number;
  /**
   * Share of the panel's picture its lettering covers where it was placed before the cap (stored balloons where they
   * are stored): fill × outline ∩ panel ÷ panel area.
   */
  cover: number;
  /** About how many words (characters, for Japanese and Chinese) the panel holds at the target fit. */
  fits: number;
  /** Words (characters) its balloons and captions carry. */
  words: number;
  /** The unit of `fits` and `words`. */
  unit: 'words' | 'chars';
  /** The cap that applies: 0.30, or 0.25 for children's books (PANEL_LIMITS.coverCap / coverCapKids). */
  cap: number;
  /** Share covered as drawn, after the engine re-placed or re-lettered the panel's movable balloons in memory. */
  drawn: number;
  /** The panel's movable balloons are lettered at this fraction of their size so it covers less (only when < 1). */
  scale?: number;
}

/** Page width in plan units. */
export const PLAN_W = 1000;

/**
 * Letter-fit policy (an owner decision, still open). `coverShrink`: when re-placing an over-cap panel's movable
 * balloons at full size cannot bring it under the cap, letter them smaller (COVER_STEPS). OFF by default, as the
 * investigation's FX2 decided: shrinking takes phone text from about 5.8 px to 4.8 px (RC8), so the cap only re-places
 * and the panel is flagged `dense` with its free fixes. Turning it on is this one line; it never goes below
 * FIT_FONT_FLOOR, children's books included.
 */
export const LETTER_FIT_POLICY: { coverShrink: boolean } = { coverShrink: false };

/**
 * The coverage cap's size steps (F8/FX2), when LETTER_FIT_POLICY.coverShrink is on: each panel over the cap is first
 * lettered again at full size (its movable balloons re-placed, partly across its border when that helps), then a
 * little smaller, panel by panel, never below the auto-fit floor. Pinned and locked balloons never move or shrink.
 */
export const COVER_STEPS: readonly number[] = [1, 0.9, FIT_FONT_FLOOR];

/** The size steps the cap may use now: full size only, unless the owner turned the shrink on. */
export const coverStepsFor = (policy: { coverShrink: boolean } = LETTER_FIT_POLICY): readonly number[] => (policy.coverShrink ? COVER_STEPS : [1]);

/** The coverage cap for a doc: PANEL_LIMITS.coverCap (0.30), or coverCapKids (0.25) for children's books. */
export function coverCapFor(doc: Pick<ComicDoc, 'format' | 'brief'>): number {
  try {
    return doc?.format && doc.brief && isKidsAudience(doc) ? PANEL_LIMITS.coverCapKids : PANEL_LIMITS.coverCap;
  } catch {
    return PANEL_LIMITS.coverCap;
  }
}

/**
 * The page is a public snapshot's published before its faces were: its page check is the snapshot's geometry-only one
 * (`checkedAt` PUBLIC_QC_CHECKED_AT) with no face lists. Where the faces are is unknown there, and its stored balloons
 * were placed around them by the page check, so the coverage cap never moves them blind: the reader draws them where
 * they are stored (as it did before the cap) and the panel is only flagged dense. A live page (a real check time)
 * and every snapshot published since (face lists always present) are capped exactly as the studio caps them.
 */
export const storedFrozen = (page: Pick<Page, 'render'>): boolean => {
  const qc = page.render?.qc;
  return !!qc && qc.checkedAt === PUBLIC_QC_CHECKED_AT && !Array.isArray(qc.keepOut) && !Array.isArray(qc.heads);
};

/** Elliptical outlines fill π/4 of their box; boxy ones all of it (density.ts needMeter uses outlineFill too). */
const BOXY_SHAPES: ReadonlySet<BubbleShape> = new Set<BubbleShape>(['rect', 'rounded_rect', 'notched', 'scroll', 'ribbon', 'electronic', 'none']);
/** Share of its outline box a balloon of this shape fills (coverage). */
export const outlineFill = (shape: BubbleShape): number => (BOXY_SHAPES.has(shape) ? 1 : Math.PI / 4);

/**
 * Placement options that keep a SAVED placement under the doc's coverage cap (the planner, tidy, the server's
 * free re-layout): spread them into placeBalloons / placeBalloonsWholeWords.
 */
export function placementCoverOptions(doc: ComicDoc): { coverCap: number; fillFor: (line: Line) => number } {
  return { coverCap: coverCapFor(doc), fillFor: (line) => outlineFill(resolveLetterStyle(doc, line).shape) };
}

/** A plan's outline (tail-less), plan units. */
const planOutline = (p: Pick<LetterPlan, 'x' | 'y' | 'geometry'>): Box => ({ x: p.x + p.geometry.bounds.x, y: p.y + p.geometry.bounds.y, w: p.geometry.bounds.w, h: p.geometry.bounds.h });

/**
 * How much of each panel's picture (by panel index) the drawn lettering covers: Σ fill × outline ∩ panel ÷ panel
 * area over every plan on the page (density.ts units; a balloon reaching in from another panel counts too).
 */
export function panelCoverage(doc: ComicDoc, page: Page, plans: readonly LetterPlan[], aspect?: number): number[] {
  const asp = Number.isFinite(aspect) && (aspect as number) > 0 ? (aspect as number) : letteringAspect(doc, page);
  const H = PLAN_W / asp;
  const boxes = panelBoxesFor(doc, page);
  const outlines = plans.map((p) => ({ outline: planOutline(p), fill: outlineFill(p.style.shape) }));
  return (page.panels || []).map((_p, i) => {
    const b = boxes[i];
    return b ? r4(coverageOf({ x: b.x * PLAN_W, y: b.y * H, w: b.w * PLAN_W, h: b.h * H }, outlines)) : 0;
  });
}
const INK = '#111111';
const SPOKEN: ReadonlySet<LineKind> = new Set<LineKind>(['speech', 'thought', 'whisper', 'shout']);
/** Render-time page margin for outlines (fraction of the page, visualqa §4). */
const PAGE_FIT_MARGIN = 0.008;

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const clampV = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);

// ── Small pure helpers ───────────────────────────────────────────────────────

/** Width / height of a page as shown: the render's pixel size when known, else the format's aspect; in panels mode
 *  (Ship 2) the book aspect the frames are laid out on. */
export function letteringAspect(doc: Pick<ComicDoc, 'format'>, page?: ComposePageShape | null): number {
  return composeAspect(doc, page);
}

const SFX_COLORS = ['#e63946', '#ffb703', '#fb5607', '#3a86ff', '#8338ec', '#06d6a0'];

/** Classic SFX colour and tilt (deterministic per line; same as balloonGeometry sfxStyle). */
export function sfxAutoStyle(lineId: string): { color: string; rotate: number } {
  const h = hashSeed(lineId || 'sfx');
  return { color: SFX_COLORS[h % SFX_COLORS.length], rotate: ((h >>> 8) % 13) - 6 };
}

/** Apply a style's text case for `lang` (caseless scripts are unaffected). */
export function applyTextCase(text: string, textCase: TextCase, lang: string): string {
  if (!text || textCase === 'as_typed' || scriptOf(lang).caseless) return text;
  const locale = lang || 'en';
  const up = (s: string) => {
    try {
      return s.toLocaleUpperCase(locale);
    } catch {
      return s.toUpperCase();
    }
  };
  if (textCase === 'upper') return up(text);
  if (textCase === 'lower') {
    try {
      return text.toLocaleLowerCase(locale);
    } catch {
      return text.toLowerCase();
    }
  }
  // title: capitalize each word's first letter, keep the rest as typed (McDuck stays McDuck).
  return text.replace(/(^|[\s  («“"'¿¡-])(\p{Ll})/gu, (_m, pre: string, ch: string) => pre + up(ch));
}

// ── Estimates without a canvas ───────────────────────────────────────────────

const CN_EM = FONT_REGISTRY['comic-neue'].avgAdvanceEm;
const NON_LATIN: [ScriptId, RegExp][] = (Object.keys(SCRIPTS) as ScriptId[])
  .filter((id) => id !== 'Latn' && id !== 'Aran')
  .map((id) => [id, SCRIPTS[id].letters]);
const FULL_WIDTH = /[　-〿＀-￯]/u;
const FONT_PX_RE = /(\d+(?:\.\d+)?)px\s+"([^"]+)"/;

/**
 * Registry-calibrated Measure (server, tests, first paint before fonts load). Latin graphemes use the
 * face's calibrated average advance (mixed-case value when the text has lowercase); other scripts use
 * their calibrated grapheme widthFactor. Deliberately a little wide (the historical 0.0105 calibration),
 * so estimated balloons are never too small for the real text.
 */
export const estimateMeasure: Measure = (text, font) => {
  const m = FONT_PX_RE.exec(font || '');
  const px = m ? Number(m[1]) : 17;
  const meta = (m && fontByFamily(m[2])) || FONT_REGISTRY['comic-neue'];
  if (!text) return 0;
  const latinEm = /\p{Ll}/u.test(text) ? meta.mixedCaseEm ?? meta.avgAdvanceEm : meta.avgAdvanceEm;
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(text)) return text.length * latinEm * px;
  let em = 0;
  for (const g of graphemes(text)) {
    if (FULL_WIDTH.test(g)) {
      em += SCRIPTS.Jpan.widthFactor * CN_EM;
      continue;
    }
    const hit = NON_LATIN.find(([, re]) => re.test(g));
    em += hit ? SCRIPTS[hit[0]].widthFactor * CN_EM : latinEm;
  }
  return em * px;
};

// ── Per-line setup (style, font, sizes) ──────────────────────────────────────

interface LineSetup {
  line: Line;
  lang: string;
  spec: ScriptSpec;
  style: LetterStyle;
  fontId: FontId;
  weight: number;
  italic: boolean;
  synthItalic: boolean;
  text: string;
  /** Size before the script's fontScale (fitBalloonText applies it). */
  baseSize: number;
  lineHeight: number;
  pad: { x: number; y: number };
  stroke: number;
  fontAt: (px: number) => string;
  measureAt: (s: string, px: number) => number;
  /** Glyph-level layout allowed (letter spacing / SFX effects never split complex-script shaping). */
  glyphs: boolean;
}

const lineSetup = (doc: ComicDoc, line: Line, measure: Measure): LineSetup => {
  const lang = line.lang || doc.format?.language || 'en';
  const spec = scriptOf(lang);
  const raw = resolveLetterStyle(doc, line);
  const auto = line.kind === 'sfx' ? sfxAutoStyle(line.id) : null;
  const style: LetterStyle = {
    ...raw,
    textColor: raw.textColor === 'auto' ? auto?.color ?? INK : raw.textColor,
    fill: raw.fill === 'auto' ? '#ffffff' : raw.fill,
    border: raw.border === 'auto' ? INK : raw.border,
    letterSpacing: spec.allowLetterSpacing ? raw.letterSpacing : 0,
    italic: raw.italic && spec.allowItalic,
    rotate: raw.rotate === 'auto' ? auto?.rotate ?? 0 : raw.rotate
  };
  const rf = resolveLetteringFont(style.font, line.kind, lang, { weight: style.weight, italic: style.italic });
  const meta = FONT_REGISTRY[rf.fontId];
  const fontAt = (px: number) => fontString(rf.fontId, px, rf.weight, rf.italic);
  const spacing = style.letterSpacing;
  const measureAt = (s: string, px: number) => {
    const base = measure(s, fontAt(px));
    const width = Number.isFinite(base) && base > 0 ? base : 0;
    return spacing ? width + spacing * px * Math.max(0, graphemes(s, lang).length - 1) : width;
  };
  return {
    line,
    lang,
    spec,
    style,
    fontId: rf.fontId,
    weight: rf.weight,
    italic: rf.italic,
    synthItalic: style.italic && !meta.italic,
    text: applyTextCase(normalizeLetteringText(line.text), style.textCase, lang),
    baseSize: PLAN_W * LETTER_METRICS.fontScale * (KIND_FONT_SCALE[line.kind] ?? 1) * style.sizeScale,
    lineHeight: style.lineHeight * (spec.lineHeight / LETTER_METRICS.lineHeight),
    pad: { x: PLAN_W * LETTER_METRICS.padX * style.padding, y: PLAN_W * LETTER_METRICS.padY * style.padding },
    stroke: r2(PLAN_W * LETTER_METRICS.strokeScale * style.borderWidth),
    fontAt,
    measureAt,
    glyphs: spec.allowLetterSpacing
  };
};

// ── Memo (LRU 500 per measure function) ──────────────────────────────────────

const MEMO_SIZE = 500;
const FIT_MEMO = new WeakMap<Measure, Map<string, FitResult>>();
const memoFit = (measure: Measure, key: string, compute: () => FitResult): FitResult => {
  let memo = FIT_MEMO.get(measure);
  if (!memo) {
    memo = new Map();
    FIT_MEMO.set(measure, memo);
  }
  const hit = memo.get(key);
  if (hit) {
    memo.delete(key);
    memo.set(key, hit);
    return hit;
  }
  const value = compute();
  memo.set(key, value);
  if (memo.size > MEMO_SIZE) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  return value;
};

/** Text box of one line at a stored balloon: fit (body text) or word-fit (SFX). Units: u. */
const layoutText = (
  setup: LineSetup,
  measure: Measure,
  b: { x: number; y: number; w: number; pinned: boolean; growLeft?: boolean; wordFit?: number },
  panel: Box,
  H: number
): { w: number; h: number; fontSize: number; lines: string[]; overflow: boolean } => {
  const { style, lang, text, pad, lineHeight } = setup;
  const key = [lang, setup.fontId, setup.weight, setup.italic ? 1 : 0, style.letterSpacing, r4(setup.baseSize), r4(lineHeight), r4(pad.x), r4(pad.y), setup.line.kind === 'sfx' ? 1 : 0, r4(b.x), r4(b.y), r4(b.w), b.pinned ? 1 : 0, b.growLeft ? 1 : 0, r4(panel.x), r4(panel.y), r4(panel.w), r4(panel.h), r2(H), b.wordFit === undefined ? '' : r4(b.wordFit), text].join('|');
  const fit = memoFit(measure, key, () => {
    if (setup.line.kind === 'sfx') {
      // Display lettering sized to the box: the longest word fits 94 % of the balloon width.
      const boxW = b.w * PLAN_W;
      let size = setup.baseSize * setup.spec.fontScale;
      const words = text.split(/[ \n]/).filter(Boolean);
      const longest = Math.max(0, ...words.map((w) => setup.measureAt(w, size)));
      if (longest > 0 && longest > boxW * 0.94) size = Math.max(1, (size * boxW * 0.94) / longest);
      size = r2(size);
      const inner = Math.max(boxW - 2 * pad.x, ...words.map((w) => setup.measureAt(w, size)));
      const lines = wrapBalancedLines(text, lang, inner, (s) => setup.measureAt(s, size));
      return { w: r4(b.w), fontPx: size, lines, heightPx: r2(Math.max(1, lines.length) * size * lineHeight + 2 * pad.y), overflow: false, grew: false, shrank: false };
    }
    const fit = fitBalloonText({
      text,
      lang,
      kind: setup.line.kind,
      balloon: { x: b.x, y: b.y, w: b.w, pinned: b.pinned },
      panel,
      pageW: PLAN_W,
      pageH: H,
      baseFontPx: setup.baseSize,
      measure: (s, px) => setup.measureAt(s, px),
      lineHeight,
      padX: pad.x / PLAN_W,
      padY: pad.y / PLAN_W,
      ...(b.growLeft ? { growLeft: true } : {}),
      ...(b.wordFit !== undefined ? { minWordFit: { maxW: b.wordFit } } : {})
    });
    // Balancing narrows the lines as far as the line count allows, and on a narrow balloon that can split a word
    // the plain wrap keeps whole ("EXPLANATI / ON"). Then the plain wrap is lettered: same lines, same height.
    const units = wrapUnits(text, lang);
    if (fit.lines.length > 1 && splitsUnit(fit.lines, units)) {
      const plain = wrapLines(text, lang, Math.max(1, fit.w * PLAN_W - 2 * pad.x), (s) => setup.measureAt(s, fit.fontPx));
      if (plain.length === fit.lines.length && !splitsUnit(plain, units)) return { ...fit, lines: plain };
    }
    return fit;
  });
  return { w: fit.w * PLAN_W, h: fit.heightPx, fontSize: fit.fontPx, lines: fit.lines, overflow: fit.overflow };
};

/** A line's lettering breaks a word across lines (a sound effect is sized to its box and never does). */
const splitsWord = (setup: LineSetup, lines: readonly string[]): boolean =>
  setup.line.kind !== 'sfx' && lines.length > 1 && splitsUnit(lines, wrapUnits(setup.text, setup.lang));

/** The wrapped lines break inside a wrap unit (a word, or an unspaced script's unbreakable cluster). */
const splitsUnit = (lines: readonly string[], units: readonly WrapUnit[]): boolean => {
  let u = 0;
  for (const line of lines) {
    let rest = line;
    while (rest) {
      const t = units[u]?.text;
      if (!t || !rest.startsWith(t)) return true;
      rest = rest.slice(t.length).replace(/^ +/, '');
      u += 1;
    }
  }
  return u !== units.length;
};

const WORD_MEMO = new WeakMap<Measure, Map<string, number>>();
/** The widest wrap unit (word) of a line's lettering at a font size, in plan units; memoized like the fits. */
const longestWord = (setup: LineSetup, measure: Measure, px: number): number => {
  let memo = WORD_MEMO.get(measure);
  if (!memo) {
    memo = new Map();
    WORD_MEMO.set(measure, memo);
  }
  const key = [setup.lang, setup.fontId, setup.weight, setup.italic ? 1 : 0, setup.style.letterSpacing, r4(px), setup.text].join('|');
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let longest = 0;
  for (const u of wrapUnits(setup.text, setup.lang)) longest = Math.max(longest, setup.measureAt(u.text, px));
  memo.set(key, longest);
  if (memo.size > MEMO_SIZE) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  return longest;
};

const geometryFor = (setup: LineSetup, w: number, h: number, tip: { x: number; y: number } | null): BubbleGeometry =>
  bubbleGeometry(setup.style.shape, w, h, {
    inset: setup.pad,
    seed: hashSeed(setup.line.id),
    tip,
    tail: resolveTailStyle(setup.style.tail, setup.line.kind, setup.style.shape),
    tailWidth: setup.style.tailWidth,
    stroke: setup.stroke || 1,
    rtl: setup.spec.dir === 'rtl',
    borderStyle: setup.style.borderStyle
  });

/**
 * Dense pages: when the page cannot hold every software-placed balloon at full size without overlaps,
 * the renderer letters those balloons smaller (a letterer's point-size drop) in these steps; the last one
 * is below the auto-fit floor and only ever reached on a page that is over-full (the crowded chip says
 * so). Pinned and locked balloons keep the size their owner chose.
 */
export const DENSITY_STEPS: readonly number[] = [1, 0.9, FIT_FONT_FLOOR, 0.72];

const densify = (setup: LineSetup, scale: number): LineSetup => (scale >= 1 ? setup : { ...setup, baseSize: r2(setup.baseSize * scale) });

/**
 * plansFor() for placeBalloons from the real plan metrics: the text-box height and the outline bounds
 * (relative to the text box) of `line` at width `w`, as page fractions.
 */
export function letteringSizer(doc: ComicDoc, _page: Page, aspect: number, measure: Measure = estimateMeasure, densityScale = 1): (line: Line, w: number) => SizedLine {
  const H = PLAN_W / (Number.isFinite(aspect) && aspect > 0 ? aspect : 2 / 3);
  const setups = new Map<string, { setup: LineSetup; sized: Map<number, SizedLine> }>();
  const whole: Box = { x: 0, y: 0, w: 1, h: 1 };
  return (line, w) => {
    let entry = setups.get(line.id);
    if (!entry || entry.setup.line !== line) {
      entry = { setup: densify(lineSetup(doc, line, measure), densityScale), sized: new Map() };
      setups.set(line.id, entry);
    }
    // The placement asks for the same few widths over and over (every candidate, every pass).
    const hit = entry.sized.get(w);
    if (hit) return hit;
    const setup = entry.setup;
    const t = layoutText(setup, measure, { x: 0, y: 0, w, pinned: true }, whole, H);
    const g = geometryFor(setup, t.w, t.h, null);
    // `tail`: the placement keeps tails out of other balloons; a tail-less style needs no room for one.
    const tail = resolveTailStyle(setup.style.tail, line.kind, setup.style.shape) !== 'none' && setup.style.shape !== 'none';
    const sized: SizedLine = { h: r4(t.h / H), bounds: { x: g.bounds.x / PLAN_W, y: g.bounds.y / H, w: g.bounds.w / PLAN_W, h: g.bounds.h / H }, tail };
    // `minW`: the narrowest box that splits no word at this size (a sound effect shrinks to its box instead).
    if (line.kind !== 'sfx') {
      const longest = longestWord(setup, measure, t.fontSize);
      if (longest > 0) sized.minW = (longest + 2 * setup.pad.x) / PLAN_W;
    }
    entry.sized.set(w, sized);
    return sized;
  };
}

// ── Glyph runs ───────────────────────────────────────────────────────────────

const runsFor = (setup: LineSetup, lines: string[], box: { x: number; y: number; w: number }, fontSize: number): GlyphRun[] => {
  const { style, pad, lineHeight, lang } = setup;
  const LH = fontSize * lineHeight;
  const anchorX = style.align === 'left' ? box.x + pad.x : style.align === 'right' ? box.x + box.w - pad.x : box.x + box.w / 2;
  const sfx = setup.line.kind === 'sfx';
  const effect = sfx ? style.sfxEffect : undefined;
  const arched = effect === 'arched' && Math.abs(style.arc) >= 0.05;
  const pop = effect === 'pop';
  const perGlyph = setup.glyphs && (style.letterSpacing !== 0 || arched || pop);
  return lines.map((text, i) => {
    const y = r2(box.y + pad.y + i * LH + LH / 2 + 0.35 * fontSize);
    const run: GlyphRun = { text, x: r2(anchorX), y };
    if (!perGlyph) return run;
    const gs = graphemes(text, lang);
    const spacing = style.letterSpacing * fontSize;
    const adv = gs.map((g) => setup.measureAt(g, fontSize));
    const total = adv.reduce((a, b) => a + b, 0) + spacing * Math.max(0, gs.length - 1);
    const start = style.align === 'left' ? anchorX : style.align === 'right' ? anchorX - total : anchorX - total / 2;
    const xs: number[] = [];
    let cursor = start;
    for (let k = 0; k < gs.length; k += 1) {
      xs.push(cursor);
      cursor += adv[k] + spacing;
    }
    run.xs = xs.map(r2);
    if (arched) {
      const sign = style.arc > 0 ? 1 : -1;
      const R = total / (Math.abs(style.arc) * Math.PI);
      const mid = start + total / 2;
      const ys: number[] = [];
      const rotates: number[] = [];
      const archedXs: number[] = [];
      gs.forEach((_g, k) => {
        const s = xs[k] + adv[k] / 2 - mid;
        const phi = s / R;
        const cxk = mid + R * Math.sin(phi);
        archedXs.push(r2(cxk - (adv[k] / 2) * Math.cos(phi)));
        ys.push(r2(y + sign * R * (1 - Math.cos(phi))));
        rotates.push(r2(((sign * phi) * 180) / Math.PI));
      });
      run.xs = archedXs;
      run.ys = ys;
      run.rotates = rotates;
    }
    if (pop) run.scales = gs.map((_g, k) => r2(gs.length > 1 ? 0.85 + (0.3 * k) / (gs.length - 1) : 1));
    return run;
  });
};

// ── planLettering ────────────────────────────────────────────────────────────

const validBalloon = (b?: Balloon): b is Balloon =>
  !!b && [b.x, b.y, b.w].every((v) => typeof v === 'number' && Number.isFinite(v)) && b.w > 0;

/** Stored balloon kept on the page with a sane width (balloonGeometry clampBalloon). */
const clampStored = (b: Balloon): Balloon => {
  const w = clampV(b.w, 0.04, 0.95);
  const out: Balloon = { ...b, w: r4(w), x: r4(clampV(b.x, 0, 1 - w)), y: r4(clampV(b.y, 0, 0.99)) };
  if (typeof b.tailX === 'number' && typeof b.tailY === 'number' && Number.isFinite(b.tailX) && Number.isFinite(b.tailY)) {
    out.tailX = r4(clampV(b.tailX, 0, 1));
    out.tailY = r4(clampV(b.tailY, 0, 1));
  } else {
    delete out.tailX;
    delete out.tailY;
  }
  return out;
};

/**
 * Pure; memoized by (text, font, width, style). Uses textLayout wrap + fit. Works on a localized doc.
 *
 * Letter fit (plan §10 A4): a panel whose lettering covers more of its picture than the doc's cap (coverCapFor) has
 * its movable balloons placed again in memory — stored unpinned ones included (F8), drawn and flagged crowded 'cover'
 * where they moved — at full size (smaller only when LETTER_FIT_POLICY allows it), and is flagged `dense` while it is
 * still over; no balloon is left over another balloon's text while the page has a text-free spot for it (FX2); a pinned balloon
 * stored narrower than its longest word is drawn as wide as that word within its panel (FX6). Stored values never
 * change, and a page whose panels are all under the cap plans exactly as before.
 */
export function planLettering(doc: ComicDoc, page: Page, aspect: number, measure: Measure): LetterPlan[] {
  if (!doc || !page || !Array.isArray(page.panels)) return [];
  const m: Measure = typeof measure === 'function' ? measure : estimateMeasure;
  const asp = Number.isFinite(aspect) && aspect > 0 ? aspect : letteringAspect(doc, page);
  const H = PLAN_W / asp;
  const ls = doc.letterStyle ?? DEFAULT_LETTERING;
  const safeMargin = typeof ls.safeMargin === 'number' ? ls.safeMargin : DEFAULT_SAFE_MARGIN;
  const safeFrac = safeAreaBox(safeMargin, asp);
  const safe: Box = { x: safeFrac.x * PLAN_W, y: safeFrac.y * H, w: safeFrac.w * PLAN_W, h: safeFrac.h * H };
  const boxes = panelBoxesFor(doc, page);
  const rtl = doc.format?.readingDirection === 'rtl';
  const stored = new Map<string, Balloon>();
  for (const b of page.balloons || []) if (validBalloon(b) && !stored.has(b.lineId)) stored.set(b.lineId, b);

  const items: { line: Line; panelIndex: number; panelN: number }[] = [];
  page.panels.forEach((panel, panelIndex) => {
    for (const line of panel.lines || []) if (normalizeLetteringText(line.text)) items.push({ line, panelIndex, panelN: panel.n });
  });
  if (!items.length) return [];
  const lineIds = new Set(items.map((it) => it.line.id));

  // A dense page is tried at full size first. When software-placed balloons still overlap something after
  // the settle pass, the software-placed balloons are packed again from scratch around the pinned ones
  // (stored-but-unpinned balloons included: software placed them, software may move them), and if that
  // is not enough they are lettered smaller and the page is planned again.
  //
  // Reading order counts as much as room: a software-placed balloon the reader would meet out of order (in
  // an earlier panel, above its panel's tier, before the previous line of its panel) or that had to leave
  // its panel's tier is not a finished page either, so the page is lettered smaller before that happens.
  // So is one lettered so narrow that a word splits ("EXPLANATI / ON"): the step first places those lines
  // again in whole words only. A line placed after a later line the owner already lettered in its panel
  // (the placement tucks it in before that line whenever there is room) is flagged `order` but moves
  // nothing of the owner's: that is the owner's call, not a reason to repack or shrink the page.
  // Ranking: overlaps, then far-early reads, then early reads, then tier spills, then split words, then
  // lines read after a later fixed one; the larger size wins a tie.
  //
  // Search order (each step tries the stored layout — again in whole words when a word split — then the
  // repack): full size; then the smallest step — a page that is not finished even there is over-full and
  // stops (the best attempt so far is drawn, its stuck lines flagged); else the steps in between, largest
  // first, and the first finished one is drawn.
  let best: PageAttempt | undefined;
  const repackable = [...stored.values()].some((b) => !b.pinned && !b.locked);
  /** Tail-less outlines by line, size and box: every attempt draws the same few. */
  const shapes = new Map<string, BubbleGeometry>();
  /** One sizer per size step: every packing of a step measures the same lines at the same widths. */
  const sizers = new Map<number, (line: Line, w: number) => SizedLine>();
  const sizerAt = (scale: number) => {
    let sz = sizers.get(scale);
    if (!sz) sizers.set(scale, (sz = letteringSizer(doc, page, asp, m, scale)));
    return sz;
  };
  const cover = { cap: coverCapFor(doc), fillFor: (line: Line) => outlineFill(resolveLetterStyle(doc, line).shape), keepStored: storedFrozen(page) };
  const ctx: PlanCtx = { doc, page, items, lineIds, stored, boxes, rtl, safe, safeMargin, asp, H, m, shapes, sizerAt, cover };
  const tryScale = (scale: number): PageAttempt | undefined => {
    const attempt = (keep: 'all' | 'pinned', whole: readonly string[] = []): PageAttempt => {
      const a = planAtDensity(ctx, scale, keep, whole);
      if (!best || worse(best, a) || (!worse(a, best) && a.scale > best.scale)) best = a;
      return a;
    };
    const all = attempt('all');
    if (finished(all)) return all;
    // A word split: those lines again, in whole words only (wherever that puts them).
    if (all.split.length) {
      const whole = attempt('all', all.split);
      if (finished(whole)) return whole;
    }
    if (!repackable) return undefined;
    const repack = attempt('pinned');
    return finished(repack) ? repack : undefined;
  };
  const steps = [...DENSITY_STEPS].sort((a, b) => b - a);
  const choose = (): PageAttempt | undefined => {
    const first = tryScale(steps[0]);
    if (first) return first;
    if (steps.length > 1) {
      const last = tryScale(steps[steps.length - 1]);
      if (!last) return best;
      for (const scale of steps.slice(1, -1)) {
        const a = tryScale(scale);
        if (a) return a;
      }
      return last;
    }
    return best;
  };
  const win = choose();
  return win ? coverCapped(ctx, win) : [];
}

/**
 * The coverage cap (FX2/F8), applied to the page the search chose. A panel whose lettering covers more of its picture
 * than the cap has its MOVABLE balloons — software-placed lines and stored balloons that are neither pinned nor locked —
 * placed again in memory at full size (partly across its border when that helps). Only when the owner's policy allows
 * it (LETTER_FIT_POLICY.coverShrink) does a panel still over the cap go down COVER_STEPS, panel by panel: each panel
 * keeps the largest step that brings IT under the cap (the smallest when none does), so a panel that fits at full size
 * is never lettered smaller for a neighbour. Nothing is written (Re-letter page saves the re-placement for free) and
 * pinned or locked balloons never move. An attempt is kept only when it is no worse a page (text covered, overlaps,
 * reading order, split words) and covers less. A panel still over the cap, or lettered smaller, is flagged `dense`.
 * A page whose panels are all under the cap is returned exactly as the search drew it.
 */
function coverCapped(ctx: PlanCtx, win: PageAttempt): LetterPlan[] {
  const { doc, page, items, stored } = ctx;
  const cap = ctx.cover.cap;
  const plans = win.build();
  const coverOf = (ps: readonly LetterPlan[]) => panelCoverage(doc, page, ps, ctx.asp);
  const cover0 = coverOf(plans);
  const movable = (id: string) => {
    const b = stored.get(id);
    return !b || (!b.pinned && !b.locked && !ctx.cover.keepStored);
  };
  const over = new Set(page.panels.map((_p, i) => i).filter((i) => cover0[i] > cap + 1e-9 && items.some((it) => it.panelIndex === i && movable(it.line.id))));
  const noScales = new Map<number, number>();
  let chosen: { plans: LetterPlan[]; cover: readonly number[]; scales: ReadonlyMap<number, number> } = { plans, cover: cover0, scales: noScales };
  /** Best coverage at the page's own size (re-placement only). */
  let full: readonly number[] = cover0;
  if (over.size) {
    // A panel that was under the cap may take a little of a neighbour's balloon, never past the cap (or past what it
    // already carried).
    const excess = (c: readonly number[]) => c.reduce((n, v, i) => n + Math.max(0, v - (over.has(i) ? cap : Math.max(cap, cover0[i]))), 0);
    let least = excess(cover0);
    // A page already lettered at a smaller step letters its capped panels no bigger: each size is tried once.
    const steps = [...new Set(coverStepsFor().map((step) => Math.min(step, win.scale)))].sort((a, b) => b - a);
    /** Each over-cap panel's step (an index into `steps`): all start at the page's own size. */
    const at = new Map<number, number>([...over].map((i) => [i, 0]));
    for (let round = 0; round < steps.length; round += 1) {
      const scales = new Map([...at].map(([i, k]) => [i, steps[k]] as [number, number]));
      const a = planAtDensity(ctx, win.scale, win.keep, win.whole, { panels: over, scales });
      const ap = a.build();
      const ac = coverOf(ap);
      if (!worse(a, win)) {
        if (round === 0) full = cover0.map((c, i) => Math.min(c, ac[i]));
        const ex = excess(ac);
        if (ex < least - 1e-9) {
          least = ex;
          chosen = { plans: ap, cover: ac, scales };
        }
        if (ex <= 1e-9) break;
      }
      // Only the panels still over the cap go a step smaller; the others keep the step that brought them under it.
      let lowered = false;
      for (const [i, k] of at)
        if (ac[i] > cap + 1e-9 && k + 1 < steps.length) {
          at.set(i, k + 1);
          lowered = true;
        }
      if (!lowered) break;
    }
  }
  const shrunk = new Map([...chosen.scales].filter(([, s]) => s < win.scale - 1e-9));
  return markDense(ctx, chosen.plans, cover0, full, chosen.cover, shrunk);
}

/**
 * `dense` on every plan of a panel whose lettering covers more than the cap even re-placed at full size (FX2), and of
 * every panel the cap lettered smaller (`shrunk`: panel index → size step), so a smaller letter is never unexplained.
 */
function markDense(
  ctx: PlanCtx,
  plans: LetterPlan[],
  before: readonly number[],
  full: readonly number[],
  drawn: readonly number[],
  shrunk: ReadonlyMap<number, number>
): LetterPlan[] {
  const { doc, page, items, boxes } = ctx;
  const cap = ctx.cover.cap;
  const flagged = (i: number) => full[i] > cap + 1e-9 || shrunk.has(i);
  if (!page.panels.some((_p, i) => flagged(i))) return plans;
  const unit = textUnitFor(doc.format?.language);
  const panelOf = new Map(items.map((it) => [it.line.id, it.panelIndex]));
  const info = new Map<number, LetterDensity>();
  page.panels.forEach((panel, i) => {
    if (!flagged(i)) return;
    const b = boxes[i];
    const balloons = (panel.lines || []).filter((l) => normalizeLetteringText(l.text)).length;
    const d: LetterDensity = {
      panelN: panel.n,
      cover: r4(before[i]),
      fits: b ? textBudget(b.w * b.h, Math.max(1, balloons), unit) : 0,
      words: panelWords(panel, unit),
      unit: unit.unit,
      cap,
      drawn: r4(drawn[i])
    };
    const s = shrunk.get(i);
    if (s !== undefined && s < 1) d.scale = s;
    info.set(i, d);
  });
  return plans.map((p) => {
    const d = info.get(panelOf.get(p.lineId) ?? -1);
    return d ? { ...p, dense: d } : p;
  });
}

// A line read after a later line the owner fixed (`late`) is flagged, never a reason to move the owner's balloons.
const finished = (a: PageAttempt) => !a.unresolved && !a.farEarly && !a.early && !a.spilled && !a.split.length;


interface PageAttempt {
  /** The attempt's plans (built on demand: only the winning attempt draws). */
  build: () => LetterPlan[];
  /** Balloons over another balloon's text (or under another outline), counted per balloon. */
  overText: number;
  /** How the attempt was planned (the coverage cap plans its panels again the same way). */
  keep: 'all' | 'pinned';
  whole: readonly string[];
  /** Lines still overlapping, read out of turn or spilled out of their tier (each one flagged). */
  stuck: string[];
  /** The density step of this attempt. */
  scale: number;
  /** Movable balloons still overlapping something. */
  unresolved: number;
  /** Balloons the engine put far too early: above their panel's tier or in a panel of an earlier tier. */
  farEarly: number;
  /** Balloons the engine put where the reader meets them too early (earlier panel, above the tier, before the previous line). */
  early: number;
  /** Software-placed balloons drawn outside their panel's tier (a later tier). */
  spilled: number;
  /** Software-placed balloons lettered so narrow that a word splits across lines ("EXPLANATI / ON"). */
  split: string[];
  /** Software-placed balloons read after a later line the owner fixed in their panel (no room before it). */
  late: number;
}

/**
 * `a` is a worse page than `b`: more balloons over text, else more overlaps, else more far-early reads, else more
 * early reads, else more tier spills, else more split words, else more lines read after a later fixed one.
 */
const worse = (a: PageAttempt, b: PageAttempt): boolean => {
  if (a.overText !== b.overText) return a.overText > b.overText;
  if (a.unresolved !== b.unresolved) return a.unresolved > b.unresolved;
  if (a.farEarly !== b.farEarly) return a.farEarly > b.farEarly;
  if (a.early !== b.early) return a.early > b.early;
  if (a.spilled !== b.spilled) return a.spilled > b.spilled;
  if (a.split.length !== b.split.length) return a.split.length > b.split.length;
  return a.late > b.late;
};

/** What every planning pass of one page shares. */
interface PlanCtx {
  doc: ComicDoc;
  page: Page;
  items: readonly { line: Line; panelIndex: number; panelN: number }[];
  lineIds: ReadonlySet<string>;
  stored: ReadonlyMap<string, Balloon>;
  boxes: readonly Box[];
  rtl: boolean;
  safe: Box;
  safeMargin: number;
  asp: number;
  H: number;
  m: Measure;
  shapes: Map<string, BubbleGeometry>;
  /** The sizer of a size step (one per step: every packing of a step measures the same lines at the same widths). */
  sizerAt: (scale: number) => (line: Line, w: number) => SizedLine;
  /**
   * The doc's coverage cap and each line's outline fill (placement and the cap pass); `keepStored`: the cap moves no
   * stored balloon on this page (storedFrozen: a snapshot page whose faces are unknown).
   */
  cover: { cap: number; fillFor: (line: Line) => number; keepStored: boolean };
}

/** An overlap this thin (plan units: 0.1 % of the page width, under half a pixel on a phone) is not text under a balloon. */
export const TEXT_SLIVER = 1;

/** Two boxes overlap by more than `eps` on both axes. */
const boxesOverlap = (a: Box, b: Box, eps = 1e-6): boolean => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > eps && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > eps;

/**
 * The widest a pinned balloon may be drawn to keep its words whole (FX6), page widths: up to its panel's far edge
 * (its near edge for an rtl caption that grows leftwards); the page's render margin when the owner put it outside
 * its panel. Never narrower than it is stored.
 */
const wordRoom = (b: Balloon, panel: Box | undefined, growLeft: boolean): number => {
  const right = b.x + b.w;
  const inPanel = !!panel && b.x >= panel.x - 1e-6 && b.x <= panel.x + panel.w && b.y >= panel.y - 0.01 && b.y <= panel.y + panel.h;
  const room = growLeft ? (inPanel ? right - panel!.x : right - PAGE_FIT_MARGIN) : inPanel ? panel!.x + panel!.w - b.x : 1 - PAGE_FIT_MARGIN - b.x;
  return r4(Math.max(b.w, Math.min(room, growLeft ? right - PAGE_FIT_MARGIN : 1 - PAGE_FIT_MARGIN - b.x)));
};

/** Panel indexes in reading order (the panel number, then the array order). */
const readingOrder = (page: Page): number[] =>
  page.panels
    .map((panel, index) => ({ n: panel.n, index }))
    .sort((a, b) => a.n - b.n || a.index - b.index)
    .map((p) => p.index);

/**
 * One planning pass at a density scale (1 = the style's size). `keep: 'all'` draws every stored balloon
 * where it is; `keep: 'pinned'` re-places the unpinned stored ones too (an over-full page's repack).
 * `wholeWords`: lines the placement letters in whole words only (a retry after a split word).
 * `unresolved` counts the balloons the settle pass could not clear of overlaps.
 */
function planAtDensity(
  ctx: PlanCtx,
  scale: number,
  keep: 'all' | 'pinned',
  wholeWords: readonly string[],
  capPass?: { panels: ReadonlySet<number>; scales: ReadonlyMap<number, number> }
): PageAttempt {
  const { doc, page, items, lineIds, stored, boxes, rtl, safe, safeMargin, asp, H, m, shapes } = ctx;
  const sizer = ctx.sizerAt(scale);
  const panelOfLine = new Map(items.map((it) => [it.line.id, it.panelIndex]));
  /** A movable line of a panel the coverage cap letters again (never a pinned or locked balloon). */
  const capLine = (id: string): boolean => {
    if (!capPass || !capPass.panels.has(panelOfLine.get(id) ?? -1)) return false;
    const b = stored.get(id);
    return !b || (!b.pinned && !b.locked && !ctx.cover.keepStored);
  };
  /** The size step a line is lettered at: the page's, or the cap's smaller one for its own panel. */
  const lineScale = (id: string): number => (capLine(id) ? Math.min(scale, capPass!.scales.get(panelOfLine.get(id) ?? -1) ?? scale) : scale);
  const repacks = (id: string) => {
    const b = stored.get(id);
    if (!b || b.pinned || b.locked) return false;
    return keep === 'pinned' || capLine(id);
  };
  // Lines without a stored balloon (and, when repacking, the unpinned stored ones; for the coverage cap, the
  // movable ones of its panels): deterministic placement around everything else on the page.
  const placed = new Map<string, Balloon>();
  let crowded: ReadonlySet<string> = new Set<string>();
  /** Lines the coverage cap placed partly across their panel's border. */
  let straddled: ReadonlySet<string> = new Set<string>();
  /** Lines the placement lettered narrower than their whole words allow (it found no wider spot). */
  let narrowed: ReadonlySet<string> = new Set<string>();
  if (items.some((it) => !stored.has(it.line.id) || repacks(it.line.id))) {
    const qc = pageSpaceQc(doc, page); // Ship 2: keep-outs and heads in page space (the stored report in page mode)
    /** The cap letters each of its panels at that panel's own step (one sizer per step). */
    const capSized = !!capPass && [...capPass.scales.values()].some((s) => s < scale);
    const result = placeBalloonsDetailed({
      page,
      boxes: [...boxes],
      aspect: asp,
      rtl,
      plansFor: capSized ? (line, w) => ctx.sizerAt(lineScale(line.id))(line, w) : sizer,
      keepOut: qc?.keepOut,
      heads: qc?.heads,
      safeMargin,
      existing: page.balloons || [],
      keep,
      // The cap letters again only its panels' movable balloons (and, repacking, every unpinned one).
      ...(capPass ? { only: [...stored.keys()].filter((id) => repacks(id)) } : {}),
      ...(wholeWords.length ? { wholeWords } : {}),
      lang: doc.format?.language,
      // Coverage-aware placement only where the cap letters a panel again: everything else is placed as it always was.
      ...(capPass ? { coverCap: ctx.cover.cap, fillFor: ctx.cover.fillFor } : {})
    });
    for (const b of result.balloons) if (!stored.has(b.lineId) || repacks(b.lineId)) placed.set(b.lineId, b);
    // A line lettered across its panel's border for the cap is crowded with the reason 'cover' (the editor draws it,
    // and pins it, where it is drawn).
    straddled = new Set(result.straddled ?? []);
    crowded = new Set(result.crowded.filter((id) => !stored.has(id) || repacks(id)));
    narrowed = new Set(result.split);
  }

  const whole: Box = { x: 0, y: 0, w: 1, h: 1 };
  const mx = PAGE_FIT_MARGIN * PLAN_W;
  const my = PAGE_FIT_MARGIN * H;

  // Pass 1: every line's text box at its (stored or placed) balloon, the real outline, the render-time page
  // fit and the tail tip. Nothing is final yet: the settle pass may still nudge movable balloons.
  interface Pre {
    line: Line;
    panelIndex: number;
    panelN: number;
    order: number;
    setup: LineSetup;
    b: Balloon;
    fallback: boolean;
    movable: boolean;
    x: number;
    y: number;
    w: number;
    h: number;
    t: ReturnType<typeof layoutText>;
    g0: BubbleGeometry;
    /** Absolute tail tip (plan units) or null; `tipFollows` when it is the default one derived from the box. */
    tip: { x: number; y: number } | null;
    tipFollows: boolean;
    /** Re-placed by this attempt (a repack or the coverage cap). */
    again: boolean;
  }
  const pre: Pre[] = [];
  const repacked = new Set<string>();
  /**
   * Stored lines the coverage cap drew somewhere else or smaller (crowded, reason 'cover': the editor's drag, Keep
   * here and Lock start from the drawn balloon), and those it placed again exactly where they are stored (not crowded).
   */
  const capMoved = new Set<string>();
  const capSame = new Set<string>();
  /** Pinned balloons drawn wider than stored so no word breaks (FX6), by line. */
  const widened = new Set<string>();
  const preOf = ({ line, panelIndex, panelN }: (typeof items)[number], order: number, wordFit: boolean): Pre | undefined => {
    const fallback = !stored.has(line.id);
    const again = repacks(line.id) && placed.has(line.id);
    const src = again ? placed.get(line.id) : stored.get(line.id) ?? placed.get(line.id);
    if (!src) return undefined;
    const b = clampStored(src);
    const panelBox = boxes[panelIndex] ?? whole;
    const pinned = !!(b.pinned || b.locked);
    const lineStep = lineScale(line.id);
    // Dense pages letter the software-placed balloons smaller; a balloon the owner placed keeps its size.
    const setup = densify(lineSetup(doc, line, m), pinned ? 1 : lineStep);
    // Captions of rtl comics are anchored at their right (reading-start) edge: they grow leftwards.
    const growLeft = rtl && line.kind === 'caption';
    // A software-placed balloon was sized against the whole page by the placement (it may have spilled out
    // of a full panel): fitting it to its panel again would shrink or overflow text that already fits. A
    // balloon lettered smaller for a dense page is not shrunk again by the auto-fit floor either (that
    // would stack: 0.72 × 0.82 ≈ 59 % of its size); it wraps taller and the settle pass finds it room.
    const densified = !pinned && lineStep < 1;
    // FX6: a pinned balloon stored narrower than its longest word is drawn as wide as that word, within the room to
    // its panel's edge (the page's, when the owner put it outside its panel). The stored width stays.
    const fit = wordFit && pinned && line.kind !== 'sfx' ? wordRoom(b, boxes[panelIndex], growLeft) : undefined;
    const t = layoutText(setup, m, { x: b.x, y: b.y, w: b.w, pinned, growLeft, ...(fit !== undefined ? { wordFit: fit } : {}) }, fallback || again || densified ? whole : panelBox, H);
    let x = growLeft ? (b.x + b.w) * PLAN_W - t.w : b.x * PLAN_W;
    let y = b.y * H;
    const w = t.w;
    const h = t.h;

    // Render-time page fit on the real outline (stored values untouched).
    const g0Key = `${line.id}|${setup.baseSize}|${r2(w)}|${r2(h)}`;
    let g0 = shapes.get(g0Key);
    if (!g0) shapes.set(g0Key, (g0 = geometryFor(setup, w, h, null)));
    const ox = (lo: number, size: number, start: number, span: number) =>
      size > span - 2 * lo ? start + (span - size) / 2 : clampV(start, lo, span - lo - size);
    const outlineX = ox(mx, g0.bounds.w, x + g0.bounds.x, PLAN_W);
    const outlineY = ox(my, g0.bounds.h, y + g0.bounds.y, H);
    x = outlineX - g0.bounds.x;
    y = outlineY - g0.bounds.y;

    // Tail tip (absolute): the stored one, else the default below the box for spoken kinds.
    const tailStyle = resolveTailStyle(setup.style.tail, line.kind, setup.style.shape);
    let tip: { x: number; y: number } | null = null;
    let tipFollows = false;
    if (tailStyle !== 'none' && setup.style.shape !== 'none') {
      if (typeof b.tailX === 'number' && typeof b.tailY === 'number') tip = { x: b.tailX * PLAN_W, y: b.tailY * H };
      else if (SPOKEN.has(line.kind)) {
        tip = { x: clampV(x + w * 0.42, 0, PLAN_W), y: clampV(y + h + 0.04 * H, 0, H) };
        tipFollows = true;
      }
    }
    return { line, panelIndex, panelN, order, setup, b, fallback, movable: !pinned, x, y, w, h, t, g0, tip, tipFollows, again };
  };
  items.forEach((it, order) => {
    const p = preOf(it, order, true);
    if (!p) return;
    if (p.again) repacked.add(p.line.id);
    if (p.again && capLine(p.line.id) && keep !== 'pinned') {
      const s = stored.get(p.line.id);
      const q = placed.get(p.line.id);
      const same = !!s && !!q && Math.abs(q.x - s.x) < 1e-4 && Math.abs(q.y - s.y) < 1e-4 && Math.abs(q.w - s.w) < 1e-4 && lineScale(p.line.id) >= scale;
      (same ? capSame : capMoved).add(p.line.id);
    }
    if (!p.movable && p.w > p.b.w * PLAN_W + 0.01) widened.add(p.line.id);
    pre.push(p);
  });
  // FX6 never makes an overlap the settle pass cannot clear: a widened pinned balloon that would now reach over
  // another pinned or locked one is drawn at its stored width again (its broken word stays flagged as overflow).
  for (const id of [...widened]) {
    const i = pre.findIndex((p) => p.line.id === id);
    const p = pre[i];
    const outline = (q: Pre) => ({ x: q.x + q.g0.bounds.x, y: q.y + q.g0.bounds.y, w: q.g0.bounds.w, h: q.g0.bounds.h });
    const hits = (o: Box) => pre.filter((q) => q.line.id !== id && !q.movable && boxesOverlap(o, outline(q))).length;
    const wide = hits(outline(p));
    if (!wide) continue;
    const narrow = preOf(items[p.order], p.order, false);
    if (!narrow || hits(outline(narrow)) >= wide) continue;
    pre[i] = narrow;
    widened.delete(id);
  }

  // Pass 2: settle — software-placed and unpinned stored balloons slide off pinned ones and each other,
  // tails included, with the real sizes, keeping reading order. Stored values stay as they are; pinned and
  // locked balloons never move.
  const groupOf = linkGroups(pre.map((p) => ({ id: p.line.id, linkTo: p.b.linkTo })));
  const order = readingOrder(page);
  const readPos = new Map(order.map((index, r) => [index, r]));
  const planBox = (index: number): Box | undefined => {
    const b = boxes[index];
    return b ? { x: b.x * PLAN_W, y: b.y * H, w: b.w * PLAN_W, h: b.h * H } : undefined;
  };
  /** Earlier panels (reading order) of the panel at `index`, plan units. */
  const earlierOf = (index: number): Box[] => order.slice(0, readPos.get(index) ?? 0).flatMap((i) => planBox(i) ?? []);
  /** The previous line of each line's panel, as the reader meets it: the line it must read after. */
  const afterOf = new Map<string, string>();
  for (const p of pre) {
    const prev = pre.filter((q) => q.panelIndex === p.panelIndex && q.order < p.order).pop();
    if (!prev) continue;
    // A pinned balloon the owner put outside the panel says nothing about this panel's order.
    const reg = planBox(p.panelIndex);
    const cx = prev.x + prev.w / 2;
    if (prev.movable || !reg || (cx >= reg.x && cx <= reg.x + reg.w && prev.y >= reg.y - 0.01 * H && prev.y <= reg.y + reg.h)) afterOf.set(p.line.id, prev.line.id);
  }
  const rowTol = ROW_TOLERANCE * H;
  /** Text box `a` (top-left) is read before `b`: above its row, or on its row nearer the reading start. */
  const readsBefore = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
    a.y < b.y - rowTol || (Math.abs(a.y - b.y) < rowTol && (rtl ? a.x > b.x - 1e-6 : a.x < b.x + 1e-6));
  /**
   * The later lines of each line's panel that the owner fixed there (stored, drawn from the stored values, and
   * met in this panel) and that the reader meets after its previous line: it is read before every one of them.
   */
  const nextOf = new Map<string, string[]>();
  const byLine = new Map(pre.map((p) => [p.line.id, p]));
  for (const p of pre) {
    const reg = planBox(p.panelIndex);
    const prevId = afterOf.get(p.line.id);
    const prev = prevId ? byLine.get(prevId) : undefined;
    const ids: string[] = [];
    for (const q of pre) {
      if (q.panelIndex !== p.panelIndex || q.order <= p.order || q.fallback || repacked.has(q.line.id)) continue;
      const cx = q.x + q.w / 2;
      if (reg && !(cx >= reg.x && cx <= reg.x + reg.w && q.y >= reg.y - 0.01 * H && q.y <= reg.y + reg.h)) continue;
      if (prev && readsBefore(q, prev)) continue; // the owner stored it before the previous line: it binds nothing
      ids.push(q.line.id);
    }
    if (ids.length) nextOf.set(p.line.id, ids);
  }
  const settled = settleBalloons(
    pre.map((p): SettleItem => {
      const outline = { x: p.x + p.g0.bounds.x, y: p.y + p.g0.bounds.y, w: p.g0.bounds.w, h: p.g0.bounds.h };
      // A default tail follows the box: its reach is part of the outline instead of a fixed tip.
      const foot = p.tip && p.tipFollows ? balloonFootprint(outline, p.tip) : outline;
      const item: SettleItem = {
        id: p.line.id,
        outline: foot,
        tip: p.tip && !p.tipFollows ? p.tip : null,
        movable: p.movable,
        region: planBox(p.panelIndex),
        group: groupOf.get(p.line.id),
        text: { x: p.x, y: p.y, w: p.w, h: p.h },
        body: outline,
        before: earlierOf(p.panelIndex),
        // Drawn from where the owner's (unpinned) balloon is stored: the never-over-text fallback keeps it near home.
        ...(p.movable && !p.fallback && !p.again ? { stored: true } : {})
      };
      const after = afterOf.get(p.line.id);
      if (after) item.after = after;
      const next = nextOf.get(p.line.id);
      if (next) item.next = next;
      return item;
    }),
    { w: PLAN_W, h: H },
    { margin: { x: mx, y: my }, gap: 0.01 * PLAN_W, rtl }
  );
  const nudged = new Set<string>();
  for (const p of pre) {
    const mv = settled.moves.get(p.line.id);
    if (!mv || (!mv.dx && !mv.dy)) continue;
    p.x += mv.dx;
    p.y += mv.dy;
    if (p.tip && p.tipFollows) p.tip = { x: clampV(p.x + p.w * 0.42, 0, PLAN_W), y: clampV(p.y + p.h + 0.04 * H, 0, H) };
    else if (p.tip && mv.tipMoved) p.tip = { x: clampV(p.tip.x + mv.dx, 0, PLAN_W), y: clampV(p.tip.y + mv.dy, 0, H) };
    nudged.add(p.line.id);
  }

  // Reading order of what the engine drew: every balloon it placed or moved is read in its panel's turn.
  // Levels as settleBalloons ranks them: a later tier (1), a little early inside the tier (2), far too
  // early — above the tier or in a panel of an earlier tier (3). Only what the engine changed counts.
  let farEarly = 0;
  let early = 0;
  let spilled = 0;
  let late = 0;
  const stuck = new Set<string>();
  const levels = new Map<string, number>();
  const textOf = new Map(pre.map((p) => [p.line.id, { x: p.x, y: p.y }]));
  const reordered = new Set(settled.reordered);
  const split: string[] = [];
  const inside = (b: Box, px: number, py: number) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
  for (const p of pre) {
    const engine = p.fallback || repacked.has(p.line.id) || nudged.has(p.line.id);
    if (!engine || !p.movable) continue;
    const reg = planBox(p.panelIndex);
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    // Where the owner (or an earlier software pass) stored it.
    const s0 = p.fallback || repacked.has(p.line.id) ? undefined : { x: p.b.x * PLAN_W + p.w / 2, y: p.b.y * H + p.h / 2 };
    const t = textOf.get(p.line.id)!;
    const level = ((): number => {
      if (reg && cy < reg.y && !(s0 && s0.y < reg.y)) return 3;
      let lv = 0;
      for (const b of earlierOf(p.panelIndex)) {
        if (!inside(b, cx, cy) || (s0 && inside(b, s0.x, s0.y))) continue;
        if (reg && !(b.y < reg.y + reg.h - rowTol && b.y + b.h > reg.y + rowTol)) return 3;
        lv = 2;
      }
      if (lv) return lv;
      const after = afterOf.get(p.line.id);
      const prev = after ? textOf.get(after) : undefined;
      if (prev && !s0) {
        if (t.y < prev.y - rowTol || (Math.abs(t.y - prev.y) < rowTol && (rtl ? t.x > prev.x + 1e-6 : t.x < prev.x - 1e-6))) return 2;
      }
      // A stored balloon the settle pass could only clear by reading it out of turn (its own report).
      if (s0 && reordered.has(p.line.id)) return 2;
      const out = (y: number) => !!reg && (y < reg.y - 0.02 * H || y > reg.y + reg.h + 0.02 * H);
      return out(cy) && !(s0 && out(s0.y)) ? 1 : 0;
    })();
    // Read after a later line the owner fixed in its panel (no room before it): flagged `order`, counted apart.
    const isLate = !level && !s0 && (nextOf.get(p.line.id) ?? []).some((id) => !readsBefore(t, textOf.get(id)!));
    // Lettered so narrow that a word splits (the placement found no wider spot): not finished either.
    if (!s0 && narrowed.has(p.line.id) && splitsWord(p.setup, p.t.lines)) split.push(p.line.id);
    if (level === 3) farEarly += 1;
    else if (level === 2) early += 1;
    else if (level === 1) spilled += 1;
    else if (isLate) late += 1;
    if (level || isLate) {
      stuck.add(p.line.id);
      levels.set(p.line.id, level || 2);
    }
  }
  const unresolved = new Set(settled.unresolved);
  for (const id of unresolved) stuck.add(id);
  // Never over text (FX2): movable balloons whose outline covers another balloon's text, or whose text sits under
  // another outline (linked balloons touch by design; two balloons the owner fixed are the owner's call).
  let overText = 0;
  {
    const outlineOf = (q: Pre): Box => ({ x: q.x + q.g0.bounds.x, y: q.y + q.g0.bounds.y, w: q.g0.bounds.w, h: q.g0.bounds.h });
    const textOf = (q: Pre): Box => ({ x: q.x, y: q.y, w: q.w, h: q.h });
    for (const p of pre) {
      const op = outlineOf(p);
      const tp = textOf(p);
      const g = groupOf.get(p.line.id);
      const hit = pre.some(
        (q) => q !== p && (p.movable || q.movable) && !(g && g === groupOf.get(q.line.id)) && (boxesOverlap(op, textOf(q), TEXT_SLIVER) || boxesOverlap(tp, outlineOf(q), TEXT_SLIVER))
      );
      if (hit) {
        overText += 1;
        if (p.movable) stuck.add(p.line.id);
      }
    }
  }

  // Pass 3 (only for the attempt that wins): the plans themselves.
  const build = (): LetterPlan[] => {
    const plans: (LetterPlan & { order: number })[] = [];
    for (const p of pre) {
      const { line, setup, b, x, y, w, h, t, tip } = p;
      const geometry = geometryFor(setup, w, h, tip ? { x: r2(tip.x - x), y: r2(tip.y - y) } : null);

      const rotate = typeof setup.style.rotate === 'number' ? setup.style.rotate : 0;
      const skewX = line.kind === 'sfx' && setup.style.sfxEffect === 'skewed' ? -12 : setup.synthItalic ? -10 : 0;
      const outline = { x: x + geometry.bounds.x, y: y + geometry.bounds.y, w: geometry.bounds.w, h: geometry.bounds.h };
      const eps = 0.5;
      const outOfSafeArea =
        outline.x < safe.x - eps || outline.y < safe.y - eps || outline.x + outline.w > safe.x + safe.w + eps || outline.y + outline.h > safe.y + safe.h + eps;

      const plan: LetterPlan & { order: number } = {
        lineId: line.id,
        kind: line.kind,
        panelN: p.panelN,
        lang: setup.lang,
        dir: setup.spec.dir,
        fallback: p.fallback,
        style: setup.style,
        fontId: setup.fontId,
        x: r2(x),
        y: r2(y),
        w: r2(w),
        h: r2(h),
        font: setup.fontAt(t.fontSize),
        fontSize: t.fontSize,
        lineHeight: r4(setup.lineHeight),
        pad: { x: r2(setup.pad.x), y: r2(setup.pad.y) },
        runs: runsFor(setup, t.lines, { x, y, w }, t.fontSize),
        geometry,
        stroke: setup.stroke,
        z: typeof b.z === 'number' && Number.isFinite(b.z) ? b.z : p.order,
        locked: !!b.locked,
        outOfSafeArea,
        // A word broken across lines is text that does not fit either (whoever stored the balloon that narrow).
        overflow: t.overflow || splitsWord(setup, t.lines),
        order: p.order
      };
      if (rotate || skewX) plan.transform = { rotate, skewX, cx: r2(x + w / 2), cy: r2(y + h / 2) };
      if (b.linkTo && b.linkTo !== line.id && lineIds.has(b.linkTo)) plan.linkTo = b.linkTo;
      if (tip) plan.tip = { x: r2(tip.x), y: r2(tip.y) };
      // Crowded: the placement could not keep it clean, the settle pass had to move it off another balloon,
      // an over-full page re-placed it, or it is read out of turn. The reason says which, honestly.
      // A balloon the coverage cap drew elsewhere (or smaller) is crowded too, reason 'cover'; one it placed again
      // exactly where it is stored is not.
      if (crowded.has(line.id) || nudged.has(line.id) || (repacked.has(line.id) && !capSame.has(line.id)) || stuck.has(line.id)) {
        plan.crowded = true;
        const reg = planBox(p.panelIndex);
        const cx = x + w / 2;
        const cy = y + h / 2;
        const inPanel = !reg || (cx >= reg.x && cx <= reg.x + reg.w && cy >= reg.y && cy <= reg.y + reg.h);
        plan.crowdedReason = unresolved.has(line.id)
          ? 'overlap'
          : (levels.get(line.id) ?? 0) >= 2
            ? 'order'
            : !inPanel
              ? 'outside'
              : capMoved.has(line.id) || straddled.has(line.id)
                ? 'cover'
                : 'moved';
      }
      // The size it is drawn at, the page's step or its panel's smaller cap step: a drag, nudge, Keep here or Lock
      // keeps it (styleOps keptSizes / keepDrawnSizeOps read this).
      const ls = lineScale(line.id);
      if (p.movable && ls < 1) plan.densityScale = ls;
      plans.push(plan);
    }
    plans.sort((a, b) => a.z - b.z || a.order - b.order);
    return plans.map(({ order: _order, ...plan }) => plan);
  };
  return { build, unresolved: settled.unresolved.length, overText, farEarly, early, spilled, split, late, stuck: [...stuck], scale, keep, whole: wholeWords };
}


/** Linked balloons (speech chains) by the root of their linkTo chain — they touch by design. */
const linkGroups = (items: readonly { id: string; linkTo?: string }[]): Map<string, string> => {
  const ids = new Set(items.map((i) => i.id));
  const parent = new Map<string, string>();
  for (const it of items) parent.set(it.id, it.linkTo && it.linkTo !== it.id && ids.has(it.linkTo) ? it.linkTo : it.id);
  const root = (id: string): string => {
    let cur = id;
    for (let i = 0; i < items.length && parent.get(cur) !== cur; i += 1) cur = parent.get(cur) ?? cur;
    return cur;
  };
  const out = new Map<string, string>();
  for (const it of items) {
    const r = root(it.id);
    if (r !== it.id || items.some((o) => o.linkTo === it.id)) out.set(it.id, r);
  }
  return out;
};

/** Convenience for tools/tests: plans for page number n (undefined when the page doesn't exist). */
export function planLetteringForPage(doc: ComicDoc, n: number, measure: Measure = estimateMeasure): LetterPlan[] | undefined {
  const page = doc.pages.find((p) => p.n === n);
  return page ? planLettering(doc, page, letteringAspect(doc, page), measure) : undefined;
}

// ── Where a balloon is drawn ─────────────────────────────────────────────────

/**
 * The balloon behind a plan as DRAWN: the plan's x, y and width (the text box the fit settled on: a dense page
 * letters it smaller, an rtl caption grows left) and its tail tip, page fractions. The render-time settle, a
 * dense-page repack and the coverage cap may draw an unpinned balloon somewhere other than where it is stored.
 */
export function drawnBalloonOf(b: Balloon, plan: LetterPlan, H: number): Balloon {
  const next: Balloon = { ...b, x: r4(plan.x / PLAN_W), y: r4(plan.y / H), w: r4(plan.w / PLAN_W) };
  if (plan.tip && Number.isFinite(plan.tip.x) && Number.isFinite(plan.tip.y)) {
    next.tailX = r4(clampV(plan.tip.x / PLAN_W, 0, 1));
    next.tailY = r4(clampV(plan.tip.y / H, 0, 1));
  }
  return next;
}

/**
 * The balloon behind every drawn plan, as the user SEES it: an unpinned balloon the plan draws somewhere it is not
 * stored (crowded: the settle, a repack or the coverage cap moved it) or that software placed (`placed`, no stored
 * balloon) takes its drawn spot; pinned and locked balloons are drawn where they are stored and stay as they are.
 * Every edit that starts from a balloon (the editor's drag, nudge, Keep here and Lock; the director's
 * arrange_balloons) starts from this map, so a balloon never jumps back to its stored spot. Mutates and returns
 * `balloons`.
 */
export function withDrawnSpots(balloons: Map<string, Balloon>, plans: readonly LetterPlan[], H: number, placed: ReadonlySet<string>): Map<string, Balloon> {
  if (!(H > 0)) return balloons;
  for (const plan of plans) {
    const b = balloons.get(plan.lineId);
    if (!b || b.pinned || b.locked || !(plan.crowded || placed.has(plan.lineId))) continue;
    balloons.set(plan.lineId, drawnBalloonOf(b, plan, H));
  }
  return balloons;
}

/**
 * Keep a balloon where it is DRAWN: an unpinned stored balloon the engine drew elsewhere (the settle, a dense-page
 * repack or the coverage cap) is pinned at its drawn spot, width and tail — never sent back to its stored spot.
 * `drawn` is the balloon behind each line as drawn (withDrawnSpots). {} for anything else (a software-placed line's
 * full balloon is sent whole by the caller; a pinned one is drawn as stored).
 */
export const drawnSpotPatch = (page: Pick<Page, 'balloons'>, lineId: string, drawn: ReadonlyMap<string, Balloon>): Partial<Balloon> => {
  const stored = (page.balloons || []).find((b) => b.lineId === lineId);
  const now = drawn.get(lineId);
  if (!stored || !now || stored.pinned || stored.locked) return {};
  const out: Partial<Balloon> = {};
  if (now.x !== stored.x || now.y !== stored.y || now.w !== stored.w) Object.assign(out, { x: now.x, y: now.y, w: now.w });
  if (typeof now.tailX === 'number' && typeof now.tailY === 'number' && (now.tailX !== stored.tailX || now.tailY !== stored.tailY)) Object.assign(out, { tailX: now.tailX, tailY: now.tailY });
  return out;
};
