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
//  - Nothing is ever placed off-page: the worst case is the least-bad candidate inside the safe area,
//    and placeBalloonsDetailed() reports it as `crowded` so the editor can offer free fixes.

import type { Balloon, Box, KeepOut, Line, LineKind, Page, SpeakerMark } from '../doc.js';
import { estimateTextHeight, estimateWidthForText, normalizeLetteringText } from '../textLayout.js';
import type { BubbleShape } from './style.js';

/** Panel inner padding and minimum gap between outlines (page fractions). */
const PAD = 0.012;
const GAP = 0.01;
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

const sizeOf = (args: PlaceArgs, line: Line, w: number, lang: string): { h: number; bounds: Box } => {
  let got: { h: number; bounds: Box } | undefined;
  try {
    got = args.plansFor(line, w);
  } catch {
    got = undefined;
  }
  if (!got || !(got.h > 0) || !validBox(got.bounds)) return fallbackSize(line, w, args.aspect, lang);
  // Bounds must contain the text box.
  const b = got.bounds;
  const x = Math.min(0, b.x);
  const y = Math.min(0, b.y);
  return { h: got.h, bounds: { x, y, w: Math.max(b.x + b.w, w) - x, h: Math.max(b.y + b.h, got.h) - y } };
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

  // Obstacles: every kept balloon's outline, page-wide, before anything is placed.
  const obstacles: { lineId: string; box: Box; panelIndex: number; x: number; y: number }[] = [];
  for (const { panel, index } of panels) {
    for (const line of panel.lines) {
      if (!normalizeLetteringText(line.text) || !isKept(line)) continue;
      const b = existing.get(line.id)!;
      const s = sizeOf(args, line, b.w, langOf(line));
      obstacles.push({ lineId: line.id, panelIndex: index, x: b.x, y: b.y, box: { x: b.x + s.bounds.x, y: b.y + s.bounds.y, w: s.bounds.w, h: s.bounds.h } });
    }
  }

  const result: Balloon[] = [];
  const placedIds: string[] = [];
  const crowded: string[] = [];

  for (const { panel, index } of panels) {
    const box = boxFor(index);
    const inner = { x: box.x + PAD, y: box.y + PAD, w: Math.max(0.01, box.w - 2 * PAD), h: Math.max(0.01, box.h - 2 * PAD) };
    let region = intersect(inner, safe);
    if (region.w < 0.02 || region.h < 0.02) region = intersect(box, safe);
    if (region.w < 0.02 || region.h < 0.02) region = safe;
    const lines = panel.lines.filter((l) => normalizeLetteringText(l.text));
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
        prevInPanel = { x: b.x, y: b.y };
        return;
      }
      const prior = existing.get(line.id);
      const head = spoken ? (args.heads || []).find((h) => h && h.panel === panel.n && !!line.speakerId && h.characterId === line.speakerId) : undefined;
      const headPt = head ? head.mouth ?? head.head : undefined;
      const suggestion = args.suggestions?.get(line.id);
      const opening = line.kind === 'caption' && lines.slice(0, k).every((l) => l.kind === 'caption');

      const w0 = Math.min(estimateWidthForText(line.text, lang), Math.max(0.08, box.w - 2 * PAD));
      const widths = [w0, Math.max(0.1, round4(w0 * 0.8)), Math.max(0.1, round4(w0 * 0.65))].filter((w, i, a) => a.indexOf(w) === i);

      type Pick = { cost: number; x: number; y: number; w: number; h: number; outline: Box; clean: boolean };
      let best: Pick | undefined;
      let bestClean: Pick | undefined;
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
        if (line.kind === 'caption') {
          const startX = rtl ? xHi : xLo;
          const endX = rtl ? xLo : xHi;
          cands.push(opening ? { x: startX, y: yLo, bias: -25 } : { x: endX, y: yHi, bias: -25 });
        }
        if (line.kind === 'sfx') {
          const actions = busy.filter((a) => covered(a, box) > 0.3);
          for (const a of actions) {
            cands.push({ x: a.x + a.w + GAP - b.x, y: a.y, bias: -10 }, { x: a.x - (b.x + b.w) - GAP, y: a.y, bias: -10 });
          }
          cands.push({ x: box.x + box.w * 0.55 - w / 2, y: box.y + box.h * 0.55, bias: -4 });
        }
        if (suggestion && validBalloon(suggestion)) cands.push({ x: suggestion.x, y: suggestion.y, bias: 0 });
        for (const y of ys) for (const x of xs) cands.push({ x, y, bias: 0 });

        for (const c of cands) {
          // Keep every candidate's outline inside the page safe area when it can fit there at all.
          const x = b.w <= safe.w ? clampP(c.x, safe.x - b.x, safe.x + safe.w - (b.x + b.w)) : c.x;
          const y = b.h <= safe.h ? clampP(c.y, safe.y - b.y, safe.y + safe.h - (b.y + b.h)) : c.y;
          const outline: Box = { x: x + b.x, y: y + b.y, w: b.w, h: b.h };
          let overlap = 0;
          for (const o of obstacles) overlap += covered(inflate(outline, GAP / 2, (GAP / 2) * aspect), o.box);
          let faceHit = 0;
          for (const f of faces) faceHit += covered(outline, f);
          let busyHit = 0;
          for (const a of busy) busyHit += covered(outline, a);
          let otherHit = 0;
          for (const a of other) otherHit += covered(outline, a);
          let order = 0;
          if (prevInPanel) {
            const sameRow = Math.abs(y - prevInPanel.y) < 0.02;
            if (y < prevInPanel.y - 0.02 || (sameRow && (rtl ? x > prevInPanel.x : x < prevInPanel.x))) order = 1;
          }
          const cx = x + w / 2;
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
            40 * order +
            12 * aim +
            6 * clampP((y - box.y) / Math.max(0.01, box.h), 0, 1) +
            4 * sug +
            c.bias;
          const clean = overlap < 0.005 && faceHit < 0.005 && outside(outline, safe) < 0.001;
          const cand: Pick = { cost, x, y, w, h: size.h, outline, clean };
          if (!best || cost < best.cost - 1e-9) best = cand;
          if (clean && (!bestClean || cost < bestClean.cost - 1e-9)) bestClean = cand;
        }
        // A clean spot (no overlap, no face, inside the safe area) at this width: never go narrower.
        if (bestClean) break;
      }
      const pick = bestClean ?? best!;
      if (!pick.clean) crowded.push(line.id);

      const balloon: Balloon = { lineId: line.id, x: round4(pick.x), y: round4(pick.y), w: round4(pick.w) };
      if (spoken) {
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
      obstacles.push({ lineId: line.id, panelIndex: index, x: balloon.x, y: balloon.y, box: pick.outline });
      prevInPanel = { x: balloon.x, y: balloon.y };
    });
  }
  return { balloons: result, placed: placedIds, crowded };
}

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
