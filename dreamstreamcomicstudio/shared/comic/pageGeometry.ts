// Page geometry (pure, dependency-free) — contract §11.1, shared by client and server.
//
// The ONE copy of the page-blueprint geometry. The board (components/comicstudio/board/pageLayout.ts)
// re-exports it; the server's twins (vision.ts estimatePanelBoxes, prompts.ts synthesizeLayout /
// parseLayout) switch to it in wave 2 once the golden test (pageGeometry.test.ts) keeps showing
// identical boxes. Margins, gutters, row weights and the parsing vocabulary are the server's.
//
// All boxes are page-normalized (0..1, origin top-left).

import type { Box, ComicDoc, ComicKind, Format, Page, Panel, PanelSize } from './doc.js';
// --- Ship 2 (K2a): panels mode reads its frames (artModeOf is pure; doc.ts never imports this module) ---
import { artModeOf } from './doc.js';

/** Outer page margin and gutter between panels (fractions of the page). */
const MARGIN = 0.02;
const GUTTER = 0.02;
/** Webtoon panels get generous vertical spacing. */
const STACK_GUTTER = 0.04;
/** A marked region smaller than this (either side) is treated as a stray click. */
export const MIN_REGION = 0.015;

const clean = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export interface LayoutCell {
  /** Panel indexes (0-based, reading order) in this row/band. */
  panels: number[];
  /** Relative height weight of the row. */
  weight: number;
  /** A tall panel spanning two rows beside a stack. */
  span?: { tallSide: 'left' | 'right'; stacked: number };
}

export interface ParsedLayout {
  mode: 'rows' | 'stack' | 'single';
  rows: LayoutCell[];
  /** Insets (B9's layout sentence: "… (panel 1) with a small inset panel in its lower right corner (panel 2)"): panels
   *  drawn inside a corner of another panel, outside every row. Absent when the sentence names none. */
  insets?: LayoutInset[];
}

/** A small panel inside a corner of its host panel (indexes are 0-based, reading order). */
export interface LayoutInset {
  panel: number;
  host: number;
  vert: 'upper' | 'lower';
  horiz: 'left' | 'right';
}

/** An inset's size against its host, and its distance from the host's corner beyond one gutter. The same numbers as
 *  the editor's layoutText (shared/comic/editor/layoutText.ts INSET / insetBox), so the plan and the frames agree. */
export const LAYOUT_INSET = { wShare: 1 / 3, hShare: 0.26, pad: 0.01 } as const;

/** The inset box in one corner of its host (page fractions, rounded like every estimated box). */
export const layoutInsetBox = (host: Box, vert: LayoutInset['vert'], horiz: LayoutInset['horiz'], gutter = GUTTER): Box => {
  const w = host.w * LAYOUT_INSET.wShare;
  const h = host.h * LAYOUT_INSET.hShare;
  const pad = gutter + LAYOUT_INSET.pad;
  return {
    x: round4(horiz === 'right' ? host.x + host.w - w - pad : host.x + pad),
    y: round4(vert === 'lower' ? host.y + host.h - h - pad : host.y + pad),
    w: round4(w),
    h: round4(h)
  };
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, single: 1, two: 2, pair: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9
};

const numberFrom = (token: string): number | undefined => {
  const t = token.toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return NUMBER_WORDS[t];
};

const rangeText = (from: number, to: number) => (from === to ? `panel ${from}` : `panels ${from}–${to}`);

/**
 * Synthesize a row blueprint from panel sizes when the plan has no usable layout
 * (mirrors server prompts.ts synthesizeLayout).
 */
export const synthesizeLayout = (
  panels: Pick<Panel, 'size'>[],
  format: { kind: ComicKind; readingDirection: 'ltr' | 'rtl' }
): string => {
  const n = panels.length;
  if (!n) return '';
  const rtl = format.readingDirection === 'rtl';
  if (format.kind === 'webtoon') {
    const tall = panels.map((p, i) => (p.size === 'tall' || p.size === 'splash' || p.size === 'large' ? i + 1 : 0)).filter(Boolean);
    return `Stacked vertically: ${n} full-width panel${n === 1 ? '' : 's'} (${rangeText(1, n)}), top to bottom.${
      tall.length ? ` Panel${tall.length > 1 ? 's' : ''} ${tall.join(', ')} ${tall.length > 1 ? 'are' : 'is'} extra tall.` : ''
    }`;
  }
  if (format.kind === 'strip') {
    return `Row 1: ${n === 1 ? 'one panel' : `${n} equal panels side by side`} (${rangeText(1, n)}${rtl ? ', right to left' : ''}).`;
  }
  if (n === 1) return 'One full-page splash panel (panel 1).';
  const rows: string[] = [];
  let row = 1;
  let i = 0;
  const pairText = (count: number, from: number) =>
    `${count === 2 ? 'two equal panels' : 'three small panels'} side by side (${rangeText(from, from + count - 1)}${rtl ? ', right to left' : ''})`;
  const shares = (s?: PanelSize) => s === 'small' || s === 'medium';
  while (i < n) {
    const size = panels[i].size;
    const next = panels[i + 1]?.size;
    if (size === 'splash') {
      rows.push(`Row ${row}: one dominant splash panel across the full width, about half the page height (panel ${i + 1}).`);
      i += 1;
      row += 1;
    } else if (size === 'wide' || size === 'large') {
      rows.push(`Row ${row}: one ${size} panel across the full width (panel ${i + 1}).`);
      i += 1;
      row += 1;
    } else if (size === 'tall') {
      let stacked = 0;
      while (stacked < 2 && i + 1 + stacked < n && shares(panels[i + 1 + stacked].size)) stacked += 1;
      if (stacked === 0) {
        rows.push(`Row ${row}: one tall panel across the full width (panel ${i + 1}).`);
        i += 1;
        row += 1;
      } else {
        const tallSide = rtl ? 'right' : 'left';
        const stackSide = rtl ? 'left' : 'right';
        const stack =
          stacked === 1
            ? `one panel on the ${stackSide} (panel ${i + 2})`
            : `two stacked panels on the ${stackSide} (${rangeText(i + 2, i + 1 + stacked)})`;
        rows.push(`Rows ${row}–${row + 1}: one tall panel on the ${tallSide} (panel ${i + 1}) beside ${stack}.`);
        i += 1 + stacked;
        row += 2;
      }
    } else if (size === 'small' && panels[i + 1]?.size === 'small' && panels[i + 2]?.size === 'small' && panels[i + 3]?.size !== 'small') {
      rows.push(`Row ${row}: ${pairText(3, i + 1)}.`);
      i += 3;
      row += 1;
    } else if (shares(next) && shares(size)) {
      rows.push(`Row ${row}: ${pairText(2, i + 1)}.`);
      i += 2;
      row += 1;
    } else {
      rows.push(`Row ${row}: one panel across the full width (panel ${i + 1}).`);
      i += 1;
      row += 1;
    }
  }
  return rows.join(' ');
};

const rowWeight = (text: string): number => {
  if (/\b(splash|dominant|two-thirds|most of the page)\b/i.test(text)) return 2.2;
  if (/\b(large|big|tall|half the page|half-page)\b/i.test(text)) return 1.6;
  if (/\b(small|thin|short|narrow)\b/i.test(text)) return 0.85;
  return 1;
};

const COUNT_RE = /\b(\d+|an?|one|single|two|pair|three|four|five|six|seven|eight|nine)\s+(?:of\s+)?((?:[a-z-]+\s+){0,3}?)panels?\b/gi;

const countPhrases = (segment: string): { n: number; words: string }[] => {
  const out: { n: number; words: string }[] = [];
  const re = new RegExp(COUNT_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) {
    const n = numberFrom(m[1]);
    if (n) out.push({ n, words: (m[2] || '').toLowerCase() });
  }
  return out;
};

const countInSegment = (segment: string): number => {
  const phrases = countPhrases(segment);
  if (!phrases.length) return 0;
  if (phrases[0].n >= 2) return phrases[0].n;
  return phrases.reduce((sum, p) => sum + p.n, 0);
};

/**
 * The inset clause exactly as the editor's layoutText writes it: "with a small inset panel in its lower right corner
 * (panel 2)", or "… in the upper left corner of panel 3 (panel 4)" when the host is not the panel just named.
 */
const INSET_RE = /,?\s*with an? small inset panel in (?:its|the) (upper|lower) (left|right) corner(?: of panel (\d+))? \(panel (\d+)\)/gi;

/**
 * Parse a row blueprint into rows (mirrors server prompts.ts parseLayout). Null when unreadable.
 *
 * A sentence with the inset clause parses without it (the rows), then each inset takes its own reading number and its
 * host (named, or the nearest panel before it that is not an inset) — the editor's framesFromLayoutText rule. A
 * sentence without the clause, or whose clause does not add up (a number used twice, out of range, an inset hosting
 * an inset), parses exactly as before.
 */
export const parseLayout = (layout: string): ParsedLayout | null => {
  const text = clean(layout);
  if (!text) return null;
  if (!new RegExp(INSET_RE.source, 'i').test(text)) return parseRows(text);
  return parseWithInsets(text) ?? parseRows(text);
};

const parseWithInsets = (text: string): ParsedLayout | null => {
  const clauses: { vert: LayoutInset['vert']; horiz: LayoutInset['horiz']; host?: number; n: number }[] = [];
  const rest = clean(
    text.replace(new RegExp(INSET_RE.source, 'gi'), (_m, vert: string, horiz: string, host: string | undefined, k: string) => {
      clauses.push({ vert: vert.toLowerCase() as LayoutInset['vert'], horiz: horiz.toLowerCase() as LayoutInset['horiz'], ...(host ? { host: Number(host) } : {}), n: Number(k) });
      return '';
    })
  );
  const main = rest ? parseRows(rest) : null;
  if (!main) return null;
  const total = layoutPanelCount(main) + clauses.length;
  const insetAt = new Set(clauses.map((c) => c.n - 1));
  if (insetAt.size !== clauses.length || clauses.some((c) => !(c.n >= 1 && c.n <= total))) return null;
  // A full-page splash is panel 1 (the single-mode boxes and harmonizePanelSizes write index 0): an inset numbered
  // first would leave the splash elsewhere and the boxes with a hole, so that sentence does not add up either.
  if (main.mode === 'single' && insetAt.has(0)) return null;
  // The rows' panels take the reading numbers the insets leave free, in order.
  const free: number[] = [];
  for (let i = 0; i < total; i++) if (!insetAt.has(i)) free.push(i);
  const insets: LayoutInset[] = [];
  for (const c of [...clauses].sort((a, b) => a.n - b.n)) {
    let host = c.host ? c.host - 1 : -1;
    if (host < 0) for (let i = c.n - 2; i >= 0 && host < 0; i--) if (!insetAt.has(i)) host = i;
    if (host < 0 || host >= total || insetAt.has(host)) return null;
    insets.push({ panel: c.n - 1, host, vert: c.vert, horiz: c.horiz });
  }
  return { mode: main.mode, rows: main.rows.map((r) => ({ ...r, panels: r.panels.map((i) => free[i]) })), insets };
};

/** The rows of a blueprint with no inset clause (the parser before insets; unchanged). */
const parseRows = (text: string): ParsedLayout | null => {
  if (/\bstacked vertically\b|\bvertical stack\b/i.test(text)) {
    const m = /(\d+|one|two|three|four|five|six|seven|eight|nine)\s+(?:[a-z-]+\s+){0,2}panels?/i.exec(text);
    const n = m ? numberFrom(m[1]) : undefined;
    if (!n) return null;
    const tall = new Set<number>();
    const tallMatch = /panels?\s+([\d,\sand]+)\s+(?:is|are)\s+extra tall/i.exec(text);
    if (tallMatch) for (const d of tallMatch[1].match(/\d+/g) || []) tall.add(Number(d) - 1);
    return { mode: 'stack', rows: Array.from({ length: n }, (_, i) => ({ panels: [i], weight: tall.has(i) ? 1.6 : 1 })) };
  }
  if (/^one full-page splash panel\b|^a single full-page (splash )?panel\b|^full-page splash\b/i.test(text)) {
    return { mode: 'single', rows: [{ panels: [0], weight: 1 }] };
  }
  const marked = text.split(/(?=\brows?\s*\d+)/i).map(clean).filter((s) => /\brows?\s*\d+/i.test(s));
  const segments = marked.length ? marked : text.split(/(?<=[.;])\s+|\n+/).map(clean).filter((s) => /panel/i.test(s));
  if (!segments.length) return null;
  const rows: LayoutCell[] = [];
  let next = 0;
  for (const segment of segments) {
    const spanRange = /\brows\s*(\d+)\s*(?:–|—|-|to|and)\s*(\d+)/i.exec(segment);
    const isSpan = /\btall\b/i.test(segment) && /\b(stacked|beside|next to)\b/i.test(segment);
    if (isSpan || (spanRange && /\btall\b/i.test(segment))) {
      const others = countPhrases(segment.replace(/\brows?\s*\d+\s*(?:–|—|-|to|and)?\s*\d*\s*:?/i, '')).filter((p) => !/\btall\b/.test(p.words));
      const stacked = Math.min(3, others.length ? (others[0].n >= 2 ? others[0].n : others.reduce((s, p) => s + p.n, 0)) : 2);
      const sideMatch =
        /\btall panel\b[^.;]*?\bon the (left|right)\b/i.exec(segment) || /\bon the (left|right)\b[^.;]*?\btall panel\b/i.exec(segment);
      const tallSide = (sideMatch?.[1]?.toLowerCase() as 'left' | 'right') || 'left';
      rows.push({ panels: Array.from({ length: 1 + stacked }, (_, k) => next + k), weight: 2, span: { tallSide, stacked } });
      next += 1 + stacked;
      continue;
    }
    const count = countInSegment(segment.replace(/\brows?\s*\d+\s*:?/i, ''));
    if (!count) return null;
    rows.push({ panels: Array.from({ length: count }, (_, k) => next + k), weight: rowWeight(segment) });
    next += count;
  }
  return rows.length ? { mode: 'rows', rows } : null;
};

export const layoutPanelCount = (parsed: ParsedLayout | null): number =>
  parsed ? parsed.rows.reduce((n, r) => n + r.panels.length, 0) + (parsed.insets?.length ?? 0) : 0;

// ── The layout as drawn (moved from server prompts.ts, which re-exports them under the same names) ──
//
// The page prompt draws `effectiveLayout`: the page's blueprint when it agrees with its panels (count, format and
// sizes), else a blueprint synthesized from the panel sizes. Every measure of "the plan as it will be drawn" (the
// page-plan check, the Render-all hold-back, the breakdown card's fit dots) reads this same layout, so the gate and
// the drawing never disagree about a stored page whose layout text and panel sizes conflict.

const FULL_WIDTH_SIZES: ReadonlySet<PanelSize> = new Set<PanelSize>(['wide', 'large', 'splash']);

/** True when a panel's size contradicts its row (a wide/large/splash panel sharing a row). */
export const layoutConflicts = (parsed: ParsedLayout, panels: Pick<Panel, 'size'>[]): boolean =>
  parsed.mode === 'rows' &&
  parsed.rows.some((r) => !r.span && r.panels.length > 1 && r.panels.some((i) => FULL_WIDTH_SIZES.has(panels[i]?.size)));

/** Index (into the page's panels) of the tall panel of a span row, by reading order. */
const tallIndexOf = (row: LayoutCell, rtl: boolean): number => {
  const startSide = rtl ? 'right' : 'left';
  return row.span?.tallSide === startSide ? row.panels[0] : row.panels[1] ?? row.panels[0];
};

/**
 * Make panel sizes agree with a parsed blueprint (the writer's layout is the page's
 * design): full-width single rows are "wide" (unless large/splash/tall), shared rows never
 * hold wide/large/splash panels, a span row's tall panel is "tall", a single-panel page is
 * a "splash". Returns new panel objects; unchanged sizes are kept.
 */
export const harmonizePanelSizes = <P extends Pick<Panel, 'size'>>(panels: P[], parsed: ParsedLayout, rtl = false): P[] => {
  const out = panels.map((p) => ({ ...p }));
  const set = (i: number, size: PanelSize) => {
    if (out[i]) out[i].size = size;
  };
  if (parsed.mode === 'single') {
    set(0, 'splash');
    return out;
  }
  if (parsed.mode === 'stack') return out;
  for (const row of parsed.rows) {
    if (row.span) {
      const tall = tallIndexOf(row, rtl);
      for (const i of row.panels) {
        if (i === tall) set(i, 'tall');
        else if (out[i] && out[i].size !== 'small' && out[i].size !== 'medium') set(i, 'medium');
      }
    } else if (row.panels.length > 1) {
      for (const i of row.panels) if (out[i] && FULL_WIDTH_SIZES.has(out[i].size)) set(i, 'medium');
    } else {
      const i = row.panels[0];
      if (out[i] && (out[i].size === 'small' || out[i].size === 'medium')) set(i, 'wide');
    }
  }
  return out;
};

/**
 * The page's layout when it matches its panels (count, format and sizes), else a
 * blueprint synthesized from the panel sizes — so the prompt never describes a layout
 * that contradicts its own panel list. This is the layout the page is DRAWN on.
 */
export const effectiveLayout = (page: Pick<Page, 'panels' | 'layout'>, format: Pick<Format, 'kind' | 'readingDirection'>): string => {
  const layout = clean(page.layout);
  const parsed = layout ? parseLayout(layout) : null;
  // Webtoon segments must be a vertical stack; a row grid would contradict the format.
  const fits = parsed && (format.kind !== 'webtoon' || parsed.mode === 'stack');
  if (fits && layoutPanelCount(parsed) === page.panels.length && !layoutConflicts(parsed, page.panels)) return layout;
  return synthesizeLayout(page.panels, format);
};

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
      const tallW = (contentW - GUTTER) * 0.45;
      const stackW = contentW - GUTTER - tallW;
      const tallLeft = row.span.tallSide === 'left';
      const tallX = tallLeft ? MARGIN : MARGIN + stackW + GUTTER;
      const stackX = tallLeft ? MARGIN + tallW + GUTTER : MARGIN;
      const k = Math.max(1, row.panels.length - 1);
      const cellH = (h - GUTTER * (k - 1)) / k;
      const tall: Box = { x: tallX, y, w: tallW, h };
      const stack: Box[] = Array.from({ length: k }, (_, i) => ({ x: stackX, y: y + i * (cellH + GUTTER), w: stackW, h: cellH }));
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

const gridLayout = (n: number): ParsedLayout => {
  const perRow = n <= 2 ? 1 : n <= 4 ? 2 : 3;
  const rows: LayoutCell[] = [];
  for (let i = 0; i < n; i += perRow) rows.push({ panels: Array.from({ length: Math.min(perRow, n - i) }, (_, k) => i + k), weight: 1 });
  return { mode: 'rows', rows };
};

export interface LayoutOptions {
  readingDirection?: 'ltr' | 'rtl';
  kind?: ComicKind;
}

/**
 * Estimated panel rectangles (reading order) from the page's blueprint; when it is missing
 * or disagrees with the panel count the blueprint is synthesized from panel sizes, and a
 * plain grid is the last resort. Mirrors server vision.ts estimatePanelBoxes.
 */
export const estimatePanelBoxes = (page: Pick<Page, 'panels' | 'layout'>, opts: LayoutOptions = {}): Box[] => {
  const n = page.panels.length;
  if (!n) return [];
  const rtl = (opts.readingDirection || (/\bright[ -]to[ -]left\b/i.test(page.layout || '') ? 'rtl' : 'ltr')) === 'rtl';
  const kind: ComicKind = opts.kind || (/\bstacked vertically\b/i.test(page.layout || '') ? 'webtoon' : 'comic');
  const fits = (p: ParsedLayout | null): p is ParsedLayout => !!p && layoutPanelCount(p) === n && (kind !== 'webtoon' || p.mode === 'stack');
  let parsed = page.layout ? parseLayout(page.layout) : null;
  if (!fits(parsed)) parsed = parseLayout(synthesizeLayout(page.panels, { kind, readingDirection: rtl ? 'rtl' : 'ltr' }));
  if (!fits(parsed)) parsed = gridLayout(n);
  const round = (b: Box): Box => ({ x: round4(b.x), y: round4(b.y), w: round4(b.w), h: round4(b.h) });
  const boxes = boxesFromLayout(parsed, n, rtl).map(round);
  // Insets sit in a corner of their host's (rounded) box, as the editor places them (layoutText framesFromLayoutText).
  for (const inset of parsed.insets ?? []) {
    const host = boxes[inset.host];
    if (host && inset.panel < n) boxes[inset.panel] = layoutInsetBox(host, inset.vert, inset.horiz);
  }
  // Every reader indexes one box per panel: a parse that leaves a panel without one (none known) gets the plain grid.
  if (boxes.length !== n || Array.from({ length: n }, (_, i) => boxes[i]).some((b) => !b)) return boxesFromLayout(gridLayout(n), n, rtl).map(round);
  return boxes;
};

const validBox = (b: unknown): b is Box => {
  if (!b || typeof b !== 'object') return false;
  const { x, y, w, h } = b as Box;
  return [x, y, w, h].every((v) => typeof v === 'number' && Number.isFinite(v)) && w > 0 && h > 0;
};

/**
 * The panel rectangles a page is DRAWN at, from its plan: the boxes of `effectiveLayout` (never a drawn take's
 * measured boxes). Equal to estimatePanelBoxes(page) unless the page's layout text contradicts its panel sizes,
 * where the prompt draws the layout synthesized from the sizes — and so do these boxes.
 */
export const drawnLayoutBoxes = (doc: Pick<ComicDoc, 'format'>, page: Pick<Page, 'panels' | 'layout'>): Box[] =>
  estimatePanelBoxes({ panels: page.panels, layout: effectiveLayout(page, doc.format) }, { readingDirection: doc.format.readingDirection, kind: doc.format.kind });

/** Ship 2 (K2a; pro plan §4.3): the page shape the box readers take — artMode is optional (absent = as drawn). */
export type PanelBoxesPage = Pick<Page, 'panels' | 'layout' | 'render'> & Partial<Pick<Page, 'artMode'>>;

/** The frames of a page shown in panels mode (artModeOf), in reading order; undefined in page mode. */
export const frameBoxesFor = (page: PanelBoxesPage): Box[] | undefined =>
  artModeOf(page) === 'panels' ? page.panels.map((p) => ({ ...p.frame!.box })) : undefined;

/**
 * The best panel rectangles we know for a page: in panels mode its frames (the page as shown — balloons, Guided
 * View, the transcript, motion export and wireframes follow them with no code of their own); else the vision pass's
 * measured boxes when they match the panel count, else the blueprint estimate.
 */
export const panelBoxesFor = (doc: Pick<ComicDoc, 'format'>, page: PanelBoxesPage): Box[] => {
  const frames = frameBoxesFor(page);
  if (frames) return frames;
  const measured = page.render?.qc?.panelBoxes;
  if (Array.isArray(measured) && measured.length === page.panels.length && measured.every(validBox)) return measured;
  return estimatePanelBoxes(page, { readingDirection: doc.format.readingDirection, kind: doc.format.kind });
};

/**
 * Like panelBoxesFor, but the fallback is the layout as drawn (drawnLayoutBoxes): the vision pass's boxes when it
 * really measured them (not `boxesFrom: 'estimate'`) and they match the panel count, else the boxes of
 * effectiveLayout. Used where a fit is judged (the breakdown card's dots on a drawn page, the director's line-edit
 * budget), so a page whose layout text contradicts its panel sizes is measured on the panels the prompt drew. A
 * check that fell back (no usable reading, or another panel count) stored an ESTIMATE as panelBoxes — one made on
 * the stored layout text — so those boxes are not a measurement and never stand in for the layout as drawn. QC
 * written before boxesFrom existed has no marker and is read as measured, as before.
 */
export const drawnPanelBoxes = (doc: Pick<ComicDoc, 'format'>, page: PanelBoxesPage): Box[] => {
  // Ship 2: in panels mode the frames are where the lettering goes, so a fit is judged on them.
  const frames = frameBoxesFor(page);
  if (frames) return frames;
  const qc = page.render?.qc;
  const measured = qc?.panelBoxes;
  if (qc?.boxesFrom !== 'estimate' && Array.isArray(measured) && measured.length === page.panels.length && measured.every(validBox)) return measured;
  return drawnLayoutBoxes(doc, page);
};

// ── Regions (Mark-up) ────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

/** Point → page-normalized coordinates within an element rect (clamped to the page). */
export const toPagePoint = (clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): Point => ({
  x: clamp01(rect.width > 0 ? (clientX - rect.left) / rect.width : 0),
  y: clamp01(rect.height > 0 ? (clientY - rect.top) / rect.height : 0)
});

/**
 * Normalized region from two drag corners (any direction), clamped to the page and rounded.
 * Null when either side is smaller than MIN_REGION (a click, not a drag).
 */
export const regionFromPoints = (a: Point, b: Point): Box | null => {
  const x1 = clamp01(Math.min(a.x, b.x));
  const y1 = clamp01(Math.min(a.y, b.y));
  const x2 = clamp01(Math.max(a.x, b.x));
  const y2 = clamp01(Math.max(a.y, b.y));
  const w = x2 - x1;
  const h = y2 - y1;
  if (w < MIN_REGION || h < MIN_REGION) return null;
  return { x: round4(x1), y: round4(y1), w: round4(w), h: round4(h) };
};

const overlapArea = (a: Box, b: Box): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

/**
 * The 1-based panel a marked region belongs to: the panel covering most of the region.
 * Undefined when the region doesn't touch any panel (e.g. a gutter-only scribble).
 */
export const panelForRegion = (region: Box, boxes: Box[]): number | undefined => {
  let best = -1;
  let bestArea = 0;
  boxes.forEach((box, i) => {
    const area = overlapArea(region, box);
    if (area > bestArea + 1e-9) {
      best = i;
      bestArea = area;
    }
  });
  return best >= 0 ? best + 1 : undefined;
};

/** 1-based panel under a page-normalized point (undefined in gutters/margins). */
export const panelAtPoint = (point: Point, boxes: Box[]): number | undefined => {
  const i = boxes.findIndex((b) => point.x >= b.x && point.x <= b.x + b.w && point.y >= b.y && point.y <= b.y + b.h);
  return i >= 0 ? i + 1 : undefined;
};
