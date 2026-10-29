// Pure helpers for the cost and model insights UI (models.md §4). Everything here reads the doc
// (shared/comic/modelInsights.ts is the per-comic source of truth), the registry (dated price list) or a
// catalog row the server sent — and when a figure is missing it returns null / the §4.6 copy, never a guess.
//
// Money: spend entries hold the CHARGED amount (provider cost × PLATFORM_MARKUP unless the user's own key paid);
// list and observed prices are PROVIDER prices. `insightsMoney` prints both for THIS viewer: governed users read
// a share of their usage (conversation/cost.ts → services/costDisplay.ts), never dollars; admins and own-key
// comics read precise dollars ("$0.7513" — insights compare small numbers, so 2 decimals would hide the story).

import type { ComicDoc, Resolution, SpendEntry, SpendKind } from '../../../shared/comic/doc';
import { PLATFORM_MARKUP, getImageModel, resolveImageJob, type ImageModelSpec } from '../../../shared/comic/models';
import { deriveLock } from '../../../shared/comic/modelLock';
import { INSIGHTS_KIND_ORDER, overviewOf } from '../../../shared/comic/modelInsights';
import { isImageCallEntry } from '../../../shared/comic/ops';
import type { CatalogEndpoint, CatalogPrice, ModelCatalogRow, ObservedEntry, QualityBoard, QualityEntry, ReliabilityEntry } from '../../../shared/comic/modelCatalog';
import { compactUsageShare } from '../../../services/costDisplay';
import { SPEND_KIND_LABEL } from '../board/boardModel';
import type { CostFormat } from '../conversation/cost';
import { NOT_RANKED_COPY, NO_OPENROUTER_PRICE_COPY, NO_UPTIME_COPY, PRICE_UNPUBLISHED_COPY, priceListCopy } from './copy';

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Observed ("real") cost needs at least this many priced calls (§4.6; the server's OBSERVED_MIN_N). */
export const OBSERVED_MIN_N = 3;
/** …and uses at most the last this-many (the server's OBSERVED_WINDOW). */
export const OBSERVED_WINDOW = 20;

/** Resolutions in display order. */
export const RESOLUTION_ORDER: readonly Resolution[] = ['512', '1K', '2K', '4K'];

// ── Money ────────────────────────────────────────────────────────────────────

/** "$0.7513", "$0.06", "$1.3685", "$12.40"; "$0" for nothing. Up to 4 decimals, never fewer than 2. */
export const preciseUsd = (usd: number): string => {
  if (!finite(usd) || usd <= 0) return '$0';
  if (usd >= 10) return `$${usd.toFixed(2)}`;
  if (usd < 0.0001) return '<$0.0001';
  return `$${usd.toFixed(4).replace(/0{1,2}$/, '')}`;
};

export interface InsightsMoney {
  /** True: shares of the user's usage, never dollars. */
  governed: boolean;
  /** Money already charged (the doc's ledger): "$0.7513" / "≈4% of your usage". */
  spent(usd: number): string;
  /** A provider price per image (list or observed): "$0.0336" / "≈0.4% of your usage". */
  price(providerUsd: number): string;
  /** A provider price for a narrow cell: "$0.0336" / "≈0.4%"; undefined while a governed share is unknown. */
  priceShort(providerUsd: number): string | undefined;
  /** A quote that already carries the markup unless BYOK: "≈$0.0437" / "≈0.4% of your usage". */
  quote(chargedUsd: number): string;
}

export const insightsMoney = (cost: CostFormat): InsightsMoney => {
  // Usage counts provider cost; the formatter takes charged amounts (it removes the markup itself), so a provider
  // price is put on the same footing first.
  const asCharged = (providerUsd: number) => (finite(providerUsd) ? providerUsd * PLATFORM_MARKUP : 0);
  if (!cost.governed) {
    return {
      governed: false,
      spent: preciseUsd,
      price: preciseUsd,
      priceShort: preciseUsd,
      quote: (usd) => `≈${preciseUsd(usd)}`
    };
  }
  return {
    governed: true,
    spent: (usd) => cost.exact(usd),
    price: (usd) => cost.approx(asCharged(usd)),
    priceShort: (usd) => compactUsageShare(cost.approx(asCharged(usd))),
    quote: (usd) => cost.approx(usd)
  };
};

// ── The shared spend summary (header Spending sheet, the board's Story tab, the cost card) ──

export interface SpendSummaryKind {
  kind: string;
  label: string;
  usd: number;
}

export interface SpendSummary {
  totalUsd: number;
  /** Every kind with spend: the known kinds in INSIGHTS_KIND_ORDER (Translate included), then any kind this build
   *  does not know yet (never a silent gap). */
  kinds: SpendSummaryKind[];
  /** Paid by the user's own key (entries.byok) and through DreamStream. */
  byok: { usd: number; images: number };
  platform: { usd: number; images: number };
  savedUsd: number;
  failed: { count: number; usd: number };
  /** Entries whose amount is the registry estimate (the provider reported no cost). */
  estimated: number;
  /** False when the entry list hit its cap: the per-entry splits (byok, estimated) cover the recent entries only. */
  exact: boolean;
  /** When not exact: how many entries the splits cover. */
  recentN?: number;
}

/** "Pages", "Translations", "future kind" (a kind this build doesn't know still reads as words). */
export const spendKindLabel = (kind: string): string => SPEND_KIND_LABEL[kind as SpendKind] ?? kind.replace(/_/g, ' ');

export const spendSummary = (doc: ComicDoc): SpendSummary => {
  const o = overviewOf(doc);
  const byKind = (doc.spend.byKind ?? {}) as Partial<Record<string, number>>;
  const known = new Set<string>(INSIGHTS_KIND_ORDER);
  const extra = Object.keys(byKind).filter((k) => !known.has(k) && finite(byKind[k]) && (byKind[k] as number) > 0);
  const kinds: SpendSummaryKind[] = [
    ...o.byKind.filter((r) => finite(r.usd)).map((r) => ({ kind: r.kind, label: spendKindLabel(r.kind), usd: r.usd })),
    ...extra.map((kind) => ({ kind, label: spendKindLabel(kind), usd: byKind[kind] as number }))
  ];
  return {
    totalUsd: finite(o.totalUsd) ? o.totalUsd : 0,
    kinds,
    byok: o.byok,
    platform: o.platform,
    savedUsd: finite(o.savedUsd) ? o.savedUsd : 0,
    failed: o.failed,
    estimated: o.estimated,
    exact: o.exact,
    ...(o.exact ? {} : { recentN: doc.spend.entries.length })
  };
};

// ── Observed ("real") cost from the doc's own entries ─────────────────────────

export interface ObservedCost {
  /** Priced calls used (≤ OBSERVED_WINDOW, newest first). */
  n: number;
  /** Median provider cost per image (the server's observed rule). */
  medianUsd: number;
  minUsd: number;
  maxUsd: number;
  /** Average recorded list price of those calls, when they recorded one. */
  listUsd: number | null;
}

/** Provider cost of an entry: own-key entries are the provider's bill; platform entries carry the markup. */
export const providerCostOf = (e: SpendEntry): number => (e.byok ? e.usd : e.usd / PLATFORM_MARKUP);

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Priced, successful, non-estimated image calls matching `match` (entries are newest first); null when none. */
export const observedCost = (entries: readonly SpendEntry[], match: (e: SpendEntry) => boolean, limit = OBSERVED_WINDOW): ObservedCost | null => {
  const hits = entries.filter((e) => isImageCallEntry(e) && e.outcome !== 'failed' && !e.estimated && finite(e.usd) && e.usd > 0 && match(e)).slice(0, limit);
  if (!hits.length) return null;
  const costs = hits.map(providerCostOf);
  const lists = hits.map((e) => e.listUsd).filter((x): x is number => finite(x) && x > 0);
  return {
    n: hits.length,
    medianUsd: round4(median(costs)),
    minUsd: round4(Math.min(...costs)),
    maxUsd: round4(Math.max(...costs)),
    listUsd: lists.length ? round4(lists.reduce((s, x) => s + x, 0) / lists.length) : null
  };
};

export type ListPrice = { usd: number; source: 'recorded' } | { usd: number; source: 'registry'; factsAsOf: string };

/** The registry's dated list price for a model at a resolution (null when it has none). */
export const registryListPrice = (modelId: string, res: Resolution): ListPrice | null => {
  const spec = getImageModel(modelId);
  const usd = spec?.priceUsd[res];
  return spec && finite(usd) && usd > 0 ? { usd, source: 'registry', factsAsOf: spec.factsAsOf } : null;
};

export interface PageRealCost extends ObservedCost {
  modelId: string;
  nickname: string;
  res: Resolution;
  list: ListPrice | null;
}

/**
 * models.md §4.1 L1 "Real cost per page: ≈{$} (your last {n}) · list {$}": pages of THIS comic drawn on the comic's
 * model at the size its next pages draw at. Null below OBSERVED_MIN_N (§4.6 "Observed n < 3 → only the list price").
 */
export const pageRealCost = (doc: ComicDoc): PageRealCost | null => {
  const lock = deriveLock(doc);
  if (!lock) return null;
  const spec: ImageModelSpec | undefined = getImageModel(lock.modelId);
  const res = spec ? resolveImageJob('page', doc.settings.quality, doc.settings.imageModelOverride, lock).resolution : undefined;
  if (!res) return null;
  const obs = observedCost(doc.spend.entries, (e) => e.kind === 'page' && e.model === lock.modelId && e.res === res);
  if (!obs || obs.n < OBSERVED_MIN_N) return null;
  const list: ListPrice | null = obs.listUsd !== null ? { usd: obs.listUsd, source: 'recorded' } : registryListPrice(lock.modelId, res);
  return { ...obs, modelId: lock.modelId, nickname: spec?.nickname ?? lock.modelId, res, list };
};

export interface SizeCost {
  res?: Resolution;
  /** Successful image calls on this model at this size (all held entries). */
  images: number;
  /** Observed cost when n ≥ OBSERVED_MIN_N, else null (list price only). */
  observed: ObservedCost | null;
  /** The list price the calls recorded, else the registry's. */
  list: ListPrice | null;
}

/** Per size: the real cost per image vs list (models.md §4.2 "Models (this comic)"). */
export const sizeCosts = (doc: ComicDoc, modelId: string): SizeCost[] => {
  const calls = doc.spend.entries.filter((e) => isImageCallEntry(e) && e.model === modelId && e.outcome !== 'failed');
  const sizes = new Set<Resolution | ''>(calls.map((e) => e.res ?? ''));
  const order = (r: Resolution | '') => (r ? RESOLUTION_ORDER.indexOf(r) : 99);
  return [...sizes]
    .sort((a, b) => order(a) - order(b))
    .map((res) => {
      const obs = observedCost(calls, (e) => (e.res ?? '') === res);
      const observed = obs && obs.n >= OBSERVED_MIN_N ? obs : null;
      const list: ListPrice | null = obs?.listUsd != null ? { usd: obs.listUsd, source: 'recorded' } : res ? registryListPrice(modelId, res) : null;
      return { ...(res ? { res } : {}), images: calls.filter((e) => (e.res ?? '') === res).length, observed, list };
    });
};

// ── T1: this comic's spend over time ─────────────────────────────────────────

export type SeriesGroup = 'pages' | 'art' | 'checks' | 'director' | 'translate' | 'other';

export const SERIES_GROUPS: readonly { id: SeriesGroup; label: string }[] = [
  { id: 'pages', label: 'Pages' },
  { id: 'art', label: 'Cover, sheets & styles' },
  { id: 'checks', label: 'Quality checks' },
  { id: 'director', label: 'Director & plans' },
  { id: 'translate', label: 'Translations' },
  { id: 'other', label: 'Other' }
];

const GROUP_OF: Partial<Record<string, SeriesGroup>> = {
  page: 'pages',
  edit: 'pages',
  cover: 'art',
  sheet: 'art',
  style: 'art',
  qc: 'checks',
  chat: 'director',
  plan: 'director',
  translate: 'translate'
};

export interface SpendBucket {
  start: number;
  total: number;
  byGroup: Partial<Record<SeriesGroup, number>>;
}

export interface SpendSeries {
  unit: 'hour' | 'day' | 'week';
  buckets: SpendBucket[];
  /** Running total at the end of each bucket (the sparkline). */
  cumulative: number[];
  /** Entries held when the list hit its cap: the series covers the recent ones only. */
  recentN?: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const MAX_SERIES_BUCKETS = 120;

/** T1 (models.md §4.4): spend entries bucketed by time and grouped by kind; null when nothing was spent. */
export const spendSeries = (doc: ComicDoc, capped = false): SpendSeries | null => {
  const entries = doc.spend.entries.filter((e) => finite(e.at) && finite(e.usd) && e.usd > 0);
  if (!entries.length) return null;
  const ats = entries.map((e) => e.at);
  const first = Math.min(...ats);
  const last = Math.max(...ats);
  const span = last - first;
  const unit: SpendSeries['unit'] = span <= 2 * DAY ? 'hour' : span <= 120 * DAY ? 'day' : 'week';
  const size = unit === 'hour' ? HOUR : unit === 'day' ? DAY : 7 * DAY;
  const start0 = Math.floor(first / size) * size;
  const count = Math.min(MAX_SERIES_BUCKETS, Math.floor((last - start0) / size) + 1);
  const offset = Math.floor((last - start0) / size) + 1 - count; // keep the newest buckets when there are too many
  const buckets: SpendBucket[] = Array.from({ length: count }, (_, i) => ({ start: start0 + (i + offset) * size, total: 0, byGroup: {} }));
  let before = 0;
  for (const e of entries) {
    const i = Math.floor((e.at - start0) / size) - offset;
    if (i < 0) {
      before += e.usd;
      continue;
    }
    const b = buckets[Math.min(i, count - 1)];
    const g = GROUP_OF[e.kind] ?? 'other';
    b.total = round4(b.total + e.usd);
    b.byGroup[g] = round4((b.byGroup[g] ?? 0) + e.usd);
  }
  let run = before;
  const cumulative = buckets.map((b) => (run = round4(run + b.total)));
  return { unit, buckets, cumulative, ...(capped ? { recentN: doc.spend.entries.length } : {}) };
};

// ── Times and dates (always the real fetch time; never "live" without one) ──

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "14:05" today, "Oct 22, 14:05" this year, "Oct 22, 2025" before; '' for an unreadable time. */
export const clockText = (at: number | string | undefined | null, now = Date.now()): string => {
  if (at === undefined || at === null || at === '') return '';
  const t = typeof at === 'number' ? at : Date.parse(at);
  if (!finite(t)) return '';
  const d = new Date(t);
  const n = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return hm;
  if (d.getFullYear() === n.getFullYear()) return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hm}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
};

/** '2026-10-07' → "Oct 7, 2026"; '2026-10' → "Oct 2026"; full ISO times → the date part; anything else as is. */
export const dateText = (s: string | undefined | null): string => {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(s);
  if (!m) return s;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return s;
  return m[3] ? `${month} ${Number(m[3])}, ${m[1]}` : `${month} ${m[1]}`;
};

/** A bucket start as a short label for its unit. */
export const bucketLabel = (start: number, unit: SpendSeries['unit']): string => {
  const d = new Date(start);
  return unit === 'hour' ? `${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:00` : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

// ── Catalog row → words (models.md §4.3 / §4.6) ───────────────────────────────

export const nicknameOf = (modelId: string): string => getImageModel(modelId)?.nickname ?? modelId;

export const BASIS_LABEL: Record<CatalogPrice['basis'], string> = {
  openrouter_endpoint: 'OpenRouter',
  vendor_table: 'vendor token table',
  derived_mp: 'per megapixel (OpenRouter)',
  registry: 'our price list'
};

/**
 * Where a catalog price comes from, in a few words: "OpenRouter", "vendor token table", or — when the catalog fell
 * back to the registry (never fetched, fetch failed with no cache, or OpenRouter has no data) — the dated price list
 * ("from our price list, 2026-10-22"). A registry fallback is never labelled OpenRouter, and only the dated
 * "from our price list" part of its note is used (it never names a dollar amount).
 */
export const catalogSourceLabel = (p: CatalogPrice): string => {
  if (p.basis !== 'registry') return BASIS_LABEL[p.basis];
  const m = /^from our price list, [^·$]+/.exec(typeof p.note === 'string' ? p.note.trim() : '');
  return m ? m[0].trim() : BASIS_LABEL.registry;
};

export interface PriceView {
  /** The figure, or the §4.6 copy. */
  text: string;
  /** No figure (the copy explains why). */
  unavailable: boolean;
  /** Where the figure comes from ("OpenRouter"; dollar viewers also get the server's note). */
  source?: string;
}

/** A catalog price in words for this viewer; undefined when the model has no such size. */
export const priceView = (p: CatalogPrice | undefined, money: InsightsMoney): PriceView | undefined => {
  if (!p) return undefined;
  const note = typeof p.note === 'string' ? p.note.trim() : '';
  if (p.usd === null || !finite(p.usd)) {
    if (/no price|doesn't list a price|publishes no price/i.test(note) || note === NO_OPENROUTER_PRICE_COPY) return { text: NO_OPENROUTER_PRICE_COPY, unavailable: true };
    if (!note || /per token|isn't published|not published/i.test(note) || note === PRICE_UNPUBLISHED_COPY) return { text: PRICE_UNPUBLISHED_COPY, unavailable: true };
    // A raw variant the catalog could not map to a size ("high_resolution"): say so with its own words.
    return { text: note.includes('$') ? 'No price for this size yet' : `No price for this size yet (${note})`, unavailable: true };
  }
  // Governed users never read a free-text price note (it can name a dollar amount) — only the dated price-list
  // copy, which never does; dollar viewers see the full source (including "sources disagree" notes).
  const priceList = p.basis === 'registry' && /^from our price list, [^$]*$/.test(note);
  const source = priceList ? note : money.governed || !note ? BASIS_LABEL[p.basis] : p.basis === 'registry' ? note : `${BASIS_LABEL[p.basis]} · ${note}`;
  return { text: money.price(p.usd), unavailable: false, source };
};

/** Registry facts for a model when no catalog row could be fetched (§4.6 "Fetch failed, no cache"). */
export const registryPriceViews = (modelId: string, money: InsightsMoney): { res: Resolution; view: PriceView }[] => {
  const spec = getImageModel(modelId);
  if (!spec) return [];
  return RESOLUTION_ORDER.filter((r) => finite(spec.priceUsd[r]))
    .map((res) => ({ res, view: { text: money.price(spec.priceUsd[res] as number), unavailable: false, source: priceListCopy(spec.factsAsOf) } }));
};

const pct = (n: number) => `${Math.round(n * 100) / 100}%`;

/** One line per endpoint: "Google AI Studio · 97.72% up (24 h)" (+ "· 99% (30 min)" only when OpenRouter has it). */
export const uptimeLines = (endpoints: readonly CatalogEndpoint[]): string[] =>
  endpoints
    .map((e) => {
      const day = finite(e.uptime1d) ? `${pct(e.uptime1d)} up (24 h)` : '';
      const recent = finite(e.uptime30m) ? `${pct(e.uptime30m)}${day ? '' : ' up'} (30 min)` : '';
      if (!day && !recent) return '';
      return `${e.provider} · ${[day, recent].filter(Boolean).join(' · ')}`;
    })
    .filter(Boolean);

/** The uptime words for a row: its lines, or the §4.6 copy. */
export const uptimeText = (endpoints: readonly CatalogEndpoint[]): string[] => {
  const lines = uptimeLines(endpoints);
  return lines.length ? lines : [NO_UPTIME_COPY];
};

export const BOARD_LABEL: Record<QualityBoard, string> = {
  lmarena_t2i: 'LMArena text-to-image',
  lmarena_edit: 'LMArena edit',
  lmarena_multi_image: 'LMArena multi-image edit',
  aa_t2i: 'Artificial Analysis text-to-image',
  aa_edit: 'Artificial Analysis edit',
  design_arena: 'Design Arena'
};

/** "LMArena edit #3 of 60 · score 1215 (Oct 20, 2026)"; the §4.6 copy when no board lists the model. */
export const qualityText = (quality: readonly QualityEntry[]): string[] =>
  quality.length
    ? quality.map((q) => {
        const rank = finite(q.rank) ? ` #${q.rank}${finite(q.of) ? ` of ${q.of}` : ''}` : '';
        return `${BOARD_LABEL[q.board] ?? q.board}${rank} · score ${Math.round(q.score)} (${dateText(q.asOf)})`;
      })
    : [NOT_RANKED_COPY];

const OBSERVED_KIND_LABEL: Record<string, string> = { page: 'pages', sheet: 'character sheets', cover: 'covers', edit: 'page edits', style_option: 'style tests', place: 'places', qc: 'quality checks' };

/** The days observed calls span: " · Oct 20, 2026–Oct 22, 2026", one date when they share a day, '' when unknown. */
const observedWindow = (o: Pick<ObservedEntry, 'from' | 'to'>): string => {
  const from = dateText(o.from);
  const to = dateText(o.to);
  if (!from || !to) return '';
  return from === to ? ` · ${from}` : ` · ${from}–${to}`;
};

/** Real cost lines from the catalog's observations — only groups with n ≥ 3 (§4.6); n, range and the days they
 *  span always shown (§4.7: every figure carries its source and time). */
export const observedLines = (observed: readonly ObservedEntry[], money: InsightsMoney): string[] =>
  observed
    .filter((o) => o.n >= OBSERVED_MIN_N && finite(o.medianUsd))
    .map((o) => {
      const range = [money.priceShort(o.minUsd), money.priceShort(o.maxUsd)];
      const spread = range[0] && range[1] ? `, ${range[0]}–${range[1]}` : '';
      return `Real cost, ${OBSERVED_KIND_LABEL[o.kind] ?? o.kind} at ${o.res}: ${money.price(o.medianUsd)} median (n = ${o.n}${spread}) · ${o.scope === 'you' ? 'your calls' : 'all creators'}${observedWindow(o)}`;
    });

/** "Last 24 h, your calls: 12 calls · 1 failed · 1 rate-limited". */
export const reliabilityText = (r: ReliabilityEntry | undefined): string | undefined =>
  r ? `Last ${r.windowH} h, ${r.scope === 'you' ? 'your calls' : 'all creators'}: ${r.calls} call${r.calls === 1 ? '' : 's'} · ${r.failed} failed · ${r.rateLimited} rate-limited` : undefined;

/** The row for a model id, if the catalog has one. */
export const rowFor = (rows: readonly ModelCatalogRow[] | null | undefined, modelId: string): ModelCatalogRow | undefined =>
  rows?.find((r) => r.id === modelId);
