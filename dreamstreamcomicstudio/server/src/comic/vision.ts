// Vision QC + balloon layout for rendered comic pages (spec §6.9).
//
// After a page renders, a Flash-class vision model looks at the image next to the page
// script and returns: the panel rectangles, QC issues (missing/extra characters, identity
// drift, anatomy), every piece of text it can read, a 0–1 score and — for overlay
// lettering — one balloon per script line placed near its speaker inside its panel.
// Everything the model returns is post-processed deterministically: coordinates are
// clamped, balloons are forced inside their panels, sized from their text, de-overlapped
// and kept in reading order, and any line the model skipped gets a layout-based balloon.
// Without vision (or when its output is unusable) fallbackBalloons() lays balloons out
// from the panel blueprint alone, so a page is never left unlettered.
//
// Balloon geometry (page-normalized, origin top-left): x, y = the balloon's top-left
// corner, w = its width as a fraction of the page width; tailX/tailY = the tail tip.
// Height is derived from the text by the renderer; estimateBalloonHeight() mirrors it.

import type {
  AspectRatio,
  Balloon,
  Box,
  ComicDoc,
  ComicKind,
  KeepOut,
  Line,
  LineKind,
  Page,
  QcReport,
  SpeakerMark
} from '../../../shared/comic/doc.js';
import { resolveImageJob } from '../../../shared/comic/models.js';
import { SAFETY_CATEGORIES, effectiveRating, type SafetyCategory, type SafetyVerdict } from '../../../shared/comic/safety.js';
import type { MessagePart } from '../ai/providers/types.js';
import { layoutPanelCount, pageAspectFor, parseLayout, stagePanel, synthesizeLayout, upperName, type ParsedLayout } from './prompts.js';
import { prefilterText, verdictFromVision } from './safety/index.js';
import { completeStructured, type StructuredCheck } from './writer.js';
import type { LlmClient } from './types.js';

// ── Geometry constants ───────────────────────────────────────────────────────

/** Outer page margin and gutter between panels (fractions of the page). */
const MARGIN = 0.02;
const GUTTER = 0.02;
/** Webtoon panels get generous vertical spacing. */
const STACK_GUTTER = 0.04;
/** Balloon width range (fraction of page width). */
export const MIN_BALLOON_W = 0.16;
export const MAX_BALLOON_W = 0.34;
/** Padding between a balloon and its panel border. */
const PAD = 0.012;
/** Vertical gap between stacked balloons. */
const GAP = 0.01;
/** Lettering metrics in page-WIDTH units (one glyph ≈ 1/95 of the page width). */
const CHAR_W = 0.0105;
const LINE_H = 0.022;
const BALLOON_PAD_W = 0.03;
const BALLOON_PAD_H = 0.026;

const SPOKEN = new Set<LineKind>(['speech', 'thought', 'whisper', 'shout']);

export interface LayoutOptions {
  readingDirection?: 'ltr' | 'rtl';
  kind?: ComicKind;
  /** Page width / height (defaults to the render's pixel size, else 2:3). */
  pageAspect?: number;
}

const clean = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
const clamp01 = (n: unknown) => clamp(typeof n === 'number' ? n : Number.NaN, 0, 1);
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

const ratioOf = (aspect: string) => {
  const [w, h] = aspect.split(':').map(Number);
  return w > 0 && h > 0 ? w / h : 2 / 3;
};

const inferRtl = (layout: string) => /\bright[ -]to[ -]left\b/i.test(layout || '');

/** Page width/height from the render's pixel size, an explicit option, or 2:3. */
const pageAspectOf = (page: Page, opts: LayoutOptions = {}): number => {
  const a = page.render?.asset;
  if (a?.w && a?.h && a.w > 0 && a.h > 0) return a.w / a.h;
  return opts.pageAspect && opts.pageAspect > 0 ? opts.pageAspect : 2 / 3;
};

// ── Panel boxes from the layout blueprint ────────────────────────────────────

const boxesFromLayout = (parsed: ParsedLayout, n: number, rtl: boolean): Box[] => {
  const boxes: Box[] = new Array(n);
  const contentW = 1 - 2 * MARGIN;
  if (parsed.mode === 'single') {
    boxes[0] = { x: MARGIN, y: MARGIN, w: contentW, h: 1 - 2 * MARGIN };
    return boxes;
  }
  const gutter = parsed.mode === 'stack' ? STACK_GUTTER : GUTTER;
  const totalWeight = parsed.rows.reduce((s, r) => s + r.weight, 0) || 1;
  const usableH = 1 - 2 * MARGIN - gutter * (parsed.rows.length - 1);
  let y = MARGIN;
  for (const row of parsed.rows) {
    const h = (usableH * row.weight) / totalWeight;
    if (row.span) {
      // A tall panel beside a stack: the tall one takes ~45% of the width.
      const tallW = (contentW - GUTTER) * 0.45;
      const stackW = contentW - GUTTER - tallW;
      const tallLeft = row.span.tallSide === 'left';
      const tallX = tallLeft ? MARGIN : MARGIN + stackW + GUTTER;
      const stackX = tallLeft ? MARGIN + tallW + GUTTER : MARGIN;
      const k = Math.max(1, row.panels.length - 1);
      const cellH = (h - GUTTER * (k - 1)) / k;
      const tall: Box = { x: tallX, y, w: tallW, h };
      const stack: Box[] = Array.from({ length: k }, (_, i) => ({ x: stackX, y: y + i * (cellH + GUTTER), w: stackW, h: cellH }));
      // Reading order: the tall panel first when it sits on the reading-start side.
      const startSide = rtl ? 'right' : 'left';
      const ordered = row.span.tallSide === startSide ? [tall, ...stack] : [stack[0], tall, ...stack.slice(1)];
      row.panels.forEach((idx, i) => {
        if (idx < n) boxes[idx] = ordered[i];
      });
    } else {
      const k = row.panels.length;
      const w = (contentW - GUTTER * (k - 1)) / k;
      row.panels.forEach((idx, i) => {
        const col = rtl ? k - 1 - i : i;
        if (idx < n) boxes[idx] = { x: MARGIN + col * (w + GUTTER), y, w, h };
      });
    }
    y += h + gutter;
  }
  return boxes;
};

/** A plain grid by panel count — the last resort when no blueprint can be read. */
const gridLayout = (n: number): ParsedLayout => {
  const perRow = n <= 2 ? 1 : n <= 4 ? 2 : 3;
  const rows: ParsedLayout['rows'] = [];
  for (let i = 0; i < n; i += perRow) rows.push({ panels: Array.from({ length: Math.min(perRow, n - i) }, (_, k) => i + k), weight: 1 });
  return { mode: 'rows', rows };
};

/**
 * Estimate panel rectangles (reading order, page-normalized, 2% margins and gutters) from
 * the page's row blueprint ("Row 1: one wide panel. Row 2: two equal panels…"). When the
 * blueprint is missing or disagrees with the panel count, the same blueprint is
 * synthesized from the panel sizes; a plain grid is the last resort.
 */
export const estimatePanelBoxes = (page: Page, opts: LayoutOptions = {}): Box[] => {
  const n = page.panels.length;
  if (!n) return [];
  const rtl = (opts.readingDirection || (inferRtl(page.layout) ? 'rtl' : 'ltr')) === 'rtl';
  const kind: ComicKind = opts.kind || (/\bstacked vertically\b/i.test(page.layout || '') ? 'webtoon' : 'comic');
  const format = { kind, readingDirection: rtl ? ('rtl' as const) : ('ltr' as const) };
  const fits = (p: ParsedLayout | null): p is ParsedLayout =>
    !!p && layoutPanelCount(p) === n && (kind !== 'webtoon' || p.mode === 'stack');
  let parsed = page.layout ? parseLayout(page.layout) : null;
  if (!fits(parsed)) parsed = parseLayout(synthesizeLayout(page.panels, format));
  if (!fits(parsed)) parsed = gridLayout(n);
  return boxesFromLayout(parsed, n, rtl).map((b) => ({ x: round4(b.x), y: round4(b.y), w: round4(b.w), h: round4(b.h) }));
};

// ── Balloon sizing ───────────────────────────────────────────────────────────

/** Balloon width from text length: short lines ≈ 0.16 of the page, long ones up to 0.34. */
export const balloonWidth = (text: string): number => {
  const len = clean(text).length;
  const t = clamp((len - 12) / (110 - 12), 0, 1);
  return round4(MIN_BALLOON_W + t * (MAX_BALLOON_W - MIN_BALLOON_W));
};

/** Estimated balloon height as a fraction of the page HEIGHT (word-wrapped at width w). */
export const estimateBalloonHeight = (text: string, w: number, pageAspect = 2 / 3): number => {
  const perLine = Math.max(6, Math.floor((w - BALLOON_PAD_W) / CHAR_W));
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
  return round4((lines * LINE_H + BALLOON_PAD_H) * pageAspect);
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Rect, b: Rect, margin = 0.006) =>
  a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;

const inside = (px: number, py: number, r: Rect) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;

const PAGE_BOX: Box = { x: 0, y: 0, w: 1, h: 1 };

/** Fit a balloon of (w, h) at (x, y) inside a box (shrinking the width if the box is narrow). */
const fitInBox = (x: number, y: number, w: number, h: number, box: Box): Rect => {
  const width = Math.min(w, Math.max(0.05, box.w - 2 * PAD));
  const maxX = box.x + box.w - width - PAD;
  const maxY = box.y + box.h - h - PAD;
  return {
    x: clamp(x, Math.min(box.x + PAD, maxX), Math.max(box.x + PAD, maxX)),
    y: maxY < box.y + PAD ? box.y + PAD : clamp(y, box.y + PAD, maxY),
    w: width,
    h
  };
};

/** Tail tip: outside the balloon, inside the panel; defaults to just below the balloon. */
const fixTail = (rect: Rect, box: Box, tailX?: number, tailY?: number): { tailX: number; tailY: number } => {
  const lo = (v: number, a: number, b: number) => clamp(v, a, b);
  const valid = typeof tailX === 'number' && typeof tailY === 'number' && tailX >= 0 && tailY >= 0;
  let tx = valid ? lo(tailX!, box.x + PAD, box.x + box.w - PAD) : rect.x + rect.w / 2;
  let ty = valid ? lo(tailY!, box.y + PAD, box.y + box.h - PAD) : rect.y + rect.h + 0.035;
  if (inside(tx, ty, rect)) {
    tx = rect.x + rect.w / 2;
    ty = rect.y + rect.h + 0.035;
  }
  tx = lo(tx, box.x + PAD, box.x + box.w - PAD);
  ty = lo(ty, box.y + PAD, box.y + box.h - PAD);
  // A balloon parked at the bottom of its panel points up instead.
  if (inside(tx, ty, rect)) ty = lo(rect.y - 0.035, box.y + PAD, box.y + box.h - PAD);
  return { tailX: round4(tx), tailY: round4(ty) };
};

interface Placed {
  line: Line;
  panelIndex: number;
  rect: Rect;
  tailX?: number;
  tailY?: number;
  pinned?: boolean;
}

const toBalloon = (p: Placed): Balloon => ({
  lineId: p.line.id,
  x: round4(p.rect.x),
  y: round4(p.rect.y),
  w: round4(p.rect.w),
  ...(typeof p.tailX === 'number' && typeof p.tailY === 'number' ? { tailX: p.tailX, tailY: p.tailY } : {}),
  ...(p.pinned ? { pinned: true } : {})
});

/** Lines of a page in reading order, with their panel index (blank lines skipped). */
const pageLines = (page: Page) =>
  page.panels.flatMap((panel, panelIndex) => panel.lines.filter((l) => clean(l.text)).map((line) => ({ line, panelIndex })));

/**
 * Keep reading order inside each panel (an earlier balloon must sit higher, or at the same
 * height further toward the reading start) and push overlapping balloons down, then
 * sideways, within their panel. Pinned balloons never move; they are obstacles.
 */
const settle = (placed: Placed[], boxes: Box[], rtl: boolean): Placed[] => {
  const settled: Placed[] = [];
  for (const item of placed) {
    if (item.pinned) {
      settled.push(item);
      continue;
    }
    const box = boxes[item.panelIndex] || PAGE_BOX;
    let rect = { ...item.rect };
    // Reading order vs the previous balloon in the same panel.
    const prev = [...settled].reverse().find((p) => p.panelIndex === item.panelIndex);
    if (prev) {
      const sameRow = Math.abs(rect.y - prev.rect.y) < 0.02;
      const readFirst = rect.y < prev.rect.y - 0.02 || (sameRow && (rtl ? rect.x > prev.rect.x : rect.x < prev.rect.x));
      if (readFirst) rect = fitInBox(rect.x, prev.rect.y + Math.max(0.03, prev.rect.h * 0.6), rect.w, rect.h, box);
    }
    for (let guard = 0; guard < 12; guard += 1) {
      const hit = settled.find((p) => overlaps(rect, p.rect));
      if (!hit) break;
      const down = fitInBox(rect.x, hit.rect.y + hit.rect.h + GAP, rect.w, rect.h, box);
      if (!settled.some((p) => p !== hit && overlaps(down, p.rect)) && !overlaps(down, hit.rect)) {
        rect = down;
        break;
      }
      // No room below: try beside the obstacle (right first in ltr, left first in rtl).
      const right = fitInBox(hit.rect.x + hit.rect.w + GAP, rect.y, rect.w, rect.h, box);
      const left = fitInBox(hit.rect.x - rect.w - GAP, rect.y, rect.w, rect.h, box);
      const options = rtl ? [left, right] : [right, left];
      const side = options.find((o) => !settled.some((p) => overlaps(o, p.rect)));
      if (side) {
        rect = side;
        break;
      }
      if (down.y === rect.y) break; // boxed in — accept the overlap rather than leave the panel
      rect = down;
    }
    const tail = typeof item.tailX === 'number' ? fixTail(rect, box, item.tailX, item.tailY) : undefined;
    settled.push({ ...item, rect, ...(tail || {}) });
  }
  return settled;
};

// ── Fallback layout (no vision) ──────────────────────────────────────────────

/**
 * Deterministic balloons from the panel boxes alone: opening captions in the panel's
 * top-left corner (top-right for rtl), closing captions bottom-right (bottom-left for rtl),
 * dialogue stacked from the top of the panel above each speaker's staged position (the same
 * left/right staging the page prompt asked for), sound effects mid-panel. Pinned balloons
 * on the page are kept as-is.
 */
export const fallbackBalloons = (page: Page, panelBoxes?: Box[], opts: LayoutOptions = {}): Balloon[] => {
  const rtl = (opts.readingDirection || (inferRtl(page.layout) ? 'rtl' : 'ltr')) === 'rtl';
  const boxes = panelBoxes && panelBoxes.length === page.panels.length ? panelBoxes : estimatePanelBoxes(page, opts);
  const aspect = pageAspectOf(page, opts);
  const pinned = new Map(page.balloons.filter((b) => b.pinned).map((b) => [b.lineId, b]));
  const placed: Placed[] = [];
  page.panels.forEach((panel, panelIndex) => {
    const box = boxes[panelIndex];
    if (!box) return;
    const staged = stagePanel(page, panel);
    const lines = panel.lines.filter((l) => clean(l.text));
    let cursor = box.y + PAD;
    let spokenSeen = 0;
    lines.forEach((line, k) => {
      const pin = pinned.get(line.id);
      if (pin) {
        const h = estimateBalloonHeight(line.text, pin.w, aspect);
        placed.push({ line, panelIndex, rect: { x: pin.x, y: pin.y, w: pin.w, h }, tailX: pin.tailX, tailY: pin.tailY, pinned: true });
        return;
      }
      const w = Math.min(balloonWidth(line.text), Math.max(0.05, box.w - 2 * PAD));
      const h = estimateBalloonHeight(line.text, w, aspect);
      if (line.kind === 'caption') {
        const opening = lines.slice(0, k).every((l) => l.kind === 'caption');
        const startX = rtl ? box.x + box.w - PAD - w : box.x + PAD;
        const endX = rtl ? box.x + PAD : box.x + box.w - PAD - w;
        const rect = opening ? fitInBox(startX, cursor, w, h, box) : fitInBox(endX, box.y + box.h - PAD - h, w, h, box);
        if (opening) cursor = rect.y + rect.h + GAP;
        placed.push({ line, panelIndex, rect });
        return;
      }
      if (line.kind === 'sfx') {
        const rect = fitInBox(box.x + box.w * 0.55 - w / 2, box.y + box.h * 0.55, w, h, box);
        placed.push({ line, panelIndex, rect });
        return;
      }
      const speaker = staged.find((s) => s.id === line.speakerId);
      // Unknown speaker: alternate sides, starting on the reading-start side.
      const alt = spokenSeen % 2 === 0 ? 0.28 : 0.72;
      const fx = speaker ? speaker.x : rtl ? 1 - alt : alt;
      spokenSeen += 1;
      const rect = fitInBox(box.x + fx * box.w - w / 2, cursor, w, h, box);
      cursor = rect.y + rect.h + GAP;
      const headY = Math.max(rect.y + rect.h + 0.035, box.y + box.h * 0.4);
      const tail = fixTail(rect, box, box.x + fx * box.w, Math.min(headY, box.y + box.h - PAD));
      placed.push({ line, panelIndex, rect, ...tail });
    });
  });
  return settle(placed, boxes, rtl).map(toBalloon);
};

// ── Lettering verification ───────────────────────────────────────────────────

/**
 * Lowercase, straight quotes, no Latin accents/punctuation, single spaces. Combining marks
 * (\p{M}) are KEPT: Indic vowel signs and viramas are letters of the word (bug: "नमस्ते"
 * became "नमस त" and every Hindi/Telugu in-art line read as misspelled).
 */
export const normalizeLettering = (text: string): string =>
  clean(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
};

/** 1 = identical, 0 = nothing alike (normalized edit distance). */
export const textSimilarity = (a: string, b: string): number => {
  const x = a.slice(0, 400);
  const y = b.slice(0, 400);
  const longest = Math.max(x.length, y.length);
  return longest ? 1 - levenshtein(x, y) / longest : 1;
};

export interface LetteringCheck {
  missing: { panel: number; line: Line }[];
  misspelled: { panel: number; line: Line; found: string }[];
  unexpected: string[];
}

/**
 * Compare the text a vision pass read off an in-art page with the script: each expected
 * line is matched against single found entries and against sliding word windows of all
 * found text (a balloon can be read as several entries). Correct = at most ~3% of the
 * characters differ (min 1 — OCR noise), ≥ 0.55 similar = misspelled, else missing.
 * Found text matching no line is "unexpected".
 */
export const compareLettering = (page: Page, textFound: string[]): LetteringCheck => {
  const found = textFound.map((t) => ({ raw: clean(t), norm: normalizeLettering(t) })).filter((f) => f.norm);
  const words = found.flatMap((f) => f.norm.split(' '));
  const joined = words.join(' ');
  const check: LetteringCheck = { missing: [], misspelled: [], unexpected: [] };
  const expectedNorms: string[] = [];
  for (const panel of page.panels) {
    for (const line of panel.lines) {
      const exp = normalizeLettering(line.text);
      if (!exp) continue;
      expectedNorms.push(exp);
      if (joined.includes(exp)) continue;
      let best = 0;
      let bestText = '';
      for (const f of found) {
        const s = textSimilarity(exp, f.norm);
        if (s > best) {
          best = s;
          bestText = f.raw;
        }
      }
      const size = exp.split(' ').length;
      const okAt = 1 - Math.max(1, Math.floor(exp.length * 0.03)) / Math.max(exp.length, 2);
      if (best < okAt && words.length) {
        for (const len of [size - 1, size, size + 1]) {
          if (len < 1) continue;
          for (let i = 0; i + len <= words.length; i += 1) {
            const window = words.slice(i, i + len).join(' ');
            const s = textSimilarity(exp, window);
            if (s > best) {
              best = s;
              bestText = window;
            }
          }
        }
      }
      if (best >= okAt) continue;
      if (best >= 0.55) check.misspelled.push({ panel: panel.n, line, found: bestText });
      else check.missing.push({ panel: panel.n, line });
    }
  }
  for (const f of found) {
    if ((f.norm.match(/\p{L}/gu) || []).length < 3) continue;
    const matches = expectedNorms.some((e) => e.includes(f.norm) || f.norm.includes(e) || textSimilarity(e, f.norm) >= 0.5);
    if (!matches) check.unexpected.push(f.raw);
  }
  return check;
};

const quoteShort = (text: string, max = 80) => {
  const t = clean(text);
  return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
};

// ── Vision request ───────────────────────────────────────────────────────────

const num = { type: 'number' } as const;
const strict = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties
});

const point = strict({ x: num, y: num });
export const KEEP_OUT_KINDS: readonly KeepOut['kind'][] = ['face', 'hands', 'action', 'text', 'other'];
/** At most this many keep-out regions / head marks are kept per panel (the prompt asks for ≤ 3). */
export const MAX_MARKS_PER_PANEL = 4;
export const VISION_RATINGS = ['G', 'PG', 'PG-13', 'X'] as const;

export const VISION_SCHEMA = strict({
  panels: { type: 'array', items: strict({ n: { type: 'integer' }, box: strict({ x: num, y: num, w: num, h: num }) }) },
  issues: { type: 'array', items: { type: 'string' } },
  textFound: { type: 'array', items: { type: 'string' } },
  extraOrMissingCharacters: { type: 'array', items: { type: 'string' } },
  score: num,
  balloons: {
    type: 'array',
    items: strict({ lineId: { type: 'string' }, x: num, y: num, w: num, tailX: num, tailY: num })
  },
  /** safety.md §3.3: the page's own rating, folded by verdictFromVision (missing ⇒ unchecked). */
  safety: strict({
    rating: { type: 'string', enum: [...VISION_RATINGS] },
    categories: { type: 'array', items: { type: 'string', enum: [...SAFETY_CATEGORIES] } },
    notes: { type: 'array', items: { type: 'string' } }
  }),
  /** lettering.md §6.6: regions balloons must not cover, and where speakers' heads are (tail aiming). */
  keepOut: {
    type: 'array',
    items: strict({ panel: { type: 'integer' }, kind: { type: 'string', enum: [...KEEP_OUT_KINDS] }, box: strict({ x: num, y: num, w: num, h: num }) })
  },
  heads: { type: 'array', items: strict({ panel: { type: 'integer' }, name: { type: 'string' }, head: point, mouth: point }) }
});

/** Compact rating anchors for the vision rubric (item 7); the IMAGE is rated, never the script. */
const SAFETY_RUBRIC =
  'G = gentle: nobody hurt, no weapons aimed at anyone. PG = bloodless action and short spooky moments, modest clothing. ' +
  'PG-13 = intense action or horror with minimal blood; no exposed wounds, no gore. ' +
  'X = any nudity, a sexualized pose or outfit, anyone who looks under 18 shown in a suggestive way, gore or exposed wounds, dismemberment, hate symbols. ' +
  'Action, monsters, darkness and peril are NOT X.';

const visionSystemPrompt = (doc: ComicDoc): string => {
  const rtl = doc.format.readingDirection === 'rtl';
  const overlay = doc.format.lettering !== 'in_art';
  const start = rtl ? 'right' : 'left';
  return [
    'You are a meticulous comics editor and letterer. You inspect one rendered comic page against its script' +
      (overlay ? ' and place the speech balloons that will be lettered over it.' : '.'),
    '',
    'COORDINATES: every number is a fraction of the full page between 0 and 1 (not pixels, not 0–1000) — x from the left edge (0) to the right edge (1), y from the top (0) to the bottom (1). A box {x, y, w, h} has x, y at its top-left corner.',
    '',
    `1. panels: the rectangle inside each panel border, in reading order (${rtl ? 'right-to-left, top-to-bottom' : 'left-to-right, top-to-bottom'}), n from 1. For borderless panels use the bounds of the art block.`,
    '2. issues: short, concrete problems versus the script — wrong panel count, a named character missing from or added to a panel, a character drawn with a different face, hair or outfit than elsewhere on the page, two characters merged or swapped, anatomy errors (extra fingers, broken limbs), garbled or unreadable art. Example: "Panel 3: Maya\'s scarf changed from red to blue." [] when the page is clean.',
    '3. extraOrMissingCharacters: per-panel notes such as "Panel 2: ARJUN missing" or "Panel 4: an extra unnamed man in the foreground" ([] when every panel shows exactly its listed characters; unnamed background figures the action calls for are fine).',
    '4. textFound: every piece of visible text in the art — balloons, captions, signs, sound effects — one entry per text element, transcribed exactly as drawn. [] when there is none.',
    '5. score: 0–1 — how well the page matches its script and holds up as a published page (1 flawless, 0.7 minor issues, below 0.5 should be redrawn).',
    overlay
      ? `6. balloons: exactly one per script line, using its lineId. x, y = the balloon's top-left corner; w = its width (0.16–0.34, longer text wider; height is about 0.03 per line of lettering). tailX, tailY = where the tail tip points, just beside the speaker's mouth or head. Rules: inside the line's own panel; near the speaker — above or beside their head; never over a face, hands or the key action — use empty areas such as sky, walls or background; reading order — an earlier line sits higher, or at the same height further ${start}; captions in the panel's top-${start} corner with tailX = tailY = -1; sound effects next to the action that makes the sound, tailX = tailY = -1.`
      : '6. balloons: [] — this page is lettered in the art.',
    `7. safety: rate the IMAGE only (not the script) as rating G, PG, PG-13 or X using these anchors: ${SAFETY_RUBRIC} categories: the matching ones from the allowed list ([] when none). notes: at most 2 short, neutral phrases such as "blood on the floor in panel 3" — never a graphic description.`,
    overlay
      ? '8. keepOut: areas balloons must not cover — at most 3 per panel, most important first (faces, then hands, then the key action; "text" only for signs drawn in the scene), each {panel: n, kind, box}. heads: for each named character in each panel where they appear, {panel: n, name: as written in the script, head: the centre of the head, mouth: the mouth, or {x: -1, y: -1} when it is not visible}.'
      : '8. keepOut: [] and heads: [] — this page is lettered in the art.',
    '',
    'Reply with JSON only, matching the schema.'
  ].join('\n');
};

const lineLabel = (doc: ComicDoc, line: Line): string => {
  const speaker = line.speakerId ? doc.cast.find((c) => c.id === line.speakerId) : undefined;
  if (line.kind === 'caption') return 'CAPTION';
  if (line.kind === 'sfx') return 'SFX';
  return `${speaker ? upperName(speaker.name) : 'OFF-PANEL'} (${line.kind})`;
};

/** The page script as the inspector sees it: panels, staged cast, every line with its id. */
export const visionSpecText = (doc: ComicDoc, page: Page): string => {
  const overlay = doc.format.lettering !== 'in_art';
  const ids = new Set(page.panels.flatMap((p) => p.castIds));
  const cast = doc.cast.filter((c) => ids.has(c.id));
  const out: string[] = [
    `PAGE ${page.n}: ${page.panels.length} panel${page.panels.length === 1 ? '' : 's'}, read ${doc.format.readingDirection === 'rtl' ? 'right-to-left' : 'left-to-right'}, ` +
      (overlay
        ? 'lettering: overlay — the art itself should contain NO text.'
        : 'lettering: in the art — it should contain exactly the lines below and no other text.')
  ];
  if (cast.length) {
    out.push(
      `CHARACTERS: ${cast
        .map((c) => {
          const look = clean(c.look?.summary);
          return `${upperName(c.name)}${look ? ` — ${look.length > 110 ? `${look.slice(0, 109)}…` : look}` : ''}`;
        })
        .join('; ')}`
    );
  }
  for (const panel of page.panels) {
    const staged = stagePanel(page, panel)
      .map((s) => {
        const c = doc.cast.find((x) => x.id === s.id);
        return c ? `${upperName(c.name)}${s.word ? ` (${s.word})` : ''}` : '';
      })
      .filter(Boolean);
    const action = clean(panel.action);
    out.push(
      `Panel ${panel.n} [${panel.size}, ${panel.shot.replace(/_/g, ' ')}]: ${action.length > 220 ? `${action.slice(0, 219)}…` : action} Characters: ${staged.join(', ') || 'none'}.`
    );
    for (const line of panel.lines) {
      if (!clean(line.text)) continue;
      out.push(`  ${line.id} — ${lineLabel(doc, line)}: ${JSON.stringify(clean(line.text))}`);
    }
  }
  return out.join('\n');
};

interface VisionReading {
  panels: Box[];
  issues: string[];
  textFound: string[];
  characterNotes: string[];
  score: number;
  balloons: { lineId: string; x: number; y: number; w: number; tailX?: number; tailY?: number }[];
  keepOut: KeepOut[];
  heads: SpeakerMark[];
  /** The raw `safety` block (verdictFromVision folds it); undefined when the model left it out. */
  safety?: Record<string, unknown>;
}

/**
 * Vision models are asked for 0–1 fractions but sometimes answer on Gemini's native 0–1000
 * grid or in pixels. Detect the scale from the largest coordinate and convert to fractions
 * (pixels need the render's size); null when the numbers can't be interpreted. Up to 1.5 is
 * still fractions — a box that overshoots the edge a little ("w: 1.02") is clamped later; on
 * the 0–1000 grid every value ≤ 1.5 would sit in a 0.15 % corner, and reading it as the grid
 * shrank every box to nothing and cost a paid repair round.
 */
export const coordinateScale = (values: number[], size?: { w?: number; h?: number }): { sx: number; sy: number } | null => {
  const finite = values.filter((v) => Number.isFinite(v) && v >= 0);
  const max = finite.length ? Math.max(...finite) : 0;
  if (max <= 1.5) return { sx: 1, sy: 1 };
  if (max <= 1000) return { sx: 1000, sy: 1000 };
  if (size?.w && size?.h && max <= Math.max(size.w, size.h) * 1.01) return { sx: size.w, sy: size.h };
  return null;
};

const KIND_PRIORITY: Record<KeepOut['kind'], number> = { face: 0, hands: 1, action: 2, text: 3, other: 4 };

/** "MAYA", "Maya", "DUCKLINGS ×3" → the comparable name. */
const nameKey = (name: unknown) => clean(name).replace(/\s*×\s*\d+$|\s+x\s*\d+$/i, '').toLowerCase();

/**
 * keepOut / heads from a vision reply (lettering.md §6.6): their own coordinate scale (an
 * unreadable scale — pixels without a known size — drops them, never the whole reading),
 * clamped to the page, panels that exist only, head names resolved to cast ids, faces
 * first and at most MAX_MARKS_PER_PANEL per panel. Optional data: problems never trigger a
 * paid repair round.
 */
export const normalizeMarks = (
  json: Record<string, unknown>,
  doc: Pick<ComicDoc, 'cast'>,
  page: Page
): { keepOut: KeepOut[]; heads: SpeakerMark[] } => {
  const rawKeep = (Array.isArray(json.keepOut) ? json.keepOut : []).filter(isObject);
  const rawHeads = (Array.isArray(json.heads) ? json.heads : []).filter(isObject);
  const pt = (v: unknown): number[] => (isObject(v) ? [Number(v.x), Number(v.y)] : []);
  const values = [
    ...rawKeep.flatMap((k) => (isObject(k.box) ? [k.box.x, k.box.y, k.box.w, k.box.h].map(Number) : [])),
    ...rawHeads.flatMap((h) => [...pt(h.head), ...pt(h.mouth)])
  ].filter((v) => Number.isFinite(v) && v >= 0);
  if (!values.length) return { keepOut: [], heads: [] };
  const scale = coordinateScale(values, page.render?.asset);
  if (!scale) return { keepOut: [], heads: [] };
  const panelNs = new Set(page.panels.map((p) => p.n));
  const panelOf = (v: unknown): number | undefined => (Number.isInteger(v) && panelNs.has(v as number) ? (v as number) : undefined);
  const count = new Map<string, number>();
  const room = (key: string) => {
    const n = count.get(key) || 0;
    if (n >= MAX_MARKS_PER_PANEL) return false;
    count.set(key, n + 1);
    return true;
  };

  const keepOut: KeepOut[] = [];
  const ordered = rawKeep
    .map((k, i) => ({ k, i, kind: (KEEP_OUT_KINDS as readonly string[]).includes(k.kind as string) ? (k.kind as KeepOut['kind']) : 'other' }))
    .sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || a.i - b.i);
  for (const { k, kind } of ordered) {
    const panel = panelOf(k.panel);
    if (panel === undefined || !isObject(k.box)) continue;
    const bx = Number(k.box.x) / scale.sx;
    const by = Number(k.box.y) / scale.sy;
    const bw = Number(k.box.w) / scale.sx;
    const bh = Number(k.box.h) / scale.sy;
    if (![bx, by, bw, bh].every((v) => Number.isFinite(v) && v >= 0) || bx > 1 || by > 1) continue;
    const box = { x: round4(clamp01(bx)), y: round4(clamp01(by)), w: round4(clamp(bw, 0, 1 - clamp01(bx))), h: round4(clamp(bh, 0, 1 - clamp01(by))) };
    if (box.w < 0.01 || box.h < 0.01 || !room(`k${panel}`)) continue;
    keepOut.push({ panel, box, kind });
  }

  const castByName = new Map(doc.cast.map((c) => [nameKey(c.name), c.id]));
  const heads: SpeakerMark[] = [];
  const seen = new Set<string>();
  for (const h of rawHeads) {
    const panel = panelOf(h.panel);
    const head = pt(h.head);
    if (panel === undefined || head.length !== 2) continue;
    const hx = head[0] / scale.sx;
    const hy = head[1] / scale.sy;
    if (![hx, hy].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) continue;
    const characterId = castByName.get(nameKey(h.name));
    const key = `${panel}:${characterId || nameKey(h.name) || heads.length}`;
    if (seen.has(key) || !room(`h${panel}`)) continue;
    seen.add(key);
    const mouth = pt(h.mouth);
    const mx = mouth[0] / scale.sx;
    const my = mouth[1] / scale.sy;
    const hasMouth = mouth.length === 2 && [mx, my].every((v) => Number.isFinite(v) && v >= 0 && v <= 1);
    heads.push({
      panel,
      ...(characterId ? { characterId } : {}),
      head: { x: round4(hx), y: round4(hy) },
      ...(hasMouth ? { mouth: { x: round4(mx), y: round4(my) } } : {})
    });
  }
  return { keepOut, heads };
};

const normalizeVision = (json: unknown, doc: Pick<ComicDoc, 'cast'>, page: Page, overlay: boolean): StructuredCheck<VisionReading> => {
  if (!isObject(json)) return { problems: ['The reply must be a JSON object.'] };
  const strings = (v: unknown) => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);
  const rawPanels = (Array.isArray(json.panels) ? json.panels : []).filter(isObject);
  const rawBalloons = (Array.isArray(json.balloons) ? json.balloons : []).filter(isObject);
  const numbered = rawPanels.every((p) => Number.isInteger(p.n));
  const boxes = (numbered ? [...rawPanels].sort((a, b) => (a.n as number) - (b.n as number)) : rawPanels).map((p) =>
    isObject(p.box) ? p.box : p
  );
  const scale = coordinateScale(
    [
      ...boxes.flatMap((b) => [b.x, b.y, b.w, b.h].map(Number)),
      ...rawBalloons.flatMap((b) => [b.x, b.y, b.w, b.tailX, b.tailY].map(Number))
    ],
    page.render?.asset
  );
  if (!scale) return { problems: ['Coordinates must be fractions of the page between 0 and 1 (not pixels).'] };
  const ux = (v: unknown) => Number(v) / scale.sx;
  const uy = (v: unknown) => Number(v) / scale.sy;
  const panels = boxes
    .map((b) => {
      const x = clamp01(ux(b.x));
      const y = clamp01(uy(b.y));
      return { x, y, w: clamp(ux(b.w), 0, 1 - x), h: clamp(uy(b.h), 0, 1 - y) };
    })
    .filter((b) => b.w >= 0.03 && b.h >= 0.03);
  const lineIds = new Set(page.panels.flatMap((p) => p.lines.map((l) => l.id)));
  const seen = new Set<string>();
  const balloons: VisionReading['balloons'] = [];
  for (const raw of rawBalloons) {
    const lineId = clean(raw.lineId);
    if (!lineIds.has(lineId) || seen.has(lineId)) continue;
    seen.add(lineId);
    const tailX = Number(raw.tailX);
    const tailY = Number(raw.tailY);
    const hasTail = Number.isFinite(tailX) && Number.isFinite(tailY) && tailX >= 0 && tailY >= 0;
    balloons.push({
      lineId,
      x: clamp01(ux(raw.x)),
      y: clamp01(uy(raw.y)),
      w: clamp01(ux(raw.w)),
      ...(hasTail ? { tailX: clamp01(ux(tailX)), tailY: clamp01(uy(tailY)) } : {})
    });
  }
  const score = typeof json.score === 'number' && Number.isFinite(json.score) ? clamp(json.score, 0, 1) : Number.NaN;
  const marks = overlay ? normalizeMarks(json, doc, page) : { keepOut: [], heads: [] };
  const reading: VisionReading = {
    panels,
    issues: strings(json.issues),
    textFound: strings(json.textFound),
    characterNotes: strings(json.extraOrMissingCharacters),
    score,
    balloons,
    ...marks,
    // Missing ⇒ unchecked (never a pass); no repair round is spent on it.
    ...(isObject(json.safety) ? { safety: json.safety } : {})
  };
  const problems: string[] = [];
  if (!panels.length && page.panels.length) problems.push('"panels" is empty: give every panel\'s rectangle.');
  const expectedLines = page.panels.reduce((n, p) => n + p.lines.filter((l) => clean(l.text)).length, 0);
  if (overlay && expectedLines && !balloons.length) problems.push('"balloons" is empty: place one balloon per script line, using the lineIds given.');
  if (Number.isNaN(score)) problems.push('"score" must be a number between 0 and 1.');
  if (!panels.length && !balloons.length && Number.isNaN(score)) return { problems };
  if (Number.isNaN(reading.score)) reading.score = 0.5;
  return { value: reading, problems };
};

/** Balloons from a vision reading: clamped, sized from text, inside their panels, in order, no overlaps. */
export const layoutBalloonsFromVision = (
  page: Page,
  raw: { lineId: string; x: number; y: number; w: number; tailX?: number; tailY?: number }[],
  boxes: Box[],
  opts: LayoutOptions & { trustBoxes?: boolean } = {}
): Balloon[] => {
  const rtl = (opts.readingDirection || (inferRtl(page.layout) ? 'rtl' : 'ltr')) === 'rtl';
  const aspect = pageAspectOf(page, opts);
  const byLine = new Map(raw.map((b) => [b.lineId, b]));
  const pinned = new Map(page.balloons.filter((b) => b.pinned).map((b) => [b.lineId, b]));
  let fallback: Map<string, Balloon> | null = null;
  const fallbackFor = (lineId: string) => {
    if (!fallback) fallback = new Map(fallbackBalloons(page, boxes, opts).map((b) => [b.lineId, b]));
    return fallback.get(lineId);
  };
  const placed: Placed[] = [];
  for (const { line, panelIndex } of pageLines(page)) {
    const panelBox = boxes[panelIndex];
    const box = opts.trustBoxes !== false && panelBox ? panelBox : PAGE_BOX;
    const pin = pinned.get(line.id);
    if (pin) {
      placed.push({ line, panelIndex, rect: { x: pin.x, y: pin.y, w: pin.w, h: estimateBalloonHeight(line.text, pin.w, aspect) }, tailX: pin.tailX, tailY: pin.tailY, pinned: true });
      continue;
    }
    const spoken = SPOKEN.has(line.kind);
    const fromVision = byLine.get(line.id);
    const src = fromVision || fallbackFor(line.id);
    if (!src) continue;
    const w = balloonWidth(line.text);
    const h = estimateBalloonHeight(line.text, Math.min(w, Math.max(0.05, box.w - 2 * PAD)), aspect);
    const rect = fitInBox(src.x, src.y, w, h, box);
    const tail = spoken ? fixTail(rect, box, src.tailX, src.tailY) : undefined;
    placed.push({ line, panelIndex, rect, ...(tail || {}) });
  }
  return settle(placed, opts.trustBoxes !== false ? boxes : [], rtl).map(toBalloon);
};

const pageAspectForDoc = (doc: ComicDoc, page: Page): number => {
  const a = page.render?.asset;
  if (a?.w && a?.h) return a.w / a.h;
  try {
    const { spec } = resolveImageJob('page', doc.settings.quality, doc.settings.imageModelOverride);
    return ratioOf(pageAspectFor(doc, spec, page.panels.length) as AspectRatio);
  } catch {
    return ratioOf(doc.format.pageAspect || '2:3');
  }
};

const dedupe = (items: string[]) => {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = i.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

const TEXT_BLOCK_NOTE = 'text drawn in the art breaks the content rules';
const MAX_TEXT_FOUND = 100;

/**
 * Pre-filter (free, safety.md §3.3) every piece of text the vision pass read off the art:
 * entries the word filter blocks are dropped from qc.textFound (never stored or quoted back)
 * and escalate the page verdict to X with their categories.
 */
export const prefilterFoundText = (
  doc: ComicDoc,
  textFound: string[]
): { kept: string[]; blocked: number; categories: SafetyCategory[] } => {
  const rating = effectiveRating(doc).rating;
  const kept: string[] = [];
  const categories = new Set<SafetyCategory>();
  let blocked = 0;
  // Bounded: a runaway reply can't make us screen (or store) thousands of strings.
  for (const text of textFound.slice(0, MAX_TEXT_FOUND)) {
    const result = prefilterText(text, rating);
    if (result?.decision === 'block') {
      blocked += 1;
      for (const c of result.categories || []) categories.add(c);
    } else kept.push(text);
  }
  return { kept, blocked, categories: [...categories] };
};

/** The image verdict with blocked drawn text folded in (X, union of categories, ≤ 2 notes). */
const foldTextVerdict = (
  verdict: SafetyVerdict | undefined,
  text: { blocked: number; categories: SafetyCategory[] },
  model: string | undefined,
  at: number
): SafetyVerdict | undefined => {
  if (!text.blocked) return verdict;
  const categories = [...new Set([...(verdict?.categories || []), ...text.categories])];
  const notes = [...new Set([...(verdict?.notes || []), TEXT_BLOCK_NOTE])].slice(0, 2);
  return {
    ...(verdict || {}),
    assessed: 'X',
    ...(categories.length ? { categories } : {}),
    notes,
    by: verdict?.by || 'qc',
    ...(verdict?.model || model ? { model: verdict?.model || model } : {}),
    at: verdict?.at || at
  };
};

/**
 * Vision QC + balloon layout for one rendered page. Transport errors (no key, rate limit,
 * cancel) propagate as StudioErrors; an unusable reply after one repair degrades to the
 * layout-based fallback with an honest QC note instead of failing the page. The same call
 * rates the image (`safety`, folded by verdictFromVision; absent ⇒ unchecked) and, for
 * overlay pages, marks faces/hands/action and speakers' heads for balloon placement.
 */
export async function analyzePageRender(args: {
  doc: ComicDoc;
  page: Page;
  dataUrl: string;
  llm: LlmClient;
  signal?: AbortSignal;
}): Promise<{ qc: QcReport; balloons: Balloon[]; costUsd?: number; model: string; safety?: SafetyVerdict }> {
  const { doc, page } = args;
  const overlay = doc.format.lettering !== 'in_art';
  const opts: LayoutOptions = { readingDirection: doc.format.readingDirection, kind: doc.format.kind, pageAspect: pageAspectForDoc(doc, page) };
  const estimated = estimatePanelBoxes(page, opts);
  const lineCount = page.panels.reduce((n, p) => n + p.lines.length, 0);
  const user: MessagePart[] = [
    { type: 'image_url', image_url: { url: args.dataUrl } },
    { type: 'text', text: visionSpecText(doc, page) }
  ];

  const result = await completeStructured<VisionReading | null>({
    llm: args.llm,
    role: 'vision',
    system: visionSystemPrompt(doc),
    user,
    schemaName: 'comic_page_check',
    schema: VISION_SCHEMA,
    validate: (json) => normalizeVision(json, doc, page, overlay),
    failure: "The page check didn't return a usable result.",
    fallback: () => null,
    temperature: 0.2,
    maxTokens: Math.min(8_000, 2_200 + lineCount * 80 + (overlay ? page.panels.length * 90 : 0)),
    signal: args.signal
  });
  const checkedAt = Date.now();
  const cost = result.costUsd !== undefined ? { costUsd: result.costUsd } : {};

  const reading = result.value;
  if (!reading) {
    return {
      qc: {
        score: 0.5,
        issues: ['Automatic page check returned no usable result — balloons were placed from the layout; review them.'],
        panelBoxes: estimated,
        checkedAt,
        ...(result.model ? { model: result.model } : {})
      },
      balloons: overlay ? fallbackBalloons(page, estimated, opts) : [],
      ...cost,
      model: result.model
    };
  }

  const n = page.panels.length;
  const countOk = reading.panels.length === n;
  const boxes = countOk ? reading.panels : estimated;
  const issues: string[] = [...reading.issues, ...reading.characterNotes];
  // Drawn text is screened before anything reads or stores it ($0).
  const screened = prefilterFoundText(doc, reading.textFound);
  const textFound = screened.kept;
  const safety = foldTextVerdict(verdictFromVision(reading.safety, result.model), screened, result.model, checkedAt);
  let score = reading.score;
  if (!countOk && reading.panels.length) {
    issues.unshift(`Expected ${n} panel${n === 1 ? '' : 's'} but the page shows ${reading.panels.length}.`);
    score = Math.min(score, 0.6);
  }
  if (screened.blocked) {
    issues.unshift('Some text drawn in the art breaks the content rules — redraw this page safer.');
    score = Math.min(score, 0.4);
  }
  if (reading.characterNotes.length) score = Math.min(score, 0.75);

  if (overlay) {
    const stray = textFound.filter((t) => (normalizeLettering(t).match(/\p{L}/gu) || []).length >= 3);
    const letters = textFound.reduce((s, t) => s + (normalizeLettering(t).match(/\p{L}/gu) || []).length, 0);
    if (stray.length || letters >= 6) {
      issues.push(`Stray text drawn in the art: ${stray.slice(0, 3).map((t) => quoteShort(t, 40)).join(', ') || quoteShort(textFound.join(' '), 40)} — overlay pages should be text-free.`);
      score = Math.min(score, 0.8);
    }
  } else {
    const check = compareLettering(page, textFound);
    for (const m of check.missing.slice(0, 6)) issues.push(`Panel ${m.panel}: line missing from the art — ${quoteShort(m.line.text)}.`);
    for (const m of check.misspelled.slice(0, 6)) {
      issues.push(`Panel ${m.panel}: lettering differs from the script — expected ${quoteShort(m.line.text)}, found ${quoteShort(m.found)}.`);
    }
    if (check.unexpected.length) issues.push(`Unexpected text in the art: ${check.unexpected.slice(0, 3).map((t) => quoteShort(t, 40)).join(', ')}.`);
    if (check.missing.length) score = Math.min(score, 0.6);
    else if (check.misspelled.length) score = Math.min(score, 0.75);
  }

  // Only force balloons into panel boxes the model actually measured; with a panel-count
  // mismatch its balloon positions (made on the real image) beat estimated boxes.
  const balloons = overlay ? layoutBalloonsFromVision(page, reading.balloons, boxes, { ...opts, trustBoxes: countOk }) : [];
  const qc: QcReport = {
    score: round4(clamp(score, 0, 1)),
    issues: dedupe(issues).slice(0, 14),
    panelBoxes: boxes.map((b) => ({ x: round4(b.x), y: round4(b.y), w: round4(b.w), h: round4(b.h) })),
    ...(textFound.length ? { textFound: textFound.slice(0, 60) } : {}),
    checkedAt,
    ...(result.model ? { model: result.model } : {}),
    ...(reading.keepOut.length ? { keepOut: reading.keepOut } : {}),
    ...(reading.heads.length ? { heads: reading.heads } : {})
  };
  return { qc, balloons, ...cost, model: result.model, ...(safety ? { safety } : {}) };
}
