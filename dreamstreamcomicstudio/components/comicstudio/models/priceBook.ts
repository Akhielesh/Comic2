// The client PriceBook (shared/comic/modelLock.ts contract) built from the catalog rows the picker already holds
// (GET /api/comic/models/catalog — live OpenRouter prices merged with the registry, plus THIS user's observed
// medians). It follows models.md §2.3 exactly as the server's priceBookFromSources does, so a redraw quoted here
// is the quote the server recomputes for change_image_model (it re-quotes when they drift > 15% + $0.01):
//   1. list price: the row's price at that resolution, else the registry's dated price, else none;
//   2. reference cost (perRefUsd × refs) is added to the LIST basis only;
//   3. observed median (n ≥ 3, the user's own before the platform's) of page/sheet/cover calls;
//   4. unit = max(list + refs, observed) — never under-quotes; null = no basis at all ("can't price yet").
// QC per page: the figure the server's own PriceBook uses (its observed QC median at n ≥ 5, else QC_USD_PER_PAGE)
// when the catalog serves it on its rows (`qcUsd`, see ServedCatalogRow), else QC_USD_PER_PAGE — so a quote the
// user agrees to equals the server's recomputation instead of sitting a fraction of a cent per page under it.
//
// `basis` labels never name a dollar amount, so they are safe to show to a governed user as they are
// ("Prices: OpenRouter, 5 min ago"); the dollar detail (observed range, list figure) is worded by the caller
// through the user's cost format.

import type { Resolution } from '../../../shared/comic/doc';
import type { CatalogPrice, ModelCatalogRow, ObservedEntry } from '../../../shared/comic/modelCatalog';
import type { PriceBook } from '../../../shared/comic/modelLock';
import { PLATFORM_MARKUP, QC_USD_PER_PAGE, getImageModel, type ImageJobKind, type ImageModelSpec } from '../../../shared/comic/models';
import { ago, asOfCouldntRefresh, fromPriceList } from './copy';

/** Observed medians are used from this many calls (models.md §2.3 step 2). */
export const OBSERVED_MIN_N = 3;
/** Sanity ceiling for a served QC figure (a vision check costs fractions of a cent; anything above is not QC). */
export const QC_SERVED_MAX_USD = 0.1;

/**
 * A catalog row as GET /api/comic/models/catalog may serve it: the shared wire row plus `qcUsd`, the QC per page
 * the server's PriceBook uses for this user (AMENDMENT queued: `ModelCatalogRow.qcUsd?: number`).
 */
export type ServedCatalogRow = ModelCatalogRow & { qcUsd?: number };

/** The QC per page the catalog served (the first well-formed `qcUsd` on the rows), or undefined. */
export const servedQcUsd = (rows: readonly ModelCatalogRow[] | null | undefined): number | undefined => {
  for (const r of rows ?? []) {
    const q = (r as ServedCatalogRow).qcUsd;
    if (isNum(q) && q >= 0 && q <= QC_SERVED_MAX_USD) return q;
  }
  return undefined;
};

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The registry's dated list price (the fallback when OpenRouter has nothing for that resolution). */
export const registryPrice = (spec: ImageModelSpec, res: Resolution): number | null => {
  if (spec.priceBasis === 'unverified') return null;
  const resolutions = spec.resolutions.length ? spec.resolutions : (['1K'] as Resolution[]);
  if (!resolutions.includes(res)) return null;
  const usd = spec.priceUsd[res];
  return isNum(usd) ? usd : null;
};

export interface ClientQuote {
  /** Provider price of one image (before QC and markup); null = no basis. */
  usd: number | null;
  source: 'observed' | 'list' | 'registry' | 'none';
  /** A dollar-free label: "your last 4 pages", "OpenRouter, 5 min ago", "from our price list, 2026-10-22". */
  label: string;
  /** The list price including references (what an observed median was compared with). */
  listUsd?: number;
  observed?: ObservedEntry;
  /** The live price's basis (OpenRouter endpoint, vendor table, per-megapixel) when the list came from the catalog. */
  priceBasis?: CatalogPrice['basis'];
}

export interface ClientPriceBook extends PriceBook {
  quote(modelId: string, res: Resolution, kind: ImageJobKind, refs?: number): ClientQuote;
  /** What one page costs THIS user: (unit + QC) × markup unless BYOK; null when unpriced. */
  pagePrice(modelId: string, res: Resolution, byok: boolean): number | null;
  /** The row behind a model id (live data), if any. */
  row(modelId: string): ModelCatalogRow | undefined;
}

const kindNoun = (kind: string, n: number) => {
  const base = kind === 'sheet' ? 'character sheet' : kind === 'style_option' ? 'style test' : kind;
  return n === 1 ? base : `${base}s`;
};

/** The observed kind a job kind reads: the same kind, exactly as the server matches it (rows carry page/sheet/cover). */
const observedKind = (kind: ImageJobKind): string => kind;

const liveLabel = (row: ModelCatalogRow, now: number): string => {
  const at = row.fetchedAt?.catalog;
  const when = at ? ago(at, now) : 'time unknown';
  return row.stale ? `OpenRouter ${asOfCouldntRefresh(when)}` : `OpenRouter, ${when}`;
};

export const clientPriceBook = (rows: readonly ModelCatalogRow[] | null | undefined, opts: { now?: number; qcUsd?: number } = {}): ClientPriceBook => {
  const now = opts.now ?? Date.now();
  // QC per page: an explicit figure, else the server's (served on the rows), else the default.
  const qcUsd = isNum(opts.qcUsd) && opts.qcUsd >= 0 ? opts.qcUsd : servedQcUsd(rows) ?? QC_USD_PER_PAGE;
  const byId = new Map((rows ?? []).map((r) => [r.id, r] as const));
  const rowFor = (modelId: string) => byId.get(getImageModel(modelId)?.id ?? modelId) ?? byId.get(modelId);

  const quote = (modelId: string, res: Resolution, kind: ImageJobKind, refs = 0): ClientQuote => {
    const spec = getImageModel(modelId);
    const row = rowFor(modelId);
    const sent = isNum(refs) && refs > 0 ? Math.floor(refs) : 0;

    // 1. List price: the catalog (already merged with the registry) → the registry → none.
    let listUsd: number | null = null;
    let label = 'no published price';
    let source: ClientQuote['source'] = 'none';
    let priceBasis: CatalogPrice['basis'] | undefined;
    const live = row?.price?.[res];
    if (live && isNum(live.usd)) {
      listUsd = live.usd;
      priceBasis = live.basis;
      if (live.basis === 'registry') {
        source = 'registry';
        label = spec ? fromPriceList(spec.factsAsOf) : 'from our price list';
      } else {
        source = 'list';
        label = liveLabel(row!, now);
      }
    } else if (spec) {
      const reg = registryPrice(spec, res);
      if (reg !== null) {
        listUsd = reg;
        source = 'registry';
        label = fromPriceList(spec.factsAsOf);
      }
    }

    // 2. References on the list basis only.
    const perRef = isNum(row?.perRefUsd) ? row!.perRefUsd : isNum(spec?.perRefUsd) ? spec!.perRefUsd! : null;
    const refsUsd = sent > 0 && perRef !== null ? round4(perRef * sent) : 0;
    const listTotal = listUsd === null ? null : round4(listUsd + refsUsd);

    // 3. Observed median, the user's own first.
    const want = observedKind(kind);
    const matches = (row?.observed ?? []).filter((o) => o.kind === want && o.res === res && o.n >= OBSERVED_MIN_N && isNum(o.medianUsd));
    const obs = matches.find((o) => o.scope === 'you') ?? matches.find((o) => o.scope === 'platform');

    // 4. Never under-quote.
    if (obs && (listTotal === null || obs.medianUsd >= listTotal)) {
      const who = obs.scope === 'platform' ? "DreamStream creators' last" : 'your last';
      return {
        usd: round4(obs.medianUsd),
        source: 'observed',
        label: `${who} ${obs.n} ${kindNoun(want, obs.n)}`,
        ...(listTotal !== null ? { listUsd: listTotal } : {}),
        observed: obs,
        ...(priceBasis ? { priceBasis } : {})
      };
    }
    return {
      usd: listTotal,
      source: listTotal === null ? 'none' : source,
      label,
      ...(listTotal !== null ? { listUsd: listTotal } : {}),
      ...(obs ? { observed: obs } : {}),
      ...(priceBasis ? { priceBasis } : {})
    };
  };

  return {
    unit: (modelId, res, kind, refs = 0) => {
      const q = quote(modelId, res, kind, refs);
      return { usd: q.usd, basis: q.label };
    },
    qcUsd,
    quote,
    pagePrice: (modelId, res, byok) => {
      const q = quote(modelId, res, 'page');
      return q.usd === null ? null : round4((q.usd + qcUsd) * (byok ? 1 : PLATFORM_MARKUP));
    },
    row: rowFor
  };
};
