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
  castKindOf,
  consistencyOf,
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
import {
  PLATFORM_MARKUP,
  aspectMatches,
  estimateJobs,
  getImageModel,
  imagePriceUsd,
  nearestResolution,
  resolveImageJob,
  type ImageJobKind,
  type ImageModelSpec,
  type SpendEstimate
} from './models.js';
import {
  ANCHOR_KINDS_OFF,
  ANCHOR_SHEET_RES,
  anchorKeys,
  anchorKindsOf,
  appearances,
  isRecurring,
  planAnchors,
  staleReasons,
  type AnchorKinds,
  type AnchorOverflowWhy,
  type AnchorRole,
  type PlannedAnchor
} from './anchors.js';
import { lintContinuity, resolveContinuity, type ContinuityIssueKind } from './continuity.js';
import { lintDirections, type DirectionIssueKind } from './directions.js';
import { lockOf } from './modelLock.js';
import { checkPagePlan, fitBoxesFor, heldBackOf, renderAllDraws, splitHeldBack } from './pagePlanCheck.js';
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
    .filter((p) => (opts.force ? p.panels.length > 0 && !isBusy(p.render) : renderAllDraws(doc, p)))
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
  /** With `anchors` mode 'auto' (Ship 2, B4): the anchor sheets the run draws first (ticked line items), the ones the
   *  user unticked (consistency.skip: not drawn, not quoted), the ones no page could attach (not drawn, not quoted),
   *  the extra reference images the anchors add, and the anchor lines by kind. */
  anchors?: RenderQuoteAnchors;
}

/**
 * One anchor line of a quote, tagged with how the server prices it: 'sheet' = a character sheet job (jobs.ts
 * priceImageJobs kind 'sheet'); 'place' / 'prop' = a 'place' job at ANCHOR_SHEET_RES; 'refs' = the reference
 * allowance (extraRefsUsd), taken as is.
 */
export interface AnchorQuoteLine {
  label: string;
  count: number;
  usd: number;
  kind: 'sheet' | 'place' | 'prop' | 'refs';
}

export interface RenderQuoteAnchors {
  /** Anchor sheets the run draws first: ticked, and attached by at least one page of the run. */
  keys: string[];
  /** Unticked by the user (consistency.skip): not drawn, not quoted. */
  skipped: string[];
  /** Ticked, but no page of the run can attach them under the model's caps (MissingAnchor.unused): not drawn, not quoted. */
  unused: string[];
  /** Reference images the anchors add over today's plan (the allowance line counts them). */
  extraRefs: number;
  /** The lines this quote appends after its base lines, in order: `lines` = [...base lines, ...these without `kind`].
   *  The base has 0–3 lines (estimateJobs drops empty ones), so a PriceBook re-prices THESE by kind — never a
   *  fixed-index slice of `lines`. */
  lines: AnchorQuoteLine[];
  /** Every missing anchor of the run with its skipped / unused flags (the card's ticked line items, and why the rest are
   *  not made). */
  missing: MissingAnchor[];
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
    /** Ship 2 (B4): mode 'auto' adds the missing anchors as line items and the reference allowance. Absent or 'none'
     *  = today's quote, byte for byte. */
    anchors?: AnchorRunOptions;
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
  const base: RenderQuote = {
    ...est,
    pageIds: pages.map((p) => p.id),
    sheetIds: sheets.map((c) => c.id),
    cover,
    nothing: !pages.length && !sheets.length && !cover,
    ...(heldBackIds ? { heldBackIds } : {})
  };
  if (opts.anchors?.mode !== 'auto') return base;
  return withAnchorLines(doc, base, pages, sheets, { ...opts, anchors: opts.anchors, lock });
}

// ── Ship 2 (B4): consistency anchors in the run and its quote ──────────────────

/**
 * Provider allowance per extra reference image while a model's per-reference price is unpublished (pro plan §7, §9:
 * $0.004 until 20 renders record SpendEntry.refs). A model with a published per-reference price (models.ts perRefUsd)
 * is quoted at that price instead. The Model Lab's LAB_AB_REF_ALLOWANCE_USD is the same number.
 */
export const REF_ALLOWANCE_USD = 0.004;

/** How a render_pages run treats consistency anchors (render_pages.anchors; the COMIC_CONSISTENCY_ANCHORS kinds). */
export interface AnchorRunOptions {
  /** 'auto' = draw the missing anchors first (ticked line items) and attach them; 'none' = today's run. */
  mode: 'auto' | 'none';
  /** The COMIC_CONSISTENCY_ANCHORS kinds that are on (absent = all off). */
  kinds?: Partial<AnchorKinds>;
  /** COMIC_LAYOUT_GUIDE is on (one reserved reference slot). */
  layoutGuide?: boolean;
}

/** An anchor sheet a run would draw first (once per book), quoted as a ticked line item. */
export interface MissingAnchor {
  key: string;
  kind: 'character' | 'place' | 'prop';
  id: string;
  name: string;
  /** Pages of the run that use it, in page order. */
  pageIds: string[];
  /** The user unticked it (consistency.skip): not drawn, not quoted; the pages describe it in words. */
  skipped: boolean;
  /** No page of the run attaches it under the locked model's caps (a legacy-locked comic's places and props, a
   *  low-ranked extra when the character slots are full): no sheet is made or quoted, the pages describe it in words.
   *  Set by the quote (quoteRenderPages anchors 'auto'), never by missingAnchorsFor. */
  unused?: true;
  /** With `unused`: "No sheet is made for THE LAKE: no page in this run has a reference slot left for it, so it is
   *  described in words." */
  text?: string;
}

/**
 * Anchors the given pages use that have no sheet yet (never busy ones), in the order characters → places → props, each
 * by first use: recurring extras (beings on ≥ 2 pages and ≥ 3 panels; lead/support sheets stay missingSheetsFor's
 * 'character sheets'), recurring places (kind 'places') and recurring extra props (kind 'props'). `skip` defaults to
 * the doc's consistency.skip. Pure.
 */
export function missingAnchorsFor(doc: ComicDoc, pages: Page[], opts: { kinds?: Partial<AnchorKinds>; skip?: readonly string[] } = {}): MissingAnchor[] {
  const kinds = anchorKindsOf(opts.kinds);
  const skip = new Set(opts.skip ?? consistencyOf(doc).skip ?? []);
  const apps = appearances(doc);
  const found = new Map<string, MissingAnchor>();
  const wants = (r: RenderState) => !isBusy(r) && r.status !== 'ready';
  const add = (key: string, kind: MissingAnchor['kind'], id: string, name: string, pageId: string) => {
    const m = found.get(key) ?? { key, kind, id, name, pageIds: [], skipped: skip.has(key) };
    if (!m.pageIds.includes(pageId)) m.pageIds.push(pageId);
    found.set(key, m);
  };
  for (const page of [...pages].sort((a, b) => a.n - b.n)) {
    for (const panel of page.panels) {
      for (const id of panel.castIds) {
        const c = doc.cast.find((x) => x.id === id);
        if (!c || c.tier !== 'extra' || !wants(c.sheet) || !isRecurring(apps.cast.get(id))) continue;
        const prop = castKindOf(c) === 'object';
        if (prop && !kinds.props) continue;
        add(anchorKeys.cast(c), prop ? 'prop' : 'character', c.id, c.name.trim().toUpperCase() || c.id, page.id);
      }
      if (panel.placeId && kinds.places) {
        const place = doc.places.find((p) => p.id === panel.placeId);
        if (place && wants(place.sheet) && isRecurring(apps.places.get(place.id))) add(anchorKeys.place(place.id), 'place', place.id, place.name.trim().toUpperCase() || place.id, page.id);
      }
    }
  }
  const order: MissingAnchor['kind'][] = ['character', 'place', 'prop'];
  return [...found.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

/** The price of `count` extra reference images on `spec` (its published per-reference price, else the allowance). */
export const extraRefsUsd = (spec: Pick<ImageModelSpec, 'perRefUsd'>, count: number, byok: boolean): number =>
  count > 0 ? round4(count * (typeof spec.perRefUsd === 'number' && Number.isFinite(spec.perRefUsd) ? spec.perRefUsd : REF_ALLOWANCE_USD) * (byok ? 1 : PLATFORM_MARKUP)) : 0;

/** Why a missing anchor is not made (MissingAnchor.text). */
const unusedAnchorText = (name: string): string =>
  `No sheet is made for ${name}: no page in this run has a reference slot left for it, so it is described in words.`;

/** What a run with anchors draws and assumes (anchorRunOf). */
interface AnchorRun {
  kinds: AnchorKinds;
  /** missingAnchorsFor, each flagged `unused` when no page of the run would attach it. */
  missing: MissingAnchor[];
  /** The anchor sheets the run draws first: ticked and used. */
  drawn: MissingAnchor[];
  /** Keys the run draws without anchors (missing lead/support sheets): today's plan assumes them. */
  todayReady: ReadonlySet<string>;
  /** todayReady plus the anchors drawn first. */
  runReady: ReadonlySet<string>;
  /** runReady plus the ticked-but-unused anchors, so a page names the cap that leaves each of them in words. */
  viewReady: ReadonlySet<string>;
  /** References each page of the run attaches with its anchors (planAnchors; sheets drawn first count as attached). */
  attached: ReadonlyMap<string, number>;
}

interface AnchorRunAt {
  /** The page job's model (resolveImageJob('page', …)); the lock's model wins inside planAnchors. */
  spec: ImageModelSpec;
  lock?: ImageModelLock;
  rating?: ContentRating;
}

/**
 * What a run with anchors draws and assumes. Every missing anchor of the pages is planned as ready on every page
 * (anchors mode, the run's pages drawn first); one that no page attaches under the model's caps is `unused` — never
 * drawn, never quoted (plan §8: a legacy-locked comic gets places and props as text). An unticked anchor is `unused`
 * when ticking it alone would not get it attached on any of its pages. With mode 'none' nothing is planned.
 */
const anchorRunOf = (doc: ComicDoc, pages: Page[], sheets: Character[], run: AnchorRunOptions, at: AnchorRunAt): AnchorRun => {
  const kinds = anchorKindsOf(run.kinds);
  const todayReady = new Set(sheets.map((c) => anchorKeys.cast(c)));
  if (run.mode !== 'auto') return { kinds, missing: [], drawn: [], todayReady, runReady: todayReady, viewReady: todayReady, attached: new Map() };
  const listed = missingAnchorsFor(doc, pages, { kinds });
  const assumeDrawn = new Set(pages.map((p) => p.id));
  const planOf = (page: Page, assumeReady: ReadonlySet<string>) =>
    planAnchors(doc, page, at.spec, at.lock ?? null, { kinds, layoutGuide: run.layoutGuide, assumeReady, assumeDrawn, ...(at.rating ? { rating: at.rating } : {}) });
  const tickedReady = new Set([...todayReady, ...listed.filter((m) => !m.skipped).map((m) => m.key)]);
  const used = new Set<string>();
  const attached = new Map<string, number>();
  for (const page of pages) {
    const plan = planOf(page, tickedReady);
    attached.set(page.id, plan.attached.length);
    for (const a of plan.attached) used.add(a.key);
  }
  const byId = new Map(pages.map((p) => [p.id, p]));
  const wouldAttach = (m: MissingAnchor): boolean =>
    m.pageIds.some((id) => {
      const page = byId.get(id);
      return !!page && planOf(page, new Set([...tickedReady, m.key])).attached.some((a) => a.key === m.key);
    });
  const missing = listed.map((m): MissingAnchor => ((m.skipped ? wouldAttach(m) : used.has(m.key)) ? m : { ...m, unused: true, text: unusedAnchorText(m.name) }));
  const drawn = missing.filter((m) => !m.skipped && !m.unused);
  const runReady = new Set([...todayReady, ...drawn.map((m) => m.key)]);
  // An unused anchor is attached nowhere even when ready, so assuming it changes no page's attachments — only the reason.
  const viewReady = new Set([...runReady, ...missing.filter((m) => m.unused && !m.skipped).map((m) => m.key)]);
  return { kinds, missing, drawn, todayReady, runReady, viewReady, attached };
};

/**
 * Extra reference images the anchors add per page: the run's anchors-mode plan (anchorRunOf) minus planAnchors as
 * today (Ship-1), both assuming the sheets and pages the run draws first; never below 0 (a page that attaches fewer
 * references with anchors never lowers the quote). Today's quote prices no reference images, so only the anchors'
 * additions are counted.
 */
const extraRefsByPage = (doc: ComicDoc, pages: Page[], run: AnchorRun, at: AnchorRunAt & { layoutGuide?: boolean }): Map<string, number> => {
  const assumeDrawn = new Set(pages.map((p) => p.id));
  const out = new Map<string, number>();
  for (const page of pages) {
    const today = planAnchors(doc, page, at.spec, at.lock ?? null, {
      kinds: ANCHOR_KINDS_OFF,
      layoutGuide: at.layoutGuide,
      assumeReady: run.todayReady,
      assumeDrawn,
      ...(at.rating ? { rating: at.rating } : {})
    }).attached.length;
    out.set(page.id, Math.max(0, (run.attached.get(page.id) ?? 0) - today));
  }
  return out;
};

/** quoteRenderPages with anchors 'auto': the base lines, then the anchor sheets the run uses and the reference allowance. */
const withAnchorLines = (
  doc: ComicDoc,
  base: RenderQuote,
  pages: Page[],
  sheets: Character[],
  o: { byok: boolean; tier: QualityTier; modelOverride?: string; lock?: ImageModelLock; anchors: AnchorRunOptions }
): RenderQuote => {
  const pageSpec = resolveImageJob('page', o.tier, o.modelOverride, o.lock).spec;
  const run = anchorRunOf(doc, pages, sheets, o.anchors, { spec: pageSpec, lock: o.lock });
  const count = (k: MissingAnchor['kind']) => run.drawn.filter((m) => m.kind === k).length;
  const markup = o.byok ? 1 : PLATFORM_MARKUP;
  const lockOpt = o.lock ? { lock: o.lock } : {};
  // Recurring extras get the same character sheet job as leads; places and props draw at ANCHOR_SHEET_RES.
  const charLines: AnchorQuoteLine[] = estimateJobs([{ kind: 'sheet', count: count('character'), label: 'recurring character sheets' }], o.tier, {
    override: o.modelOverride,
    byok: o.byok,
    ...lockOpt
  }).lines.map((l) => ({ ...l, kind: 'sheet' }));
  const sheetSpec = resolveImageJob('place', o.tier, o.modelOverride, o.lock).spec;
  const sheetUnit = imagePriceUsd(sheetSpec, nearestResolution(sheetSpec, ANCHOR_SHEET_RES));
  const at1k = (label: string, kind: 'place' | 'prop', n: number): AnchorQuoteLine[] => (n > 0 ? [{ label, count: n, usd: round4(sheetUnit * n * markup), kind }] : []);
  const perPage = extraRefsByPage(doc, pages, run, { spec: pageSpec, lock: o.lock, layoutGuide: o.anchors.layoutGuide });
  const extraRefs = [...perPage.values()].reduce((n, v) => n + v, 0);
  const refLine: AnchorQuoteLine[] = extraRefs > 0 ? [{ label: 'extra references', count: extraRefs, usd: extraRefsUsd(pageSpec, extraRefs, o.byok), kind: 'refs' }] : [];
  const anchorLines = [...charLines, ...at1k('place sheets', 'place', count('place')), ...at1k('prop sheets', 'prop', count('prop')), ...refLine];
  const lines = [...base.lines, ...anchorLines.map(({ kind: _kind, ...line }) => line)];
  const images = run.drawn.length;
  return {
    ...base,
    usd: round4(lines.reduce((sum, l) => sum + l.usd, 0)),
    imageCount: base.imageCount + images,
    lines,
    nothing: base.nothing && !images,
    anchors: {
      keys: run.drawn.map((m) => m.key),
      skipped: run.missing.filter((m) => m.skipped).map((m) => m.key),
      unused: run.missing.filter((m) => m.unused && !m.skipped).map((m) => m.key),
      extraRefs,
      lines: anchorLines,
      missing: run.missing
    }
  };
};

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
  // ── Ship 2 (B4): only with summarizeBook's `consistency` option ──
  /** What the page attaches when it is drawn next (planAnchors), in attachment order. */
  anchors?: PageAnchorItem[];
  /** Beings, places and props this page describes in words only, and why. */
  textOnly?: PageTextOnlyItem[];
  /** How much consistency detail the page carries, and what changed since its drawing (staleness parts). */
  detail?: PageDetail;
  /** Continuity and direction problems on this page ($0 lint), when any. */
  lint?: PageLintItem[];
}

/** One reference a page attaches (PageSummary.anchors): "MEERA · sheet", "NIGHT MARKET · sheet (drawn first)". */
export interface PageAnchorItem {
  key: string;
  role: AnchorRole;
  name: string;
  source: PlannedAnchor['source'];
  /** The image attached (a thumbnail for the card); absent for the layout guide and for anchors drawn first. */
  path?: string;
  /** Drawn first by this run. */
  pending?: true;
}
/** One being, place or prop described in words (PageSummary.textOnly). */
export interface PageTextOnlyItem {
  id: string;
  name: string;
  why: AnchorOverflowWhy;
  /** "This model keeps 4 characters on model per page. FROG is described in words on this page." */
  text: string;
}
export interface PageDetail {
  panels: number;
  /** Panels with an art direction. */
  directions: number;
  /** The page records continuity changes. */
  continuity: boolean;
  /** The page's scene: from the ledger, or derived from its places. */
  scene?: { name: string; from: 'ledger' | 'derived' };
  /** What changed since the current drawing, when it carries staleness parts ("Panel 2: who's in it"). */
  changed?: string[];
}
export interface PageLintItem {
  kind: ContinuityIssueKind | DirectionIssueKind;
  severity: 'minor' | 'major';
  text: string;
  /** Panel number, for direction problems. */
  panel?: number;
}

/** summarizeBook's Ship 2 view: the anchor run options plus the job rating used to rank photos (absent = summarizeBook's
 *  own `rating`, else the doc's effective rating). */
export interface ConsistencyViewOptions extends AnchorRunOptions {
  rating?: ContentRating;
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
  /** Ship 2 (B4), with the `consistency` option: the anchors "Render all" draws first and what they add to its quote. */
  anchors?: {
    mode: AnchorRunOptions['mode'];
    kinds: AnchorKinds;
    /** Missing anchors of the pages "Render all" draws, as its quote counts them: unticked ones are `skipped`, ones no
     *  page can attach under the model's caps are `unused` (with the words why); neither is drawn or quoted. */
    missing: MissingAnchor[];
    /** The anchor sheets and the reference allowance inside totals.toDrawUsd. */
    usd: number;
    extraRefs: number;
  };
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
    /** Ship 2 (B4): per-page anchors, text-only cast, detail and lint, and anchors in the quotes. Absent = today's
     *  summary, byte for byte. */
    consistency?: ConsistencyViewOptions;
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
  // The view ranks photos with its own rating, else summarizeBook's (one rating for the safety badges and the anchors).
  const viewRating = opts.consistency?.rating ?? opts.rating;
  const view = opts.consistency
    ? consistencyView(doc, { ...opts.consistency, ...(viewRating ? { rating: viewRating } : {}) }, { byok: opts.byok, tier, modelOverride: override })
    : undefined;
  const runAnchors = view?.run ? { anchors: view.run } : {};
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
      const boxes = fitBoxesFor(doc, p);
      const check = p.panels.length ? checkPagePlan(doc, p, boxes ? { meter, boxes, fixLayout: false } : { meter }) : undefined;
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
      if (drawable.has(p.id)) summary.quoteUsd = view ? round4(page1.usd + view.extraUsd(p.id)) : page1.usd;
      else if (p.render.status === 'ready' && p.panels.length) {
        // The gate's own forced quote: a new take also draws any missing lead/support sheet first.
        summary.redrawUsd = quoteRenderPages(doc, { pageIds: [p.id], force: true, byok: opts.byok, tier, modelOverride: override, ...runAnchors }).usd;
      }
      if (view) Object.assign(summary, view.page(p));
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
      ...renderAllTotals(doc, { byok: opts.byok, tier, modelOverride: override, drawOverfull: [...anyway], meter, ...runAnchors })
    },
    pricing: { model: page1.model, pageUsd: page1.usd, coverUsd: cover1.usd, tier, byok: opts.byok, locked: !!override || !!quoteLockOf(doc) },
    moments: momentsLine(doc, page1.usd),
    budgetUnit: textUnitFor(doc.format.language).unit,
    ...(view ? { anchors: view.book(anyway, meter) } : {})
  };
}

/**
 * summarizeBook's Ship 2 view (B4): one anchor plan per page on the model the next drawing uses, the run's missing
 * anchors and reference allowance (mode 'auto'), staleness parts, and the continuity and direction lint by page.
 */
const consistencyView = (doc: ComicDoc, o: ConsistencyViewOptions, q: { byok: boolean; tier: QualityTier; modelOverride?: string }) => {
  const lock = quoteLockOf(doc);
  const spec = resolveImageJob('page', q.tier, q.modelOverride, lock).spec;
  const targets = pageTargets(doc);
  const at: AnchorRunAt = { spec, lock, ...(o.rating ? { rating: o.rating } : {}) };
  const run = anchorRunOf(doc, targets, missingSheetsFor(doc, targets), o, at);
  const assumeDrawn = new Set(targets.map((p) => p.id));
  const extra = o.mode === 'auto' ? extraRefsByPage(doc, targets, run, { ...at, layoutGuide: o.layoutGuide }) : new Map<string, number>();
  const lint = new Map<string, PageLintItem[]>();
  const note = (pageId: string, item: PageLintItem) => lint.set(pageId, [...(lint.get(pageId) ?? []), item]);
  for (const i of lintContinuity(doc)) note(i.pageId, { kind: i.kind, severity: i.severity, text: i.text });
  for (const i of lintDirections(doc)) note(i.pageId, { kind: i.kind, severity: i.severity, text: i.text, panel: i.panel });
  const runOpts: AnchorRunOptions = { mode: o.mode, ...(o.kinds ? { kinds: o.kinds } : {}), ...(o.layoutGuide ? { layoutGuide: true } : {}) };
  return {
    run: o.mode === 'auto' ? runOpts : undefined,
    extraUsd: (pageId: string): number => extraRefsUsd(spec, extra.get(pageId) ?? 0, q.byok),
    page: (p: Page): Pick<PageSummary, 'anchors' | 'textOnly' | 'detail' | 'lint'> => {
      // viewReady: an anchor no page can attach is planned as ready, so the page names the cap that leaves it in words.
      const plan = planAnchors(doc, p, spec, lock ?? null, { kinds: run.kinds, layoutGuide: o.layoutGuide, rating: o.rating, assumeReady: run.viewReady, assumeDrawn });
      const state = resolveContinuity(doc, p);
      const changed = staleReasons(doc, p).map((r) => r.text);
      const textOnly = plan.overflow
        .filter((x) => x.role === 'character' || x.role === 'prop' || x.role === 'place')
        .map((x) => ({ id: x.id, name: x.name, why: x.why, text: x.text }));
      const detail: PageDetail = {
        panels: p.panels.length,
        directions: p.panels.filter((panel) => panel.direction).length,
        continuity: !!p.continuity,
        ...(state?.scene && state.sceneFrom !== 'none' ? { scene: { name: state.scene.name, from: state.sceneFrom } } : {}),
        ...(changed.length ? { changed } : {})
      };
      return {
        anchors: plan.attached.map((a) => ({ key: a.key, role: a.role, name: a.name, source: a.source, ...(a.path ? { path: a.path } : {}), ...(a.pending ? { pending: true as const } : {}) })),
        textOnly,
        detail,
        ...(lint.get(p.id)?.length ? { lint: lint.get(p.id) } : {})
      };
    },
    book: (anyway: Set<string>, meter: NeedMeter): NonNullable<BookSummary['anchors']> => {
      const all = quoteRenderPages(doc, { byok: q.byok, tier: q.tier, modelOverride: q.modelOverride, holdBack: { drawOverfull: [...anyway], meter }, ...(o.mode === 'auto' ? { anchors: runOpts } : {}) });
      const plain = quoteRenderPages(doc, { byok: q.byok, tier: q.tier, modelOverride: q.modelOverride, holdBack: { drawOverfull: [...anyway], meter } });
      return {
        mode: o.mode,
        kinds: run.kinds,
        // The quote's own list: the pages "Render all" draws, each anchor flagged skipped / unused as the quote counts it.
        missing: all.anchors?.missing ?? [],
        usd: round4(all.usd - plain.usd),
        extraRefs: all.anchors?.extraRefs ?? 0
      };
    }
  };
};

/** "Render all" for the totals: held-back pages excluded (and counted) unless the user chose to draw them anyway. */
const renderAllTotals = (
  doc: ComicDoc,
  o: { byok: boolean; tier: QualityTier; modelOverride?: string; drawOverfull: string[]; meter: NeedMeter; anchors?: AnchorRunOptions }
): { toDrawUsd: number; heldBack?: number } => {
  const q = quoteRenderPages(doc, {
    byok: o.byok,
    tier: o.tier,
    modelOverride: o.modelOverride,
    holdBack: { drawOverfull: o.drawOverfull, meter: o.meter },
    ...(o.anchors ? { anchors: o.anchors } : {})
  });
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
