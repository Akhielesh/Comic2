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
  type LetteringMode,
  type Page,
  type PanelSize,
  type QualityTier,
  type RenderState,
  type ShotType
} from './doc.js';
import { aspectMatches, estimateJobs, getImageModel, resolveImageJob, type SpendEstimate } from './models.js';
import { panelBoxesFor } from './pageGeometry.js';
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

export interface RenderQuote extends SpendEstimate { pageIds: string[]; sheetIds: string[]; cover: boolean; nothing: boolean }

/**
 * Quote a render_pages action exactly as the server's gate would (same targets, same registry
 * estimate, same line labels). `includeCover` adds the cover only when it needs drawing (or when
 * forced and not busy). `nothing` ⇒ $0: every requested page is already drawn and current.
 */
export function quoteRenderPages(
  doc: ComicDoc,
  opts: { pageIds?: string[]; force?: boolean; includeCover?: boolean; byok: boolean; tier: QualityTier; modelOverride?: string }
): RenderQuote {
  const pages = pageTargets(doc, opts);
  const sheets = missingSheetsFor(doc, pages);
  const cover = !!opts.includeCover && (opts.force ? !isBusy(doc.cover.render) : coverNeedsDraw(doc));
  const est = estimateJobs(
    [
      { kind: 'page', count: pages.length, label: 'pages' },
      { kind: 'sheet', count: sheets.length, label: 'character sheets' },
      { kind: 'cover', count: cover ? 1 : 0, label: 'cover' }
    ],
    opts.tier,
    { override: opts.modelOverride, byok: opts.byok }
  );
  return { ...est, pageIds: pages.map((p) => p.id), sheetIds: sheets.map((c) => c.id), cover, nothing: !pages.length && !sheets.length && !cover };
}

/** Registry price of ONE image of a kind for this doc right now (tier + model override; QC included for pages/edits). */
export function unitPrice(
  doc: ComicDoc,
  kind: 'page' | 'cover' | 'sheet' | 'edit',
  opts: { byok: boolean; tier?: QualityTier; modelOverride?: string }
): { usd: number; model: string } {
  const tier = opts.tier ?? doc.settings.quality;
  const override = opts.modelOverride ?? doc.settings.imageModelOverride;
  const est = estimateJobs([{ kind, count: 1, label: kind }], tier, { override, byok: opts.byok });
  return { usd: est.usd, model: resolveImageJob(kind, tier, override).spec.nickname };
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

export interface PanelSummary { n: number; box: Box; shot: ShotType; size: PanelSize; castIds: string[]; speech: number; captions: number; sfx: number; words: number }
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
  /** Price of a forced new take of a drawn page (render_pages force), for "New take · ≈$X". */
  redrawUsd?: number;
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
  totals: { pages: number; panels: number; lines: number; drawn: number; stale: number; spentUsd: number; savedUsd: number; toDrawUsd: number };
  /** What the next drawing runs on (registry facts, no guesses). */
  pricing?: { model: string; pageUsd: number; coverUsd: number; tier: QualityTier; byok: boolean; locked: boolean };
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

export function summarizeBook(doc: ComicDoc, opts: { pageIds?: string[]; byok: boolean; tier?: QualityTier; rating?: ContentRating }): BookSummary {
  const tier = opts.tier ?? doc.settings.quality;
  const override = doc.settings.imageModelOverride;
  const page1 = unitPrice(doc, 'page', { byok: opts.byok, tier, modelOverride: override });
  const cover1 = unitPrice(doc, 'cover', { byok: opts.byok, tier, modelOverride: override });
  const ids = Array.isArray(opts.pageIds) && opts.pageIds.length ? new Set(opts.pageIds) : null;
  const drawable = new Set(pageTargets(doc).map((p) => p.id));
  const ledger = spendByTarget(doc);
  const pages: PageSummary[] = [...doc.pages]
    .sort((a, b) => a.n - b.n)
    .filter((p) => (ids ? ids.has(p.id) : true))
    .map((p) => {
      const boxes = panelBoxesFor(doc, p);
      const castIds = [...new Set(p.panels.flatMap((panel) => panel.castIds))];
      const asset = p.render.asset;
      const summary: PageSummary = {
        id: p.id,
        n: p.n,
        summary: p.summary,
        panels: p.panels.map((panel, i) => ({
          n: panel.n,
          box: boxes[i] ?? { x: 0, y: 0, w: 1, h: 1 },
          shot: panel.shot,
          size: panel.size,
          castIds: panel.castIds,
          speech: panel.lines.filter((l) => l.kind !== 'caption' && l.kind !== 'sfx').length,
          captions: panel.lines.filter((l) => l.kind === 'caption').length,
          sfx: panel.lines.filter((l) => l.kind === 'sfx').length,
          words: panel.lines.reduce((n, l) => n + words(l.text), 0)
        })),
        castIds,
        missingRefCastIds: doc.cast.filter((c) => castIds.includes(c.id) && c.tier !== 'extra' && c.sheet.status !== 'ready' && !c.refs.length).map((c) => c.id),
        status: statusOf(p.render, isPageStale(doc, p))
      };
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
      else if (p.render.status === 'ready' && p.panels.length) summary.redrawUsd = page1.usd;
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
      toDrawUsd: quoteRenderPages(doc, { byok: opts.byok, tier, modelOverride: override }).usd
    },
    pricing: { model: page1.model, pageUsd: page1.usd, coverUsd: cover1.usd, tier, byok: opts.byok, locked: !!override }
  };
}
