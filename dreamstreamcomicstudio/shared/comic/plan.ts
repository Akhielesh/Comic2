// Single target/estimate core for "what would be drawn and what it costs" (contract §11.2).
//
// One definition, used by the server (jobs.ts pageTargets / estimateSpendAction for render_pages),
// the board (boardModel.ts re-uses pageTargets / missingSheetsFor) and the chat breakdown card.
// Pure and dependency-free (shared/comic only), so client and server can never disagree about
// which pages a "draw everything" would touch or what it would cost.
//
// Money rule (the owner's $0.06 bug): without `force`, a page that is drawn and up to date is
// NEVER a target and is never quoted. Busy pages (queued/rendering) are never targets either.
//
// Every number here is real: quotes come from the model registry (estimateJobs, the same call the
// server's gate uses), and "spent" comes from the doc's own spend ledger and render metadata.

import {
  coverSpecHash,
  isPageStale,
  thumbOf,
  type Box,
  type Character,
  type ComicDoc,
  type ImageModelLock,
  type LetteringMode,
  type Page,
  type PanelSize,
  type QualityTier,
  type RenderState,
  type ShotType
} from './doc.js';
import { needMeter, type FitState, type NeedMeter } from './density.js';
import { letteringAspect } from './lettering/layout.js';
import { aspectMatches, estimateJobs, getImageModel, resolveImageJob, type ImageJobKind, type SpendEstimate } from './models.js';
import { lockOf } from './modelLock.js';
import { checkPagePlan, heldBackOf, splitHeldBack } from './pagePlanCheck.js';
import { drawnPanelBoxes } from './pageGeometry.js';
import { PLAN_POLICY, RECURRING, textUnitFor } from './panelRules.js';
import { safetyStatusOf, type ContentRating, type SafetyStatus } from './safety.js';

const isBusy = (r?: RenderState) => !!r && (r.status === 'queued' || r.status === 'rendering');
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** QC score below which a drawn page is flagged for a look (mirrors server jobs.ts LOW_QC_SCORE). */
export const LOW_QC_SCORE = 0.45;

/** No force ⇒ undrawn / stale / failed pages with panels, never busy. Sorted by n. */
export function pageTargets(doc: ComicDoc, opts: { pageIds?: string[]; force?: boolean } = {}): Page[] {
  const ids = Array.isArray(opts.pageIds) && opts.pageIds.length ? new Set(opts.pageIds) : null;
  return doc.pages
    .filter((p) => (ids ? ids.has(p.id) : true))
    .filter((p) => p.panels.length > 0 && !isBusy(p.render))
    .filter((p) => opts.force || p.render.status !== 'ready' || isPageStale(doc, p))
    .sort((a, b) => a.n - b.n);
}

const sheetWanted = (c: Character, force?: boolean) => c.tier !== 'extra' && !isBusy(c.sheet) && (force || c.sheet.status !== 'ready');

/** Lead/support/companions whose sheet should be drawn; never extras. */
export function sheetTargets(doc: ComicDoc, opts: { characterIds?: string[]; force?: boolean } = {}): Character[] {
  const ids = Array.isArray(opts.characterIds) && opts.characterIds.length ? new Set(opts.characterIds) : null;
  return doc.cast.filter((c) => (ids ? ids.has(c.id) : true) && sheetWanted(c, opts.force));
}

/** Lead/support cast appearing on these pages that has no usable sheet yet (the server draws those first, billed too). */
export function missingSheetsFor(doc: ComicDoc, pages: Page[]): Character[] {
  const ids = new Set(pages.flatMap((p) => p.panels.flatMap((panel) => panel.castIds)));
  return doc.cast.filter((c) => ids.has(c.id) && sheetWanted(c));
}

/** The cover has no art, failed, or was drawn from an older title/style/cast (never while busy). */
export function coverNeedsDraw(doc: ComicDoc): boolean {
  const r = doc.cover.render;
  if (isBusy(r)) return false;
  if (r.status !== 'ready') return true;
  return !!r.specHash && r.specHash !== coverSpecHash(doc);
}

/**
 * The model lock every quote prices on (models.md §3.4 item 1): the comic's persisted lock, else the migration lock
 * of a legacy doc drawn before the lock existed (deriveLock: reads never write); undefined = nothing drawn yet. The
 * server's jobs.ts lockOf is the same function (modelLock.ts lockOf), so a chip, a card, the director and the gate name
 * one price.
 */
export const quoteLockOf = (doc: ComicDoc): ImageModelLock | undefined => lockOf(doc);

/** `lock` option of the quote helpers: absent = the doc's own lock (quoteLockOf); null = price as if unlocked. */
const lockFor = (doc: ComicDoc, lock: ImageModelLock | null | undefined): ImageModelLock | undefined =>
  lock === null ? undefined : (lock ?? quoteLockOf(doc));

/**
 * Registry estimate for image jobs on THIS comic's model: with a lock every kind (style swatches included) prices
 * on the locked model and the tier only picks the resolution — exactly what the server draws (jobs.ts
 * resolveJobFor). Tier and override default to the doc's settings. The one lock-aware entry point for quotes that
 * are not a render_pages action (cover, sheet, style-option and retry chips).
 */
export function estimateDocJobs(
  doc: ComicDoc,
  jobs: { kind: ImageJobKind; count: number; label?: string }[],
  opts: { byok: boolean; tier?: QualityTier; modelOverride?: string; lock?: ImageModelLock | null }
): SpendEstimate {
  const lock = lockFor(doc, opts.lock);
  return estimateJobs(jobs, opts.tier ?? doc.settings.quality, {
    override: opts.modelOverride ?? doc.settings.imageModelOverride,
    byok: opts.byok,
    ...(lock ? { lock } : {})
  });
}

export interface RenderQuote extends SpendEstimate {
  pageIds: string[];
  sheetIds: string[];
  cover: boolean;
  nothing: boolean;
  /** With `holdBack`: overfull pages left out of the run and this quote (PD-1), when any. */
  heldBackIds?: string[];
}

/**
 * Quote a render_pages action exactly as the server's gate would (same targets, same registry
 * estimate, same line labels). `includeCover` adds the cover only when it needs drawing (or when
 * forced and not busy). `nothing` ⇒ $0: every requested page is already drawn and current.
 */
export function quoteRenderPages(
  doc: ComicDoc,
  opts: {
    pageIds?: string[];
    force?: boolean;
    includeCover?: boolean;
    byok: boolean;
    tier: QualityTier;
    modelOverride?: string;
    /** Leave overfull pages out of the run and the quote (the render gate's rule), except `drawOverfull`.
     *  `meter` reuses a caller's need meter (same doc) so a summary measures each line once. */
    holdBack?: { drawOverfull?: readonly string[]; meter?: NeedMeter };
    /** Absent: the comic's own lock (quoteLockOf) — a locked comic always quotes its locked model, whatever the
     *  tier or override say (the tier picks the resolution). null: price as if unlocked. */
    lock?: ImageModelLock | null;
  }
): RenderQuote {
  let pages = pageTargets(doc, opts);
  let heldBackIds: string[] | undefined;
  if (opts.holdBack) {
    const split = splitHeldBack(doc, pages.map((p) => p.id), opts.holdBack.drawOverfull ?? [], { meter: opts.holdBack.meter, fixLayout: false });
    if (split.heldBack.length) {
      const keep = new Set(split.draw);
      pages = pages.filter((p) => keep.has(p.id));
      heldBackIds = split.heldBack.map((h) => h.pageId);
    }
  }
  const sheets = missingSheetsFor(doc, pages);
  const cover = !!opts.includeCover && (opts.force ? !isBusy(doc.cover.render) : coverNeedsDraw(doc));
  const lock = lockFor(doc, opts.lock);
  const est = estimateJobs(
    [
      { kind: 'page', count: pages.length, label: 'pages' },
      { kind: 'sheet', count: sheets.length, label: 'character sheets' },
      { kind: 'cover', count: cover ? 1 : 0, label: 'cover' }
    ],
    opts.tier,
    { override: opts.modelOverride, byok: opts.byok, ...(lock ? { lock } : {}) }
  );
  return {
    ...est,
    pageIds: pages.map((p) => p.id),
    sheetIds: sheets.map((c) => c.id),
    cover,
    nothing: !pages.length && !sheets.length && !cover,
    ...(heldBackIds ? { heldBackIds } : {})
  };
}

/**
 * Registry price of ONE image of a kind for this doc right now (QC included for pages/edits): on the comic's locked
 * model when it has one (the tier picks the resolution), else the tier preset or the model override.
 */
export function unitPrice(
  doc: ComicDoc,
  kind: 'page' | 'cover' | 'sheet' | 'edit',
  opts: { byok: boolean; tier?: QualityTier; modelOverride?: string; lock?: ImageModelLock | null }
): { usd: number; model: string } {
  const tier = opts.tier ?? doc.settings.quality;
  const override = opts.modelOverride ?? doc.settings.imageModelOverride;
  const lock = lockFor(doc, opts.lock);
  const est = estimateJobs([{ kind, count: 1, label: kind }], tier, { override, byok: opts.byok, ...(lock ? { lock } : {}) });
  return { usd: est.usd, model: resolveImageJob(kind, tier, override, lock).spec.nickname };
}

/** Real money recorded against one render target (renders, edits, reuses) from the spend ledger. */
export interface TargetSpend { usd: number; savedUsd: number; count: number }

/**
 * Spend ledger grouped by render target key ('page:pg_x', 'cover', 'sheet:c_x' …). The ledger keeps
 * the most recent MAX_SPEND_ENTRIES entries, so very old spend on a long book can be missing here
 * (the book total `spend.totalUsd` is always complete).
 */
export function spendByTarget(doc: ComicDoc): Map<string, TargetSpend> {
  const out = new Map<string, TargetSpend>();
  for (const e of doc.spend?.entries ?? []) {
    if (!e || typeof e.target !== 'string' || !e.target) continue;
    const cur = out.get(e.target) ?? { usd: 0, savedUsd: 0, count: 0 };
    cur.usd = round4(cur.usd + (Number.isFinite(e.usd) ? Math.max(0, e.usd) : 0));
    cur.savedUsd = round4(cur.savedUsd + (Number.isFinite(e.savedUsd) ? Math.max(0, e.savedUsd as number) : 0));
    cur.count += 1;
    out.set(e.target, cur);
  }
  return out;
}

export interface PanelSummary {
  /** `box`: for a page "Render all" would draw (undrawn, failed or stale), the layout as drawn (effectiveLayout) —
   *  the boxes the hold-back is decided on; for a drawn, current (or busy) page, its measured panels (else the
   *  layout as drawn). */
  n: number; box: Box; shot: ShotType; size: PanelSize; castIds: string[]; speech: number; captions: number; sfx: number; words: number;
  /** How much of the panel its lettering covers (density.ts need ÷ area, on `box`), its state and what it holds
   *  (in BookSummary.budgetUnit: words, or characters for Japanese and Chinese). Same boxes as the page's planFit. */
  fit?: number;
  fitState?: FitState;
  budget?: number;
}

/** The page-plan check for a page (shared/comic/pagePlanCheck.ts): the worst panel's state, and whether
 *  "Render all" holds the page back (overfull and not in `drawOverfull`). */
export interface PagePlanFit {
  state: FitState;
  worst: number;
  /** 1-based panel with the worst fit. */
  panel?: number;
  /** Left out of "Render all" and its quote until fixed or "Draw anyway" (PD-1). */
  heldBack?: boolean;
  /** "Page 2 is held back: …" with the free fixes. */
  text?: string;
  /** The blueprint that fits, when one exists (the first free fix). */
  layoutFix?: string;
}
export interface PageSummary {
  id: string; n: number; summary: string; turnHook?: string; chapterTitle?: string;
  panels: PanelSummary[]; castIds: string[]; missingRefCastIds: string[];
  status: 'planned' | 'queued' | 'rendering' | 'ready' | 'stale' | 'failed' | 'custom';
  aspectOk?: boolean; costUsd?: number; quoteUsd?: number; qcScore?: number; thumbPath?: string;
  safety?: SafetyStatus;
  /** Everything the ledger recorded for this page (renders + edits), when any. */
  spentUsd?: number;
  /** Friendly name of the model that drew the current art. */
  model?: string;
  /** Price of a forced new take of a drawn page (render_pages force, missing sheets included), for "New take · ≈$X". */
  redrawUsd?: number;
  /** Plan fit (pages with panels): per-page state and the hold-back verdict for pages "Render all" would draw. */
  planFit?: PagePlanFit;
}
export interface BookSummary {
  pages: PageSummary[];
  cover: {
    status: PageSummary['status']; title: string; quoteUsd?: number; thumbPath?: string; lettering: LetteringMode;
    /** Ledger spend on the cover, when any. */
    spentUsd?: number;
    model?: string;
    safety?: SafetyStatus;
  };
  totals: {
    pages: number; panels: number; lines: number; drawn: number; stale: number; spentUsd: number; savedUsd: number;
    /** "Render all" right now: held-back (overfull) pages excluded unless in `drawOverfull`. */
    toDrawUsd: number;
    /** Pages "Render all" holds back (overfull), when any. */
    heldBack?: number;
  };
  /** What the next drawing runs on (registry facts, no guesses). `locked`: the model is fixed — the comic's model
   *  lock (quoteLockOf) or an explicit model override; `model` is then that model. */
  pricing?: { model: string; pageUsd: number; coverUsd: number; tier: QualityTier; byok: boolean; locked: boolean };
  /** "6 pages · 19 panels. Want more moments? Add a page." — the page count stays the user's choice; the UI
   *  formats `addPageUsd` (usage words for governed users). */
  moments?: { pages: number; panels: number; addPageUsd: number; line: string };
  /** What PanelSummary.budget counts: words, or characters for Japanese and Chinese (the book's language). */
  budgetUnit?: 'words' | 'chars';
}

const statusOf = (r: RenderState, stale: boolean): PageSummary['status'] => {
  switch (r.status) {
    case 'queued':
    case 'rendering':
    case 'failed':
      return r.status;
    case 'stale':
      return 'stale';
    case 'ready':
      if (stale) return 'stale';
      return !r.specHash && r.origin === 'adopted' ? 'custom' : 'ready';
    default:
      return 'planned';
  }
};

const words = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);
const modelNickname = (id?: string) => (id ? getImageModel(id)?.nickname : undefined);

/**
 * Cast on a page who will be drawn without a reference: lead/support without a ready sheet or a photo, and —
 * now that page renders attach any on-page being's ready sheet (presence-based references) — recurring extras
 * (on ≥ 2 pages and in ≥ 3 panels of the book) without one either. One-off walk-ons stay text-only by design.
 */
export function missingRefCastIdsFor(doc: ComicDoc, castIds: string[], recurring: ReadonlySet<string> = recurringCastIds(doc)): string[] {
  const on = new Set(castIds);
  return doc.cast
    .filter((c) => on.has(c.id) && c.sheet.status !== 'ready' && !c.refs.length && (c.tier !== 'extra' || recurring.has(c.id)))
    .map((c) => c.id);
}

/** Beings on at least RECURRING.minPages pages and in at least RECURRING.minPanels panels of the book. */
export function recurringCastIds(doc: Pick<ComicDoc, 'pages'>): Set<string> {
  const seen = new Map<string, { panels: number; pages: Set<string> }>();
  for (const page of doc.pages) {
    for (const panel of page.panels) {
      for (const id of new Set(panel.castIds)) {
        const s = seen.get(id) ?? { panels: 0, pages: new Set<string>() };
        s.panels += 1;
        s.pages.add(page.id);
        seen.set(id, s);
      }
    }
  }
  return new Set([...seen].filter(([, s]) => s.panels >= RECURRING.minPanels && s.pages.size >= RECURRING.minPages).map(([id]) => id));
}

export function summarizeBook(
  doc: ComicDoc,
  opts: {
    pageIds?: string[];
    byok: boolean;
    tier?: QualityTier;
    rating?: ContentRating;
    /** Overfull pages the user chose to draw anyway (render_pages.drawOverfull): not held back. */
    drawOverfull?: readonly string[];
  }
): BookSummary {
  const tier = opts.tier ?? doc.settings.quality;
  const override = doc.settings.imageModelOverride;
  const page1 = unitPrice(doc, 'page', { byok: opts.byok, tier, modelOverride: override });
  const cover1 = unitPrice(doc, 'cover', { byok: opts.byok, tier, modelOverride: override });
  const ids = Array.isArray(opts.pageIds) && opts.pageIds.length ? new Set(opts.pageIds) : null;
  const drawable = new Set(pageTargets(doc).map((p) => p.id));
  const ledger = spendByTarget(doc);
  const anyway = new Set(opts.drawOverfull ?? []);
  const meter = needMeter(doc, { aspect: letteringAspect(doc, null) });
  const recurring = recurringCastIds(doc);
  const pages: PageSummary[] = [...doc.pages]
    .sort((a, b) => a.n - b.n)
    .filter((p) => (ids ? ids.has(p.id) : true))
    .map((p) => {
      const castIds = [...new Set(p.panels.flatMap((panel) => panel.castIds))];
      const asset = p.render.asset;
      // One plan check per page, on one set of boxes, feeds the per-panel dots AND the page verdict, so they never
      // disagree: a page "Render all" would draw (undrawn, failed or stale) is checked on the layout as drawn
      // (pagePlanCheck planBoxes: effectiveLayout, the gate's boxes) even when an older take left measured boxes; a
      // drawn, current (or busy) page on the panels it was drawn with (measured, else the layout as drawn), and is
      // never held back.
      const about = drawable.has(p.id);
      const check = p.panels.length
        ? checkPagePlan(doc, p, about ? { meter } : { meter, boxes: drawnPanelBoxes(doc, p), fixLayout: false })
        : undefined;
      const summary: PageSummary = {
        id: p.id,
        n: p.n,
        summary: p.summary,
        panels: p.panels.map((panel, i) => {
          const fit = check?.panels[i];
          return {
            n: panel.n,
            box: fit?.box ?? { x: 0, y: 0, w: 1, h: 1 },
            shot: panel.shot,
            size: panel.size,
            castIds: panel.castIds,
            speech: panel.lines.filter((l) => l.kind !== 'caption' && l.kind !== 'sfx').length,
            captions: panel.lines.filter((l) => l.kind === 'caption').length,
            sfx: panel.lines.filter((l) => l.kind === 'sfx').length,
            words: panel.lines.reduce((n, l) => n + words(l.text), 0),
            ...(fit ? { fit: fit.fit, fitState: fit.state, budget: fit.budget } : {})
          };
        }),
        castIds,
        missingRefCastIds: missingRefCastIdsFor(doc, castIds, recurring),
        status: statusOf(p.render, isPageStale(doc, p))
      };
      if (check) {
        // About to be drawn: the hold-back follows the gate's rule (PD-1). Drawn and current: nothing is held back.
        const back = about && PLAN_POLICY.holdBackOverfull && check.state === 'overfull' && !anyway.has(p.id) ? heldBackOf(check) : undefined;
        summary.planFit = {
          state: check.state,
          worst: check.worst,
          ...(check.worstPanel !== undefined ? { panel: check.worstPanel } : {}),
          ...(back ? { heldBack: true, text: back.text } : {}),
          ...(about && check.layoutFix ? { layoutFix: check.layoutFix.layout } : {})
        };
      }
      if (p.turnHook) summary.turnHook = p.turnHook;
      if (p.chapterTitle) summary.chapterTitle = p.chapterTitle;
      if (asset) {
        summary.aspectOk = aspectMatches(doc.format.pageAspect, asset.w, asset.h);
        summary.thumbPath = thumbOf(asset, 320)?.path;
        if (opts.rating) summary.safety = safetyStatusOf(asset.safety, opts.rating);
      }
      if (typeof p.render.costUsd === 'number') summary.costUsd = p.render.costUsd;
      if (typeof p.render.qc?.score === 'number') summary.qcScore = p.render.qc.score;
      const model = modelNickname(p.render.model);
      if (model && asset) summary.model = model;
      const spent = ledger.get(`page:${p.id}`);
      if (spent && spent.usd > 0) summary.spentUsd = spent.usd;
      if (drawable.has(p.id)) summary.quoteUsd = page1.usd;
      else if (p.render.status === 'ready' && p.panels.length) {
        // The gate's own forced quote: a new take also draws any missing lead/support sheet first.
        summary.redrawUsd = quoteRenderPages(doc, { pageIds: [p.id], force: true, byok: opts.byok, tier, modelOverride: override }).usd;
      }
      return summary;
    });
  const coverQuote = coverNeedsDraw(doc) ? cover1.usd : undefined;
  const coverAsset = doc.cover.render.asset;
  const coverSpent = ledger.get('cover');
  const coverModel = coverAsset ? modelNickname(doc.cover.render.model) : undefined;
  const all = doc.pages;
  return {
    pages,
    cover: {
      status: statusOf(doc.cover.render, doc.cover.render.status === 'ready' && !!doc.cover.render.specHash && doc.cover.render.specHash !== coverSpecHash(doc)),
      title: doc.cover.title ?? doc.brief.title,
      ...(coverQuote !== undefined ? { quoteUsd: coverQuote } : {}),
      ...(coverAsset ? { thumbPath: thumbOf(coverAsset, 320)?.path } : {}),
      lettering: doc.cover.lettering ?? 'in_art',
      ...(coverSpent && coverSpent.usd > 0 ? { spentUsd: coverSpent.usd } : {}),
      ...(coverModel ? { model: coverModel } : {}),
      ...(coverAsset && opts.rating ? { safety: safetyStatusOf(coverAsset.safety, opts.rating) } : {})
    },
    totals: {
      pages: all.length,
      panels: all.reduce((n, p) => n + p.panels.length, 0),
      lines: all.reduce((n, p) => n + p.panels.reduce((m, panel) => m + panel.lines.length, 0), 0),
      drawn: all.filter((p) => p.render.status === 'ready').length,
      stale: all.filter((p) => isPageStale(doc, p)).length,
      spentUsd: doc.spend.totalUsd,
      savedUsd: doc.spend.savedUsd ?? 0,
      ...renderAllTotals(doc, { byok: opts.byok, tier, modelOverride: override, drawOverfull: [...anyway], meter })
    },
    pricing: { model: page1.model, pageUsd: page1.usd, coverUsd: cover1.usd, tier, byok: opts.byok, locked: !!override || !!quoteLockOf(doc) },
    moments: momentsLine(doc, page1.usd),
    budgetUnit: textUnitFor(doc.format.language).unit
  };
}

/** "Render all" for the totals: held-back pages excluded (and counted) unless the user chose to draw them anyway. */
const renderAllTotals = (
  doc: ComicDoc,
  o: { byok: boolean; tier: QualityTier; modelOverride?: string; drawOverfull: string[]; meter: NeedMeter }
): { toDrawUsd: number; heldBack?: number } => {
  const q = quoteRenderPages(doc, { byok: o.byok, tier: o.tier, modelOverride: o.modelOverride, holdBack: { drawOverfull: o.drawOverfull, meter: o.meter } });
  return { toDrawUsd: q.usd, ...(q.heldBackIds?.length ? { heldBack: q.heldBackIds.length } : {}) };
};

/** "6 pages · 19 panels. Want more moments? Add a page." (price-free text; the UI formats addPageUsd). */
const momentsLine = (doc: ComicDoc, pageUsd: number): BookSummary['moments'] => {
  const pages = doc.pages.length;
  const panels = doc.pages.reduce((n, p) => n + p.panels.length, 0);
  return {
    pages,
    panels,
    addPageUsd: pageUsd,
    line: `${pages} page${pages === 1 ? '' : 's'} · ${panels} panel${panels === 1 ? '' : 's'}. Want more moments? Add a page.`
  };
};
