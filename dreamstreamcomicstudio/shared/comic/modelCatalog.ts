// Model catalog wire types (models.md §4.3 rows, §4.1 L3 detail, §4.4 trends) — what
// GET /api/comic/models/catalog, /models/:id and /models/trends answer. Defined here so the server
// (server/src/comic/models/{catalog,quality,observed}.ts re-export them, names unchanged) and the
// picker / Insights UIs share one contract instead of mirroring it. Types only: no runtime code.
//
// Every price, uptime and quality figure carries its source and time; a figure we do not have is
// null with the §4.6 copy in `note`, never a guess. Dollar fields are server-side facts: a governed
// user's UI words them through formatCostForUser (the routes strip dollar amounts from notes for a
// usage view and say which view in X-Cost-View).

import type { Resolution } from './doc.js';
import type { ImageJobKind, ImageModelSpec } from './models.js';
import type { FitReason } from './modelLock.js';

// ── Prices ───────────────────────────────────────────────────────────────────

export type PriceBasis = 'openrouter_endpoint' | 'vendor_table' | 'derived_mp' | 'registry';

export interface CatalogPrice {
  usd: number | null;
  basis: PriceBasis;
  /** Where the number comes from, or the exact §4.6 copy when it is null. */
  note?: string;
}

export interface CatalogEndpoint {
  provider: string;
  uptime1d: number | null;
  uptime30m: number | null;
}

// ── Quality (public leaderboards) ─────────────────────────────────────────────

export type QualityBoard = 'lmarena_t2i' | 'lmarena_edit' | 'lmarena_multi_image' | 'aa_t2i' | 'aa_edit' | 'design_arena';

export interface QualityEntry {
  board: QualityBoard;
  rank?: number;
  of?: number;
  score: number;
  ci?: [number, number];
  /** Board publish date / fetch time. */
  asOf: string;
  source: string;
}

export interface QualityHistoryPoint {
  asOf: string;
  rank?: number;
  score: number;
  /** The leaderboard entry this point is (a model's variants change over time, e.g. preview → GA). */
  name?: string;
}

export interface RankMove {
  board: QualityBoard;
  from: QualityHistoryPoint;
  to: QualityHistoryPoint;
  /** Positive = climbed (rank got smaller). */
  delta: number;
}

// ── Our own observations (comic_image_calls) ─────────────────────────────────

export type ObservedKind = ImageJobKind | 'qc';

export interface ObservedEntry {
  kind: ObservedKind;
  res: Resolution;
  n: number;
  medianUsd: number;
  minUsd: number;
  maxUsd: number;
  from: string;
  to: string;
  scope: 'you' | 'platform';
}

export interface ReliabilityEntry {
  /** The window in hours (24). */
  windowH: 24;
  calls: number;
  failed: number;
  rateLimited: number;
  scope: 'you' | 'platform';
}

/** `model_usage_monthly` row for product 'comic_studio'. */
export interface MonthlyUsageRow {
  month: string;
  product: string;
  source: string;
  model: string;
  requests: number;
}

// ── Rows (models.md §4.3) ─────────────────────────────────────────────────────

export interface ModelCatalogRow {
  id: string;
  nickname: string;
  providerModel: string;
  canonicalSlug?: string;
  openrouterCreated?: string;
  pickable: boolean;
  lifecycle: ImageModelSpec['lifecycle'];
  price: Partial<Record<Resolution, CatalogPrice>>;
  perRefUsd: number | null;
  endpoints: CatalogEndpoint[];
  quality: QualityEntry[];
  /** Rows only carry `kind` 'page' | 'sheet' | 'cover' (models.md §4.3). */
  observed: ObservedEntry[];
  reliability?: ReliabilityEntry;
  /** When a projectId is passed. */
  fit?: FitReason[];
  /** When a projectId is passed: this is the comic's locked (or migrated) model. */
  current?: boolean;
  /**
   * When a projectId is passed and this is not the comic's model: this model's list price per page at the
   * resolution it would draw this comic's pages at, divided by the current model's (models.md §5.1 acceptance
   * "Nano Banana Pro (warn: price)"). Absent when either price is unknown.
   */
  priceVsCurrent?: { currentId: string; ratio: number; res: Resolution };
  fetchedAt: { catalog?: string; uptime?: string; quality?: string };
  /** This row's price or uptime refresh failed (or did not finish in time); showing cached data. */
  stale: boolean;
  /** The leaderboard refresh failed; the dated snapshot (`fetchedAt.quality`) is shown. Never folded into `stale`. */
  qualityStale?: boolean;
}

/** GET /api/comic/models/:id — the row plus the registry facts and the history we hold (models.md §4.1 L3). */
export interface ModelCatalogDetail extends ModelCatalogRow {
  facts: {
    factsAsOf: string;
    priceBasis: ImageModelSpec['priceBasis'];
    refs: ImageModelSpec['refs'];
    aspects: ImageModelSpec['aspects'];
    resolutions: ImageModelSpec['resolutions'];
    fixedQuality?: ImageModelSpec['fixedQuality'];
    gradeSources?: ImageModelSpec['gradeSources'];
    replacement?: string;
  };
  /** Change-only price snapshots for this model in the last 90 days (T3). */
  priceHistory: { res: Resolution; usd: number | null; basis: PriceBasis; at: string; note?: string }[];
  /** Dated leaderboard points we hold (T4); nothing interpolated. */
  qualityHistory: { board: QualityBoard; asOf: string; rank?: number; score: number }[];
  /** NOT_RANKED_COPY when no public board lists the model. */
  qualityNote?: string;
}

// ── Trends (models.md §4.4) ───────────────────────────────────────────────────

export type TrendRange = '30d' | '90d';

export interface ModelTrends {
  range: TrendRange;
  from: string;
  to: string;
  /** T2 — your image use by model per month (comic_image_calls, yours) + the platform monthly counters. */
  t2: {
    yours: { month: string; modelId: string; images: number }[];
    platform: MonthlyUsageRow[];
    source: { yours: string; platform: string };
  };
  /** T3 — price changes we recorded (change-only snapshots). */
  t3: {
    trackingSince: string | null;
    changes: { modelId: string; res: Resolution; usd: number | null; basis: PriceBasis; at: string; note?: string | null }[];
    /** "Tracking since {first fetch}"; null before the first fetch (§4.4: no line before that date). */
    note: string | null;
  };
  /** T4 — leaderboard movement from the history we hold. */
  t4: { moves: (RankMove & { modelId: string })[]; trackingSince: string | null; asOf?: string; source: string };
  /** T5 — new on OpenRouter inside the range. */
  t5: { sinceDays: number; models: { id: string; name: string; created: string }[]; fetchedAt?: string; stale: boolean };
  /** T6 — reliability: ours (24 h and 7 d) and OpenRouter's uptime, each labelled with its source. */
  t6: {
    ours: { modelId: string; window: '24h' | '7d'; calls: number; failed: number; rateLimited: number; scope: 'you' | 'platform' }[];
    openrouter: { modelId: string; provider: string; day: string; uptime1d: number | null; uptime30m: number | null; fetchedAt: string }[];
    source: { ours: string; openrouter: string };
  };
  /** T7 — most used by DreamStream creators, hidden below 5 distinct users. */
  t7: { available: boolean; copy?: string; models?: { modelId: string; calls: number; users: number }[]; sinceDays: number };
}
