// Page layout templates (Ship 2, B9; pro plan §4.5, design §4.4): twelve curated layouts led by two to four large
// panels (D-OWN-2), each with frames and a layout sentence parseLayout reads, so the writer, the image prompt and the
// editor describe the same page. The picker shows fit dots for this page's own words (density.ts, read-only reuse)
// and marks the best fit. Webtoon pages get stacked variants. Pure.

import { artModeOf, frameStyleOf, type Box, type ComicDoc, type Page, type PanelFrame, type PanelSize } from '../doc.js';
import { fitState, hardFitLimit, needMeter, panelFit, type FitState, type NeedMeter } from '../density.js';
import { EDITOR_LIMITS } from '../limits.js';
import { applyOp, type DocOp } from '../ops.js';
import { PANEL_LIMITS } from '../panelRules.js';
import { upscaleOf } from '../panelize/space.js';
import { framesFromLayoutText, layoutTextOf } from './layoutText.js';
import { cap1, editOf, isUndrawn, lockedReason, NOTHING_TO_CHANGE, panelWord, refuse, roundBox, sameBox, type EditResult } from './scene.js';

export type TemplateId =
  | 'splash'
  | 'two-tiers'
  | 'hero-inset'
  | 'big-top-two'
  | 'two-big-bottom'
  | 'tall-left-two'
  | 'tall-right-two'
  | 'three-tiers'
  | 'four-grid'
  | 'wide-tall-left-two'
  | 'wide-two-wide'
  | 'fast-five'
  | 'stack-2'
  | 'stack-3'
  | 'stack-4';

export interface PageTemplate {
  id: TemplateId;
  /** Plain-words name shown in the picker. */
  name: string;
  panels: number;
  /** The layout sentence for left-to-right books (parseLayout's vocabulary; layoutTextOf of the frames). */
  sentence: string;
  /** Panel sizes that agree with the sentence (so the prompt keeps it as the page's layout). */
  sizes: PanelSize[];
  /** A one-line caution shown with the template (amber in the picker). */
  note?: string;
  /** Webtoon-only stacked variant. */
  webtoon?: true;
}

/** The template for a new scene (design §4.4), one constant so the default is a one-line change. */
export const DEFAULT_TEMPLATE_ID: TemplateId = 'big-top-two';

const W = 'Row 1: one wide panel across the full width (panel 1).';
/** The twelve curated templates, then the webtoon stacks. */
export const PAGE_TEMPLATES: readonly PageTemplate[] = [
  { id: 'splash', name: 'Splash', panels: 1, sentence: 'One full-page splash panel (panel 1).', sizes: ['splash'], note: 'Use a splash at most once every 4 pages.' },
  {
    id: 'two-tiers',
    name: 'Two tiers',
    panels: 2,
    sentence: `${W} Row 2: one wide panel across the full width (panel 2).`,
    sizes: ['wide', 'wide']
  },
  {
    id: 'hero-inset',
    name: 'Hero + inset',
    panels: 2,
    sentence: 'Row 1: one dominant splash panel across the full page (panel 1) with a small inset panel in its lower right corner (panel 2).',
    sizes: ['medium', 'small'],
    note: 'The inset is for a silent reaction.'
  },
  {
    id: 'big-top-two',
    name: 'Big top + two',
    panels: 3,
    sentence: `${W} Row 2: two equal panels side by side (panels 2–3).`,
    sizes: ['wide', 'medium', 'medium']
  },
  {
    id: 'two-big-bottom',
    name: 'Two + big bottom',
    panels: 3,
    sentence: 'Row 1: two equal panels side by side (panels 1–2). Row 2: one wide panel across the full width (panel 3).',
    sizes: ['medium', 'medium', 'wide']
  },
  {
    id: 'tall-left-two',
    name: 'Tall left + two',
    panels: 3,
    sentence: 'Rows 1–2: one tall panel on the left (panel 1) beside two stacked panels on the right (panels 2–3).',
    sizes: ['tall', 'medium', 'medium']
  },
  {
    id: 'tall-right-two',
    name: 'Tall right + two',
    panels: 3,
    sentence: 'Rows 1–2: one tall panel on the right (panel 2) beside two stacked panels on the left (panels 1 and 3).',
    sizes: ['medium', 'tall', 'medium']
  },
  {
    id: 'three-tiers',
    name: 'Three tiers',
    panels: 3,
    sentence: `${W} Row 2: one wide panel across the full width (panel 2). Row 3: one wide panel across the full width (panel 3).`,
    sizes: ['wide', 'wide', 'wide']
  },
  {
    id: 'four-grid',
    name: 'Four grid',
    panels: 4,
    sentence: 'Row 1: two equal panels side by side (panels 1–2). Row 2: two equal panels side by side (panels 3–4).',
    sizes: ['medium', 'medium', 'medium', 'medium']
  },
  {
    id: 'wide-tall-left-two',
    name: 'Wide + tall left + two',
    panels: 4,
    sentence: `${W} Rows 2–3: one tall panel on the left (panel 2) beside two stacked panels on the right (panels 3–4).`,
    sizes: ['wide', 'tall', 'medium', 'medium']
  },
  {
    id: 'wide-two-wide',
    name: 'Wide / two / wide',
    panels: 4,
    sentence: `${W} Row 2: two equal panels side by side (panels 2–3). Row 3: one wide panel across the full width (panel 4).`,
    sizes: ['wide', 'medium', 'medium', 'wide'],
    note: 'Two small panels: keep them nearly silent.'
  },
  {
    id: 'fast-five',
    name: 'Fast five',
    panels: 5,
    sentence: `${W} Row 2: two equal panels side by side (panels 2–3). Row 3: two equal panels side by side (panels 4–5).`,
    sizes: ['wide', 'medium', 'medium', 'medium', 'medium'],
    note: 'For fast action with few words.'
  },
  { id: 'stack-2', name: 'Two stacked', panels: 2, sentence: 'Stacked vertically: 2 full-width panels (panels 1–2), top to bottom.', sizes: ['wide', 'wide'], webtoon: true },
  { id: 'stack-3', name: 'Three stacked', panels: 3, sentence: 'Stacked vertically: 3 full-width panels (panels 1–3), top to bottom.', sizes: ['wide', 'wide', 'wide'], webtoon: true },
  { id: 'stack-4', name: 'Four stacked', panels: 4, sentence: 'Stacked vertically: 4 full-width panels (panels 1–4), top to bottom.', sizes: ['wide', 'wide', 'wide', 'wide'], webtoon: true }
];

export const templateById = (id: string): PageTemplate | undefined => PAGE_TEMPLATES.find((t) => t.id === id);

export interface TemplateLayout {
  frames: Box[];
  /** The sentence in the book's reading direction. */
  sentence: string;
  /** z per frame (insets above their host). */
  z: (number | undefined)[];
}

const contains = (o: Box, i: Box) => i.x >= o.x - 1e-6 && i.y >= o.y - 1e-6 && i.x + i.w <= o.x + o.w + 1e-6 && i.y + i.h <= o.y + o.h + 1e-6;

/**
 * A template's frames at a page's margin and gutter (default: the blueprint's 0.02), mirrored for right-to-left books
 * (the reading order mirrors with it), and its sentence in that direction.
 */
export function templateLayout(t: PageTemplate, opts: { rtl?: boolean; margin?: number; gutter?: number } = {}): TemplateLayout {
  const ltr = framesFromLayoutText(t.sentence, t.panels, { margin: opts.margin, gutter: opts.gutter }) ?? [];
  const frames = opts.rtl ? ltr.map((b) => roundBox({ ...b, x: 1 - b.x - b.w })) : ltr;
  const z = frames.map((b, i) => (frames.some((o, k) => k !== i && contains(o, b) && o.w * o.h > b.w * b.h) ? 1 : undefined));
  const sentence = opts.rtl ? layoutTextOf(frames, { rtl: true, kind: t.webtoon ? 'webtoon' : 'comic' }) : t.sentence;
  return { frames, sentence, z };
}

/** The templates offered for a book: the twelve, or the webtoon stacks for webtoon books. */
export const templatesForKind = (kind: string | undefined): PageTemplate[] => PAGE_TEMPLATES.filter((t) => (kind === 'webtoon' ? !!t.webtoon : !t.webtoon));

export interface PanelFitDot {
  area: number;
  fit: number;
  state: FitState;
  /** Below PANEL_LIMITS.minArea (or minInsertArea for a silent panel). */
  small: boolean;
}
export interface TemplateFit {
  panels: PanelFitDot[];
  worst: FitState;
  worstFit: number;
}

const STATE_RANK: Record<FitState, number> = { roomy: 0, fits: 1, tight: 2, overfull: 3 };

/** Fit dots: this page's own lines in each frame of a template (density.ts need ÷ area). Null when the counts differ. */
export function templateFit(doc: ComicDoc, page: Page, t: PageTemplate, meter: NeedMeter = needMeter(doc)): TemplateFit | null {
  if (t.panels !== page.panels.length) return null;
  const { frames } = templateLayout(t, { rtl: doc.format?.readingDirection === 'rtl', margin: frameStyleOf(page).margin, gutter: frameStyleOf(page).gutter });
  const hard = hardFitLimit(doc);
  const panels = page.panels.map((p, i) => {
    const box = frames[i];
    const area = box ? box.w * box.h : 0;
    const fit = panelFit(meter.panel(p.lines, box), area);
    const silent = !p.lines.some((l) => l.text && l.text.trim());
    const small = area < (silent ? PANEL_LIMITS.minInsertArea : PANEL_LIMITS.minArea);
    return { area: Math.round(area * 10000) / 10000, fit, state: fitState(fit, hard), small };
  });
  let worst: FitState = 'roomy';
  let worstFit = 0;
  for (const d of panels) {
    if (STATE_RANK[d.state] > STATE_RANK[worst]) worst = d.state;
    if (d.fit > worstFit) worstFit = d.fit;
  }
  return { panels, worst, worstFit };
}

export interface TemplateChoice {
  template: PageTemplate;
  fit: TemplateFit;
  best: boolean;
}

/**
 * The templates that fit this page's panel count, each with its fit dots; "Best fit" is the one whose fullest panel is
 * emptiest (ties: no too-small panel, then catalogue order, which leads with the default).
 */
export function templatesFor(doc: ComicDoc, page: Page, meter: NeedMeter = needMeter(doc)): TemplateChoice[] {
  const out = templatesForKind(doc.format?.kind)
    .map((template) => ({ template, fit: templateFit(doc, page, template, meter) }))
    .filter((c): c is { template: PageTemplate; fit: TemplateFit } => !!c.fit)
    .map((c) => ({ ...c, best: false }));
  let best: TemplateChoice | undefined;
  const score = (c: TemplateChoice) => [STATE_RANK[c.fit.worst], c.fit.panels.some((p) => p.small) ? 1 : 0, c.fit.worstFit];
  for (const c of out) {
    if (!best) best = c;
    else {
      const a = score(c);
      const b = score(best);
      if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2] - 1e-9)))) best = c;
    }
  }
  if (best) best.best = true;
  return out;
}

/** The best-fitting template for the page's own words, or undefined when none has its panel count. */
export const bestTemplate = (doc: ComicDoc, page: Page, meter?: NeedMeter): PageTemplate | undefined => templatesFor(doc, page, meter).find((c) => c.best)?.template;

const applyAll = (doc: ComicDoc, ops: DocOp[]): ComicDoc => ops.reduce((d, op) => applyOp(d, op), doc);

/**
 * Lay the page out with a template. Not drawn yet: the frames, the layout sentence and the panel sizes (the plan).
 * Drawn and editable (or with cuts to show): the frames only — the art re-fits by cover, the layout sentence is not
 * touched so the page does not go out of date, and a panel enlarged past 1.5× is named as possibly soft.
 */
export function applyTemplateEdit(doc: ComicDoc, page: Page, id: string): EditResult {
  const t = templateById(id);
  if (!t) return refuse('That layout is not available.');
  if (t.panels !== page.panels.length) return refuse(`This layout has ${t.panels} panel${t.panels === 1 ? '' : 's'}; page ${page.n} has ${page.panels.length}.`);
  for (const p of page.panels) {
    const locked = lockedReason(page, { kind: 'frame', id: p.id });
    if (locked) return refuse(locked);
  }
  const undrawn = isUndrawn(page);
  const hasCuts = !!page.render.cuts?.cuts?.length;
  if (!undrawn && artModeOf(page) !== 'panels' && !hasCuts) return refuse(`Page ${page.n} is shown as drawn. Make its panels editable first (free), then pick a layout.`);
  const style = frameStyleOf(page);
  const rtl = doc.format?.readingDirection === 'rtl';
  const layout = templateLayout(t, { rtl, margin: style.margin, gutter: style.gutter });
  const frames: { panelId: string; frame: PanelFrame }[] = [];
  page.panels.forEach((p, i) => {
    const frame: Record<string, unknown> = { ...(p.frame ?? {}), box: layout.frames[i] };
    delete frame.fit; // the art re-fits by cover
    if (layout.z[i] !== undefined) frame.z = layout.z[i];
    else delete frame.z;
    if (!p.frame || !sameBox(p.frame.box, layout.frames[i], 1e-5) || p.frame.fit || p.frame.z !== layout.z[i]) frames.push({ panelId: p.id, frame: frame as unknown as PanelFrame });
  });
  const ops: DocOp[] = [];
  const toPanels = !undrawn && artModeOf(page) !== 'panels';
  if (frames.length || toPanels) ops.push({ op: 'page_frames', pageId: page.id, ...(toPanels ? { artMode: 'panels' as const } : {}), frames });
  if (undrawn) {
    if (page.layout !== layout.sentence) ops.push({ op: 'page', id: page.id, patch: { layout: layout.sentence } });
    page.panels.forEach((p, i) => {
      if (t.sizes[i] && p.size !== t.sizes[i]) ops.push({ op: 'panel', pageId: page.id, id: p.id, patch: { size: t.sizes[i] } });
    });
  }
  if (!ops.length) return refuse(NOTHING_TO_CHANGE);
  const notes: string[] = [];
  if (!undrawn) {
    const after = applyAll(doc, ops);
    const pa = after.pages.find((p) => p.id === page.id)!;
    for (const p of pa.panels) {
      const up = upscaleOf(after, pa, p.id);
      if (up !== undefined && up > EDITOR_LIMITS.upscaleSoft) notes.push(`${cap1(panelWord(pa, p.id))} may look soft at this size (shown ${up}× larger than drawn).`);
    }
    notes.push('The drawing is kept: only where the panels sit changes.');
  }
  if (t.note) notes.push(t.note);
  return editOf(doc, ops, `Use the “${t.name}” layout`, notes);
}
