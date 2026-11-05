// Per-comic cost and model insights (models.md §4.2). Pure functions over `doc` — every number traces to
// doc.spend (entries, byKind, the §3.3 running totals) or to the drawn assets themselves. Nothing is estimated
// here: when a figure is not in the doc, the row says so (`exact: false`, `recentN`), it never invents one.

import {
  aspectFromSize,
  getImageModel,
  type ImageJobKind
} from './models.js';
import { MAX_SPEND_ENTRIES } from './limits.js';
import { renderTargetKey, type AspectRatio, type ComicDoc, type RenderState, type RenderTarget, type Resolution, type SpendEntry, type SpendKind } from './doc.js';
import { isImageCallEntry, spendTotalsFromEntries } from './ops.js';
import { lockedModelId } from './modelLock.js';
import type { PriceBook } from './modelLock.js';

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Display order of spend kinds (Translate included — the old SPEND_ORDER left it out). */
export const INSIGHTS_KIND_ORDER: readonly SpendKind[] = ['page', 'cover', 'sheet', 'edit', 'style', 'qc', 'plan', 'chat', 'translate'];

export interface InsightsOverview {
  totalUsd: number;
  /** Non-zero kinds only, in INSIGHTS_KIND_ORDER. */
  byKind: { kind: SpendKind; usd: number }[];
  /** "Free, done by the editor, no AI cost" (decisions-final #6). */
  savedUsd: number;
  failed: { count: number; usd: number };
  /** Paid by the user's own key vs by the platform (from entries.byok). */
  byok: { usd: number; images: number };
  platform: { usd: number; images: number };
  /** Entries whose cost is the registry estimate (the provider reported none). */
  estimated: number;
  /** False when the entry list hit its cap: per-entry splits (byok, estimated) then cover the recent entries only. */
  exact: boolean;
}

const entriesComplete = (doc: ComicDoc) => doc.spend.entries.length < MAX_SPEND_ENTRIES;

/** Failed attempts: the running total when present, else rebuilt from the entries held. */
export const failedOf = (doc: ComicDoc): { count: number; usd: number } =>
  doc.spend.failed ?? spendTotalsFromEntries(doc.spend.entries).failed;

/** "Saved by software": the running total and how many entries carried a saving. */
export const savedOf = (doc: ComicDoc): { usd: number; count: number } => ({
  usd: doc.spend.savedUsd ?? 0,
  count: doc.spend.entries.filter((e) => (e.savedUsd ?? 0) > 0).length
});

export const overviewOf = (doc: ComicDoc): InsightsOverview => {
  const byKind = INSIGHTS_KIND_ORDER.map((kind) => ({ kind, usd: doc.spend.byKind[kind] || 0 })).filter((x) => x.usd > 0);
  const byok = { usd: 0, images: 0 };
  const platform = { usd: 0, images: 0 };
  let estimated = 0;
  for (const e of doc.spend.entries) {
    const bucket = e.byok ? byok : platform;
    bucket.usd = round4(bucket.usd + (Number.isFinite(e.usd) ? e.usd : 0));
    if (isImageCallEntry(e) && e.outcome !== 'failed') bucket.images += 1;
    if (e.estimated) estimated += 1;
  }
  return { totalUsd: doc.spend.totalUsd, byKind, savedUsd: savedOf(doc).usd, failed: failedOf(doc), byok, platform, estimated, exact: entriesComplete(doc) };
};

export interface TargetRow {
  key: string;
  target: RenderTarget;
  /** "Cover", "Page 3", "MAYA sheet", "DOCKS". */
  label: string;
  /** Spent on this target: the running total, else the sum of entries with this target. */
  spentUsd: number;
  /** Render history length + 1 when an image exists. */
  versions: number;
  model?: string;
  nickname?: string;
  res?: Resolution;
  w?: number;
  h?: number;
  aspect?: AspectRatio;
  /** Quiet badges: the size when the book mixes sizes, 'older model' when drawn on another model than the lock. */
  badges: string[];
  /** ≈ cost to redraw now on the locked model (unit + QC for pages), when a PriceBook is given and has a price. */
  redrawUsd?: number | null;
}

const targetLabelOf = (doc: ComicDoc, t: RenderTarget): string => {
  switch (t.kind) {
    case 'cover':
      return 'Cover';
    case 'page': {
      const p = doc.pages.find((x) => x.id === t.id);
      return p ? `Page ${p.n}` : 'Page';
    }
    case 'sheet': {
      const c = doc.cast.find((x) => x.id === t.id);
      return c ? `${c.name.toUpperCase()} sheet` : 'Character sheet';
    }
    case 'place': {
      const p = doc.places.find((x) => x.id === t.id);
      return p ? p.name.toUpperCase() : 'Place';
    }
    default:
      return 'Style option';
  }
};

const kindOfTarget = (t: RenderTarget): ImageJobKind => (t.kind === 'style_option' ? 'style_option' : t.kind);

/** One row per target (cover, pages in book order, sheets, places) that has or had an image. */
export const byTarget = (doc: ComicDoc, prices?: PriceBook): TargetRow[] => {
  const locked = lockedModelId(doc);
  const spentFromEntries = new Map<string, number>();
  if (!doc.spend.byTarget) {
    for (const e of doc.spend.entries) if (e.target) spentFromEntries.set(e.target, round4((spentFromEntries.get(e.target) || 0) + (Number.isFinite(e.usd) ? e.usd : 0)));
  }
  const targets: { target: RenderTarget; render: RenderState }[] = [
    { target: { kind: 'cover' }, render: doc.cover.render },
    ...doc.pages.map((p) => ({ target: { kind: 'page', id: p.id } as RenderTarget, render: p.render })),
    ...doc.cast.map((c) => ({ target: { kind: 'sheet', id: c.id } as RenderTarget, render: c.sheet })),
    ...doc.places.map((p) => ({ target: { kind: 'place', id: p.id } as RenderTarget, render: p.sheet }))
  ];
  const rows: TargetRow[] = [];
  for (const { target, render } of targets) {
    const key = renderTargetKey(target);
    const spent = doc.spend.byTarget ? doc.spend.byTarget[key] || 0 : spentFromEntries.get(key) || 0;
    const hasImage = !!render.asset;
    if (!hasImage && !render.history.length && spent === 0) continue;
    const model = render.asset?.model || render.model;
    const row: TargetRow = {
      key,
      target,
      label: targetLabelOf(doc, target),
      spentUsd: spent,
      versions: hasImage ? render.history.length + 1 : render.history.length,
      badges: []
    };
    if (model) {
      row.model = model;
      const spec = getImageModel(model);
      if (spec) row.nickname = spec.nickname;
      if (locked && model !== locked) row.badges.push('older model');
    }
    if (render.resolution) row.res = render.resolution;
    if (render.asset?.w && render.asset?.h) {
      row.w = render.asset.w;
      row.h = render.asset.h;
      row.aspect = aspectFromSize(render.asset.w, render.asset.h);
    }
    if (prices && locked && hasImage) {
      const kind = kindOfTarget(target);
      const unit = prices.unit(locked, render.resolution || '1K', kind, 0);
      row.redrawUsd = unit.usd === null ? null : round4(unit.usd + (kind === 'page' ? prices.qcUsd : 0));
    }
    rows.push(row);
  }
  const sizes = new Set(rows.map((r) => r.res).filter(Boolean));
  if (sizes.size > 1) for (const r of rows) if (r.res) r.badges.unshift(r.res);
  return rows;
};

export interface ModelSizeRow {
  res?: Resolution;
  /** Successful image calls with a recorded cost. */
  n: number;
  avgUsd: number;
  /** Average list price at the time, when the entries recorded one. */
  avgListUsd?: number;
}

export interface ModelRow {
  modelId: string;
  nickname?: string;
  images: number;
  usd: number;
  failed: number;
  sizes: ModelSizeRow[];
}

export interface ModelsInsights {
  rows: ModelRow[];
  /** True when the totals are the §3.3 running totals or the entry list is complete. */
  exact: boolean;
  /** When not exact: how many recent entries the rebuild covers ("(recent 200)"). */
  recentN?: number;
}

/** Models used by this comic: images, $, failed; per size the average real $ per image vs list. */
export const byModel = (doc: ComicDoc): ModelsInsights => {
  const exact = !!doc.spend.byModel || entriesComplete(doc);
  const totals = doc.spend.byModel ?? spendTotalsFromEntries(doc.spend.entries).byModel;
  const sizes = new Map<string, Map<string, { n: number; usd: number; list: number; listN: number }>>();
  for (const e of doc.spend.entries) {
    if (!isImageCallEntry(e) || e.outcome === 'failed') continue;
    const perModel = sizes.get(e.model!) ?? new Map();
    const key = e.res || '';
    const cell = perModel.get(key) ?? { n: 0, usd: 0, list: 0, listN: 0 };
    cell.n += 1;
    cell.usd += Number.isFinite(e.usd) ? e.usd : 0;
    if (typeof e.listUsd === 'number' && Number.isFinite(e.listUsd)) {
      cell.list += e.listUsd;
      cell.listN += 1;
    }
    perModel.set(key, cell);
    sizes.set(e.model!, perModel);
  }
  const ids = new Set<string>([...Object.keys(totals), ...sizes.keys()]);
  const rows: ModelRow[] = [...ids].map((modelId) => {
    const t = totals[modelId] || { usd: 0, images: 0, failed: 0 };
    const perModel = sizes.get(modelId);
    const sizeRows: ModelSizeRow[] = perModel
      ? [...perModel.entries()].map(([res, c]) => ({
          ...(res ? { res: res as Resolution } : {}),
          n: c.n,
          avgUsd: round4(c.usd / c.n),
          ...(c.listN ? { avgListUsd: round4(c.list / c.listN) } : {})
        }))
      : [];
    const spec = getImageModel(modelId);
    return { modelId, ...(spec ? { nickname: spec.nickname } : {}), images: t.images, usd: t.usd, failed: t.failed, sizes: sizeRows };
  });
  rows.sort((a, b) => b.usd - a.usd || b.images - a.images || a.modelId.localeCompare(b.modelId));
  return exact ? { rows, exact } : { rows, exact, recentN: doc.spend.entries.length };
};

export interface ObservedVsList {
  modelId: string;
  res?: Resolution;
  n: number;
  avgUsd: number;
  minUsd: number;
  maxUsd: number;
  avgListUsd: number;
}

/** Real provider-reported cost vs the list price at the time, per model and size (entries that recorded listUsd). */
export const observedVsList = (doc: ComicDoc): ObservedVsList[] => {
  const cells = new Map<string, { modelId: string; res?: Resolution; usd: number[]; list: number }>();
  for (const e of doc.spend.entries) {
    if (!isImageCallEntry(e) || e.outcome === 'failed' || e.estimated || typeof e.listUsd !== 'number' || !Number.isFinite(e.listUsd)) continue;
    const key = `${e.model}|${e.res || ''}`;
    const cell = cells.get(key) ?? { modelId: e.model!, ...(e.res ? { res: e.res } : {}), usd: [], list: 0 };
    cell.usd.push(Number.isFinite(e.usd) ? e.usd : 0);
    cell.list += e.listUsd;
    cells.set(key, cell);
  }
  return [...cells.values()].map((c) => ({
    modelId: c.modelId,
    ...(c.res ? { res: c.res } : {}),
    n: c.usd.length,
    avgUsd: round4(c.usd.reduce((s, u) => s + u, 0) / c.usd.length),
    minUsd: Math.min(...c.usd),
    maxUsd: Math.max(...c.usd),
    avgListUsd: round4(c.list / c.usd.length)
  }));
};

/** The entries of one target, newest first (the Pages tab's per-row detail). */
export const entriesForTarget = (doc: ComicDoc, target: RenderTarget): SpendEntry[] => {
  const key = renderTargetKey(target);
  return doc.spend.entries.filter((e) => e.target === key);
};
