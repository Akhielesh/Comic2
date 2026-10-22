// Single target/estimate core for "what would be drawn and what it costs" (contract §11.2).
// WAVE-0: real pageTargets/sheetTargets (no force ⇒ undrawn/stale/failed only, never busy) and a
// registry quote; P1-BOOKMODEL owns it in wave 1 (moving jobs.ts / PlanCard / boardModel logic here).

import {
  coverSpecHash,
  isPageStale,
  thumbOf,
  type Character,
  type ComicDoc,
  type LetteringMode,
  type Page,
  type PanelSize,
  type QualityTier,
  type RenderState,
  type ShotType,
  type Box
} from './doc.js';
import { aspectMatches, estimateJobs, tierPagePrice, type SpendEstimate } from './models.js';
import { panelBoxesFor } from './pageGeometry.js';
import { safetyStatusOf, type ContentRating, type SafetyStatus } from './safety.js';

const isBusy = (r?: RenderState) => !!r && (r.status === 'queued' || r.status === 'rendering');
const round4 = (n: number) => Math.round(n * 10000) / 10000;

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

/** Lead/support cast appearing on these pages that has no usable sheet yet. */
export function missingSheetsFor(doc: ComicDoc, pages: Page[]): Character[] {
  const ids = new Set(pages.flatMap((p) => p.panels.flatMap((panel) => panel.castIds)));
  return doc.cast.filter((c) => ids.has(c.id) && sheetWanted(c));
}

export function coverNeedsDraw(doc: ComicDoc): boolean {
  const r = doc.cover.render;
  if (isBusy(r)) return false;
  if (r.status !== 'ready') return true;
  return !!r.specHash && r.specHash !== coverSpecHash(doc);
}

export interface RenderQuote extends SpendEstimate { pageIds: string[]; sheetIds: string[]; cover: boolean; nothing: boolean }

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

export interface PanelSummary { n: number; box: Box; shot: ShotType; size: PanelSize; castIds: string[]; speech: number; captions: number; sfx: number; words: number }
export interface PageSummary {
  id: string; n: number; summary: string; turnHook?: string; chapterTitle?: string;
  panels: PanelSummary[]; castIds: string[]; missingRefCastIds: string[];
  status: 'planned' | 'queued' | 'rendering' | 'ready' | 'stale' | 'failed' | 'custom';
  aspectOk?: boolean; costUsd?: number; quoteUsd?: number; qcScore?: number; thumbPath?: string;
  safety?: SafetyStatus;
}
export interface BookSummary {
  pages: PageSummary[];
  cover: { status: PageSummary['status']; title: string; quoteUsd?: number; thumbPath?: string; lettering: LetteringMode };
  totals: { pages: number; panels: number; lines: number; drawn: number; stale: number; spentUsd: number; savedUsd: number; toDrawUsd: number };
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

export function summarizeBook(doc: ComicDoc, opts: { pageIds?: string[]; byok: boolean; tier?: QualityTier; rating?: ContentRating }): BookSummary {
  const tier = opts.tier ?? doc.settings.quality;
  const perPage = round4(tierPagePrice(tier, opts.byok));
  const ids = Array.isArray(opts.pageIds) && opts.pageIds.length ? new Set(opts.pageIds) : null;
  const drawable = new Set(pageTargets(doc).map((p) => p.id));
  const pages: PageSummary[] = doc.pages
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
      if (drawable.has(p.id)) summary.quoteUsd = perPage;
      return summary;
    });
  const coverQuote = coverNeedsDraw(doc) ? estimateJobs([{ kind: 'cover', count: 1 }], tier, { override: doc.settings.imageModelOverride, byok: opts.byok }).usd : undefined;
  const all = doc.pages;
  return {
    pages,
    cover: {
      status: statusOf(doc.cover.render, doc.cover.render.status === 'ready' && !!doc.cover.render.specHash && doc.cover.render.specHash !== coverSpecHash(doc)),
      title: doc.cover.title ?? doc.brief.title,
      ...(coverQuote !== undefined ? { quoteUsd: coverQuote } : {}),
      ...(doc.cover.render.asset ? { thumbPath: thumbOf(doc.cover.render.asset, 320)?.path } : {}),
      lettering: doc.cover.lettering ?? 'in_art'
    },
    totals: {
      pages: all.length,
      panels: all.reduce((n, p) => n + p.panels.length, 0),
      lines: all.reduce((n, p) => n + p.panels.reduce((m, panel) => m + panel.lines.length, 0), 0),
      drawn: all.filter((p) => p.render.status === 'ready').length,
      stale: all.filter((p) => isPageStale(doc, p)).length,
      spentUsd: doc.spend.totalUsd,
      savedUsd: doc.spend.savedUsd ?? 0,
      toDrawUsd: quoteRenderPages(doc, { byok: opts.byok, tier, modelOverride: doc.settings.imageModelOverride }).usd
    }
  };
}
