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
import { coverCapFor, LETTER_FIT_POLICY, letteringAspect, letteringSizer, planLettering, withDrawnSpots, type CrowdedReason, type LetterPlan, type Measure } from '../../../shared/comic/lettering/layout';
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
  /** Why each crowded line is flagged, when the plan says (LetterPlan.crowdedReason). */
  reasons?: Map<string, CrowdedReason>;
}

/** Stored + software-placed balloons for every lettered line of a page (pure; matches planLettering). */
export function resolvePlacements(doc: ComicDoc, page: Page, aspect: number, measure: Measure): Placements {
  const balloons = new Map<string, Balloon>();
  const fallback = new Set<string>();
  const crowded = new Set<string>();
  const reasons = new Map<string, CrowdedReason>();
  if (!page || !Array.isArray(page.panels)) return { balloons, fallback, crowded, reasons };
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
  return { balloons, fallback, crowded, reasons };
}

/**
 * The render-time settle and dense-page repack (planLettering) may draw a software-placed or an unpinned
 * stored balloon somewhere else than the placement put it, tail included. Those lines are `crowded` (the
 * editor's chip and the inspector's free fixes), and the balloon behind each of them is the one the user
 * SEES — so a first drag, nudge, lock or tail aim starts from the drawn spot and never jumps back. Pinned
 * and locked balloons are drawn where they are stored and stay as they are. Pure; mutates and returns `p`.
 */
export function withDrawnGeometry(p: Placements, plans: readonly LetterPlan[], H: number): Placements {
  for (const plan of plans) {
    if (plan.crowded) {
      p.crowded.add(plan.lineId);
      if (plan.crowdedReason) (p.reasons ??= new Map()).set(plan.lineId, plan.crowdedReason);
    }
  }
  // x, y AND w as drawn (and the tail tip): one rule with the director's arrange_balloons (layout.ts withDrawnSpots).
  withDrawnSpots(p.balloons, plans, H, p.fallback);
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

// ── Plans cache ──────────────────────────────────────────────────────────────
//
// planLettering is pure, but a dense page runs several placement and settle passes. Every doc change (any
// op, on any page) hands the hooks a new doc object, so without this every page view on screen — board
// thumbnails, the reader, the editor — would re-plan after each commit. Plans are cached per measure (a
// font load gives a new one) by the CONTENT planLettering reads, so a change that leaves a page's lettering
// alone returns the very same array.

const PLAN_CACHE = new WeakMap<Measure, Map<string, LetterPlan[]>>();
const PLAN_CACHE_SIZE = 240;

/**
 * Everything planLettering reads from a doc and a page, as one string: equal keys plan identically. (The
 * lettering style and format of the doc; the coverage cap the brief sets (a children's book letters under a lower
 * one) and the owner's cover-shrink policy; the page's layout, panel numbers / sizes / cast, every line's
 * lettering fields, stored balloons and the vision qc that holds panel boxes, faces and heads.)
 */
export function letteringKey(doc: Pick<ComicDoc, 'letterStyle' | 'format' | 'brief'>, page: Page, aspect: number): string {
  const f = doc.format;
  return JSON.stringify([
    Math.round(aspect * 1e6) / 1e6,
    doc.letterStyle ?? null,
    f ? [f.language, f.readingDirection, f.kind, f.pageAspect] : null,
    [coverCapFor(doc), LETTER_FIT_POLICY.coverShrink],
    page.layout ?? '',
    (page.panels || []).map((p) => [p.n, p.size, p.castIds ?? [], (p.lines || []).map((l) => [l.id, l.kind, l.text, l.lang ?? '', l.speakerId ?? '', l.style ?? null])]),
    page.balloons ?? [],
    page.render?.qc ?? null
  ]);
}

/** planLettering, memoized by content (see letteringKey). The returned array is shared: treat it as read-only. */
export function planLetteringCached(doc: ComicDoc, page: Page, aspect: number, measure: Measure): LetterPlan[] {
  let memo = PLAN_CACHE.get(measure);
  if (!memo) {
    memo = new Map();
    PLAN_CACHE.set(measure, memo);
  }
  const key = letteringKey(doc, page, aspect);
  const hit = memo.get(key);
  if (hit) {
    memo.delete(key);
    memo.set(key, hit);
    return hit;
  }
  const plans = planLettering(doc, page, aspect, measure);
  memo.set(key, plans);
  if (memo.size > PLAN_CACHE_SIZE) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  return plans;
}

export interface PagePlans {
  plans: LetterPlan[];
  placements: Placements;
  measure: Measure;
  /** Plan units: page height for this aspect (width is always 1000). */
  H: number;
}

const NO_PLACEMENTS: Placements = { balloons: new Map(), fallback: new Set(), crowded: new Set(), reasons: new Map() };

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
  const plans = useMemo(() => planLetteringCached(doc, page, asp, measure), [doc, page, asp, measure]);
  const placements = useMemo(() => (wantPlacements ? withDrawnGeometry(resolvePlacements(doc, page, asp, measure), plans, 1000 / asp) : NO_PLACEMENTS), [wantPlacements, doc, page, asp, measure, plans]);
  useEnsurePlanFonts(plans);
  return { plans, placements, measure, H: 1000 / asp };
}
