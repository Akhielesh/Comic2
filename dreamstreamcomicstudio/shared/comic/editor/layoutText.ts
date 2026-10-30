// Frames ↔ the page's layout sentence (Ship 2, B9; pro plan §4.5, design §4.4). Once panels are objects, the layout
// sentence is DERIVED from the frames ("Row 1: one wide panel… Row 2: two equal panels side by side…"), in the exact
// vocabulary `parseLayout` (pageGeometry.ts) reads, so the writer, the image prompt and the editor describe the same
// page. The other way, a sentence becomes frames with the same geometry as `estimatePanelBoxes`, at the page's own
// margin and gutter. Insets ("with a small inset panel in its lower right corner") use pageGeometry's own inset geometry
// (LAYOUT_INSET / layoutInsetBox), so the editor, the board, the wireframes and the lettering place an inset alike. Pure.

import { DEFAULT_FRAME_STYLE, type Box, type ComicKind } from '../doc.js';
import { LAYOUT_INSET, layoutInsetBox, layoutPanelCount, parseLayout, type ParsedLayout } from '../pageGeometry.js';

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const TOL = 0.012;

export interface LayoutGeometry {
  /** Reading direction: rows read right to left, a tall panel "on the right" comes first. */
  rtl?: boolean;
  /** Outer margin and gutter (page fractions); default DEFAULT_FRAME_STYLE (0.02, as the blueprint geometry). */
  margin?: number;
  gutter?: number;
}

/** The inset's size against its host frame, and its distance from the host's corner (beyond one gutter). */
export const INSET = LAYOUT_INSET;

/**
 * Boxes for a parsed blueprint: the same geometry as pageGeometry's estimate (rows by weight, a tall panel 45% of the
 * width beside its stack, webtoon stacks with a double gutter), at any margin and gutter.
 */
export function boxesForLayout(parsed: ParsedLayout, n: number, geo: LayoutGeometry = {}): Box[] {
  const margin = geo.margin ?? DEFAULT_FRAME_STYLE.margin;
  const gut = geo.gutter ?? DEFAULT_FRAME_STYLE.gutter;
  const rtl = !!geo.rtl;
  const boxes: Box[] = new Array(n);
  const contentW = 1 - 2 * margin;
  if (parsed.mode === 'single') {
    boxes[0] = { x: margin, y: margin, w: contentW, h: 1 - 2 * margin };
    return boxes.map((b) => b && roundB(b));
  }
  const rowGutter = parsed.mode === 'stack' ? gut * 2 : gut;
  const totalWeight = parsed.rows.reduce((s, r) => s + r.weight, 0) || 1;
  const usableH = 1 - 2 * margin - rowGutter * (parsed.rows.length - 1);
  let y = margin;
  for (const row of parsed.rows) {
    const h = (usableH * row.weight) / totalWeight;
    if (row.span) {
      const tallW = (contentW - gut) * 0.45;
      const stackW = contentW - gut - tallW;
      const tallLeft = row.span.tallSide === 'left';
      const tallX = tallLeft ? margin : margin + stackW + gut;
      const stackX = tallLeft ? margin + tallW + gut : margin;
      const k = Math.max(1, row.panels.length - 1);
      const cellH = (h - gut * (k - 1)) / k;
      const tall: Box = { x: tallX, y, w: tallW, h };
      const stack: Box[] = Array.from({ length: k }, (_, i) => ({ x: stackX, y: y + i * (cellH + gut), w: stackW, h: cellH }));
      const startSide = rtl ? 'right' : 'left';
      const ordered = row.span.tallSide === startSide ? [tall, ...stack] : [stack[0], tall, ...stack.slice(1)];
      row.panels.forEach((idx, i) => {
        if (idx < n) boxes[idx] = ordered[i];
      });
    } else {
      const k = row.panels.length;
      const w = (contentW - gut * (k - 1)) / k;
      row.panels.forEach((idx, i) => {
        const col = rtl ? k - 1 - i : i;
        if (idx < n) boxes[idx] = { x: margin + col * (w + gut), y, w, h };
      });
    }
    y += h + rowGutter;
  }
  return boxes.map((b) => b && roundB(b));
}
const roundB = (b: Box): Box => ({ x: r4(b.x), y: r4(b.y), w: r4(b.w), h: r4(b.h) });

// ── Insets ───────────────────────────────────────────────────────────────────

const INSET_RE = /,?\s*with an? small inset panel in (?:its|the) (upper|lower) (left|right) corner(?: of panel (\d+))? \(panel (\d+)\)/gi;
interface InsetClause {
  vert: 'upper' | 'lower';
  horiz: 'left' | 'right';
  host?: number;
  n: number;
}

/** The inset box inside a host frame, in one of its corners. */
export const insetBox = (host: Box, vert: 'upper' | 'lower', horiz: 'left' | 'right', gutter = DEFAULT_FRAME_STYLE.gutter): Box =>
  layoutInsetBox(host, vert, horiz, gutter);

/**
 * The frames a layout sentence describes for `n` panels (reading order), at the page's margin and gutter; insets
 * placed in their host's corner. Null when the sentence does not describe exactly `n` panels.
 */
export function framesFromLayoutText(text: string, n: number, geo: LayoutGeometry = {}): Box[] | null {
  if (typeof text !== 'string' || !(n > 0)) return null;
  const insets: InsetClause[] = [];
  const rest = text.replace(INSET_RE, (_m, vert: string, horiz: string, host: string | undefined, k: string) => {
    insets.push({ vert: vert.toLowerCase() as InsetClause['vert'], horiz: horiz.toLowerCase() as InsetClause['horiz'], ...(host ? { host: Number(host) } : {}), n: Number(k) });
    return '';
  });
  const mainN = n - insets.length;
  if (mainN < 1 || insets.some((c) => !(c.n >= 1 && c.n <= n))) return null;
  const parsed = parseLayout(rest);
  if (!parsed || layoutPanelCount(parsed) !== mainN) return null;
  const main = boxesForLayout(parsed, mainN, geo);
  if (main.some((b) => !b)) return null;
  const out: (Box | undefined)[] = new Array(n);
  const insetAt = new Set(insets.map((c) => c.n - 1));
  if (insetAt.size !== insets.length) return null;
  let m = 0;
  for (let i = 0; i < n; i++) if (!insetAt.has(i)) out[i] = main[m++];
  for (const c of [...insets].sort((a, b) => a.n - b.n)) {
    let hostIdx = c.host ? c.host - 1 : -1;
    if (hostIdx < 0) for (let i = c.n - 2; i >= 0 && hostIdx < 0; i--) if (!insetAt.has(i)) hostIdx = i;
    const host = hostIdx >= 0 ? out[hostIdx] : undefined;
    if (!host || insetAt.has(hostIdx)) return null;
    out[c.n - 1] = insetBox(host, c.vert, c.horiz, geo.gutter ?? DEFAULT_FRAME_STYLE.gutter);
  }
  return out as Box[];
}

// ── Frames → sentence ────────────────────────────────────────────────────────

const NUM_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const numWord = (k: number) => NUM_WORDS[k] ?? String(k);

/** "panel 2", "panels 2–3", "panels 1 and 3", "panels 1, 3 and 5". */
export const panelsText = (nums: number[]): string => {
  const s = [...nums].sort((a, b) => a - b);
  if (s.length === 1) return `panel ${s[0]}`;
  if (s.every((v, i) => i === 0 || v === s[i - 1] + 1)) return `panels ${s[0]}–${s[s.length - 1]}`;
  return `panels ${s.slice(0, -1).join(', ')} and ${s[s.length - 1]}`;
};

/** Row weights parseLayout reads from words (pageGeometry rowWeight). */
const WEIGHTS = [0.85, 1, 1.6, 2.2] as const;
type Weight = (typeof WEIGHTS)[number];
const SINGLE_WORD: Record<Weight, string> = { 0.85: 'short', 1: 'wide', 1.6: 'large', 2.2: 'dominant splash' };
const MULTI_WORD: Record<Weight, string> = { 0.85: 'small', 1: 'equal', 1.6: 'large', 2.2: 'dominant' };
const SPAN_WEIGHT = 2;

interface Item {
  box: Box;
  /** 1-based reading number. */
  n: number;
}
interface Band {
  items: Item[];
  y: number;
  h: number;
  kind: 'row' | 'span' | 'other';
  tall?: Item;
  stack?: Item[];
}

const contains = (outer: Box, inner: Box) =>
  inner.x >= outer.x - 1e-6 && inner.y >= outer.y - 1e-6 && inner.x + inner.w <= outer.x + outer.w + 1e-6 && inner.y + inner.h <= outer.y + outer.h + 1e-6;

function bandsOf(items: Item[]): Band[] {
  const sorted = [...items].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const groups: Item[][] = [];
  for (const it of sorted) {
    const g = groups.find((grp) => grp.some((o) => Math.min(o.box.y + o.box.h, it.box.y + it.box.h) - Math.max(o.box.y, it.box.y) > TOL));
    if (g) g.push(it);
    else groups.push([it]);
  }
  return groups.map((g) => {
    const y = Math.min(...g.map((i) => i.box.y));
    const h = Math.max(...g.map((i) => i.box.y + i.box.h)) - y;
    const band: Band = { items: g, y, h, kind: 'other' };
    if (g.every((i) => Math.abs(i.box.y - y) <= TOL && Math.abs(i.box.h - h) <= TOL)) band.kind = 'row';
    else {
      const talls = g.filter((i) => Math.abs(i.box.y - y) <= TOL && Math.abs(i.box.h - h) <= TOL);
      const others = g.filter((i) => !talls.includes(i));
      if (talls.length === 1 && others.length >= 1 && others.length <= 3 && others.every((o) => Math.abs(o.box.x - others[0].box.x) <= TOL && Math.abs(o.box.w - others[0].box.w) <= TOL)) {
        band.kind = 'span';
        band.tall = talls[0];
        band.stack = [...others].sort((a, b) => a.box.y - b.box.y);
      }
    }
    return band;
  });
}

/** Word weights (one per non-span band) whose parseLayout heights come closest to the frames' row heights. */
function bestWeights(bands: Band[]): Weight[] {
  const free = bands.filter((b) => b.kind !== 'span');
  const total = bands.reduce((s, b) => s + b.h, 0) || 1;
  if (free.length > 6) return free.map(() => 1);
  let best: Weight[] = free.map(() => 1);
  let bestErr = Infinity;
  const pick: Weight[] = free.map(() => 1);
  const visit = (i: number) => {
    if (i === free.length) {
      let wsum = 0;
      let k = 0;
      for (const b of bands) wsum += b.kind === 'span' ? SPAN_WEIGHT : pick[k++];
      let err = 0;
      k = 0;
      for (const b of bands) {
        const w = b.kind === 'span' ? SPAN_WEIGHT : pick[k++];
        err += (b.h / total - w / wsum) ** 2;
      }
      // Prefer the plain word (1) on ties: fewer adjectives, the same geometry.
      const plain = pick.filter((w) => w !== 1).length * 1e-9;
      if (err + plain < bestErr) {
        bestErr = err + plain;
        best = pick.slice();
      }
      return;
    }
    for (const w of WEIGHTS) {
      pick[i] = w;
      visit(i + 1);
    }
  };
  visit(0);
  return best;
}

export interface LayoutTextOptions {
  rtl?: boolean;
  kind?: ComicKind;
}

/**
 * The layout sentence for frames given in reading order: what the writer and the image prompt read, in parseLayout's
 * vocabulary, so `framesFromLayoutText(layoutTextOf(frames), n)` gives back the same row structure (equal widths
 * within a row and the blueprint's tall-panel width — the frames themselves stay the display truth).
 */
export function layoutTextOf(frames: readonly Box[], opts: LayoutTextOptions = {}): string {
  const n = frames.length;
  if (!n) return '';
  const rtl = !!opts.rtl;
  const items: Item[] = frames.map((box, i) => ({ box, n: i + 1 }));
  // Insets: a frame inside a larger one.
  const hostOf = new Map<number, Item>();
  for (const it of items) {
    const host = items.find((o) => o !== it && o.box.w * o.box.h > it.box.w * it.box.h && contains(o.box, it.box));
    if (host) hostOf.set(it.n, host);
  }
  const main = items.filter((it) => !hostOf.has(it.n));
  const insetClause = (host: Item, own: boolean): string =>
    items
      .filter((it) => hostOf.get(it.n) === host)
      .map((it) => {
        const vert = it.box.y + it.box.h / 2 >= host.box.y + host.box.h / 2 ? 'lower' : 'upper';
        const horiz = it.box.x + it.box.w / 2 >= host.box.x + host.box.w / 2 ? 'right' : 'left';
        return ` with a small inset panel in ${own ? 'its' : 'the'} ${vert} ${horiz} corner${own ? '' : ` of panel ${host.n}`} (panel ${it.n})`;
      })
      .join(',');
  if (main.length === 1 && !hostOf.size && main[0].box.w >= 0.85 && main[0].box.h >= 0.85) return 'One full-page splash panel (panel 1).';

  const bands = bandsOf(main);
  if (opts.kind === 'webtoon' && !hostOf.size && bands.every((b) => b.kind === 'row' && b.items.length === 1)) {
    const hs = bands.map((b) => b.h).sort((a, b) => a - b);
    const median = hs[Math.floor((hs.length - 1) / 2)];
    const tall = bands.filter((b) => b.h > median * 1.3).map((b) => b.items[0].n);
    const k = bands.length;
    return `Stacked vertically: ${k} full-width panel${k === 1 ? '' : 's'} (${panelsText(bands.map((b) => b.items[0].n))}), top to bottom.${
      tall.length ? ` Panel${tall.length > 1 ? 's' : ''} ${tall.join(', ')} ${tall.length > 1 ? 'are' : 'is'} extra tall.` : ''
    }`;
  }
  const weights = bestWeights(bands);
  const segments: string[] = [];
  let row = 1;
  let wi = 0;
  for (const band of bands) {
    if (band.kind === 'span') {
      const tall = band.tall!;
      const stack = band.stack!;
      const side = tall.box.x < stack[0].box.x ? 'left' : 'right';
      const other = side === 'left' ? 'right' : 'left';
      const k = stack.length;
      const stackText = k === 1 ? `one panel on the ${other}` : `${numWord(k)} stacked panels on the ${other}`;
      segments.push(
        `Rows ${row}–${row + 1}: one tall panel on the ${side} (panel ${tall.n})${insetClause(tall, true)} beside ${stackText} (${panelsText(stack.map((s) => s.n))})${stack.map((s) => insetClause(s, false)).join('')}`
      );
      row += 2;
      continue;
    }
    const w = weights[wi++];
    const cells = [...band.items].sort((a, b) => (rtl ? b.box.x - a.box.x : a.box.x - b.box.x));
    const k = cells.length;
    const hosts = cells.filter((c) => items.some((it) => hostOf.get(it.n) === c));
    if (k === 1 && bands.length === 1 && cells[0].box.h >= 0.85) {
      // One panel filling the page (with an inset, or it would be the splash sentence above).
      segments.push(`Row ${row}: one dominant splash panel across the full page (panel ${cells[0].n})${insetClause(cells[0], true)}`);
    } else if (k === 1) {
      segments.push(`Row ${row}: one ${SINGLE_WORD[w]} panel across the full width (panel ${cells[0].n})${insetClause(cells[0], true)}`);
    } else if (hosts.length) {
      // parseLayout counts "two … panels" as two, whatever follows: name each panel so the inset is counted too.
      const adj = w === 1 ? '' : `${MULTI_WORD[w]} `;
      segments.push(
        `Row ${row}: ${cells.map((c) => `one ${adj}panel (panel ${c.n})`).join(', ')} side by side${rtl ? ', right to left' : ''}${cells.map((c) => insetClause(c, false)).join('')}`
      );
    } else {
      const equal = cells.every((c) => Math.abs(c.box.w - cells[0].box.w) <= TOL);
      const adj = w === 1 ? (equal ? 'equal ' : '') : `${MULTI_WORD[w]} `;
      segments.push(`Row ${row}: ${numWord(k)} ${adj}panels side by side (${panelsText(cells.map((c) => c.n))}${rtl ? ', right to left' : ''})`);
    }
    row += 1;
  }
  return `${segments.join('. ')}.`;
}

/** True when a sentence describes exactly `n` panels for parseLayout (so the prompt keeps it as the page's layout). */
export const layoutTextFits = (text: string, n: number): boolean => {
  const parsed = parseLayout(text);
  return !!parsed && layoutPanelCount(parsed) === n;
};
