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
import { fitBalloonText, graphemes, normalizeLetteringText, wrapBalancedLines, type FitResult } from '../textLayout.js';
import { FONT_REGISTRY, fontByFamily, fontString, resolveLetteringFont } from './fonts.js';
import { placeBalloons, safeAreaBox } from './place.js';
import { bubbleGeometry, hashSeed, resolveTailStyle, type BubbleGeometry } from './shapes.js';
import {
  DEFAULT_LETTERING,
  DEFAULT_SAFE_MARGIN,
  KIND_FONT_SCALE,
  LETTER_METRICS,
  resolveLetterStyle,
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
  overflow: boolean; // text did not fit even at the floor (never clipped)
}

/** Page width in plan units. */
export const PLAN_W = 1000;
const INK = '#111111';
const SPOKEN: ReadonlySet<LineKind> = new Set<LineKind>(['speech', 'thought', 'whisper', 'shout']);
/** Render-time page margin for outlines (fraction of the page, visualqa §4). */
const PAGE_FIT_MARGIN = 0.008;

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const clampV = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);

// ── Small pure helpers ───────────────────────────────────────────────────────

/** Width / height of a page: the render's pixel size when known, else the format's aspect. */
export function letteringAspect(doc: Pick<ComicDoc, 'format'>, page?: Pick<Page, 'render'> | null): number {
  const a = page?.render?.asset;
  if (a?.w && a?.h && a.w > 0 && a.h > 0) return a.w / a.h;
  const [w, h] = String(doc.format?.pageAspect || '').split(':').map(Number);
  return w > 0 && h > 0 ? w / h : 2 / 3;
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
  b: { x: number; y: number; w: number; pinned: boolean; growLeft?: boolean },
  panel: Box,
  H: number
): { w: number; h: number; fontSize: number; lines: string[]; overflow: boolean } => {
  const { style, lang, text, pad, lineHeight } = setup;
  const key = [lang, setup.fontId, setup.weight, setup.italic ? 1 : 0, style.letterSpacing, r4(setup.baseSize), r4(lineHeight), r4(pad.x), r4(pad.y), setup.line.kind === 'sfx' ? 1 : 0, r4(b.x), r4(b.y), r4(b.w), b.pinned ? 1 : 0, b.growLeft ? 1 : 0, r4(panel.x), r4(panel.y), r4(panel.w), r4(panel.h), r2(H), text].join('|');
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
    return fitBalloonText({
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
      ...(b.growLeft ? { growLeft: true } : {})
    });
  });
  return { w: fit.w * PLAN_W, h: fit.heightPx, fontSize: fit.fontPx, lines: fit.lines, overflow: fit.overflow };
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
 * plansFor() for placeBalloons from the real plan metrics: the text-box height and the outline bounds
 * (relative to the text box) of `line` at width `w`, as page fractions.
 */
export function letteringSizer(doc: ComicDoc, _page: Page, aspect: number, measure: Measure = estimateMeasure): (line: Line, w: number) => { h: number; bounds: Box } {
  const H = PLAN_W / (Number.isFinite(aspect) && aspect > 0 ? aspect : 2 / 3);
  const setups = new Map<string, LineSetup>();
  const whole: Box = { x: 0, y: 0, w: 1, h: 1 };
  return (line, w) => {
    let setup = setups.get(line.id);
    if (!setup || setup.line !== line) {
      setup = lineSetup(doc, line, measure);
      setups.set(line.id, setup);
    }
    const t = layoutText(setup, measure, { x: 0, y: 0, w, pinned: true }, whole, H);
    const g = geometryFor(setup, t.w, t.h, null);
    return { h: r4(t.h / H), bounds: { x: g.bounds.x / PLAN_W, y: g.bounds.y / H, w: g.bounds.w / PLAN_W, h: g.bounds.h / H } };
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

/** Pure; memoized by (text, font, width, style). Uses textLayout wrap + fit. Works on a localized doc. */
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

  // Lines without a stored balloon: deterministic placement around everything already on the page.
  const placed = new Map<string, Balloon>();
  if (items.some((it) => !stored.has(it.line.id))) {
    const qc = page.render?.qc;
    const balloons = placeBalloons({
      page,
      boxes,
      aspect: asp,
      rtl,
      plansFor: letteringSizer(doc, page, asp, m),
      keepOut: qc?.keepOut,
      heads: qc?.heads,
      safeMargin,
      existing: page.balloons || [],
      keep: 'all',
      lang: doc.format?.language
    });
    for (const b of balloons) if (!stored.has(b.lineId)) placed.set(b.lineId, b);
  }

  const lineIds = new Set(items.map((it) => it.line.id));
  const plans: (LetterPlan & { order: number })[] = [];
  items.forEach(({ line, panelIndex, panelN }, order) => {
    const fallback = !stored.has(line.id);
    const src = stored.get(line.id) ?? placed.get(line.id);
    if (!src) return;
    const b = clampStored(src);
    const setup = lineSetup(doc, line, m);
    const panelBox = boxes[panelIndex] ?? { x: 0, y: 0, w: 1, h: 1 };
    const pinned = !!(b.pinned || b.locked);
    // Captions of rtl comics are anchored at their right (reading-start) edge: they grow leftwards.
    const growLeft = rtl && line.kind === 'caption';
    const t = layoutText(setup, m, { x: b.x, y: b.y, w: b.w, pinned, growLeft }, panelBox, H);
    let x = growLeft ? (b.x + b.w) * PLAN_W - t.w : b.x * PLAN_W;
    let y = b.y * H;
    const w = t.w;
    const h = t.h;

    // Render-time page fit on the real outline (stored values untouched).
    const g0 = geometryFor(setup, w, h, null);
    const mx = PAGE_FIT_MARGIN * PLAN_W;
    const my = PAGE_FIT_MARGIN * H;
    const ox = (lo: number, size: number, start: number, span: number) =>
      size > span - 2 * lo ? start + (span - size) / 2 : clampV(start, lo, span - lo - size);
    const outlineX = ox(mx, g0.bounds.w, x + g0.bounds.x, PLAN_W);
    const outlineY = ox(my, g0.bounds.h, y + g0.bounds.y, H);
    x = outlineX - g0.bounds.x;
    y = outlineY - g0.bounds.y;

    // Tail tip (absolute), then relative to the drawn text box.
    const tailStyle = resolveTailStyle(setup.style.tail, line.kind, setup.style.shape);
    let tip: { x: number; y: number } | null = null;
    if (tailStyle !== 'none' && setup.style.shape !== 'none') {
      if (typeof b.tailX === 'number' && typeof b.tailY === 'number') tip = { x: b.tailX * PLAN_W, y: b.tailY * H };
      else if (SPOKEN.has(line.kind)) {
        tip = { x: clampV(x + w * 0.42, 0, PLAN_W), y: clampV(y + h + 0.04 * H, 0, H) };
      }
    }
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
      panelN,
      lang: setup.lang,
      dir: setup.spec.dir,
      fallback,
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
      z: typeof b.z === 'number' && Number.isFinite(b.z) ? b.z : order,
      locked: !!b.locked,
      outOfSafeArea,
      overflow: t.overflow,
      order
    };
    if (rotate || skewX) plan.transform = { rotate, skewX, cx: r2(x + w / 2), cy: r2(y + h / 2) };
    if (b.linkTo && b.linkTo !== line.id && lineIds.has(b.linkTo)) plan.linkTo = b.linkTo;
    plans.push(plan);
  });
  plans.sort((a, b) => a.z - b.z || a.order - b.order);
  return plans.map(({ order: _order, ...plan }) => plan);
}

/** Convenience for tools/tests: plans for page number n (undefined when the page doesn't exist). */
export function planLetteringForPage(doc: ComicDoc, n: number, measure: Measure = estimateMeasure): LetterPlan[] | undefined {
  const page = doc.pages.find((p) => p.n === n);
  return page ? planLettering(doc, page, letteringAspect(doc, page), measure) : undefined;
}
