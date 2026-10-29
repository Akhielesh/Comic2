// Model lock helpers (models.md §3.3). Pure: reads never write. The server persists what deriveLock returns
// with the next image commit; the client uses the same functions for honest labels and quotes.

import type { AssetRef, ComicDoc, ImageModelLock, RedrawScope, RenderState, Resolution } from './doc.js';
import type { StudioCaps } from './capabilities.js';
import { PLATFORM_MARKUP, getImageModel, resolveImageJob, type ImageJobKind, type ImageModelSpec } from './models.js';

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** A generated current asset with the model it was drawn on (asset.model, else the render's model). */
const generatedModel = (r: RenderState | undefined): { model: string; at: number } | undefined => {
  const a: AssetRef | undefined = r?.asset;
  if (!a || a.source !== 'generated') return undefined;
  const model = a.model || r?.model;
  if (typeof model !== 'string' || !model) return undefined;
  return { model, at: typeof a.at === 'number' && Number.isFinite(a.at) ? a.at : 0 };
};

/** The persisted lock, else the migration lock of a legacy doc, else undefined (nothing drawn yet). */
export const deriveLock = (doc: ComicDoc): ImageModelLock | undefined => {
  if (doc.imageModel) return doc.imageModel;
  const pages = doc.pages.map((p) => generatedModel(p.render)).filter((x): x is { model: string; at: number } => !!x);
  const others = [
    ...doc.cast.map((c) => generatedModel(c.sheet)),
    ...doc.places.map((p) => generatedModel(p.sheet)),
    generatedModel(doc.cover.render)
  ].filter((x): x is { model: string; at: number } => !!x);
  const all = [...pages, ...others];
  if (!all.length) return undefined;
  const latest = (list: { model: string; at: number }[]) => list.reduce((best, x) => (x.at > best.at ? x : best));
  const override = doc.settings.imageModelOverride;
  const pick =
    override && all.some((a) => a.model === override)
      ? latest(all.filter((a) => a.model === override))
      : pages.length
        ? latest(pages)
        : latest(all);
  return { modelId: pick.model, lockedAt: pick.at, origin: 'migrated' };
};

/** doc.imageModel?.modelId ?? deriveLock(doc)?.modelId */
export const lockedModelId = (doc: ComicDoc): string | undefined => doc.imageModel?.modelId ?? deriveLock(doc)?.modelId;

export interface DrawnTargets {
  pages: string[];
  sheets: string[];
  places: string[];
  cover: boolean;
}

/**
 * Targets whose CURRENT image was generated (uploads, library art and adopted refs are not redrawn). The
 * render status is deliberately ignored: a failed re-render keeps the previous generated asset (ops.ts
 * patchRenderRaw), so that page is still drawn on the old model and must be counted, quoted and redrawn
 * (models.md §3.3 "generated assets only"; §2.3 never under-quotes).
 */
export const drawnTargets = (doc: ComicDoc): DrawnTargets => {
  const drawn = (r: RenderState) => r.asset?.source === 'generated';
  return {
    pages: doc.pages.filter((p) => drawn(p.render)).map((p) => p.id),
    sheets: doc.cast.filter((c) => drawn(c.sheet)).map((c) => c.id),
    places: doc.places.filter((p) => drawn(p.sheet)).map((p) => p.id),
    cover: drawn(doc.cover.render)
  };
};

/** Every model the doc's current generated images were drawn with (legacy mixed books), with counts. */
export const drawnModels = (doc: ComicDoc): { modelId: string; images: number }[] => {
  const counts = new Map<string, number>();
  const add = (r?: RenderState) => {
    const g = generatedModel(r);
    if (g) counts.set(g.model, (counts.get(g.model) || 0) + 1);
  };
  doc.pages.forEach((p) => add(p.render));
  doc.cast.forEach((c) => add(c.sheet));
  doc.places.forEach((p) => add(p.sheet));
  add(doc.cover.render);
  return [...counts.entries()].map(([modelId, images]) => ({ modelId, images })).sort((a, b) => b.images - a.images || a.modelId.localeCompare(b.modelId));
};

/**
 * Prices for a quote (models.md §2.3): the server builds one from the live catalog and observed costs; tests
 * inject hand values. `unit` already includes reference cost on the list basis — redrawQuote never adds it
 * again. usd null = no basis at all ("can't price yet").
 */
export interface PriceBook {
  unit(modelId: string, res: Resolution, kind: ImageJobKind, refs?: number): { usd: number | null; basis: string };
  /** QC per page (observed median when n ≥ 5, else QC_USD_PER_PAGE). */
  qcUsd: number;
}

export interface RedrawQuote {
  /** null when any unit in scope has no price (the UI shows "can't price yet", never a number). */
  usd: number | null;
  lines: { label: string; count: number; usd: number | null }[];
  /** Distinct price bases used, in order of first use. */
  basis: string[];
}

/** The resolution a kind would draw at on `modelId` for this doc's tier (the lock is the new model). */
export const redrawResolution = (doc: ComicDoc, modelId: string, kind: ImageJobKind): Resolution =>
  resolveImageJob(kind, doc.settings.quality, undefined, { modelId, lockedAt: 0, origin: 'user_change' }).resolution;

/**
 * models.md §3.5: Σ over drawn targets in scope of unit(toModel, res(kind), kind, refs) (+ QC per page),
 * × PLATFORM_MARKUP unless BYOK. scope 'pages_cover' = drawn pages + cover; 'all' adds character sheets and
 * places; 'none' = $0. `refs` = reference images per image (the M0 fixture uses 0).
 */
export const redrawQuote = (doc: ComicDoc, toModelId: string, scope: RedrawScope, prices: PriceBook, byok: boolean, refs = 0): RedrawQuote => {
  if (scope === 'none') return { usd: 0, lines: [], basis: [] };
  const targets = drawnTargets(doc);
  const markup = byok ? 1 : PLATFORM_MARKUP;
  const basis: string[] = [];
  const note = (b: string) => {
    if (b && !basis.includes(b)) basis.push(b);
  };
  const lines: RedrawQuote['lines'] = [];
  let total: number | null = 0;
  const line = (label: string, count: number, kind: ImageJobKind, qc: boolean) => {
    if (count <= 0) return;
    const unit = prices.unit(toModelId, redrawResolution(doc, toModelId, kind), kind, refs);
    note(unit.basis);
    if (unit.usd === null || !Number.isFinite(unit.usd)) {
      lines.push({ label, count, usd: null });
      total = null;
      return;
    }
    const usd = round4((unit.usd + (qc ? prices.qcUsd : 0)) * count * markup);
    lines.push({ label, count, usd });
    if (total !== null) total = round4(total + usd);
  };
  line('Pages', targets.pages.length, 'page', true);
  line('Cover', targets.cover ? 1 : 0, 'cover', false);
  if (scope === 'all') {
    line('Character sheets', targets.sheets.length, 'sheet', false);
    line('Places', targets.places.length, 'place', false);
  }
  return { usd: total, lines, basis };
};

export interface FitReason {
  code: 'aspect' | 'characters' | 'resolution' | 'refs' | 'lettering' | 'access' | 'experimental' | 'price_unverified' | 'transport' | 'hidden' | 'price';
  severity: 'block' | 'warn';
  /** Exact picker copy (models.md §3.6 B / C). */
  text: string;
}

/** The everyday model every plan may use (models.md §3.4 item 7.3). */
export const FREE_PLAN_IMAGE_MODEL = 'nano-banana-2.1';

/** Distinct cast on a page (every panel). */
const pageCastCount = (doc: ComicDoc, pageId: string): number => {
  const page = doc.pages.find((p) => p.id === pageId);
  return page ? new Set(page.panels.flatMap((pn) => pn.castIds)).size : 0;
};

/**
 * Why a model does (not) fit this comic, blocks first. Pure over the registry spec, the doc and the user's caps;
 * transport facts that need the server's keys (M1-LOCK-SERVER) are not judged here.
 */
/** A model at least this many times the comic's current model's price per page gets the 'price' warning. */
export const PRICE_WARN_RATIO = 1.5;

const ratioWords = (ratio: number): string => (ratio >= 10 ? String(Math.round(ratio)) : String(Math.round(ratio * 10) / 10));

/**
 * 'price' (models.md §5.1 "Nano Banana Pro (warn: price)"): this model's price per page at the resolution it would
 * draw this comic's pages at, against the comic's current (locked) model's. Only with a price book, only when both
 * prices are known, never for the current model itself; no dollar figure in the copy.
 */
const priceFit = (spec: ImageModelSpec, doc: ComicDoc, prices: PriceBook): FitReason | null => {
  const currentId = lockedModelId(doc);
  const current = currentId ? getImageModel(currentId) : undefined;
  if (!current || current.id === spec.id) return null;
  try {
    const mine = prices.unit(spec.id, redrawResolution(doc, spec.id, 'page'), 'page').usd;
    const theirs = prices.unit(current.id, redrawResolution(doc, current.id, 'page'), 'page').usd;
    if (typeof mine !== 'number' || !Number.isFinite(mine) || typeof theirs !== 'number' || !(theirs > 0)) return null;
    const ratio = mine / theirs;
    if (ratio < PRICE_WARN_RATIO) return null;
    return { code: 'price', severity: 'warn', text: `About ${ratioWords(ratio)}× the price of ${current.nickname} per page` };
  } catch {
    return null;
  }
};

/** `prices` (optional): adds the 'price' warning against the comic's current model (existing callers unchanged). */
export const modelFit = (spec: ImageModelSpec, doc: ComicDoc, caps: StudioCaps, prices?: PriceBook): FitReason[] => {
  const blocks: FitReason[] = [];
  const warns: FitReason[] = [];
  // models.md §3.4 item 7.2: a hidden or deprecated model is allowed only when it is the current lock or the
  // model just switched away from (changes[0].from), so "Switch back" (§3.6 F) keeps working after it was hidden.
  const current = lockedModelId(doc);
  const priorModel = doc.imageModel?.changes?.[0]?.from;
  const allowed = spec.id === current || spec.id === priorModel;
  if (!spec.pickable && !allowed) blocks.push({ code: 'hidden', severity: 'block', text: 'Not available in Comic Studio yet' });
  else if (spec.lifecycle === 'deprecated' && !allowed) blocks.push({ code: 'hidden', severity: 'block', text: 'Not available in Comic Studio yet' });
  if (!Object.values(spec.routes).some(Boolean)) blocks.push({ code: 'transport', severity: 'block', text: 'Not available in Comic Studio yet' });
  if (!spec.aspects.includes(doc.format.pageAspect)) blocks.push({ code: 'aspect', severity: 'block', text: `Can't draw ${doc.format.pageAspect} pages` });
  if (!caps.modelOverride && spec.id !== FREE_PLAN_IMAGE_MODEL) blocks.push({ code: 'access', severity: 'block', text: 'Needs a paid plan or your own key' });
  if (spec.refs.characters === 0 && doc.cast.some((c) => c.tier !== 'extra')) {
    blocks.push({ code: 'refs', severity: 'block', text: `${spec.nickname} can't keep characters on model (no character references)` });
  }

  const over = doc.pages.map((p) => ({ n: p.n, c: pageCastCount(doc, p.id) })).filter((x) => spec.refs.characters > 0 && x.c > spec.refs.characters);
  if (over.length) {
    const worst = over.reduce((a, b) => (b.c > a.c ? b : a));
    warns.push({ code: 'characters', severity: 'warn', text: `${spec.nickname} holds up to ${spec.refs.characters} characters per image; page ${worst.n} has ${worst.c}.` });
  }
  const want = redrawResolution(doc, FREE_PLAN_IMAGE_MODEL, 'page'); // the tier's resolution on a model that has every size
  if (spec.resolutions.length ? !spec.resolutions.includes(want) : want !== '1K') {
    warns.push({ code: 'resolution', severity: 'warn', text: `${spec.nickname} has no ${want} option here.` });
  }
  if (doc.format.lettering === 'in_art' && (spec.text === 'none' || spec.text === 'basic')) {
    warns.push({ code: 'lettering', severity: 'warn', text: `${spec.nickname} is weak at in-art lettering; overlay lettering keeps the words exact.` });
  }
  if (spec.lifecycle === 'experimental') warns.push({ code: 'experimental', severity: 'warn', text: 'Experimental in Comic Studio.' });
  const pricier = prices ? priceFit(spec, doc, prices) : null;
  if (pricier) warns.push(pricier);
  const res = spec.resolutions.length ? redrawResolution(doc, spec.id, 'page') : '1K';
  if (spec.priceBasis === 'unverified' || typeof spec.priceUsd[res] !== 'number') {
    warns.push({ code: 'price_unverified', severity: 'warn', text: "Price per image isn't published, so you'll see the real cost after the first image" });
  }
  return [...blocks, ...warns];
};

/** Convenience: a registry id's fit, or a single 'hidden' block when the id is unknown. */
export const modelFitById = (modelId: string, doc: ComicDoc, caps: StudioCaps): FitReason[] => {
  const spec = getImageModel(modelId);
  return spec ? modelFit(spec, doc, caps) : [{ code: 'hidden', severity: 'block', text: 'Not available in Comic Studio yet' }];
};
