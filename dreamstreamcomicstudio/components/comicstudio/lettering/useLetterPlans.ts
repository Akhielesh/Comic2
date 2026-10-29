// Plans for one page, re-planned with real font metrics as faces load (lettering.md §6.2).
//
// `resolvePlacements` replicates planLettering's own placement call for lines without a stored balloon
// (same sizer, same measure, keep: 'all'), so the editor knows the FULL balloon behind every drawn plan
// (x/y/w + the tail tip). The first drag or nudge of a never-placed balloon then sends that whole balloon,
// never a bare {x, y} that the op would complete with a 0.28-wide default (the old "jumping balloon" bug).
// It also reports which placed lines are `crowded` (could not avoid an overlap, or had to be moved /
// lettered smaller by the render-time settle): the editor's chip.

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Balloon, ComicDoc, Page } from '../../../shared/comic/doc';
import { panelBoxesFor } from '../../../shared/comic/pageGeometry';
import { normalizeLetteringText } from '../../../shared/comic/textLayout';
import { letteringAspect, letteringSizer, planLettering, type LetterPlan, type Measure } from '../../../shared/comic/lettering/layout';
import { placeBalloonsDetailed } from '../../../shared/comic/lettering/place';
import { DEFAULT_LETTERING, DEFAULT_SAFE_MARGIN, type FontId } from '../../../shared/comic/lettering/style';
import { ensureFonts, fontLoadGeneration, subscribeFontLoads } from './fontLoader';
import { measureForGeneration, parseFont } from './measure';
import { fontByFamily } from '../../../shared/comic/lettering/fonts';

const validBalloon = (b?: Balloon): b is Balloon =>
  !!b && [b.x, b.y, b.w].every((v) => typeof v === 'number' && Number.isFinite(v)) && b.w > 0;

export interface Placements {
  /** The balloon behind each non-empty line: stored, or placed by software. */
  balloons: Map<string, Balloon>;
  /** Lines drawn at a software-placed position (no stored balloon). */
  fallback: Set<string>;
  /** Placed lines that could not avoid an overlap / the safe area. */
  crowded: Set<string>;
}

/** Stored + software-placed balloons for every lettered line of a page (pure; matches planLettering). */
export function resolvePlacements(doc: ComicDoc, page: Page, aspect: number, measure: Measure): Placements {
  const balloons = new Map<string, Balloon>();
  const fallback = new Set<string>();
  const crowded = new Set<string>();
  if (!page || !Array.isArray(page.panels)) return { balloons, fallback, crowded };
  const stored = new Map<string, Balloon>();
  for (const b of page.balloons || []) if (validBalloon(b) && !stored.has(b.lineId)) stored.set(b.lineId, b);
  const lines = page.panels.flatMap((p) => (p.lines || []).filter((l) => normalizeLetteringText(l.text)));
  for (const l of lines) {
    const b = stored.get(l.id);
    if (b) balloons.set(l.id, b);
  }
  if (lines.some((l) => !stored.has(l.id))) {
    const asp = Number.isFinite(aspect) && aspect > 0 ? aspect : letteringAspect(doc, page);
    const ls = doc.letterStyle ?? DEFAULT_LETTERING;
    const qc = page.render?.qc;
    const result = placeBalloonsDetailed({
      page,
      boxes: panelBoxesFor(doc, page),
      aspect: asp,
      rtl: doc.format?.readingDirection === 'rtl',
      plansFor: letteringSizer(doc, page, asp, measure),
      keepOut: qc?.keepOut,
      heads: qc?.heads,
      safeMargin: typeof ls.safeMargin === 'number' ? ls.safeMargin : DEFAULT_SAFE_MARGIN,
      existing: page.balloons || [],
      keep: 'all',
      lang: doc.format?.language
    });
    for (const b of result.balloons) {
      if (stored.has(b.lineId)) continue;
      balloons.set(b.lineId, b);
      fallback.add(b.lineId);
    }
    for (const id of result.crowded) if (!stored.has(id)) crowded.add(id);
  }
  return { balloons, fallback, crowded };
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * The render-time settle and dense-page repack (planLettering) may draw a software-placed or an unpinned
 * stored balloon somewhere else than the placement put it, tail included. Those lines are `crowded` (the
 * editor's chip and the inspector's free fixes), and the balloon behind each of them is the one the user
 * SEES — so a first drag, nudge, lock or tail aim starts from the drawn spot and never jumps back. Pinned
 * and locked balloons are drawn where they are stored and stay as they are. Pure; mutates and returns `p`.
 */
export function withDrawnGeometry(p: Placements, plans: readonly LetterPlan[], H: number): Placements {
  for (const plan of plans) {
    if (plan.crowded) p.crowded.add(plan.lineId);
    const b = p.balloons.get(plan.lineId);
    if (!b || b.pinned || b.locked || !(plan.crowded || p.fallback.has(plan.lineId)) || !(H > 0)) continue;
    const next: Balloon = { ...b, x: r4(plan.x / 1000), y: r4(plan.y / H) };
    if (plan.tip && Number.isFinite(plan.tip.x) && Number.isFinite(plan.tip.y)) {
      next.tailX = r4(Math.min(1, Math.max(0, plan.tip.x / 1000)));
      next.tailY = r4(Math.min(1, Math.max(0, plan.tip.y / H)));
    }
    p.balloons.set(plan.lineId, next);
  }
  return p;
}

/** Faces (id + weight + italic) the plans draw with — what to load before measuring for real. */
export function facesOfPlans(plans: readonly LetterPlan[]): { id: FontId; weights: number[]; italic: boolean; sample: string }[] {
  const by = new Map<FontId, { id: FontId; weights: Set<number>; italic: boolean; sample: string }>();
  for (const p of plans) {
    const parsed = parseFont(p.font);
    const meta = parsed ? fontByFamily(parsed.family) : undefined;
    const id = meta?.id ?? p.fontId;
    const entry = by.get(id) ?? { id, weights: new Set<number>(), italic: false, sample: '' };
    entry.weights.add(parsed?.weight ?? 400);
    entry.italic = entry.italic || !!parsed?.italic;
    if (entry.sample.length < 120) entry.sample += p.runs.map((r) => r.text).join(' ').slice(0, 120 - entry.sample.length);
    by.set(id, entry);
  }
  return [...by.values()].map((e) => ({ id: e.id, weights: [...e.weights].sort((a, b) => a - b), italic: e.italic, sample: e.sample }));
}

/** Subscribe to font loads; returns the current generation (bumps re-plan with real metrics). */
export function useFontGeneration(): number {
  return useSyncExternalStore(subscribeFontLoads, fontLoadGeneration, () => 0);
}

/** Load the faces a set of plans draws with (idempotent; memoized in the loader). */
export function useEnsurePlanFonts(plans: readonly LetterPlan[]): void {
  const faces = useMemo(() => facesOfPlans(plans), [plans]);
  const key = faces.map((f) => `${f.id}:${f.weights.join('/')}:${f.italic ? 'i' : ''}`).join('|');
  useEffect(() => {
    for (const f of faces) void ensureFonts([f.id], { weights: f.weights, italic: f.italic, sample: f.sample });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

export interface PagePlans {
  plans: LetterPlan[];
  placements: Placements;
  measure: Measure;
  /** Plan units: page height for this aspect (width is always 1000). */
  H: number;
}

const NO_PLACEMENTS: Placements = { balloons: new Map(), fallback: new Set(), crowded: new Set() };

/**
 * Plans + placements for a page at `aspect` (w/h), re-planned when lettering faces finish loading.
 * `placements: false` skips the second placement pass for read-only views (the reader and the board
 * grid only draw; the full balloons behind the plans matter only to an editor).
 */
export function useLetterPlans(doc: ComicDoc, page: Page, aspect: number, opts: { placements?: boolean } = {}): PagePlans {
  const wantPlacements = opts.placements !== false;
  const generation = useFontGeneration();
  const measure = measureForGeneration(generation);
  const asp = Number.isFinite(aspect) && aspect > 0 ? aspect : letteringAspect(doc, page);
  const plans = useMemo(() => planLettering(doc, page, asp, measure), [doc, page, asp, measure]);
  const placements = useMemo(() => (wantPlacements ? withDrawnGeometry(resolvePlacements(doc, page, asp, measure), plans, 1000 / asp) : NO_PLACEMENTS), [wantPlacements, doc, page, asp, measure, plans]);
  useEnsurePlanFonts(plans);
  return { plans, placements, measure, H: 1000 / asp };
}
