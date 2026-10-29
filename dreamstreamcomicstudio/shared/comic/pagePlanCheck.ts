// The free page-plan check (plan §4.1): before anything is drawn, does every panel's dialogue fit its panel?
// count → boxes → minimum area → fit of every panel → shot sense, plus the book rules (one splash per 4 pages,
// never two in a row; an establishing panel in a full-width row opens each scene).
//
// When a page is overfull, `chooseLayout` tries every same-count, same-order blueprint (rows of 1–3 panels, a
// large single row, tall-beside-stack variants; extra-tall panels for webtoon segments) and returns the one that
// fits while changing the writer's design the least (it avoids shrinking wide, tall or establishing panels).
// Nothing here moves a line between panels or edits text: re-choosing the blueprint is the only automatic fix.
//
// Pure and shared: the writer's validator, the render gate (planCheckGate), the breakdown card, the editor and
// the director all read the same verdict. Costs $0 (CPU only, milliseconds per page).

import type { Box, ComicDoc, Page, PanelSize } from './doc.js';
import { balloonCount, boxArea, fitState, hardFitLimit, needMeter, panelFit, wordBudget, type FitState, type NeedMeter } from './density.js';
import { letteringAspect, type Measure } from './lettering/layout.js';
import { estimatePanelBoxes, layoutPanelCount, parseLayout } from './pageGeometry.js';
import { minAreaFor, PANEL_LIMITS, PLAN_POLICY, QUIET_SHOTS, panelCountProblem, panelWords } from './panelRules.js';

export interface PanelFitCheck {
  /** 1-based reading order. */
  n: number;
  panelId: string;
  box: Box;
  /** Page fraction. */
  area: number;
  /** Page area the panel's lettering needs (density.ts). */
  need: number;
  /** need ÷ area. */
  fit: number;
  state: FitState;
  /** Words in balloons and captions (sound effects excluded). */
  words: number;
  balloons: number;
  /** Words this panel holds at the target fit with its balloon count. */
  budget: number;
  /** The smallest area this panel should have (0.15, or 0.08 for a silent insert or close-up). */
  minArea: number;
}

export type PlanIssueKind = 'count' | 'overfull' | 'quiet_shot' | 'min_area' | 'establishing' | 'splash';

export interface PlanIssue {
  kind: PlanIssueKind;
  /** 'repair' problems go back to the writer (one repair round); 'note' is shown, never sent. */
  severity: 'repair' | 'note';
  /** 1-based panel the issue is about, when it is about one. */
  panel?: number;
  /** One plain sentence, precise enough to act on. */
  text: string;
}

/** A free re-choice of the page blueprint. */
export interface LayoutChoice {
  /** The blueprint sentence (parseLayout vocabulary). */
  layout: string;
  /** Worst panel fit under it. */
  worst: number;
  /** Fit of every panel under it (reading order). */
  fits: number[];
  /** Wide, large, tall, splash or establishing panels it shrinks (off their full-width row, or below half their area). */
  shrunk: number;
  /** Panels it leaves below their minimum area. */
  small: number;
}

export interface PagePlanCheck {
  pageId: string;
  n: number;
  /** The worst panel's state ('roomy' for a silent page). */
  state: FitState;
  /** Worst panel fit and its panel (1-based). */
  worst: number;
  worstPanel?: number;
  /** The overfull line used (0.25 for children's books, else 0.30). */
  hard: number;
  panels: PanelFitCheck[];
  issues: PlanIssue[];
  /** Overfull pages only: the blueprint that fits, when one exists. */
  layoutFix?: LayoutChoice;
}

export interface PlanCheckOptions {
  /** Panel boxes to check (default: the blueprint's estimated boxes — the plan as it will be drawn). */
  boxes?: Box[];
  /** Text measure (default `estimateMeasure`). */
  measure?: Measure;
  /** Reuse a need meter across pages (one per doc). */
  meter?: NeedMeter;
  /** Look for a layout that fits when the page is overfull (default true). */
  fixLayout?: boolean;
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const pct = (area: number) => `${Math.max(1, Math.round(area * 100))}% of the page`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const BIG_SIZES: ReadonlySet<PanelSize> = new Set<PanelSize>(['wide', 'large', 'tall', 'splash']);
/** A box at least this wide spans the page (the content width is 0.96). */
const FULL_WIDTH = 0.9;

/** The boxes a page will be drawn at: its blueprint (never a drawn take's measured boxes). */
export function planBoxes(doc: Pick<ComicDoc, 'format'>, page: Pick<Page, 'panels' | 'layout'>): Box[] {
  return estimatePanelBoxes(page, { readingDirection: doc.format.readingDirection, kind: doc.format.kind });
}

const meterFor = (doc: ComicDoc, page: Pick<Page, 'render'> | null, opts: PlanCheckOptions): NeedMeter =>
  opts.meter ?? needMeter(doc, { aspect: letteringAspect(doc, page), measure: opts.measure });

const sizeWord = (area: number): string => (area < 0.11 ? 'small' : area < 0.2 ? 'medium' : 'large');

/** Check one page's plan. Pure; $0. */
export function checkPagePlan(doc: ComicDoc, page: Page, opts: PlanCheckOptions = {}): PagePlanCheck {
  const meter = meterFor(doc, page, opts);
  const hard = hardFitLimit(doc);
  const boxes = opts.boxes && opts.boxes.length === page.panels.length ? opts.boxes : planBoxes(doc, page);
  const panels: PanelFitCheck[] = page.panels.map((panel, i) => {
    const box = boxes[i] ?? { x: 0, y: 0, w: 1, h: 1 };
    const area = boxArea(box);
    const need = meter.panel(panel.lines, box);
    const fit = panelFit(need, area);
    const balloons = balloonCount(panel);
    return {
      n: i + 1,
      panelId: panel.id,
      box,
      area,
      need,
      fit,
      state: fitState(fit, hard),
      words: panelWords(panel),
      balloons,
      budget: wordBudget(area, Math.max(1, balloons)),
      minArea: minAreaFor(panel)
    };
  });
  let worst = 0;
  let worstPanel: number | undefined;
  for (const p of panels) {
    if (p.fit > worst) {
      worst = p.fit;
      worstPanel = p.n;
    }
  }
  const check: PagePlanCheck = { pageId: page.id, n: page.n, state: fitState(worst, hard), worst: r4(worst), hard, panels, issues: [] };
  if (worstPanel !== undefined) check.worstPanel = worstPanel;
  const label = `Page ${page.n}`;

  const count = panelCountProblem(doc.format, page.panels);
  if (count) {
    const rule = count.rule;
    const text =
      rule.exact !== undefined
        ? `${label} has ${page.panels.length} panels; plan exactly ${rule.exact}${rule.clampedFrom !== undefined ? ` (storybook pages hold at most ${PANEL_LIMITS.storybookMax})` : ''}.`
        : rule.fast
          ? `${label} has ${page.panels.length} panels; plan ${rule.min}–${rule.max} big panels (usually ${rule.typical}). ${rule.fast.panels} only for a fast, nearly silent sequence of ${rule.fast.maxWords} words or fewer on the page — combine moments or move one to another page.`
          : `${label} has ${page.panels.length} panels; plan ${rule.min}–${rule.max} (usually ${rule.typical}) — combine moments or move one to another page.`;
    check.issues.push({ kind: 'count', severity: 'repair', text });
  }

  if (check.state === 'overfull') {
    const fix = opts.fixLayout === false ? null : chooseLayout(doc, page, { meter });
    if (fix) check.layoutFix = fix;
    const p = panels[(worstPanel ?? 1) - 1];
    const silent = panels.filter((q) => q.n !== p.n && q.balloons === 0).map((q) => q.n);
    const holds = `it holds about ${p.budget} in ${plural(Math.max(1, p.balloons), 'balloon')}`;
    const move = silent.length ? `move part of it to silent panel ${silent[0]}` : 'move part of it to a bigger panel';
    check.issues.push({
      kind: 'overfull',
      severity: fix ? 'note' : 'repair',
      panel: p.n,
      text: fix
        ? `${label}, panel ${p.n}: ${plural(p.words, 'word')} in a ${sizeWord(p.area)} panel (${pct(p.area)}; ${holds}). This layout fits it: ${fix.layout}`
        : `${label}, panel ${p.n}: ${plural(p.words, 'word')} in a ${sizeWord(p.area)} panel (${pct(p.area)}; ${holds}) — give it a full-width row, ${move}, or trim it.`
    });
  }

  page.panels.forEach((panel, i) => {
    if (!QUIET_SHOTS.has(panel.shot)) return;
    const lines = balloonCount(panel);
    const words = panelWords(panel);
    if (lines <= PANEL_LIMITS.quietShotMaxLines && words <= PANEL_LIMITS.quietShotMaxWords) return;
    const shot = panel.shot === 'pov' ? 'a point-of-view' : 'an insert';
    check.issues.push({
      kind: 'quiet_shot',
      severity: 'repair',
      panel: i + 1,
      text: `${label}, panel ${i + 1} is ${shot} shot with ${plural(lines, 'line')} (${plural(words, 'word')}); a pov or insert panel carries at most ${PANEL_LIMITS.quietShotMaxLines} line of ${PANEL_LIMITS.quietShotMaxWords} words or fewer — move the conversation to a panel that shows the speakers.`
    });
  });

  for (const p of panels) {
    if (p.area + 1e-4 >= p.minArea) continue;
    check.issues.push({
      kind: 'min_area',
      severity: 'note',
      panel: p.n,
      text: `${label}, panel ${p.n} is ${pct(p.area)}; ${p.minArea === PANEL_LIMITS.minArea ? `a panel with people or words needs at least ${pct(PANEL_LIMITS.minArea)}` : `even a silent insert needs ${pct(p.minArea)}`}.`
    });
  }
  return check;
}

// ── chooseLayout ─────────────────────────────────────────────────────────────

type Block =
  | { kind: 'row'; panels: 1 | 2 | 3; large?: boolean }
  | { kind: 'span'; stacked: 1 | 2; tallFirst: boolean };

const blockPanels = (b: Block) => (b.kind === 'row' ? b.panels : 1 + b.stacked);
const blockUnits = (b: Block) => (b.kind === 'row' ? 1 : 2);
const BLOCKS: Block[] = [
  { kind: 'row', panels: 1 },
  { kind: 'row', panels: 1, large: true },
  { kind: 'row', panels: 2 },
  { kind: 'row', panels: 3 },
  { kind: 'span', stacked: 1, tallFirst: true },
  { kind: 'span', stacked: 1, tallFirst: false },
  { kind: 'span', stacked: 2, tallFirst: true },
  { kind: 'span', stacked: 2, tallFirst: false }
];
/** Most row heights a re-chosen page uses (fewer, larger panels: three rows at most). */
const MAX_UNITS = 3;

const ROW_TEXT = ['', 'one wide panel', 'two equal panels', 'three small panels'];

const blockText = (b: Block, row: number, rtl: boolean): string => {
  if (b.kind === 'row') return `Row ${row}: ${b.panels === 1 && b.large ? 'one large panel' : ROW_TEXT[b.panels]}.`;
  const start = rtl ? 'right' : 'left';
  const end = rtl ? 'left' : 'right';
  const tallSide = b.tallFirst ? start : end;
  const stackSide = b.tallFirst ? end : start;
  const stack = b.stacked === 1 ? `one panel on the ${stackSide}` : `two stacked panels on the ${stackSide}`;
  return `Rows ${row}–${row + 1}: one tall panel on the ${tallSide} beside ${stack}.`;
};

/** Every row blueprint for n panels in reading order (2–3 row heights). */
const rowBlueprints = (n: number, rtl: boolean): string[] => {
  const out: string[] = [];
  const walk = (left: number, units: number, acc: Block[]) => {
    if (left === 0) {
      if (units >= 2) {
        let row = 1;
        out.push(
          acc
            .map((b) => {
              const t = blockText(b, row, rtl);
              row += blockUnits(b);
              return t;
            })
            .join(' ')
        );
      }
      return;
    }
    for (const b of BLOCKS) {
      if (blockPanels(b) > left || units + blockUnits(b) > MAX_UNITS) continue;
      walk(left - blockPanels(b), units + blockUnits(b), [...acc, b]);
    }
  };
  walk(n, 0, []);
  return out;
};

/** Webtoon segments: one or two panels made extra tall. */
const stackBlueprints = (n: number): string[] => {
  const base = `Stacked vertically: ${n} full-width panel${n === 1 ? '' : 's'} (${n === 1 ? 'panel 1' : `panels 1–${n}`}), top to bottom.`;
  const out: string[] = [];
  for (let a = 1; a <= n; a += 1) {
    out.push(`${base} Panel ${a} is extra tall.`);
    for (let b = a + 1; b <= n; b += 1) out.push(`${base} Panels ${a}, ${b} are extra tall.`);
  }
  return out;
};

/** Candidate blueprints for a page (same panel count, same reading order). Empty when the format allows none. */
export function candidateLayouts(doc: Pick<ComicDoc, 'format'>, panelCount: number): string[] {
  const n = panelCount;
  if (n < 1 || doc.format.kind === 'strip') return [];
  if (doc.format.kind === 'webtoon') return stackBlueprints(n);
  if (n < 2) return [];
  return rowBlueprints(n, doc.format.readingDirection === 'rtl');
}

/**
 * The blueprint that makes an overfull page fit, or null when none does. Ranking: fits (≤ 0.22) before tight;
 * then fewest wide/tall/establishing panels shrunk; then fewest panels below their minimum area; then the lowest
 * worst fit; then the smallest change from the writer's boxes. Never returns an overfull layout.
 */
export function chooseLayout(doc: ComicDoc, page: Page, opts: { meter?: NeedMeter; measure?: Measure } = {}): LayoutChoice | null {
  const n = page.panels.length;
  const candidates = candidateLayouts(doc, n);
  if (!candidates.length) return null;
  const meter = opts.meter ?? needMeter(doc, { aspect: letteringAspect(doc, page), measure: opts.measure });
  const hard = hardFitLimit(doc);
  const orig = planBoxes(doc, page);
  const origAreas = orig.map(boxArea);
  const big = page.panels.map((p) => BIG_SIZES.has(p.size) || p.shot === 'establishing');
  // A big panel is "shrunk" when it loses its full-width row, or more than half its area.
  const fullWidth = (b: Box | undefined) => !!b && b.w >= FULL_WIDTH;
  const shrinks = (b: Box, a: number, i: number) => big[i] && ((fullWidth(orig[i]) && !fullWidth(b)) || a < origAreas[i] * 0.5);
  const mins = page.panels.map((p) => minAreaFor(p));
  const sameBoxes = (boxes: Box[]) => boxes.every((b, i) => orig[i] && Math.abs(b.x - orig[i].x) < 1e-4 && Math.abs(b.y - orig[i].y) < 1e-4 && Math.abs(b.w - orig[i].w) < 1e-4 && Math.abs(b.h - orig[i].h) < 1e-4);
  type Scored = LayoutChoice & { cls: number; distance: number; order: number };
  let best: Scored | null = null;
  for (const [order, layout] of candidates.entries()) {
    const parsed = parseLayout(layout);
    if (!parsed || layoutPanelCount(parsed) !== n) continue;
    if (doc.format.kind === 'webtoon' ? parsed.mode !== 'stack' : parsed.mode === 'stack') continue;
    const boxes = estimatePanelBoxes({ panels: page.panels, layout }, { readingDirection: doc.format.readingDirection, kind: doc.format.kind });
    if (boxes.length !== n || sameBoxes(boxes)) continue;
    const areas = boxes.map(boxArea);
    const fits = page.panels.map((p, i) => panelFit(meter.panel(p.lines, boxes[i]), areas[i]));
    const worst = r4(Math.max(0, ...fits));
    if (worst > hard) continue;
    const cand: Scored = {
      layout,
      worst,
      fits,
      shrunk: boxes.filter((b, i) => shrinks(b, areas[i], i)).length,
      small: areas.filter((a, i) => a + 1e-4 < mins[i]).length,
      cls: worst <= PANEL_LIMITS.fitTarget ? 0 : 1,
      distance: r4(areas.reduce((s, a, i) => s + Math.abs(a - (origAreas[i] ?? 0)), 0)),
      order
    };
    if (!best || better(cand, best)) best = cand;
  }
  if (!best) return null;
  const { layout, worst, fits, shrunk, small } = best;
  return { layout, worst, fits, shrunk, small };
}

const better = (
  a: { cls: number; shrunk: number; small: number; worst: number; distance: number; order: number },
  b: { cls: number; shrunk: number; small: number; worst: number; distance: number; order: number }
): boolean => {
  if (a.cls !== b.cls) return a.cls < b.cls;
  if (a.shrunk !== b.shrunk) return a.shrunk < b.shrunk;
  if (a.small !== b.small) return a.small < b.small;
  if (a.worst !== b.worst) return a.worst < b.worst;
  if (a.distance !== b.distance) return a.distance < b.distance;
  return a.order < b.order;
};

// ── The book ─────────────────────────────────────────────────────────────────

const isSplashPage = (page: Pick<Page, 'panels' | 'layout'>): boolean =>
  page.panels.length === 1 || page.panels.some((p) => p.size === 'splash');

/** Check every page plus the book rules (splash spacing; establishing panels opening scenes). */
export function checkBookPlan(doc: ComicDoc, opts: { pages?: Page[]; measure?: Measure; fixLayout?: boolean } = {}): PagePlanCheck[] {
  const pages = [...(opts.pages ?? doc.pages)].sort((a, b) => a.n - b.n);
  const meter = needMeter(doc, { aspect: letteringAspect(doc, null), measure: opts.measure });
  const checks = pages.map((p) => checkPagePlan(doc, p, { meter, fixLayout: opts.fixLayout }));

  // At most one splash per `splashEvery` pages, never two in a row (comics and manga; storybooks are big-panel books).
  if (doc.format.kind === 'comic' || doc.format.kind === 'manga') {
    let last: Page | undefined;
    pages.forEach((page, i) => {
      if (!isSplashPage(page)) return;
      if (last && page.n - last.n < PANEL_LIMITS.splashEvery) {
        checks[i].issues.push({
          kind: 'splash',
          severity: 'repair',
          text: `Page ${page.n} is a splash only ${plural(page.n - last.n, 'page')} after the splash on page ${last.n}: use at most one splash per ${PANEL_LIMITS.splashEvery} pages, never two in a row.`
        });
      }
      last = page;
    });
  }

  // An establishing panel in a full-width row opens each scene (a new place).
  let place: string | undefined;
  pages.forEach((page, i) => {
    page.panels.forEach((panel, k) => {
      const opens = !!panel.placeId && panel.placeId !== place;
      if (panel.placeId) place = panel.placeId;
      if (!opens) return;
      const box = checks[i].panels[k]?.box;
      const wideShot = panel.shot === 'establishing' || panel.shot === 'wide';
      if (!!box && box.w >= FULL_WIDTH && wideShot) return;
      checks[i].issues.push({
        kind: 'establishing',
        severity: 'note',
        panel: k + 1,
        text: `Page ${page.n}, panel ${k + 1} opens a new place: make it an establishing or wide shot in a full-width row.`
      });
    });
  });
  return checks;
}

// ── Hold-back (render gate core, shared with the quote) ──────────────────────

export interface HeldBackPage {
  pageId: string;
  n: number;
  /** Worst panel fit and its panel. */
  worst: number;
  panel?: number;
  /** "Page 2 is held back: …" with the free fixes. */
  text: string;
  /** The blueprint that fits, when one exists (the first free fix). */
  layoutFix?: string;
}

/**
 * Split the pages about to be drawn into the ones to draw and the overfull ones held back (decision PD-1: held
 * back from "Render all" with free fixes and "Draw anyway"; never refused). `drawOverfull` lists pages the
 * user chose to draw anyway. Unknown ids pass through untouched. Order is kept.
 */
export function splitHeldBack(doc: ComicDoc, pageIds: string[], drawOverfull: readonly string[] = []): { draw: string[]; heldBack: HeldBackPage[] } {
  const ids = Array.isArray(pageIds) ? pageIds.filter((id): id is string => typeof id === 'string') : [];
  if (!PLAN_POLICY.holdBackOverfull) return { draw: [...ids], heldBack: [] };
  const anyway = new Set(Array.isArray(drawOverfull) ? drawOverfull : []);
  const byId = new Map(doc.pages.map((p) => [p.id, p]));
  const meter = needMeter(doc, { aspect: letteringAspect(doc, null) });
  const draw: string[] = [];
  const heldBack: HeldBackPage[] = [];
  for (const id of ids) {
    const page = byId.get(id);
    if (!page || anyway.has(id) || !page.panels.length) {
      draw.push(id);
      continue;
    }
    const check = checkPagePlan(doc, page, { meter });
    if (check.state !== 'overfull') {
      draw.push(id);
      continue;
    }
    heldBack.push(heldBackOf(check));
  }
  return { draw, heldBack };
}

/** The held-back record (and its sentence) for an overfull check. */
export function heldBackOf(check: PagePlanCheck): HeldBackPage {
  const p = check.panels[(check.worstPanel ?? 1) - 1];
  const fixes = [check.layoutFix ? 'use the layout that fits' : '', 'split the page', 'move a line', 'make it a caption'].filter(Boolean).join(', ');
  const text = p
    ? `Page ${check.n} is held back: panel ${p.n} has ${plural(p.words, 'word')} in ${pct(p.area)} (it holds about ${p.budget}). Free fixes: ${fixes} — or draw it anyway.`
    : `Page ${check.n} is held back: too much text for its panels. Free fixes: ${fixes} — or draw it anyway.`;
  return {
    pageId: check.pageId,
    n: check.n,
    worst: check.worst,
    ...(check.worstPanel !== undefined ? { panel: check.worstPanel } : {}),
    text,
    ...(check.layoutFix ? { layoutFix: check.layoutFix.layout } : {})
  };
}

/** "That makes panel 6 about 34 words; it holds about 32." — the director's line-edit report (K1). */
export function panelBudgetSentence(doc: ComicDoc, page: Page, panelIndex: number): string | undefined {
  const check = checkPagePlan(doc, page, { fixLayout: false });
  const p = check.panels[panelIndex];
  if (!p) return undefined;
  const base = `That makes panel ${p.n} about ${plural(p.words, 'word')}; it holds about ${p.budget}.`;
  return p.state === 'overfull' ? `${base} That's too much text for this panel.` : base;
}

export type { FitState } from './density.js';
