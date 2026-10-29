// Deterministic, free balloon auto-placement (contract §10.2, lettering.md §6.6, visualqa §4).
// Used by the client for lines without a stored balloon, by the server's free re-layout
// (`arrange_balloons auto_layout`, relayout with stored qc) and by vision placement.
//
// Coordinates are page-normalized: x/w are fractions of the page WIDTH, y/h of the page HEIGHT.
// `aspect` = width / height, so a margin of m page widths is m·aspect page heights.
//
// Rules:
//  - Collisions, safe-area and panel tests use OUTLINES (text box + the shape's bleed), never bare
//    text boxes, so bursts/clouds don't overlap neighbours or hug the page edge.
//  - Pinned / locked balloons are page-wide obstacles (a stored balloon of panel 2 sitting over
//    panel 5 is respected by panel 5's placement).
//  - Faces (and synthesized boxes around known heads) are avoided whenever space exists.
//  - A balloon's FOOTPRINT is its outline plus its tail tip (the box the drawn group occupies): tails
//    never cross another balloon, and nothing is placed under a stored balloon's tail.
//  - Reading order is part of a clean spot: a line is read after the previous line of its panel (below it,
//    or after it on its row), and a full panel packs again compactly before anything leaves it.
//  - A panel that is full spills, still in reading order: beside the panel in its own tier first, then a
//    later tier, never into a panel the reader finishes first, never above its tier, never more than
//    about a panel away; it is reported as `crowded` so the editor can offer free fixes. Only an over-full
//    page (no such room anywhere) takes a free spot read early — as few panels back as possible — and only
//    a page with no free room at all takes the least-bad candidate inside the safe area.
//  - settleBalloons() is the render-time pass (planLettering): with the REAL text sizes and tails it
//    nudges software-placed and unpinned stored balloons out of each other's way and off pinned ones,
//    keeping the same reading order (its tier, then a later tier, then edge to edge, and only then early).
//    Stored values stay untouched; pinned and locked balloons never move.

import type { Balloon, Box, KeepOut, Line, LineKind, Page, SpeakerMark } from '../doc.js';
import { estimateTextHeight, estimateWidthForText, normalizeLetteringText } from '../textLayout.js';
import type { BubbleShape } from './style.js';

/** Panel inner padding and minimum gap between outlines (page fractions). */
const PAD = 0.012;
const GAP = 0.01;
/** Clearance a placement keeps around a balloon's footprint: the settle gap plus rounding headroom. */
const CLEAR_GAP = GAP * 1.05;
const PAGE_FALLBACK_BOX: Box = { x: 0.02, y: 0.02, w: 0.96, h: 0.96 };
const SPOKEN: ReadonlySet<LineKind> = new Set<LineKind>(['speech', 'thought', 'whisper', 'shout']);

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const clampP = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);

export interface PlaceArgs {
  page: Page;
  boxes: Box[];
  aspect: number;
  rtl: boolean;
  /**
   * Size of a line's balloon at width w: `h` = text-box height (page-HEIGHT fraction), `bounds` = the
   * outline bbox RELATIVE to the text box's top-left (page fractions; x ≤ 0, y ≤ 0, w ≥ w, h ≥ h).
   * layout.ts `letteringSizer()` builds it from the real plan metrics.
   */
  plansFor: (line: Line, w: number) => { h: number; bounds: Box };
  keepOut?: KeepOut[];
  heads?: SpeakerMark[];
  suggestions?: Map<string, Balloon>; // vision rects: a hint, not law
  safeMargin: number; // letterStyle.safeMargin ?? 0.03 (page-WIDTH fraction)
  existing: Balloon[]; // pinned/locked = obstacles (page-wide, not per panel)
  /** 'pinned' (default): every unpinned line is (re)placed. 'all': every valid stored balloon is kept; only missing lines are placed. */
  keep?: 'pinned' | 'all';
  /** Only (re)place these lines (locked ones never move); every other stored balloon stays. */
  only?: readonly string[];
  /** Lettering language (estimates); default the line's own `lang`, else 'en'. */
  lang?: string;
}

export interface PlaceResult {
  /** One balloon per non-empty line, in reading order. */
  balloons: Balloon[];
  /** Lines (re)placed by this call. */
  placed: string[];
  /** Placed lines that could not avoid an overlap / face / the safe area (least-bad position used). */
  crowded: string[];
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

const validBalloon = (b?: Balloon | null): b is Balloon =>
  !!b && [b.x, b.y, b.w].every((v) => typeof v === 'number' && Number.isFinite(v)) && b.w > 0;
const validBox = (b?: Box | null): b is Box =>
  !!b && [b.x, b.y, b.w, b.h].every((v) => typeof v === 'number' && Number.isFinite(v)) && b.w > 0 && b.h > 0;

const area = (b: Box) => Math.max(0, b.w) * Math.max(0, b.h);
const intersect = (a: Box, b: Box): Box => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
};
const inflate = (b: Box, dx: number, dy: number): Box => ({ x: b.x - dx, y: b.y - dy, w: b.w + 2 * dx, h: b.h + 2 * dy });
/** Fraction of `b` lying outside `region` (0..1). */
const outside = (b: Box, region: Box) => {
  const a = area(b);
  return a > 0 ? 1 - area(intersect(b, region)) / a : 0;
};
/** Fraction of `b` covered by `other` (0..1). */
const covered = (b: Box, other: Box) => {
  const a = area(b);
  return a > 0 ? area(intersect(b, other)) / a : 0;
};
const segmentHitsBox = (p: { x: number; y: number }, q: { x: number; y: number }, b: Box): boolean => {
  for (let i = 1; i < 12; i += 1) {
    const t = i / 12;
    const x = p.x + (q.x - p.x) * t;
    const y = p.y + (q.y - p.y) * t;
    if (x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h) return true;
  }
  return false;
};

/** Safe area: the page inset by `margin` page widths on every side (margin·aspect in page heights). */
export function safeAreaBox(margin: number, aspect: number): Box {
  const m = clampP(margin, 0, 0.2);
  const my = m * (Number.isFinite(aspect) && aspect > 0 ? aspect : 2 / 3);
  return { x: m, y: my, w: 1 - 2 * m, h: 1 - 2 * my };
}

// ── Outline bleed ────────────────────────────────────────────────────────────

/**
 * Per-axis bleed of each kind's CLASSIC outline past its text box (fraction of the box), measured from
 * the real generators over typical auto-sized balloons (w 0.12–0.34 page widths, h ≤ w, classic
 * padding). Flat wide thought clouds really do scallop well above their text. Used by
 * fitBalloonOnPage (kind-only callers such as drag clamps); planLettering uses the exact geometry.
 */
export const OUTLINE_BLEED_XY: Record<LineKind, { x: number; y: number }> = {
  speech: { x: 0.07, y: 0.12 },
  whisper: { x: 0.07, y: 0.12 },
  thought: { x: 0.24, y: 1.28 },
  shout: { x: 0.19, y: 0.48 },
  caption: { x: 0, y: 0 },
  sfx: { x: 0, y: 0.1 }
};

/** Uniform conservative bleed per kind (max of the per-axis values above). Prefer OUTLINE_BLEED_XY or real bounds. */
export const OUTLINE_BLEED: Record<LineKind, number> = {
  speech: 0.12,
  whisper: 0.12,
  thought: 1.28,
  shout: 0.48,
  caption: 0,
  sfx: 0.1
};

/** Per-axis bleed by shape over the same typical balloons (shapes.test.ts checks the real geometry stays within). */
export const SHAPE_BLEED: Record<BubbleShape, { x: number; y: number }> = {
  squircle: { x: 0.07, y: 0.12 },
  oval: { x: 0.15, y: 0.21 },
  rounded_rect: { x: 0, y: 0 },
  rect: { x: 0, y: 0 },
  notched: { x: 0, y: 0 },
  scroll: { x: 0.07, y: 0.06 },
  ribbon: { x: 0.35, y: 0.15 },
  cloud: { x: 0.24, y: 1.28 },
  burst: { x: 0.19, y: 0.48 },
  explosion: { x: 0.29, y: 0.63 },
  jagged: { x: 0.14, y: 0.23 },
  wavy: { x: 0.19, y: 0.26 },
  electronic: { x: 0.14, y: 0.21 },
  none: { x: 0, y: 0 }
};

export function outlineBounds(b: { x: number; y: number; w: number; h: number }, kind: LineKind, shape: BubbleShape): Box {
  const bleed = SHAPE_BLEED[shape] ?? OUTLINE_BLEED_XY[kind] ?? { x: 0, y: 0 };
  const dx = b.w * bleed.x;
  const dy = b.h * bleed.y;
  return { x: b.x - dx, y: b.y - dy, w: b.w + 2 * dx, h: b.h + 2 * dy };
}

/** Classic shape of a kind (used when only the kind is known). */
const CLASSIC_SHAPE: Record<LineKind, BubbleShape> = {
  speech: 'squircle',
  whisper: 'squircle',
  thought: 'cloud',
  shout: 'burst',
  caption: 'rect',
  sfx: 'none'
};

/**
 * Render-time fit: keeps the OUTLINE ≥ margin (0.008) inside the page without moving stored values.
 * A balloon whose outline is wider than the page is narrowed; one taller than the page is pinned to
 * the top margin and flagged `crowded`. The tail tip is clamped to the page.
 */
export function fitBalloonOnPage(
  b: { x: number; y: number; w: number; tailX?: number; tailY?: number },
  kind: LineKind,
  hFrac: number,
  _aspect: number,
  margin = 0.008
): { x: number; y: number; w: number; tailX?: number; tailY?: number; crowded: boolean } {
  const bleed = OUTLINE_BLEED_XY[kind] ?? OUTLINE_BLEED_XY.speech;
  const m = clampP(margin, 0, 0.2);
  let crowded = false;
  let w = Number.isFinite(b.w) && b.w > 0 ? b.w : 0.16;
  if (w * (1 + 2 * bleed.x) > 1 - 2 * m) {
    w = (1 - 2 * m) / (1 + 2 * bleed.x);
    crowded = true;
  }
  const h = Number.isFinite(hFrac) && hFrac > 0 ? hFrac : 0;
  const bx = w * bleed.x;
  const by = h * bleed.y;
  const x = clampP(b.x, bx + m, 1 - w - bx - m);
  const loY = by + m;
  const hiY = 1 - h - by - m;
  let y: number;
  if (hiY < loY) {
    y = loY;
    crowded = true;
  } else y = clampP(b.y, loY, hiY);
  const out: { x: number; y: number; w: number; tailX?: number; tailY?: number; crowded: boolean } = {
    x: x === b.x ? b.x : round4(x),
    y: y === b.y ? b.y : round4(y),
    w: w === b.w ? b.w : round4(w),
    crowded
  };
  if (typeof b.tailX === 'number' && typeof b.tailY === 'number' && Number.isFinite(b.tailX) && Number.isFinite(b.tailY)) {
    out.tailX = clampP(b.tailX, 0, 1);
    out.tailY = clampP(b.tailY, 0, 1);
  }
  return out;
}

// ── Staging (mirrors server prompts.ts stagePanel) ───────────────────────────

/**
 * Horizontal screen position (0..1 within the panel) where the page prompt staged a speaker
 * (characters keep their left→right page order); unknown speakers alternate sides from the reading start.
 */
export const stagedSpeakerX = (page: Page, panelIndex: number, speakerId: string | undefined, spokenSeen = 0, rtl = false): number => {
  const panel = page.panels[panelIndex];
  const pageOrder: string[] = [];
  for (const p of page.panels) for (const id of p.castIds || []) if (!pageOrder.includes(id)) pageOrder.push(id);
  const ids = [...new Set(panel?.castIds || [])].sort((a, b) => pageOrder.indexOf(a) - pageOrder.indexOf(b));
  const i = speakerId ? ids.indexOf(speakerId) : -1;
  if (i >= 0) return ids.length === 1 ? 0.5 : 0.2 + (0.6 * i) / (ids.length - 1);
  const alt = spokenSeen % 2 === 0 ? 0.28 : 0.72;
  return rtl ? 1 - alt : alt;
};

// ── Placement ────────────────────────────────────────────────────────────────

interface Candidate {
  x: number;
  y: number;
  bias: number; // kind-specific preference (negative = preferred)
}

/** Default sizer when the caller's `plansFor` returns nothing usable: estimates + classic bleed. */
const fallbackSize = (line: Line, w: number, aspect: number, lang: string): { h: number; bounds: Box } => {
  const h = estimateTextHeight(line.text, w, aspect, lang);
  const o = outlineBounds({ x: 0, y: 0, w, h }, line.kind, CLASSIC_SHAPE[line.kind] ?? 'squircle');
  return { h, bounds: o };
};

/** What `plansFor` reports for a line at a width: text-box height, outline bounds and whether it draws a tail. */
export interface SizedLine {
  h: number;
  bounds: Box;
  /** The style draws a tail (default: spoken kinds do). */
  tail?: boolean;
}

const sizeOf = (args: PlaceArgs, line: Line, w: number, lang: string): SizedLine => {
  let got: SizedLine | undefined;
  try {
    got = args.plansFor(line, w);
  } catch {
    got = undefined;
  }
  const tail = typeof got?.tail === 'boolean' ? got.tail : SPOKEN.has(line.kind);
  if (!got || !(got.h > 0) || !validBox(got.bounds)) return { ...fallbackSize(line, w, args.aspect, lang), tail };
  // Bounds must contain the text box.
  const b = got.bounds;
  const x = Math.min(0, b.x);
  const y = Math.min(0, b.y);
  return { h: got.h, bounds: { x, y, w: Math.max(b.x + b.w, w) - x, h: Math.max(b.y + b.h, got.h) - y }, tail };
};

/** The box a drawn balloon really occupies: its outline plus (when it has one) its tail tip. */
export function balloonFootprint(outline: Box, tip?: { x: number; y: number } | null): Box {
  if (!tip || !Number.isFinite(tip.x) || !Number.isFinite(tip.y)) return outline;
  if (tip.x >= outline.x && tip.x <= outline.x + outline.w && tip.y >= outline.y && tip.y <= outline.y + outline.h) return outline;
  const x = Math.min(outline.x, tip.x);
  const y = Math.min(outline.y, tip.y);
  return { x, y, w: Math.max(outline.x + outline.w, tip.x) - x, h: Math.max(outline.y + outline.h, tip.y) - y };
}

/**
 * The tail tip the renderer draws for a balloon with no stored tail (layout.ts planLettering): below the
 * text box, a little right of centre. Page fractions; `h` is the text-box height (page-HEIGHT fraction).
 */
export const defaultTailTip = (b: { x: number; y: number; w: number }, h: number): { x: number; y: number } => ({
  x: clampP(b.x + b.w * 0.42, 0, 1),
  y: clampP(b.y + h + 0.04, 0, 1)
});

/** The tip a stored balloon draws: its stored tail, else the renderer's default when the style has a tail. */
const storedTip = (b: Balloon, size: SizedLine): { x: number; y: number } | null => {
  if (typeof b.tailX === 'number' && typeof b.tailY === 'number' && Number.isFinite(b.tailX) && Number.isFinite(b.tailY)) return { x: clampP(b.tailX, 0, 1), y: clampP(b.tailY, 0, 1) };
  return size.tail ? defaultTailTip(b, size.h) : null;
};

/** Distance (page widths) from a box's centre to the nearest point of `region` (0 inside). */
const distToRegion = (b: Box, region: Box, aspect: number): number => {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = Math.max(region.x - cx, 0, cx - (region.x + region.w));
  const dy = Math.max(region.y - cy, 0, cy - (region.y + region.h));
  return Math.hypot(dx, dy / aspect);
};

/** Placement with diagnostics (which lines moved, which had to accept a crowded spot). */
export function placeBalloonsDetailed(args: PlaceArgs): PlaceResult {
  const page = args.page;
  const aspect = Number.isFinite(args.aspect) && args.aspect > 0 ? args.aspect : 2 / 3;
  const rtl = !!args.rtl;
  const safe = safeAreaBox(Number.isFinite(args.safeMargin) ? args.safeMargin : 0.03, aspect);
  const keepAll = args.keep === 'all';
  const only = args.only ? new Set(args.only) : undefined;
  const existing = new Map<string, Balloon>();
  for (const b of args.existing || []) if (validBalloon(b) && !existing.has(b.lineId)) existing.set(b.lineId, b);

  const keepOut = (args.keepOut || []).filter((k) => k && validBox(k.box));
  const faces: Box[] = keepOut.filter((k) => k.kind === 'face').map((k) => k.box);
  // A known head without a face box still gets one (balloons never cover heads).
  for (const h of args.heads || []) {
    if (!h?.head || !Number.isFinite(h.head.x) || !Number.isFinite(h.head.y)) continue;
    if (faces.some((f) => h.head.x >= f.x && h.head.x <= f.x + f.w && h.head.y >= f.y && h.head.y <= f.y + f.h)) continue;
    const r = 0.045;
    faces.push({ x: h.head.x - r, y: h.head.y - r * aspect, w: 2 * r, h: 2 * r * aspect });
  }
  const busy: Box[] = keepOut.filter((k) => k.kind === 'hands' || k.kind === 'action' || k.kind === 'text').map((k) => k.box);
  const other: Box[] = keepOut.filter((k) => k.kind === 'other').map((k) => k.box);

  const panels = page.panels.map((panel, index) => ({ panel, index })).sort((a, b) => a.panel.n - b.panel.n || a.index - b.index);
  const boxFor = (index: number): Box => (validBox(args.boxes?.[index]) ? args.boxes[index] : PAGE_FALLBACK_BOX);
  const langOf = (line: Line) => line.lang || args.lang || 'en';
  const isKept = (line: Line): boolean => {
    const b = existing.get(line.id);
    if (!b) return false;
    if (b.locked) return true;
    if (only) return !only.has(line.id);
    return !!b.pinned || keepAll;
  };

  // Obstacles: every kept balloon's FOOTPRINT (outline + tail tip), page-wide, before anything is placed.
  const obstacles: { lineId: string; box: Box; panelIndex: number; x: number; y: number }[] = [];
  for (const { panel, index } of panels) {
    for (const line of panel.lines) {
      if (!normalizeLetteringText(line.text) || !isKept(line)) continue;
      const b = existing.get(line.id)!;
      const s = sizeOf(args, line, b.w, langOf(line));
      const outline = { x: b.x + s.bounds.x, y: b.y + s.bounds.y, w: s.bounds.w, h: s.bounds.h };
      obstacles.push({ lineId: line.id, panelIndex: index, x: b.x, y: b.y, box: balloonFootprint(outline, storedTip(b, s)) });
    }
  }

  const result: Balloon[] = [];
  const placedIds: string[] = [];
  const crowded: string[] = [];

  type Pick = { cost: number; x: number; y: number; w: number; h: number; outline: Box; clean: boolean; roomy: boolean; spill: boolean; tip: { x: number; y: number } | null };

  panels.forEach(({ panel, index }, readPos) => {
    const box = boxFor(index);
    const inner = { x: box.x + PAD, y: box.y + PAD, w: Math.max(0.01, box.w - 2 * PAD), h: Math.max(0.01, box.h - 2 * PAD) };
    let region = intersect(inner, safe);
    if (region.w < 0.02 || region.h < 0.02) region = intersect(box, safe);
    if (region.w < 0.02 || region.h < 0.02) region = safe;
    const lines = panel.lines.filter((l) => normalizeLetteringText(l.text));
    // Reading order across panels: the panels a reader finishes before this one (measured boxes only).
    const earlier: Box[] = [];
    for (let r = 0; r < readPos; r += 1) {
      const e = args.boxes?.[panels[r].index];
      if (validBox(e)) earlier.push(e);
    }
    /** A text box centred here is read before this panel: inside an earlier panel, or above this panel's tier. */
    const readsEarly = (cx: number, cy: number): boolean => cy < box.y || earlier.some((e) => cx >= e.x && cx <= e.x + e.w && cy >= e.y && cy <= e.y + e.h);
    /** How far back the reader meets a text box centred here: 0 = in turn, else panels back (above the tier counts as one). */
    const readBack = (cx: number, cy: number): number => {
      for (let i = earlier.length - 1; i >= 0; i -= 1) {
        const e = earlier[i];
        if (cx >= e.x && cx <= e.x + e.w && cy >= e.y && cy <= e.y + e.h) return earlier.length - i;
      }
      return cy < box.y ? 1 : 0;
    };
    /** Farthest a spilled balloon's outline centre may sit from its panel: about one panel away (page widths). */
    const spillReach = Math.max(box.w, box.h / aspect);

    /**
     * Letter the panel's lines in reading order. `compact`: a full panel is packed the way a letterer packs
     * one — every balloon as high and as near the reading start as it goes, the next one after it — instead
     * of aiming at speakers. Returns how many lines found no clean spot.
     */
    const letterPanel = (compact: boolean): number => {
      let stuck = 0;
      let spokenSeen = 0;
      let prevInPanel: { x: number; y: number } | undefined;
      lines.forEach((line, k) => {
        const lang = langOf(line);
        const spoken = SPOKEN.has(line.kind);
        const stageX = spoken ? stagedSpeakerX(page, index, line.speakerId, spokenSeen, rtl) : 0.5;
        if (spoken) spokenSeen += 1;
        if (isKept(line)) {
          const b = existing.get(line.id)!;
          result.push(b);
          // A stored balloon the owner put in another panel says nothing about this panel's reading order.
          const cx = b.x + b.w / 2;
          if (cx >= box.x && cx <= box.x + box.w && b.y >= box.y - GAP && b.y <= box.y + box.h) prevInPanel = { x: b.x, y: b.y };
          return;
        }
        const prior = existing.get(line.id);
        const head = spoken ? (args.heads || []).find((h) => h && h.panel === panel.n && !!line.speakerId && h.characterId === line.speakerId) : undefined;
        const headPt = head ? head.mouth ?? head.head : undefined;
        const suggestion = args.suggestions?.get(line.id);
        const opening = line.kind === 'caption' && lines.slice(0, k).every((l) => l.kind === 'caption');

        const w0 = Math.min(estimateWidthForText(line.text, lang), Math.max(0.08, box.w - 2 * PAD));
        const widths = [w0, Math.max(0.1, round4(w0 * 0.8)), Math.max(0.1, round4(w0 * 0.65))].filter((w, i, a) => a.indexOf(w) === i);

        /** Score one text-box position (x, y) at a width: the drawn footprint (outline + tail) against everything on the page. */
        const score = (x: number, y: number, w: number, size: SizedLine, bias: number, spill: boolean): Pick => {
          const b = size.bounds;
          const outline: Box = { x: x + b.x, y: y + b.y, w: b.w, h: b.h };
          let tip = spoken && size.tail !== false ? tailTip({ x, y, w, h: size.h }, box, headPt, faces, aspect, box.x + stageX * box.w) : null;
          // A spilled balloon sits away from its panel: its tail points home but stays short, so it never
          // reaches back across the balloons that filled the panel.
          if (tip && spill) tip = shortenTail({ x, y, w, h: size.h }, tip, aspect, SPILL_TAIL_LEN);
          const foot = balloonFootprint(outline, tip);
          let overlap = 0;
          // The full gap (a hair more than the render-time settle asks for, so a rounded placement never
          // needs a nudge): what is clean here stays clean when drawn.
          const grownFoot = inflate(foot, CLEAR_GAP, CLEAR_GAP * aspect);
          for (const o of obstacles) overlap += covered(grownFoot, o.box);
          let faceHit = 0;
          for (const f of faces) faceHit += covered(outline, f);
          let busyHit = 0;
          for (const a of busy) busyHit += covered(outline, a);
          let otherHit = 0;
          for (const a of other) otherHit += covered(outline, a);
          let order = 0;
          if (prevInPanel) {
            const sameRow = Math.abs(y - prevInPanel.y) < ROW_TOLERANCE;
            if (y < prevInPanel.y - ROW_TOLERANCE || (sameRow && (rtl ? x > prevInPanel.x : x < prevInPanel.x))) order = 1;
          }
          const cx = x + w / 2;
          const dist = spill ? distToRegion(outline, box, aspect) : 0;
          let aim = 0;
          if (headPt) aim = Math.hypot(cx - headPt.x, (y + size.h - headPt.y) / aspect);
          else if (spoken) aim = Math.abs(cx - (box.x + stageX * box.w));
          const sug = suggestion ? Math.hypot(x - suggestion.x, (y - suggestion.y) / aspect) : 0;
          const cost =
            1000 * outside(outline, safe) +
            400 * faceHit +
            150 * busyHit +
            60 * otherHit +
            300 * overlap +
            80 * outside(outline, box) +
            // A spilled balloon stays as close to its panel as the page allows.
            300 * dist +
            40 * order +
            (compact
              ? 30 * clampP((y - region.y) / Math.max(0.01, region.h), 0, 1) + 8 * clampP((rtl ? region.x + region.w - (x + w) : x - region.x) / Math.max(0.01, region.w), 0, 1)
              : 12 * aim + 6 * clampP((y - box.y) / Math.max(0.01, box.h), 0, 1) + 4 * sug + bias);
          // Clean: clear of every balloon and face, inside the safe area, and read after the panel's previous
          // line. A spilled spot must also be read after everything before this panel and stay near it.
          const roomy = overlap < 1e-9 && faceHit < 0.005 && outside(outline, safe) < 0.001;
          const clean = roomy && !order && (!spill || (!readsEarly(cx, y + size.h / 2) && dist <= spillReach));
          return { cost, x, y, w, h: size.h, outline, clean, roomy, spill, tip };
        };

        let best: Pick | undefined;
        let bestClean: Pick | undefined;
        /** Clear of everything but read out of order inside the panel: better than an overlap, worse than a spill. */
        let bestRoomy: Pick | undefined;
        const consider = (p: Pick) => {
          if (!best || p.cost < best.cost - 1e-9) best = p;
          if (p.clean && (!bestClean || p.cost < bestClean.cost - 1e-9)) bestClean = p;
          if (p.roomy && !p.spill && (!bestRoomy || p.cost < bestRoomy.cost - 1e-9)) bestRoomy = p;
        };
        for (const w of widths) {
          const size = sizeOf(args, line, w, lang);
          const b = size.bounds;
          // Text-box positions that keep the outline inside the region (centred when it can't fit).
          const xLo = region.x - b.x;
          const xHi = region.x + region.w - (b.x + b.w);
          const yLo = region.y - b.y;
          const yHi = region.y + region.h - (b.y + b.h);
          const xs = xHi >= xLo ? Array.from({ length: 7 }, (_, i) => xLo + ((xHi - xLo) * i) / 6) : [(xLo + xHi) / 2];
          const ys = yHi >= yLo ? Array.from({ length: 7 }, (_, i) => yLo + ((yHi - yLo) * i) / 6) : [(yLo + yHi) / 2];
          const cands: Candidate[] = [];
          if (line.kind === 'caption' && !compact) {
            const startX = rtl ? xHi : xLo;
            const endX = rtl ? xLo : xHi;
            cands.push(opening ? { x: startX, y: yLo, bias: -25 } : { x: endX, y: yHi, bias: -25 });
          }
          if (line.kind === 'sfx' && !compact) {
            const actions = busy.filter((a) => covered(a, box) > 0.3);
            for (const a of actions) {
              cands.push({ x: a.x + a.w + GAP - b.x, y: a.y, bias: -10 }, { x: a.x - (b.x + b.w) - GAP, y: a.y, bias: -10 });
            }
            cands.push({ x: box.x + box.w * 0.55 - w / 2, y: box.y + box.h * 0.55, bias: -4 });
          }
          if (suggestion && validBalloon(suggestion)) cands.push({ x: suggestion.x, y: suggestion.y, bias: 0 });
          for (const y of ys) for (const x of xs) cands.push({ x, y, bias: 0 });
          const place = (list: readonly Candidate[]) => {
            for (const c of list) {
              // Keep every candidate's outline inside the page safe area when it can fit there at all.
              const x = b.w <= safe.w ? clampP(c.x, safe.x - b.x, safe.x + safe.w - (b.x + b.w)) : c.x;
              const y = b.h <= safe.h ? clampP(c.y, safe.y - b.y, safe.y + safe.h - (b.y + b.h)) : c.y;
              consider(score(x, y, w, size, c.bias, false));
            }
          };
          place(cands);
          // A clean spot (no overlap, no face, inside the safe area) at this width: never go narrower.
          if (bestClean) break;
          // Flush against every balloon already in (or reaching into) the panel: below it, beside it, above it.
          // A busy panel's free pockets sit right next to its balloons, between the grid's points.
          const flush: Candidate[] = [];
          if (xHi >= xLo && yHi >= yLo) {
            const gx = CLEAR_GAP + 1e-4;
            const gy = (CLEAR_GAP + 1e-4) * aspect;
            const near = inflate(region, 2 * GAP, 2 * GAP * aspect);
            for (const o of obstacles) {
              if (!area(intersect(o.box, near))) continue;
              const below = o.box.y + o.box.h + gy - b.y;
              const above = o.box.y - gy - (b.y + b.h);
              const right = o.box.x + o.box.w + gx - b.x;
              const left = o.box.x - gx - (b.x + b.w);
              for (const x of [xLo, xHi, o.box.x - b.x, right, left]) flush.push({ x: clampP(x, xLo, xHi), y: clampP(below, yLo, yHi), bias: 0 });
              for (const y of [yLo, yHi, o.box.y - b.y, below]) {
                flush.push({ x: clampP(right, xLo, xHi), y: clampP(y, yLo, yHi), bias: 0 }, { x: clampP(left, xLo, xHi), y: clampP(y, yLo, yHi), bias: 0 });
              }
              for (const x of [xLo, xHi]) flush.push({ x, y: clampP(above, yLo, yHi), bias: 0 });
            }
          }
          place(flush);
          if (bestClean) break;
        }
        // The panel is full: spill to the nearest free spot in the page's safe area that the reader still
        // meets after this panel's earlier lines and every earlier panel (never over another balloon, never
        // more than about a panel away). Narrow widths first — a slimmer balloon stays nearer home.
        let spilled = false;
        /** Last resort of an over-full page: a free spot the reader meets early, as few panels back as possible. */
        let bestFree: Pick | undefined;
        /** Over-full search: free cells anywhere, ranked by how far back the reader meets them. */
        const spillSearch = (mode: 'tier' | 'later' | 'free'): void => {
          const strict = mode !== 'free';
          // Slimmer than the panel search would go: a tall narrow balloon fits a gutter or a side band.
          const spillWidths = [...new Set([...widths, Math.max(0.1, round4(w0 * 0.5))])].sort((a, b) => a - b);
          for (const w of spillWidths) {
            const size = sizeOf(args, line, w, lang);
            const b = size.bounds;
            if (b.w > safe.w || b.h > safe.h) continue;
            const xLo = safe.x - b.x;
            const xHi = safe.x + safe.w - (b.x + b.w);
            const yLo = safe.y - b.y;
            const yHi = safe.y + safe.h - (b.y + b.h);
            const nx = Math.max(2, Math.min(24, Math.round((xHi - xLo) / Math.max(0.01, b.w / 3)) + 1));
            const ny = Math.max(2, Math.min(40, Math.round((yHi - yLo) / Math.max(0.01, b.h / 3)) + 1));
            // Only a free spill spot is ever taken (the panel search already holds the least-bad one), so a
            // cell whose outline alone already touches a balloon or a face — or, in the strict pass, that the
            // reader would meet too early or that sits too far from home — is skipped before the full score.
            const hopeless = (x: number, y: number): boolean => {
              if (strict && readsEarly(x + w / 2, y + size.h / 2)) return true;
              // First pass: the panel's own tier only (beside it, in its gutters); a later tier is the second choice.
              if (mode === 'tier' && y + size.h / 2 > box.y + box.h) return true;
              const outline: Box = { x: x + b.x, y: y + b.y, w: b.w, h: b.h };
              if (strict && distToRegion(outline, box, aspect) > spillReach) return true;
              const grown = inflate(outline, CLEAR_GAP, CLEAR_GAP * aspect);
              for (const o of obstacles) if (area(intersect(grown, o.box)) > 0) return true;
              let faceHit = 0;
              for (const f of faces) faceHit += covered(outline, f);
              return faceHit >= 0.005;
            };
            for (let j = 0; j < ny; j += 1)
              for (let i = 0; i < nx; i += 1) {
                const x = xLo + ((xHi - xLo) * i) / (nx - 1);
                const y = yLo + ((yHi - yLo) * j) / (ny - 1);
                if (hopeless(x, y)) continue;
                const p = score(x, y, w, size, 0, true);
                if (strict) consider(p);
                else if (p.roomy) {
                  p.cost += 200 * readBack(x + w / 2, y + size.h / 2);
                  if (!bestFree || p.cost < bestFree.cost - 1e-9) bestFree = p;
                }
              }
            if (strict ? bestClean : bestFree) return;
          }
        };
        // The panel is full: spill to the nearest free spot in the page's safe area that the reader still
        // meets after this panel's earlier lines and every earlier panel (never more than about a panel away).
        if (!bestClean) spillSearch('tier');
        if (!bestClean) spillSearch('later');
        spilled = !!bestClean && bestClean.spill;
        // Over-full: no room in reading order anywhere. A free spot read early beats an overlap (the page
        // is lettered smaller first, and the line is flagged so the editor can say so).
        if (!bestClean && !bestRoomy) spillSearch('free');
        const pick = (bestClean ?? bestRoomy ?? bestFree ?? best)!;
        if (!pick.clean) stuck += 1;
        if (!pick.clean || spilled) crowded.push(line.id);

        // Rounded to the stored precision without nudging an outline that fits the safe area out of it.
        const inside = (v: number, lo: number, hi: number) => {
          const r = round4(v);
          if (r > hi + 1e-9 && v <= hi + 1e-9) return Math.floor(v * 10000) / 10000;
          if (r < lo - 1e-9 && v >= lo - 1e-9) return Math.ceil(v * 10000) / 10000;
          return r;
        };
        const ox = pick.outline.x - pick.x;
        const oy = pick.outline.y - pick.y;
        const balloon: Balloon = {
          lineId: line.id,
          x: inside(pick.x, safe.x - ox, safe.x + safe.w - (ox + pick.outline.w)),
          y: inside(pick.y, safe.y - oy, safe.y + safe.h - (oy + pick.outline.h)),
          w: round4(pick.w)
        };
        if (pick.tip) {
          balloon.tailX = round4(pick.tip.x);
          balloon.tailY = round4(pick.tip.y);
        } else if (spoken) {
          const tip = tailTip({ x: pick.x, y: pick.y, w: pick.w, h: pick.h }, box, headPt, faces, aspect, box.x + stageX * box.w);
          balloon.tailX = round4(tip.x);
          balloon.tailY = round4(tip.y);
        }
        if (prior) {
          if (typeof prior.z === 'number') balloon.z = prior.z;
          if (prior.linkTo) balloon.linkTo = prior.linkTo;
        }
        result.push(balloon);
        placedIds.push(line.id);
        obstacles.push({ lineId: line.id, panelIndex: index, x: balloon.x, y: balloon.y, box: balloonFootprint(pick.outline, pick.tip) });
        prevInPanel = { x: balloon.x, y: balloon.y };
      });
      return stuck;
    };

    // A panel whose lines did not all find a clean spot is packed again, compactly; the better one stays.
    const mark = { obstacles: obstacles.length, result: result.length, placed: placedIds.length, crowded: crowded.length };
    const keep = () => ({ obstacles: obstacles.slice(mark.obstacles), result: result.slice(mark.result), placed: placedIds.slice(mark.placed), crowded: crowded.slice(mark.crowded) });
    const rewind = () => {
      obstacles.length = mark.obstacles;
      result.length = mark.result;
      placedIds.length = mark.placed;
      crowded.length = mark.crowded;
    };
    const stuck = letterPanel(false);
    if (!stuck) return;
    const first = keep();
    rewind();
    if (letterPanel(true) < stuck) return;
    rewind();
    obstacles.push(...first.obstacles);
    result.push(...first.result);
    placedIds.push(...first.placed);
    crowded.push(...first.crowded);
  });
  return { balloons: result, placed: placedIds, crowded };
}

/** Two text boxes whose tops are this close (page heights) share a row: the reader takes them left to right (rtl: right to left). */
export const ROW_TOLERANCE = 0.02;

/** Longest tail (page widths) a balloon that spilled out of its panel draws toward it. */
const SPILL_TAIL_LEN = 0.09;

/** Pull a tail tip toward its box so the visible tail is at most `maxLen` page widths long. */
const shortenTail = (r: Box, tip: { x: number; y: number }, aspect: number, maxLen: number): { x: number; y: number } => {
  const exit = tailExitPoint(r, tip);
  const dx = tip.x - exit.x;
  const dy = (tip.y - exit.y) / aspect;
  const len = Math.hypot(dx, dy);
  if (len <= maxLen) return tip;
  return { x: clampP(exit.x + (dx / len) * maxLen, 0, 1), y: clampP(exit.y + (dy / len) * maxLen * aspect, 0, 1) };
};

/** Where the ray from the text box's centre toward `p` leaves the box (the visible start of a tail). */
export const tailExitPoint = (r: Box, p: { x: number; y: number }): { x: number; y: number } => {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const tx = dx ? (r.w / 2) / Math.abs(dx) : Infinity;
  const ty = dy ? (r.h / 2) / Math.abs(dy) : Infinity;
  const t = Math.min(1, tx, ty);
  return { x: cx + dx * t, y: cy + dy * t };
};

/**
 * Tail tip: the speaker's mouth (or head), pulled 0.02 toward the balloon. When the tail would cross
 * another character's face — or cut through the speaker's own face — it aims at the head top, then the
 * head's sides, whichever is clear. Without head data: the position the page prompt staged them at.
 */
function tailTip(
  r: Box,
  panel: Box,
  headPt: { x: number; y: number } | undefined,
  faces: Box[],
  aspect: number,
  stageX: number
): { x: number; y: number } {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const insideBox = (p: { x: number; y: number }) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  let tip: { x: number; y: number };
  if (headPt && Number.isFinite(headPt.x) && Number.isFinite(headPt.y)) {
    const contains = (f: Box) => headPt.x >= f.x && headPt.x <= f.x + f.w && headPt.y >= f.y && headPt.y <= f.y + f.h;
    const own = faces.find(contains);
    const others = faces.filter((f) => f !== own);
    const dx = cx - headPt.x;
    const dy = (cy - headPt.y) / aspect;
    const len = Math.hypot(dx, dy) || 1;
    const candidates = [{ x: headPt.x + (dx / len) * 0.02, y: headPt.y + (dy / len) * 0.02 * aspect }];
    if (own) {
      const towards = cx < headPt.x ? own.x - 0.01 : own.x + own.w + 0.01;
      const away = cx < headPt.x ? own.x + own.w + 0.01 : own.x - 0.01;
      candidates.push({ x: headPt.x, y: own.y - 0.01 }, { x: towards, y: headPt.y }, { x: away, y: headPt.y });
    } else candidates.push({ x: headPt.x, y: headPt.y - 0.05 });
    const core = own ? inflate(own, -own.w * 0.25, -own.h * 0.25) : undefined;
    const clear = (p: { x: number; y: number }) => {
      const root = tailExitPoint(r, p);
      return !others.some((f) => segmentHitsBox(root, p, f)) && !(core && segmentHitsBox(root, p, core));
    };
    tip = candidates.find(clear) ?? candidates[own ? 1 : 0];
  } else {
    tip = { x: stageX, y: Math.min(Math.max(r.y + r.h + 0.035, panel.y + panel.h * 0.4), panel.y + panel.h - PAD) };
  }
  if (insideBox(tip)) tip = { x: cx, y: r.y + r.h + 0.035 };
  if (insideBox(tip) || tip.y > 1) tip = { x: cx, y: r.y - 0.035 };
  return { x: clampP(tip.x, 0, 1), y: clampP(tip.y, 0, 1) };
}

export function placeBalloons(args: {
  page: Page;
  boxes: Box[];
  aspect: number;
  rtl: boolean;
  plansFor: (line: Line, w: number) => { h: number; bounds: Box };
  keepOut?: KeepOut[];
  heads?: SpeakerMark[];
  suggestions?: Map<string, Balloon>; // vision rects: a hint, not law
  safeMargin: number; // letterStyle.safeMargin ?? 0.03
  existing: Balloon[]; // pinned/locked = obstacles (page-wide, not per panel)
  keep?: 'pinned' | 'all';
  only?: readonly string[];
  lang?: string;
}): Balloon[] {
  return placeBalloonsDetailed(args).balloons;
}

// ── Render-time settle ───────────────────────────────────────────────────────

export interface SettleItem {
  id: string;
  /** Outline bbox in any unit, as long as both axes share it (plan units: W = 1000, H = 1000/aspect). */
  outline: Box;
  /** Absolute tail tip (same unit); it stays put while the balloon moves. */
  tip?: { x: number; y: number } | null;
  /** Software-placed or stored-but-unpinned: may be nudged. Pinned and locked balloons never move. */
  movable: boolean;
  /** Where the balloon belongs (its panel): a nudge prefers to stay inside it. */
  region?: Box;
  /** Linked balloons (speech chains) touch by design. */
  group?: string;
  /** The text box (same unit; it moves with the outline): reading-order checks use it. Default: the outline. */
  text?: Box;
  /** Panels the reader finishes before this balloon's own: a nudge never lands its text centre in one. */
  before?: Box[];
  /** The line this one is read after (the previous line of its panel): a nudge keeps it read after that one. */
  after?: string;
}

export interface SettleMove {
  dx: number;
  dy: number;
  /** The tail tip moved with the balloon (no free spot kept its aim; the tail keeps its shape instead). */
  tipMoved: boolean;
}

export interface SettleResult {
  /** Offsets applied to the moved outlines, by id. */
  moves: Map<string, SettleMove>;
  /** Movable balloons that still overlap something (the page is full). */
  unresolved: string[];
  /** Moved balloons that only found room where the reader meets them out of order (outside their panel's tier,
   *  in an earlier panel, or before the previous line of their panel). */
  reordered: string[];
}

/** Candidate indexes by ascending cost, the lower index first on a tie (a native numeric sort of packed keys). */
const sortedByCost = (cost: Float64Array): Uint32Array => {
  const n = cost.length;
  const keys = new Float64Array(n);
  // Costs are page units (≥ 0, well under 1e6): a 1/1024-unit grid keeps their order; the index breaks ties.
  for (let k = 0; k < n; k += 1) keys[k] = Math.round(Math.max(0, cost[k]) * 1024) * 65536 + k;
  keys.sort();
  const out = new Uint32Array(n);
  for (let k = 0; k < n; k += 1) out[k] = keys[k] % 65536;
  return out;
};

/** Clearance (plan units) of an edge-to-edge packing: rounding never turns touching balloons into overlapping ones. */
const TIGHT_PAD = 0.5;

const overlapsBox = (a: Box, b: Box): boolean => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-6 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-6;

/**
 * Deterministic collision pass over DRAWN balloons (planLettering's real text sizes and tails), in
 * reading order. A movable balloon that overlaps a pinned/locked one, or one that reads before it, slides
 * to the nearest free spot: flush against the blocker's footprint first, then the closest free cell of a
 * page lattice, preferring positions inside its own panel. Outlines keep `margin` from the page edge;
 * footprints keep `gap` from each other. Linked balloons may touch. Nothing moves when nothing overlaps.
 */
export function settleBalloons(
  items: readonly SettleItem[],
  page: { w: number; h: number },
  opts: { margin?: { x: number; y: number }; gap?: number; rtl?: boolean } = {}
): SettleResult {
  const W = Number.isFinite(page.w) && page.w > 0 ? page.w : 1000;
  const H = Number.isFinite(page.h) && page.h > 0 ? page.h : W * 1.5;
  const margin = opts.margin ?? { x: W * 0.008, y: H * 0.008 };
  const gap = Number.isFinite(opts.gap) && (opts.gap as number) >= 0 ? (opts.gap as number) : W * 0.01;
  const half = gap / 2;
  const rtl = !!opts.rtl;
  const rowTol = ROW_TOLERANCE * H;
  const moves = new Map<string, SettleMove>();
  const unresolved: string[] = [];
  const reordered: string[] = [];
  const cur = new Map<string, Box>();
  /** Tail tips as drawn now (a tip that had to move with its balloon is updated here). */
  const tips = new Map<string, { x: number; y: number } | null>();
  for (const it of items) {
    if (!validBox(it.outline)) continue;
    cur.set(it.id, { ...it.outline });
    tips.set(it.id, it.tip && Number.isFinite(it.tip.x) && Number.isFinite(it.tip.y) ? { x: it.tip.x, y: it.tip.y } : null);
  }
  const live = items.filter((it) => cur.has(it.id));
  const footOf = (it: SettleItem, outline: Box, tip: { x: number; y: number } | null = tips.get(it.id) ?? null): Box => inflate(balloonFootprint(outline, tip), half, half);
  const collides = (a: SettleItem, fa: Box, b: SettleItem): boolean => {
    if (a.id === b.id || (a.group && a.group === b.group)) return false;
    return overlapsBox(fa, footOf(b, cur.get(b.id)!));
  };
  const insideX = (o: Box) => o.w > W - 2 * margin.x || (o.x >= margin.x - 1e-6 && o.x + o.w <= W - margin.x + 1e-6);
  const insideY = (o: Box) => o.h > H - 2 * margin.y || (o.y >= margin.y - 1e-6 && o.y + o.h <= H - margin.y + 1e-6);

  const byId = new Map(live.map((it) => [it.id, it]));
  const start = new Map(live.map((it) => [it.id, { ...cur.get(it.id)! }]));
  /** Top-left of an item's text box when its outline sits at (x, y). */
  const textAt = (it: SettleItem, x: number, y: number): Box => {
    const o0 = start.get(it.id)!;
    const t = it.text && validBox(it.text) ? it.text : o0;
    return { x: t.x + (x - o0.x), y: t.y + (y - o0.y), w: t.w, h: t.h };
  };
  /** `a` (a text box) is read after `b`: below it, or on its row and after it (rtl: before it in x). */
  const readsAfter = (a: Box, b: Box): boolean => {
    if (a.y < b.y - rowTol) return false;
    if (Math.abs(a.y - b.y) >= rowTol) return true;
    return rtl ? a.x <= b.x + 1e-6 : a.x >= b.x - 1e-6;
  };
  const inBox = (px: number, py: number, b: Box) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
  /**
   * Reading-order level of a text box for `it` (only what its start spot does not already break counts):
   *  0 = in its panel's tier and read in order;
   *  1 = read after everything before it, but in a later tier (a forward spill);
   *  2 = read a little early, inside its own tier (the panel before it on the same row, or before the
   *      previous line of its panel) — an over-full page's last resort;
   *  3 = read far too early (above its tier, or in a panel of an earlier tier).
   */
  const orderLevel = (it: SettleItem, t: Box): number => {
    const s0 = start.get(it.id)!;
    const t0 = textAt(it, s0.x, s0.y);
    const cx = t.x + t.w / 2;
    const cy = t.y + t.h / 2;
    const cx0 = t0.x + t0.w / 2;
    const cy0 = t0.y + t0.h / 2;
    const reg = it.region;
    let level = 0;
    if (reg && cy > reg.y + reg.h + gap && cy0 <= reg.y + reg.h + gap) level = 1;
    if (reg && cy < reg.y && cy0 >= reg.y) return 3;
    for (const b of it.before ?? []) {
      if (!inBox(cx, cy, b) || inBox(cx0, cy0, b)) continue;
      const sameTier = !reg || (b.y < reg.y + reg.h - rowTol && b.y + b.h > reg.y + rowTol);
      if (!sameTier) return 3;
      level = 2;
    }
    const prev = it.after ? byId.get(it.after) : undefined;
    if (prev && level < 2) {
      const p = cur.get(prev.id)!;
      const p0 = start.get(prev.id)!;
      if (!readsAfter(t, textAt(prev, p.x, p.y)) && readsAfter(t0, textAt(prev, p0.x, p0.y))) level = 2;
    }
    return level;
  };

  live.forEach((it, index) => {
    if (!it.movable) return;
    const o = cur.get(it.id)!;
    if (!insideX(o) || !insideY(o)) return; // the page fit owns oversized or off-page boxes
    const fo = footOf(it, o);
    // Blockers: everything this balloon may not sit on. A movable balloon that reads LATER moves itself.
    const blockers = live.filter((b, j) => collides(it, fo, b) && (!b.movable || j < index));
    // The previous line of the panel moved below this one: this one follows it (reading order).
    const behind = orderLevel(it, textAt(it, o.x, o.y)) >= 2;
    if (!blockers.length && !behind) return;
    const tip0 = tips.get(it.id) ?? null;
    const reg = it.region;
    /** Two attempts: the tail keeps its aim (fixed tip), else the tail moves with the balloon (offset kept). */
    const tipAt = (c: Box, follow: boolean) => (tip0 && follow ? { x: tip0.x + (c.x - o.x), y: tip0.y + (c.y - o.y) } : tip0);
    // Everything else stays put while this balloon looks for room: its footprints are computed once.
    const others: Box[] = [];
    /** The same footprints without the gap: a full page may pack balloons edge to edge (never overlapping). */
    const othersTight: Box[] = [];
    for (const b of live) {
      if (b.id === it.id || (it.group && it.group === b.group)) continue;
      others.push(footOf(b, cur.get(b.id)!));
      othersTight.push(inflate(balloonFootprint(cur.get(b.id)!, tips.get(b.id) ?? null), TIGHT_PAD, TIGHT_PAD));
    }
    /** The footprint (outline + tail tip, inflated by half the gap) at outline position (x, y) is clear of everything. */
    const fits = (x: number, y: number, follow: boolean, tight = false): boolean => {
      const pad = tight ? TIGHT_PAD : half;
      const list = tight ? othersTight : others;
      let lx = x;
      let ly = y;
      let rx = x + o.w;
      let ry = y + o.h;
      if (tip0) {
        const tx = follow ? tip0.x + (x - o.x) : tip0.x;
        const ty = follow ? tip0.y + (y - o.y) : tip0.y;
        if (tx < lx) lx = tx;
        if (tx > rx) rx = tx;
        if (ty < ly) ly = ty;
        if (ty > ry) ry = ty;
      }
      lx -= pad;
      ly -= pad;
      rx += pad;
      ry += pad;
      for (const f of list) if (Math.min(rx, f.x + f.w) - Math.max(lx, f.x) > 1e-6 && Math.min(ry, f.y + f.h) - Math.max(ly, f.y) > 1e-6) return false;
      return true;
    };
    // Candidate outline positions (clamped inside the page margin): flush against each blocker's footprint
    // first, then a lattice over the page (2.5 % of the width per step).
    const xs: number[] = [];
    const ys: number[] = [];
    const loX = margin.x;
    const hiX = W - margin.x - o.w;
    const loY = margin.y;
    const hiY = H - margin.y - o.h;
    const add = (x: number, y: number) => {
      xs.push(o.w > W - 2 * margin.x ? (W - o.w) / 2 : clampP(x, loX, hiX));
      ys.push(o.h > H - 2 * margin.y ? (H - o.h) / 2 : clampP(y, loY, hiY));
    };
    for (const b of blockers) {
      const fb = footOf(b, cur.get(b.id)!);
      add(o.x, fb.y + fb.h + half);
      add(o.x, fb.y - half - o.h);
      add(fb.x + fb.w + half, o.y);
      add(fb.x - half - o.w, o.y);
    }
    const step = W * 0.025;
    if (hiX >= loX && hiY >= loY) {
      const nx = Math.min(48, Math.floor((hiX - loX) / step) + 1);
      const ny = Math.min(64, Math.floor((hiY - loY) / step) + 1);
      for (let j = 0; j < ny; j += 1) for (let i = 0; i < nx; i += 1) add(loX + (nx > 1 ? ((hiX - loX) * i) / (nx - 1) : 0), loY + (ny > 1 ? ((hiY - loY) * j) / (ny - 1) : 0));
    }
    // Stay in the panel when there is room; a slight preference for moving down / forward keeps reading order.
    const costAt = (x: number, y: number): number => {
      let c = Math.hypot(x - o.x, y - o.y);
      if (reg) {
        const iw = Math.min(x + o.w, reg.x + reg.w) - Math.max(x, reg.x);
        const ih = Math.min(y + o.h, reg.y + reg.h) - Math.max(y, reg.y);
        c += 0.5 * W * (1 - (iw > 0 && ih > 0 ? (iw * ih) / (o.w * o.h) : 0));
      }
      return y < o.y - 1e-6 ? c + 0.04 * W : c;
    };
    if (behind && it.after) {
      // Below / after the previous line of the panel, right where it now sits.
      const prev = byId.get(it.after)!;
      const fp = footOf(prev, cur.get(prev.id)!);
      add(o.x, fp.y + fp.h + half);
      add(rtl ? fp.x - half - o.w : fp.x + fp.w + half, fp.y);
    }
    // Edge to edge against every balloon near the panel: the pockets a gap-sized lattice misses.
    const near = reg ? inflate(reg, o.w, o.h) : { x: 0, y: 0, w: W, h: H };
    for (const f of othersTight) {
      if (!overlapsBox(f, near)) continue;
      for (const x of [f.x - o.w, f.x + f.w, f.x, f.x + f.w - o.w]) for (const y of [f.y - o.h, f.y + f.h, f.y, f.y + f.h - o.h]) add(x, y);
    }
    // The cheapest free candidate (the first one in candidate order on a tie), reading order first: in the
    // balloon's tier with the full gap, then a later tier, then edge to edge, then a little early inside the
    // tier, and only on a page with no such room anywhere the nearest spot back. Every candidate's cost,
    // reading level and fit is computed at most once.
    const n = xs.length;
    const cost = new Float64Array(n);
    for (let k = 0; k < n; k += 1) cost[k] = costAt(xs[k], ys[k]);
    const levels = new Int8Array(n).fill(-1);
    const levelOf = (k: number) => (levels[k] >= 0 ? levels[k] : (levels[k] = orderLevel(it, textAt(it, xs[k], ys[k]))));
    const fitMemo = [new Int8Array(n), new Int8Array(n), new Int8Array(n), new Int8Array(n)];
    const fitsK = (k: number, follow: boolean, tight: boolean): boolean => {
      const memo = fitMemo[(follow ? 1 : 0) + (tight ? 2 : 0)];
      if (!memo[k]) memo[k] = fits(xs[k], ys[k], follow, tight) ? 1 : 2;
      return memo[k] === 1;
    };
    const byCost = sortedByCost(cost);
    /** Reading distance of a spot read early: how many panels back its text centre sits (0 = none). */
    const back = (k: number): number => {
      const t = textAt(it, xs[k], ys[k]);
      const cx = t.x + t.w / 2;
      const cy = t.y + t.h / 2;
      const list = it.before ?? [];
      for (let i = list.length - 1; i >= 0; i -= 1) if (inBox(cx, cy, list[i])) return list.length - i;
      return 0;
    };
    const phases: { level: number; tight: boolean }[] = [
      { level: 0, tight: false },
      { level: 1, tight: false },
      { level: 0, tight: true },
      { level: 1, tight: true },
      { level: 2, tight: false },
      { level: 2, tight: true },
      { level: 3, tight: false }
    ];
    let best: { c: Box; cost: number; follow: boolean; level: number } | undefined;
    for (const { level, tight } of phases) {
      // The last resort reads early: the nearest panel back, never the top of the page when a later one has room.
      const order = level === 3 ? sortedByCost(cost.map((c, k) => c + 0.5 * W * back(k))) : byCost;
      for (const follow of tip0 ? [false, true] : [false]) {
        for (const k of order) {
          if (level < 3 && levelOf(k) > level) continue;
          if (!fitsK(k, follow, tight)) continue;
          best = { c: { x: xs[k], y: ys[k], w: o.w, h: o.h }, cost: cost[k], follow, level };
          break;
        }
        if (best) break;
      }
      if (best) break;
    }
    if (!best) {
      if (blockers.length) unresolved.push(it.id);
      return;
    }
    if (best.level >= 2) {
      // Read early, but the only room on the page: better than an overlap. A balloon that was merely out of
      // order (nothing overlapped it) stays where it is instead.
      if (!blockers.length) return;
      reordered.push(it.id);
    }
    cur.set(it.id, best.c);
    if (best.follow) tips.set(it.id, tipAt(best.c, true));
    moves.set(it.id, { dx: round4(best.c.x - o.x), dy: round4(best.c.y - o.y), tipMoved: best.follow });
  });
  return { moves, unresolved, reordered };
}
