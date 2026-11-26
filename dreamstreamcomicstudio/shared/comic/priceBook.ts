// The one price book (models.md §2.3), shared by the server and the client (docs/features/pricing.md).
//
// `priceBookFromSources` turns a user's price sources — live list prices merged with the registry, that user's
// observed medians, observed vision-QC cost and the observed text rates — into the PriceBook every quote reads:
//   unit price      = max(list + perRefUsd × refs, observed median), the user's own median (n ≥ 3) before the
//                     platform's; null = no basis at all ("can't price yet");
//   QC per page     = max(observed median (n ≥ 5), QC_USD_PER_PAGE);
//   text rates      = the constants × max(1, observed factor) (server/src/comic/models/textRates.ts).
// Never under the list price or the constant: the observed figure only ever raises a quote. The markup
// (PLATFORM_MARKUP unless BYOK) is applied by the caller (estimateJobs, redrawQuote) or by `jobQuote()`, never inside
// `unit()`, so `unit()` is always the provider price.
//
// The server builds its book per request from the sources it loads (models/index.ts createPriceBook); the client
// builds the SAME book from the sources the server serves (GET /api/comic/models/prices → services/priceSheet.ts).
// So a Draw button, the Approve card it opens, the run and the credit card name one price.
//
// `basis` strings name dollar amounts: dollar views only (admins, own-key calls). A governed user's copy is worded
// from the numbers through the viewer's cost format, never by printing `basis` or a price `note`.

import type { Resolution } from './doc.js';
import type { CatalogPrice, PriceBasis } from './modelCatalog.js';
import type { PriceBook } from './modelLock.js';
import {
  PLAN_USD_PER_PAGE,
  PLATFORM_MARKUP,
  QC_USD_PER_PAGE,
  STYLE_DIRECTIONS_USD,
  getImageModel,
  type AnyImageJobKind,
  type ImageModelSpec
} from './models.js';

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const money = (n: number) => `$${round4(n)}`;

// ── §4.6 exact copy ───────────────────────────────────────────────────────────

/** Per-image price unpublished (billed per token, no vendor table). */
export const PRICE_UNPUBLISHED_COPY = "Price per image isn't published · you'll see the real cost after the first image";
/** OpenRouter publishes no price (empty `pricing[]`, e.g. Krea). */
export const NO_OPENROUTER_PRICE_COPY = "OpenRouter doesn't list a price for this model";

/** The registry's dated price list as catalog prices (the fallback when OpenRouter has nothing). */
export const registryPrices = (spec: ImageModelSpec): Partial<Record<Resolution, CatalogPrice>> => {
  const out: Partial<Record<Resolution, CatalogPrice>> = {};
  const note = `from our price list, ${spec.factsAsOf}`;
  const resolutions = spec.resolutions.length ? spec.resolutions : (['1K'] as Resolution[]);
  for (const r of resolutions) {
    const usd = spec.priceUsd[r];
    if (spec.priceBasis === 'unverified' || !isFiniteNumber(usd)) out[r] = { usd: null, basis: 'registry', note: PRICE_UNPUBLISHED_COPY };
    else out[r] = { usd, basis: 'registry', note };
  }
  return out;
};

// ── Text rates (what planning, style directions and translation really cost) ──

/** The text operations priced from observations (server/src/comic/models/textRates.ts). */
export type TextOpKind = 'plan' | 'style_directions' | 'translate';
export const TEXT_OP_KINDS: readonly TextOpKind[] = ['plan', 'style_directions', 'translate'];

/** Where one text rate came from. */
export interface TextRateBasis {
  source: 'observed' | 'floor';
  /** Observed: how many operations, and whose. */
  n?: number;
  scope?: 'you' | 'platform';
}

/**
 * Provider prices of the text steps, before markup. Each is the constant (or, for translation, the token estimate)
 * times the observed factor what those steps really cost, never below 1.
 */
export interface TextRates {
  /** Writing the page plan, per page. */
  planPerPageUsd: number;
  /** The writer call that proposes style directions when none are named. */
  styleDirectionsUsd: number;
  /** × the translation's token estimate (≥ 1). */
  translateFactor: number;
  basis?: Partial<Record<TextOpKind, TextRateBasis>>;
}

/** The constants: the floor and the fallback. */
export const FLOOR_TEXT_RATES: Readonly<TextRates> = Object.freeze({
  planPerPageUsd: PLAN_USD_PER_PAGE,
  styleDirectionsUsd: STYLE_DIRECTIONS_USD,
  translateFactor: 1
});

/** The floor constant behind each kind (the base an observed factor multiplies). */
export const TEXT_FLOOR_USD: Readonly<Record<Exclude<TextOpKind, 'translate'>, number>> = Object.freeze({
  plan: PLAN_USD_PER_PAGE,
  style_directions: STYLE_DIRECTIONS_USD
});

/** Well-formed text rates, never under the constants (anything missing or malformed reads as the floor). */
export const sanitizeTextRates = (value: unknown): TextRates => {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<TextRates>;
  const atLeast = (x: unknown, floor: number) => (isFiniteNumber(x) && x > floor ? round4(x) : floor);
  const factor = isFiniteNumber(v.translateFactor) && v.translateFactor > 1 ? Math.round(v.translateFactor * 1000) / 1000 : 1;
  const basis: TextRates['basis'] = {};
  for (const kind of TEXT_OP_KINDS) {
    const b = (v.basis as Record<string, TextRateBasis> | undefined)?.[kind];
    if (b && (b.source === 'observed' || b.source === 'floor'))
      basis[kind] = { source: b.source, ...(isFiniteNumber(b.n) ? { n: b.n } : {}), ...(b.scope === 'you' || b.scope === 'platform' ? { scope: b.scope } : {}) };
  }
  return {
    planPerPageUsd: atLeast(v.planPerPageUsd, PLAN_USD_PER_PAGE),
    styleDirectionsUsd: atLeast(v.styleDirectionsUsd, STYLE_DIRECTIONS_USD),
    translateFactor: factor,
    ...(Object.keys(basis).length ? { basis } : {})
  };
};

/** The text rates a book carries (the floor without a book, or a book that has none). */
export const textRatesOf = (prices?: Pick<PriceBook, 'text'> | null): TextRates => (prices?.text ? sanitizeTextRates(prices.text) : FLOOR_TEXT_RATES);

const charged = (providerUsd: number, byok: boolean) => round4(providerUsd * (byok ? 1 : PLATFORM_MARKUP));

/** Planning `pages` pages as quoted to this user (markup unless BYOK). */
export const planUsd = (pages: number, byok: boolean, prices?: Pick<PriceBook, 'text'> | null): number =>
  charged(textRatesOf(prices).planPerPageUsd * Math.max(1, Math.floor(pages) || 1), byok);

/** The style-directions writer line as quoted to this user (markup unless BYOK). */
export const styleDirectionsQuoteUsd = (byok: boolean, prices?: Pick<PriceBook, 'text'> | null): number => charged(textRatesOf(prices).styleDirectionsUsd, byok);

/** One page re-check (one vision pass, QC-priced: the book's QC per page) as quoted to this user. */
export const recheckQuoteUsd = (byok: boolean, prices?: Pick<PriceBook, 'qcUsd'> | null): number =>
  charged(isFiniteNumber(prices?.qcUsd) && (prices!.qcUsd as number) >= QC_USD_PER_PAGE ? (prices!.qcUsd as number) : QC_USD_PER_PAGE, byok);

// ── PriceBook ────────────────────────────────────────────────────────────────

export const OBSERVED_MIN_N = 3;
export const QC_OBSERVED_MIN_N = 5;
export const OBSERVED_WINDOW = 20;

/** What a quote can price: every comic image job kind, and 'image' for a standalone image (no QC, no observed kind). */
export type PricedKind = AnyImageJobKind | 'image';

export interface PriceBookRow {
  id: string;
  price: Partial<Record<Resolution, CatalogPrice>>;
  perRefUsd: number | null;
  fetchedAt?: { catalog?: string };
  stale?: boolean;
}

export interface ObservedMedian {
  modelId: string;
  kind: string;
  res: Resolution;
  n: number;
  medianUsd: number;
  minUsd: number;
  maxUsd: number;
  scope: 'you' | 'platform';
}

export interface PriceBookSources {
  rows: PriceBookRow[];
  observed?: ObservedMedian[];
  /** Observed vision-QC cost per page (kind 'qc' rows), used when n ≥ QC_OBSERVED_MIN_N and above the constant. */
  qc?: { medianUsd: number; n: number } | null;
  /** Observed text rates (absent = the constants). */
  text?: TextRates | null;
}

/**
 * The basis of a quote as data, next to the text. The text names dollar amounts, so it is for dollar views only
 * (admins, own-key calls); a governed user's copy must be worded from these fields through
 * costFormatterFor(ctx) / formatCostForUser, never by printing `basis` or a price `note`.
 */
export interface QuoteBasis {
  /** Which basis set the number: our observed median, the live list price, the registry's dated list, or none. */
  source: 'observed' | 'list' | 'registry' | 'none';
  /** Observed: how many calls, whose, and their range (provider cost per image). */
  n?: number;
  scope?: 'you' | 'platform';
  minUsd?: number;
  maxUsd?: number;
  /** The list price including reference cost (what an observed median was compared with, or what was used). */
  listUsd?: number;
  /** Registry: the price list's date. */
  factsAsOf?: string;
  /** Live list: when OpenRouter's price was fetched. */
  fetchedAt?: string;
  /** References sent, what they added to the list basis, and whether their price is unpublished. */
  refs?: number;
  refsUsd?: number;
  refsUnpriced?: boolean;
}

export interface PriceQuote {
  usd: number | null;
  /** Human-readable basis, e.g. "your last 4 pages: $0.043–$0.054; list $0.0336". Dollar views only. */
  basis: string;
  /** The same basis as data (every view; governed copy is worded from this). */
  basisDetail: QuoteBasis;
  list: { usd: number | null; basis: PriceBasis | 'none'; label: string; note?: string };
  observed?: ObservedMedian;
  /** Reference cost added to the list basis (0 when none sent or unpublished). */
  refsUsd: number;
  /** True when reference cost could not be added because the per-reference price is unpublished. */
  refsUnpriced: boolean;
}

/** models.md §2.3 in full for one job: (unit + QC for page, edit and panel jobs) × PLATFORM_MARKUP unless BYOK. */
export interface JobQuote {
  /** What the user is charged (null = no basis: the UI shows no number). */
  usd: number | null;
  /** The provider price of the image (unit), before QC and markup. */
  providerUsd: number | null;
  /** QC added (page, edit and panel jobs only: one QC run each, as estimateJobs counts them). */
  qcUsd: number;
  markup: number;
  /** Dollar views only (see QuoteBasis). */
  basis: string;
  basisDetail: QuoteBasis & { qc?: { usd: number; source: 'observed' | 'default'; n?: number } };
}

export interface SharedPriceBook extends PriceBook {
  /** Any image job kind, Ship 2's 'panel' included: observed medians are matched by the exact kind. */
  quote(modelId: string, res: Resolution, kind: PricedKind, refs?: number): PriceQuote;
  jobQuote(modelId: string, res: Resolution, kind: PricedKind, opts?: { refs?: number; byok?: boolean }): JobQuote;
  /** Observed QC detail when it set the QC figure (above the constant). */
  qcObserved: { medianUsd: number; n: number } | null;
  /** The text rates this book quotes with (the constants when nothing was observed). */
  text: TextRates;
}

const kindNoun = (kind: string, n: number) => {
  const base = kind === 'style_option' ? 'style test' : kind === 'sheet' ? 'character sheet' : kind;
  return n === 1 ? base : `${base}s`;
};

const basisLabel = (p: CatalogPrice, fetchedAt?: string): string => {
  const when = fetchedAt ? `, ${fetchedAt}` : '';
  if (p.basis === 'openrouter_endpoint') return `OpenRouter price${when}`;
  if (p.basis === 'vendor_table') return `vendor token table via OpenRouter${when}`;
  if (p.basis === 'derived_mp') return `OpenRouter per-megapixel price${when}`;
  return p.note && p.note.startsWith('from our price list') ? p.note.replace('from our ', '') : 'price list';
};

/** Kinds a drawn image is checked after (one vision QC each). */
const checkedKind = (kind: PricedKind) => kind === 'page' || kind === 'edit' || kind === 'panel';

/**
 * The PriceBook for one user: rows from the live catalog (already merged with the registry) and that user's
 * observed medians. `unit()` never under-quotes (max of the bases) and says which basis it used; usd null
 * means no basis at all ("can't price yet" — the UI shows no number).
 */
export const priceBookFromSources = (src: PriceBookSources): SharedPriceBook => {
  const rows = new Map((src.rows ?? []).map((r) => [r.id, r] as const));
  const observed = src.observed ?? [];
  const seen = src.qc && src.qc.n >= QC_OBSERVED_MIN_N && isFiniteNumber(src.qc.medianUsd) ? { medianUsd: round4(src.qc.medianUsd), n: src.qc.n } : null;
  // Never under the constant: an observed QC median only ever raises the figure.
  const qc = seen && seen.medianUsd >= QC_USD_PER_PAGE ? seen : null;
  const text = sanitizeTextRates(src.text);

  const quote = (modelId: string, res: Resolution, kind: PricedKind, refs = 0): PriceQuote => {
    const spec = getImageModel(modelId);
    const row = rows.get(spec?.id ?? modelId) ?? rows.get(modelId);
    const sent = Number.isFinite(refs) && refs > 0 ? Math.floor(refs) : 0;

    // 1. List price: live catalog (merged with the registry) → registry → none.
    let list: PriceQuote['list'] = { usd: null, basis: 'none', label: 'no list price' };
    const live = row?.price[res];
    if (live && isFiniteNumber(live.usd)) list = { usd: live.usd, basis: live.basis, label: basisLabel(live, row?.fetchedAt?.catalog), note: live.note };
    else if (spec) {
      const reg = registryPrices(spec)[res];
      if (reg && isFiniteNumber(reg.usd)) list = { usd: reg.usd, basis: 'registry', label: `price list from ${spec.factsAsOf}`, note: reg.note };
      else list = { usd: null, basis: 'none', label: live?.note || reg?.note || PRICE_UNPUBLISHED_COPY };
    } else if (live) list = { usd: null, basis: 'none', label: live.note || NO_OPENROUTER_PRICE_COPY };

    // 2. Reference cost on the list basis only (observed already includes it).
    const perRef = row?.perRefUsd ?? spec?.perRefUsd ?? null;
    const refsUnpriced = sent > 0 && !isFiniteNumber(perRef);
    const refsUsd = sent > 0 && isFiniteNumber(perRef) ? round4(perRef * sent) : 0;
    const listTotal = isFiniteNumber(list.usd) ? round4(list.usd + refsUsd) : null;

    // 3. Observed median (n ≥ 3), the user's own first.
    const matches = observed.filter((o) => (o.modelId === modelId || o.modelId === spec?.id) && o.kind === kind && o.res === res && o.n >= OBSERVED_MIN_N);
    const obs = matches.find((o) => o.scope === 'you') ?? matches.find((o) => o.scope === 'platform');

    // 4. Never under-quote: the higher basis wins.
    let usd: number | null = listTotal;
    let basis: string;
    const who = obs?.scope === 'platform' ? "DreamStream creators' last" : 'your last';
    const obsText = obs ? `${who} ${obs.n} ${kindNoun(kind, obs.n)}: ${money(obs.minUsd)}–${money(obs.maxUsd)}` : '';
    const usedObserved = Boolean(obs && (listTotal === null || obs.medianUsd >= listTotal));
    if (obs && usedObserved) {
      usd = round4(obs.medianUsd);
      basis = listTotal === null ? obsText : `${obsText}; list ${money(listTotal)}`;
    } else if (listTotal !== null) {
      basis = `${list.label}${refsUsd ? ` + ${money(refsUsd)} for ${sent} reference${sent === 1 ? '' : 's'}` : ''}${obs ? ` (${obsText})` : ''}`;
    } else {
      basis = list.label;
    }
    if (refsUnpriced) basis += ' · reference cost unpublished';
    const basisDetail: QuoteBasis = {
      source: usedObserved ? 'observed' : listTotal === null ? 'none' : list.basis === 'registry' ? 'registry' : 'list',
      ...(usedObserved && obs ? { n: obs.n, scope: obs.scope, minUsd: obs.minUsd, maxUsd: obs.maxUsd } : {}),
      ...(listTotal !== null ? { listUsd: listTotal } : {}),
      ...(list.basis === 'registry' && spec ? { factsAsOf: spec.factsAsOf } : {}),
      ...(list.basis !== 'registry' && list.basis !== 'none' && row?.fetchedAt?.catalog ? { fetchedAt: row.fetchedAt.catalog } : {}),
      ...(sent > 0 ? { refs: sent, refsUsd, refsUnpriced } : {})
    };
    return { usd, basis, basisDetail, list, ...(obs ? { observed: obs } : {}), refsUsd, refsUnpriced };
  };

  const qcUsd = qc ? qc.medianUsd : QC_USD_PER_PAGE;
  const jobQuote: SharedPriceBook['jobQuote'] = (modelId, res, kind, opts = {}) => {
    const q = quote(modelId, res, kind, opts.refs ?? 0);
    const markup = opts.byok ? 1 : PLATFORM_MARKUP;
    const qcAdd = checkedKind(kind) ? qcUsd : 0;
    const qcBasis = qcAdd ? (qc ? ` + QC ${money(qcAdd)} (your last ${qc.n} checks)` : ` + QC ${money(qcAdd)}`) : '';
    return {
      usd: q.usd === null ? null : round4((q.usd + qcAdd) * markup),
      providerUsd: q.usd,
      qcUsd: qcAdd,
      markup,
      basis: `${q.basis}${q.usd === null ? '' : qcBasis}`,
      basisDetail: { ...q.basisDetail, ...(qcAdd ? { qc: { usd: qcAdd, source: qc ? ('observed' as const) : ('default' as const), ...(qc ? { n: qc.n } : {}) } } : {}) }
    };
  };

  return {
    unit: (modelId, res, kind, refs = 0) => {
      const q = quote(modelId, res, kind, refs);
      return { usd: q.usd, basis: q.basis };
    },
    qcUsd,
    qcObserved: qc,
    text,
    quote,
    jobQuote
  };
};

/** A book from the registry's dated price list and the constants only (no I/O). */
export const registryPriceBook = (): SharedPriceBook => priceBookFromSources({ rows: [] });

// ── The price sheet (GET /api/comic/models/prices) ──────────────────────────

/** What the server serves so the client builds the same book: the caller's sources, without notes. */
export interface PriceSheet {
  v: 1;
  /** When the server built it (ms since epoch). */
  at: number;
  sources: PriceBookSources;
}

const BASES = new Set<string>(['openrouter_endpoint', 'vendor_table', 'derived_mp', 'registry']);
const RESOLUTIONS = new Set<string>(['512', '1K', '2K', '4K']);
const MAX_SHEET_ROWS = 200;
const MAX_SHEET_OBSERVED = 2000;

/** The sheet for some sources: prices and bases only (notes stay on the server: they are words, and some name dollars). */
export const priceSheetOf = (sources: PriceBookSources, at: number): PriceSheet => ({
  v: 1,
  at,
  sources: {
    rows: (sources.rows ?? []).map((r) => ({
      id: r.id,
      price: Object.fromEntries(Object.entries(r.price ?? {}).map(([res, p]) => [res, { usd: p?.usd ?? null, basis: p?.basis ?? 'registry' }])) as PriceBookRow['price'],
      perRefUsd: r.perRefUsd ?? null,
      ...(r.fetchedAt?.catalog ? { fetchedAt: { catalog: r.fetchedAt.catalog } } : {}),
      ...(r.stale ? { stale: true } : {})
    })),
    observed: (sources.observed ?? []).map((o) => ({ ...o })),
    qc: sources.qc ? { medianUsd: sources.qc.medianUsd, n: sources.qc.n } : null,
    text: sanitizeTextRates(sources.text)
  }
});

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finiteOrNull = (v: unknown): number | null => (isFiniteNumber(v) && v >= 0 ? v : null);

/** A well-formed sheet from the wire, or null (anything malformed is dropped: the quote then reads the registry). */
export const sanitizePriceSheet = (value: unknown): PriceSheet | null => {
  if (!isObj(value) || value.v !== 1 || !isFiniteNumber(value.at) || !isObj(value.sources)) return null;
  const src = value.sources;
  const rows: PriceBookRow[] = (Array.isArray(src.rows) ? src.rows : []).slice(0, MAX_SHEET_ROWS).flatMap((r): PriceBookRow[] => {
    if (!isObj(r) || typeof r.id !== 'string' || !r.id) return [];
    const price: PriceBookRow['price'] = {};
    for (const [res, p] of Object.entries(isObj(r.price) ? r.price : {})) {
      if (!RESOLUTIONS.has(res) || !isObj(p)) continue;
      price[res as Resolution] = { usd: finiteOrNull(p.usd), basis: (typeof p.basis === 'string' && BASES.has(p.basis) ? p.basis : 'registry') as PriceBasis };
    }
    const catalogAt = isObj(r.fetchedAt) && typeof r.fetchedAt.catalog === 'string' ? r.fetchedAt.catalog : undefined;
    return [{ id: r.id, price, perRefUsd: finiteOrNull(r.perRefUsd), ...(catalogAt ? { fetchedAt: { catalog: catalogAt } } : {}), ...(r.stale === true ? { stale: true } : {}) }];
  });
  const observed: ObservedMedian[] = (Array.isArray(src.observed) ? src.observed : []).slice(0, MAX_SHEET_OBSERVED).flatMap((o): ObservedMedian[] => {
    if (!isObj(o) || typeof o.modelId !== 'string' || typeof o.kind !== 'string' || typeof o.res !== 'string' || !RESOLUTIONS.has(o.res)) return [];
    const n = o.n;
    const med = o.medianUsd;
    if (!isFiniteNumber(n) || n < 1 || !isFiniteNumber(med) || med < 0) return [];
    const min = isFiniteNumber(o.minUsd) ? o.minUsd : med;
    const max = isFiniteNumber(o.maxUsd) ? o.maxUsd : med;
    return [{ modelId: o.modelId, kind: o.kind, res: o.res as Resolution, n, medianUsd: med, minUsd: min, maxUsd: max, scope: o.scope === 'platform' ? 'platform' : 'you' }];
  });
  const qc = isObj(src.qc) && isFiniteNumber(src.qc.medianUsd) && isFiniteNumber(src.qc.n) ? { medianUsd: src.qc.medianUsd, n: src.qc.n } : null;
  return { v: 1, at: value.at, sources: { rows, observed, qc, text: sanitizeTextRates(src.text) } };
};
