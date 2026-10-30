// Word budget by panel area (plan §4.1): the single calibration used by the writer, the page-plan check, the
// breakdown card, the editor and the director. Pure (shared/comic only), so client and server agree.
//
// A line's NEED is the page area its balloon outline takes, measured with the lettering engine's own sizer (the
// same fonts, preset sizeScale, script widths and padding planLettering draws with) at the width the placer
// starts from, filled like its shape (π/4 of the box for elliptical outlines). A panel's FIT is its lines' need
// divided by its area:
//   ≤ 0.18 roomy · ≤ 0.22 fits · ≤ 0.30 tight (amber, allowed) · above it overfull (kids' books: 0.25).
//
// Oracle (challenger balloonfit.ts, classic preset, planLettering outlines): speech ≈ 0.0029 + 0.0014 per word,
// caption ≈ 0.0047 + 0.0011 per word, sfx ≈ 0.004 of the page. The fit table, `wordBudget` (11 words at 0.084 of
// the page, 20 at 0.144, 32 at 0.221, capped at 40) and the b4b5774f p2 numbers (0.55 → 0.22) are all in these
// outline units, so the sizer is used as is (NEED_SCALE 1): its bounds are already the drawn outline (measured
// equal to planLettering's geometry), and the tail and stroke the outline leaves out are about 15% more in
// pixels — a further ×1.15 here would tighten every threshold by that much (see NEED_SCALE).

import { emptyRender, type Box, type ComicDoc, type Line, type Page, type Panel } from './doc.js';
import { estimateMeasure, letteringAspect, letteringSizer, type Measure } from './lettering/layout.js';
import { resolveLetterStyle, type BubbleShape } from './lettering/style.js';
import { PANEL_LIMITS } from './panelRules.js';
// The word budget (the speech oracle) lives in panelRules.ts so the lettering engine can import it without a
// cycle through this file; re-exported here unchanged.
export { BALLOON_BASE, WORD_COST, wordBudget } from './panelRules.js';
import { isKidsAudience } from './safety.js';
import { estimateWidthForText, normalizeLetteringText } from './textLayout.js';

/**
 * Multiplier from outline area to need. 1: the fit table is calibrated in outline units (planLettering geometry).
 * Pixels on screen run about 1.15× the outline (stroke and tail); set 1.15 here only together with a 15% looser
 * fit table, or every page reads 15% fuller than the thresholds were measured for.
 */
export const NEED_SCALE = 1;
/** The placer's inset inside a panel (lettering/place.ts PAD): the widest a balloon starts is the panel minus this twice. */
const PLACE_PAD = 0.012;
/** Elliptical outlines fill π/4 of their box; boxy ones fill all of it. */
const BOXY: ReadonlySet<BubbleShape> = new Set<BubbleShape>(['rect', 'rounded_rect', 'notched', 'scroll', 'ribbon', 'electronic', 'none']);

export type FitState = 'roomy' | 'fits' | 'tight' | 'overfull';

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const EMPTY_PAGE: Page = { id: '', n: 0, summary: '', layout: '', panels: [], render: emptyRender(), balloons: [] };

export interface NeedOptions {
  /** Page width ÷ height (default: the doc's page aspect). */
  aspect?: number;
  /** The panel the line sits in: its width caps the balloon's starting width, as the placer does. */
  box?: Pick<Box, 'w'>;
  /** Text measure (default `estimateMeasure`, deterministic on client and server). */
  measure?: Measure;
}

/** A reusable need calculator for one doc (one engine sizer, memoized per line and width). */
export interface NeedMeter {
  line(line: Line, box?: Pick<Box, 'w'>): number;
  panel(lines: Line[], box?: Pick<Box, 'w'>): number;
}

/** Build a need calculator for a doc (use one per page check: it caches the engine's measurements). */
export function needMeter(doc: ComicDoc, opts: Omit<NeedOptions, 'box'> = {}): NeedMeter {
  const aspect = Number.isFinite(opts.aspect) && (opts.aspect as number) > 0 ? (opts.aspect as number) : letteringAspect(doc, null);
  const sizer = letteringSizer(doc, EMPTY_PAGE, aspect, opts.measure ?? estimateMeasure);
  // Per line object: its starting width estimate and its need at each width (the placer's widths are few).
  const cache = new Map<Line, { text: string; kind: Line['kind']; est: number; fill: number; byWidth: Map<number, number> }>();
  const line = (l: Line, box?: Pick<Box, 'w'>): number => {
    if (!l || !normalizeLetteringText(l.text)) return 0;
    let entry = cache.get(l);
    if (!entry || entry.text !== l.text || entry.kind !== l.kind) {
      const lang = l.lang || doc.format?.language || 'en';
      const shape = resolveLetterStyle(doc, l).shape;
      entry = { text: l.text, kind: l.kind, est: estimateWidthForText(l.text, lang), fill: BOXY.has(shape) ? 1 : Math.PI / 4, byWidth: new Map() };
      cache.set(l, entry);
    }
    const w = box && Number.isFinite(box.w) && box.w > 0 ? Math.min(entry.est, Math.max(0.08, box.w - 2 * PLACE_PAD)) : entry.est;
    const hit = entry.byWidth.get(w);
    if (hit !== undefined) return hit;
    const size = sizer(l, w);
    const need = r4(NEED_SCALE * entry.fill * size.bounds.w * size.bounds.h);
    entry.byWidth.set(w, need);
    return need;
  };
  return { line, panel: (lines, box) => r4((lines || []).reduce((sum, l) => sum + line(l, box), 0)) };
}

/** Page area (fraction) one line's balloon needs: its outline area (planLettering geometry; stroke and tail excluded, see NEED_SCALE). 0 for an empty line. */
export function lineNeed(line: Line, doc: ComicDoc, opts: NeedOptions = {}): number {
  return needMeter(doc, opts).line(line, opts.box);
}

/** Page area (fraction) a panel's lines need together. */
export function panelNeed(lines: Line[], doc: ComicDoc, opts: NeedOptions = {}): number {
  return needMeter(doc, opts).panel(lines, opts.box);
}

/** need ÷ area: how much of the panel the lettering covers (0 for a silent panel). */
export function panelFit(need: number, area: number): number {
  if (!(need > 0)) return 0;
  if (!(area > 0)) return Number.POSITIVE_INFINITY;
  return r4(need / area);
}

/** The overfull line for this doc: 0.25 for children's books, else 0.30. */
export function hardFitLimit(doc: Pick<ComicDoc, 'format' | 'brief'>): number {
  return isKidsAudience(doc) ? PANEL_LIMITS.fitHardKids : PANEL_LIMITS.fitHard;
}

/** roomy / fits / tight / overfull for a fit value. */
export function fitState(fit: number, hard: number = PANEL_LIMITS.fitHard): FitState {
  if (fit <= PANEL_LIMITS.fitRoomy) return 'roomy';
  if (fit <= PANEL_LIMITS.fitTarget) return 'fits';
  if (fit <= hard) return 'tight';
  return 'overfull';
}

/** Lettered balloons in a panel (every non-empty line is one balloon or caption box). */
export const balloonCount = (panel: Pick<Panel, 'lines'>): number => (panel.lines || []).filter((l) => normalizeLetteringText(l.text)).length;

/** Box area as a page fraction. */
export const boxArea = (box: Pick<Box, 'w' | 'h'> | undefined): number => (box && box.w > 0 && box.h > 0 ? r4(box.w * box.h) : 0);
