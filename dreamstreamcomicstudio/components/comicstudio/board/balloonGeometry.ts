// Balloon geometry for overlay lettering — the board's thin layer over the shared lettering engine
// (contract §10.2: "balloonGeometry.ts becomes a thin re-export plus client-only helpers").
//
// - Shapes, tails, seeds, outline bleed, the render-time page fit and placement live once in
//   shared/comic/lettering/ (shapes.ts, place.ts) and are re-exported here under their old names, so the
//   board, print view and PNG exporter keep importing from this file unchanged.
// - The pixel helpers below (balloonFontPx, strokePx, sfxFontPx, wrapText…) and the server-mirroring
//   estimates (balloonWidthForText, estimateBalloonHeight) stay here as the regression reference the
//   shared textLayout estimates are tested against (byte-identical for 'en').
// - resolveBalloons places lines without a stored balloon with the SAME deterministic placer the board's
//   planLettering uses (page-wide obstacles: a stored balloon of panel 2 sitting over panel 5 is avoided),
//   and flags the ones that could not avoid an overlap as `crowded`.
//
// Coordinates: a Balloon is page-normalized (x, y = top-left, w = fraction of the page WIDTH, tail tip
// in page fractions); its height follows the text. Shape helpers work in balloon-local units.

import type { AspectRatio, Balloon, ComicDoc, Line, LineKind, Page } from '../../../shared/comic/doc';
import { panelBoxesFor } from './pageLayout';
import { KIND_FONT_SCALE as SHARED_KIND_FONT_SCALE, LETTER_METRICS, DEFAULT_LETTERING, DEFAULT_SAFE_MARGIN } from '../../../shared/comic/lettering/style';
import { burstPath, captionPath, cloudPath, speechBodyPath, tailPath, thoughtBubbles, type Circle, type Pt, type TextInset } from '../../../shared/comic/lettering/shapes';
import { placeBalloonsDetailed } from '../../../shared/comic/lettering/place';
import { estimateMeasure, letteringSizer, sfxAutoStyle } from '../../../shared/comic/lettering/layout';

export { OUTLINE_BLEED, OUTLINE_BLEED_XY, SHAPE_BLEED, fitBalloonOnPage, outlineBounds, safeAreaBox } from '../../../shared/comic/lettering/place';

export const LETTERING = {
  /** Font size as a fraction of the rendered page width (≈ 1.7%). */
  fontScale: LETTER_METRICS.fontScale,
  /** Never letter smaller than this (readability on small thumbnails is handled by hiding detail, not shrinking text). */
  minFontPx: 9,
  /** Line height in ems. 1.7% × 1.3 ≈ the server's 0.022 page-width line. */
  lineHeight: LETTER_METRICS.lineHeight,
  /** Inner padding per side (fractions of the page WIDTH): 2 × 0.015 = the server's 0.03. */
  padX: LETTER_METRICS.padX,
  /** 2 × 0.013 = the server's 0.026. */
  padY: LETTER_METRICS.padY,
  /** Server sizing metrics (page-width units). */
  charW: LETTER_METRICS.charW,
  lineH: LETTER_METRICS.lineH,
  padW: 0.03,
  padH: 0.026,
  /** Balloon width bounds (fraction of page width). */
  minW: 0.04,
  maxW: 0.95,
  /** Outline weight as a fraction of page width (≈ 2px on a 700px page). */
  strokeScale: LETTER_METRICS.strokeScale,
  minStrokePx: 1.25,
  fill: '#ffffff',
  captionFill: '#fff6c8',
  ink: '#111111'
} as const;

/** Server-side width bounds for auto-sized balloons (vision.ts MIN/MAX_BALLOON_W). */
const AUTO_MIN_W = 0.16;
const AUTO_MAX_W = 0.34;

const SPOKEN: ReadonlySet<LineKind> = new Set<LineKind>(['speech', 'thought', 'whisper', 'shout']);
export const isSpokenKind = (kind: LineKind) => SPOKEN.has(kind);
/** Kinds drawn with a tail (or a thought trail) toward the speaker. */
export const hasTail = (kind: LineKind) => SPOKEN.has(kind);

/** Kind base sizes (the shared constant; unchanged values). */
export const KIND_FONT_SCALE: Record<LineKind, number> = SHARED_KIND_FONT_SCALE;

// ── Numbers ──────────────────────────────────────────────────────────────────

export const clamp = (n: number, lo: number, hi: number): number => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
export const clamp01 = (n: number) => clamp(n, 0, 1);
const round = (n: number, places = 2) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
const round4 = (n: number) => round(n, 4);

const clean = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/** Width / height of an aspect ratio string ("2:3" → 0.667). */
export const aspectNumber = (aspect?: AspectRatio | string | null): number => {
  if (!aspect) return 2 / 3;
  const [w, h] = String(aspect).split(':').map(Number);
  return w > 0 && h > 0 ? w / h : 2 / 3;
};

/** A page's width/height: the render's pixel size when known, else the format's aspect. */
export const pageAspectOf = (doc: Pick<ComicDoc, 'format'>, page?: Pick<Page, 'render'> | null): number => {
  const a = page?.render?.asset;
  if (a?.w && a?.h && a.w > 0 && a.h > 0) return a.w / a.h;
  return aspectNumber(doc.format.pageAspect);
};

// ── Type ─────────────────────────────────────────────────────────────────────

/** Lettering font size in px for a page rendered `pageWidthPx` wide. */
export const balloonFontPx = (pageWidthPx: number, kind: LineKind = 'speech'): number =>
  round(Math.max(LETTERING.minFontPx, Math.max(0, pageWidthPx) * LETTERING.fontScale * (KIND_FONT_SCALE[kind] ?? 1)));

/**
 * Sound-effect size: big display lettering that still fits its box on one line per word
 * (Bangers is condensed: ≈ 0.5em per glyph).
 */
export const sfxFontPx = (text: string, boxWidthPx: number, pageWidthPx: number): number => {
  const longest = Math.max(1, ...clean(text).split(' ').map((w) => w.length));
  const fit = (Math.max(0, boxWidthPx) * 0.94) / (longest * 0.5);
  return round(Math.max(LETTERING.minFontPx, Math.min(balloonFontPx(pageWidthPx, 'sfx'), fit)));
};

/** Outline weight in px for a page rendered `pageWidthPx` wide. */
export const strokePx = (pageWidthPx: number): number => round(Math.max(LETTERING.minStrokePx, pageWidthPx * LETTERING.strokeScale));

/** Inner padding in px. */
export const balloonPaddingPx = (pageWidthPx: number) => ({ x: round(pageWidthPx * LETTERING.padX), y: round(pageWidthPx * LETTERING.padY) });

/** Locale-aware uppercase lettering (comic convention); scripts without case are unaffected. */
export const letteringText = (text: string, language = 'en'): string => {
  const t = clean(text);
  try {
    return t.toLocaleUpperCase(language || 'en');
  } catch {
    return t.toUpperCase();
  }
};

/** Balloon width from text length — same curve the server uses when it auto-sizes balloons. */
export const balloonWidthForText = (text: string): number => {
  const len = clean(text).length;
  const t = clamp((len - 12) / (110 - 12), 0, 1);
  return round4(AUTO_MIN_W + t * (AUTO_MAX_W - AUTO_MIN_W));
};

/** Estimated balloon height as a fraction of the page HEIGHT (word-wrapped at width w). Mirrors the server. */
export const estimateBalloonHeight = (text: string, w: number, pageAspect = 2 / 3): number => {
  const perLine = Math.max(6, Math.floor((w - LETTERING.padW) / LETTERING.charW));
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
  return round4((lines * LETTERING.lineH + LETTERING.padH) * pageAspect);
};

/** Keep a balloon on the page with a sane width; tail tips clamped to the page. */
export const clampBalloon = (b: Balloon): Balloon => {
  const w = clamp(typeof b.w === 'number' ? b.w : AUTO_MIN_W, LETTERING.minW, LETTERING.maxW);
  const out: Balloon = {
    ...b,
    w: round4(w),
    x: round4(clamp(typeof b.x === 'number' ? b.x : 0, 0, 1 - w)),
    y: round4(clamp(typeof b.y === 'number' ? b.y : 0, 0, 0.99))
  };
  if (typeof b.tailX === 'number' && typeof b.tailY === 'number' && Number.isFinite(b.tailX) && Number.isFinite(b.tailY)) {
    out.tailX = round4(clamp01(b.tailX));
    out.tailY = round4(clamp01(b.tailY));
  } else {
    delete out.tailX;
    delete out.tailY;
  }
  return out;
};

/** Tail tip for a speaking balloon that has none: just below, slightly toward the reading start. */
export const defaultTailTip = (b: Pick<Balloon, 'x' | 'y' | 'w'>, heightFrac: number): { tailX: number; tailY: number } => ({
  tailX: round4(clamp01(b.x + b.w * 0.42)),
  tailY: round4(clamp01(b.y + heightFrac + 0.04))
});

// ── Word wrap (canvas) ───────────────────────────────────────────────────────

/** Greedy word wrap; a word longer than the line is broken across lines. */
export const wrapText = (text: string, maxWidth: number, measure: (s: string) => number): string[] => {
  const words = clean(text).split(' ').filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let current = '';
  const pushLongWord = (word: string) => {
    let chunk = '';
    for (const ch of word) {
      if (chunk && measure(chunk + ch) > maxWidth) {
        lines.push(chunk);
        chunk = ch;
      } else chunk += ch;
    }
    return chunk;
  };
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = measure(word) > maxWidth ? pushLongWord(word) : word;
  }
  if (current) lines.push(current);
  return lines;
};

/**
 * Word wrap with balanced line lengths (like CSS `text-wrap: balance`): the narrowest width
 * that keeps the greedy line count, so balloons don't end on a lonely word.
 */
export const wrapBalanced = (text: string, maxWidth: number, measure: (s: string) => number): string[] => {
  const greedy = wrapText(text, maxWidth, measure);
  if (greedy.length <= 1) return greedy;
  let lo = maxWidth * 0.4;
  let hi = maxWidth;
  for (let i = 0; i < 10; i += 1) {
    const mid = (lo + hi) / 2;
    if (wrapText(text, mid, measure).length <= greedy.length) hi = mid;
    else lo = mid;
  }
  return wrapText(text, hi, measure);
};

// ── Shapes (the shared vector library; byte-identical classic generators) ────

export {
  burstPath,
  burstPoints,
  captionPath,
  cloudPath,
  fitOutlineScale,
  hashSeed,
  insideBody,
  smoothClosedPath,
  speechBodyPath,
  superellipsePoints,
  tailPath,
  thoughtBubbles
} from '../../../shared/comic/lettering/shapes';
export type { Circle, Pt, TextInset } from '../../../shared/comic/lettering/shapes';

export interface BalloonShape {
  kind: LineKind;
  /** Closed body outline (SVG path data); absent for sound effects. */
  body?: string;
  /** Tail wedge (speech / whisper / shout). */
  tail?: string;
  /** Thought trail toward the speaker. */
  bubbles: Circle[];
  fill: string;
  stroke: string;
  dashed: boolean;
}

/**
 * Everything needed to draw one balloon in balloon-local px. `tip` is the tail tip relative
 * to the balloon's top-left corner (omit for no tail).
 */
export const balloonShape = (
  kind: LineKind,
  w: number,
  h: number,
  opts: { tip?: Pt | null; seed?: number; /** Text padding in px (keeps lettering clear of the outline). */ inset?: TextInset } = {}
): BalloonShape => {
  const inset = opts.inset;
  const tip = opts.tip && hasTail(kind) ? opts.tip : null;
  const base = { kind, fill: LETTERING.fill, stroke: LETTERING.ink, dashed: false, bubbles: [] as Circle[] };
  switch (kind) {
    case 'caption':
      return { ...base, body: captionPath(w, h), fill: LETTERING.captionFill };
    case 'sfx':
      return { ...base, fill: 'none', stroke: 'none' };
    case 'thought':
      return { ...base, body: cloudPath(w, h, opts.seed, inset), bubbles: tip ? thoughtBubbles(w, h, tip) : [] };
    case 'shout':
      return { ...base, body: burstPath(w, h, opts.seed, inset), ...(tip ? { tail: tailPath(w, h, tip, 'straight') || undefined } : {}) };
    case 'whisper':
      return { ...base, body: speechBodyPath(w, h, inset), dashed: true, ...(tip ? { tail: tailPath(w, h, tip) || undefined } : {}) };
    case 'speech':
    default:
      return { ...base, body: speechBodyPath(w, h, inset), ...(tip ? { tail: tailPath(w, h, tip) || undefined } : {}) };
  }
};

/** Dash pattern for whispers, scaled to the stroke. */
export const dashArray = (stroke: number) => `${round(stroke * 3)} ${round(stroke * 2.2)}`;

// ── Sound effects ────────────────────────────────────────────────────────────

/** Color and tilt for a sound effect (deterministic per line; the shared classic SFX palette). */
export const sfxStyle = (lineId: string): { color: string; rotate: number } => sfxAutoStyle(lineId);

// ── Lines → balloons ─────────────────────────────────────────────────────────

export interface ResolvedBalloon {
  line: Line;
  /** 1-based panel number the line belongs to. */
  panelN: number;
  balloon: Balloon;
  /** True when the page had no balloon for this line and we placed it ourselves. */
  fallback: boolean;
  /** A placed balloon that could not avoid an overlap (the editor offers free fixes). */
  crowded?: boolean;
}

const validBalloon = (b?: Balloon): b is Balloon =>
  !!b && [b.x, b.y, b.w].every((v) => typeof v === 'number' && Number.isFinite(v)) && b.w > 0;

const isFullDoc = (doc: Pick<ComicDoc, 'format'>): doc is ComicDoc => Array.isArray((doc as ComicDoc).pages);

/**
 * Every non-empty line of a page with the balloon to draw for it, in reading order. Lines without a
 * balloon (new lines, an unfinished layout) are placed by the shared deterministic placer around
 * EVERY stored balloon on the page (outlines, not text boxes), inside their panel and the safe area,
 * so no text is ever lost and nothing is placed off-page.
 */
export const resolveBalloons = (doc: Pick<ComicDoc, 'format'>, page: Page): ResolvedBalloon[] => {
  const byId = new Map<string, Balloon>();
  for (const b of page.balloons || []) if (validBalloon(b) && !byId.has(b.lineId)) byId.set(b.lineId, b);
  const aspect = pageAspectOf(doc, page);
  const items: { line: Line; panelN: number }[] = [];
  page.panels.forEach((panel) => {
    for (const line of panel.lines) if (clean(line.text)) items.push({ line, panelN: panel.n });
  });
  const placed = new Map<string, Balloon>();
  const crowded = new Set<string>();
  if (items.some((it) => !byId.has(it.line.id))) {
    const letterStyle = (doc as Partial<ComicDoc>).letterStyle ?? DEFAULT_LETTERING;
    const qc = page.render?.qc;
    const result = placeBalloonsDetailed({
      page,
      boxes: panelBoxesFor(doc, page),
      aspect,
      rtl: doc.format.readingDirection === 'rtl',
      // Real plan metrics when we have the whole doc (styles, fonts); estimates otherwise.
      plansFor: isFullDoc(doc) ? letteringSizer(doc, page, aspect, estimateMeasure) : () => ({ h: 0, bounds: { x: 0, y: 0, w: 0, h: 0 } }),
      keepOut: qc?.keepOut,
      heads: qc?.heads,
      safeMargin: typeof letterStyle.safeMargin === 'number' ? letterStyle.safeMargin : DEFAULT_SAFE_MARGIN,
      existing: page.balloons || [],
      keep: 'all',
      lang: doc.format.language
    });
    for (const b of result.balloons) if (!byId.has(b.lineId)) placed.set(b.lineId, b);
    for (const id of result.crowded) crowded.add(id);
  }
  const out: ResolvedBalloon[] = [];
  for (const { line, panelN } of items) {
    const stored = byId.get(line.id);
    if (stored) {
      out.push({ line, panelN, balloon: clampBalloon(stored), fallback: false });
      continue;
    }
    const b = placed.get(line.id);
    if (!b) continue;
    const r: ResolvedBalloon = { line, panelN, balloon: clampBalloon(b), fallback: true };
    if (crowded.has(line.id)) r.crowded = true;
    out.push(r);
  }
  return out;
};

/** Line → its tail tip in page coordinates (explicit, else the default below the balloon). */
export const tailTipOf = (balloon: Balloon, kind: LineKind, heightFrac: number): { tailX: number; tailY: number } | null => {
  if (!hasTail(kind)) return null;
  if (typeof balloon.tailX === 'number' && typeof balloon.tailY === 'number') return { tailX: balloon.tailX, tailY: balloon.tailY };
  return defaultTailTip(balloon, heightFrac);
};
