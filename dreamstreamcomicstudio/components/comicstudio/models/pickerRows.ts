// What the picker shows per model, and in which order (models.md §2.4 R2, §3.6 B, §3.7). Pure: the doc, the
// user's caps, the catalog rows and a price book in; row models out. Every figure keeps its source (the catalog
// row it came from) so the view can say where and when it was measured.
//
// Order (R2): fit first (a model with a blocking reason drops to the bottom; one that cannot fit this comic's
// pages comes after the ones that can), then quality (public edit leaderboards), then price per page, then
// resilience (providers, then their 24 h uptime). Easy shows the 3 best-fitting models a user may pick (the
// suggested and the current model are kept in view); "Compare all" / Pro shows every row, sortable.

import type { ComicDoc, Resolution } from '../../../shared/comic/doc';
import type { StudioCaps } from '../../../shared/comic/capabilities';
import type { ModelCatalogRow, QualityEntry } from '../../../shared/comic/modelCatalog';
import { lockedModelId, modelFit, redrawResolution, type FitReason } from '../../../shared/comic/modelLock';
import { TIER_PRESETS, getImageModel, resolveImageJob, type ImageModelSpec } from '../../../shared/comic/models';
import type { ClientPriceBook, ClientQuote } from './priceBook';
import { DISABLED, ago, dateLabel, fromPriceList, pricesOpenRouter, rankingAa, rankingLmarena } from './copy';

export type PickerSort = 'fit' | 'price' | 'quality' | 'reliability';
export const PICKER_SORTS: readonly PickerSort[] = ['fit', 'price', 'quality', 'reliability'];
/** Easy shows at most this many models (models.md §3.7). */
export const EASY_MAX_ROWS = 3;

/** Warnings that say the model cannot hold this comic as it is (they rank it below the models that can). */
const FIT_WARN_CODES: ReadonlySet<FitReason['code']> = new Set<FitReason['code']>(['characters', 'resolution', 'lettering', 'refs']);

export interface PickerRowModel {
  id: string;
  nickname: string;
  spec?: ImageModelSpec;
  row: ModelCatalogRow;
  fit: FitReason[];
  blocks: FitReason[];
  warns: FitReason[];
  /** A blocking reason: the row cannot be picked (its reasons are shown). */
  disabled: boolean;
  /** The comic's model: locked (or migrated), or the one it will draw with before the lock. */
  current: boolean;
  /** The tier's default model. */
  isDefault: boolean;
  experimental: boolean;
  suggested: boolean;
  pickable: boolean;
  /** The resolution the per-page price is quoted at (the tier's page size on this model; 1K for fixed-size models). */
  pageRes: Resolution;
  /** One page for THIS user: (unit + QC) × markup unless BYOK; null = no basis (never shown as a number). */
  pageUsd: number | null;
  quote: ClientQuote;
  characters: number;
  providers: number;
  /** Best 24 h uptime among the model's OpenRouter endpoints (null = none reported). */
  uptime1d: number | null;
  lmarenaEdit?: QualityEntry;
  aaEdit?: QualityEntry;
  fitGroup: 0 | 1 | 2;
}

/** True when the comic has a lock (persisted, or derived from a legacy doc's drawn images). */
export const isLocked = (doc: ComicDoc): boolean => !!lockedModelId(doc);

/** The comic's model: the lock, else what its pages would draw with now (override, else the tier's model). */
export const currentModelId = (doc: ComicDoc): string =>
  lockedModelId(doc) ?? resolveImageJob('page', doc.settings.quality, doc.settings.imageModelOverride).spec.id;

export const modelNickname = (id: string): string => getImageModel(id)?.nickname || id;

/** The resolution a model's per-page price is quoted at for this comic. */
export const pagePriceRes = (doc: ComicDoc, spec: ImageModelSpec): Resolution => (spec.resolutions.length ? redrawResolution(doc, spec.id, 'page') : '1K');

const best = (entries: QualityEntry[], board: QualityEntry['board']): QualityEntry | undefined =>
  entries.filter((e) => e.board === board && typeof e.rank === 'number').sort((a, b) => (b.asOf > a.asOf ? 1 : b.asOf < a.asOf ? -1 : 0))[0];

export interface BuildRowsInput {
  doc: ComicDoc;
  caps: StudioCaps;
  rows: readonly ModelCatalogRow[];
  prices: ClientPriceBook;
  byok: boolean;
  suggest?: string;
}

export const buildPickerRows = ({ doc, caps, rows, prices, byok, suggest }: BuildRowsInput): PickerRowModel[] => {
  const currentId = currentModelId(doc);
  const tierDefault = TIER_PRESETS[doc.settings.quality]?.model;
  const suggestId = suggest ? getImageModel(suggest)?.id ?? suggest : undefined;
  return rows.map((row) => {
    const spec = getImageModel(row.id);
    const id = spec?.id ?? row.id;
    // The registry the client was built with judges fit (the same pure modelFit the server runs); a model this
    // client does not know cannot be quoted here, so it is shown but never offered.
    const fit: FitReason[] = spec ? modelFit(spec, doc, caps, prices) : row.fit?.length ? row.fit : [{ code: 'hidden', severity: 'block', text: DISABLED.unavailable }];
    const blocks = fit.filter((f) => f.severity === 'block');
    const warns = fit.filter((f) => f.severity === 'warn');
    const current = id === currentId;
    const pageRes = spec ? pagePriceRes(doc, spec) : '1K';
    const uptimes = row.endpoints.map((e) => e.uptime1d).filter((u): u is number => typeof u === 'number');
    const lmarenaEdit = best(row.quality, 'lmarena_edit');
    const aaEdit = best(row.quality, 'aa_edit');
    return {
      id,
      nickname: spec?.nickname || row.nickname,
      ...(spec ? { spec } : {}),
      row,
      fit,
      blocks,
      warns,
      disabled: blocks.length > 0 && !current,
      current,
      isDefault: id === tierDefault,
      experimental: (spec?.lifecycle ?? row.lifecycle) === 'experimental',
      suggested: !!suggestId && id === suggestId && !current,
      pickable: spec ? spec.pickable : row.pickable,
      pageRes,
      pageUsd: spec ? prices.pagePrice(id, pageRes, byok) : null,
      quote: prices.quote(id, pageRes, 'page'),
      characters: spec?.refs.characters ?? 0,
      providers: row.endpoints.length,
      uptime1d: uptimes.length ? Math.max(...uptimes) : null,
      ...(lmarenaEdit ? { lmarenaEdit } : {}),
      ...(aaEdit ? { aaEdit } : {}),
      fitGroup: blocks.length ? 2 : warns.some((w) => FIT_WARN_CODES.has(w.code)) ? 1 : 0
    };
  });
};

const byNumberAsc = (a: number | null | undefined, b: number | null | undefined) => {
  const x = typeof a === 'number' ? a : Infinity;
  const y = typeof b === 'number' ? b : Infinity;
  return x === y ? 0 : x < y ? -1 : 1;
};
const quality = (a: PickerRowModel, b: PickerRowModel) => byNumberAsc(a.lmarenaEdit?.rank, b.lmarenaEdit?.rank) || byNumberAsc(a.aaEdit?.rank, b.aaEdit?.rank);
const price = (a: PickerRowModel, b: PickerRowModel) => byNumberAsc(a.pageUsd, b.pageUsd);
const negated = (u: number | null) => (u === null ? null : -u);
/** More providers first, then the higher 24 h uptime (unknown last). */
const resilience = (a: PickerRowModel, b: PickerRowModel) => b.providers - a.providers || byNumberAsc(negated(a.uptime1d), negated(b.uptime1d));
const fitOrder = (a: PickerRowModel, b: PickerRowModel) => a.fitGroup - b.fitGroup || quality(a, b) || price(a, b) || resilience(a, b);

/** Rows in the requested order; rows that cannot be picked always come last. Stable. */
export const sortPickerRows = (rows: readonly PickerRowModel[], sort: PickerSort = 'fit'): PickerRowModel[] => {
  const cmp: Record<PickerSort, (a: PickerRowModel, b: PickerRowModel) => number> = {
    fit: fitOrder,
    price: (a, b) => price(a, b) || fitOrder(a, b),
    quality: (a, b) => quality(a, b) || fitOrder(a, b),
    reliability: (a, b) => resilience(a, b) || fitOrder(a, b)
  };
  return rows
    .map((row, i) => ({ row, i }))
    .sort((x, y) => Number(x.row.disabled) - Number(y.row.disabled) || cmp[sort](x.row, y.row) || x.i - y.i)
    .map((x) => x.row);
};

/**
 * Easy: the best-fitting models the user may pick (at most EASY_MAX_ROWS), keeping the suggested model and the
 * comic's own model in view by replacing the lowest-ranked of the others.
 */
export const easyPickerRows = (sorted: readonly PickerRowModel[], max = EASY_MAX_ROWS): PickerRowModel[] => {
  const candidates = sorted.filter((r) => r.pickable || r.current || r.suggested);
  const shown = candidates.slice(0, max);
  for (const must of [candidates.find((r) => r.suggested), candidates.find((r) => r.current)]) {
    if (!must || shown.includes(must)) continue;
    const replaceAt = [...shown].reverse().findIndex((r) => !r.suggested && !r.current);
    if (replaceAt === -1) continue;
    shown[shown.length - 1 - replaceAt] = must;
  }
  // Keep the sorted order after replacements.
  return sorted.filter((r) => shown.includes(r));
};

/** The picker footer's sources: where the prices and the rankings come from, and when. */
export const footerSources = (rows: readonly ModelCatalogRow[], now: number, fallbackFactsAsOf: string): { prices: string; rankings: string[] } => {
  const catalogTimes = rows.map((r) => r.fetchedAt?.catalog).filter((t): t is string => !!t).sort();
  const newest = catalogTimes[catalogTimes.length - 1];
  const allStale = rows.length > 0 && rows.every((r) => r.stale);
  const prices = newest ? pricesOpenRouter(allStale ? `as of ${ago(newest, now)} · couldn't refresh` : ago(newest, now)) : fromPriceList(fallbackFactsAsOf);
  const entries = rows.flatMap((r) => r.quality);
  const latest = (pred: (e: QualityEntry) => boolean) =>
    entries.filter(pred).sort((a, b) => (a.asOf < b.asOf ? 1 : a.asOf > b.asOf ? -1 : 0))[0];
  const lm = latest((e) => e.board.startsWith('lmarena'));
  const aa = latest((e) => e.board.startsWith('aa_'));
  const rankings = [
    ...(lm ? [rankingLmarena(dateLabel(lm.asOf))] : []),
    ...(aa ? [rankingAa(dateLabel(aa.asOf), /openrouter/i.test(aa.source))] : [])
  ];
  return { prices, rankings };
};
