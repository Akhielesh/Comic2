// Insights over HTTP (models.md §4.3–§4.5): GET /api/comic/models/catalog?projectId= (ModelCatalogRow[]) and
// GET /api/comic/models/trends?range=30d|90d (ModelTrends), both served by M1-CATALOG. Every answer is validated
// field by field, so a newer or broken server never reaches the UI as anything but well-formed rows (unknown
// fields dropped, malformed rows skipped, a missing figure stays null — never filled in). Requests go through
// services/apiClient (auth token + the user's own key headers, so the server prices for THIS user). Nothing here
// polls: callers ask on demand (useInsights.tsx).

import { get } from '../../../services/apiClient';
import { toStudioApiError } from '../studioApi';
import type { Resolution } from '../../../shared/comic/doc';
import type { ImageModelSpec } from '../../../shared/comic/models';
import type { FitReason } from '../../../shared/comic/modelLock';
import type {
  CatalogEndpoint,
  CatalogPrice,
  ModelCatalogRow,
  ModelTrends,
  MonthlyUsageRow,
  ObservedEntry,
  PriceBasis,
  QualityBoard,
  QualityEntry,
  QualityHistoryPoint,
  ReliabilityEntry,
  TrendRange
} from '../../../shared/comic/modelCatalog';

export const CATALOG_PATH = '/api/comic/models/catalog';
export const TRENDS_PATH = '/api/comic/models/trends';
export const TREND_RANGES: readonly TrendRange[] = ['30d', '90d'];

const RESOLUTIONS: ReadonlySet<string> = new Set<Resolution>(['512', '1K', '2K', '4K']);
const BASES: ReadonlySet<string> = new Set<PriceBasis>(['openrouter_endpoint', 'vendor_table', 'derived_mp', 'registry']);
const BOARDS: ReadonlySet<string> = new Set<QualityBoard>(['lmarena_t2i', 'lmarena_edit', 'lmarena_multi_image', 'aa_t2i', 'aa_edit', 'design_arena']);
const LIFECYCLES: ReadonlySet<string> = new Set<ImageModelSpec['lifecycle']>(['ga', 'preview', 'deprecated', 'experimental']);
const OBSERVED_KINDS: ReadonlySet<string> = new Set(['page', 'sheet', 'cover', 'edit', 'style_option', 'place', 'qc']);
const FIT_CODES: ReadonlySet<string> = new Set<FitReason['code']>(['aspect', 'characters', 'resolution', 'refs', 'lettering', 'access', 'experimental', 'price_unverified', 'transport', 'hidden', 'price']);
const SCOPES: ReadonlySet<string> = new Set(['you', 'platform']);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const numOrNull = (v: unknown): number | null => num(v) ?? null;
const text = (v: unknown, max = 200): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/\s+/g, ' ').trim().slice(0, max);
  return s || undefined;
};
const list = <T>(v: unknown, as: (x: unknown) => T | undefined, max = 200): T[] =>
  Array.isArray(v) ? v.slice(0, max).map(as).filter((x): x is T => x !== undefined) : [];
const opt = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> => (value === undefined ? {} : ({ [key]: value } as Record<K, V>));

const asPrice = (v: unknown): CatalogPrice | undefined => {
  if (!isObject(v)) return undefined;
  const basis = BASES.has(String(v.basis)) ? (v.basis as PriceBasis) : 'registry';
  const usd = num(v.usd);
  return { usd: usd !== undefined && usd >= 0 ? usd : null, basis, ...opt('note', text(v.note, 300)) };
};

const asEndpoint = (v: unknown): CatalogEndpoint | undefined => {
  if (!isObject(v)) return undefined;
  const provider = text(v.provider, 80);
  return provider ? { provider, uptime1d: numOrNull(v.uptime1d), uptime30m: numOrNull(v.uptime30m) } : undefined;
};

const asQuality = (v: unknown): QualityEntry | undefined => {
  if (!isObject(v) || !BOARDS.has(String(v.board))) return undefined;
  const score = num(v.score);
  const asOf = text(v.asOf, 40);
  const source = text(v.source, 200);
  if (score === undefined || !asOf || !source) return undefined;
  const ci = Array.isArray(v.ci) && v.ci.length === 2 && num(v.ci[0]) !== undefined && num(v.ci[1]) !== undefined ? ([v.ci[0], v.ci[1]] as [number, number]) : undefined;
  return { board: v.board as QualityBoard, ...opt('rank', num(v.rank)), ...opt('of', num(v.of)), score, ...opt('ci', ci), asOf, source };
};

const asObserved = (v: unknown): ObservedEntry | undefined => {
  if (!isObject(v) || !OBSERVED_KINDS.has(String(v.kind)) || !RESOLUTIONS.has(String(v.res)) || !SCOPES.has(String(v.scope))) return undefined;
  const n = num(v.n);
  const medianUsd = num(v.medianUsd);
  const minUsd = num(v.minUsd);
  const maxUsd = num(v.maxUsd);
  if (n === undefined || medianUsd === undefined || minUsd === undefined || maxUsd === undefined) return undefined;
  return {
    kind: v.kind as ObservedEntry['kind'],
    res: v.res as Resolution,
    n,
    medianUsd,
    minUsd,
    maxUsd,
    from: text(v.from, 40) ?? '',
    to: text(v.to, 40) ?? '',
    scope: v.scope as ObservedEntry['scope']
  };
};

const asReliability = (v: unknown): ReliabilityEntry | undefined => {
  if (!isObject(v) || !SCOPES.has(String(v.scope))) return undefined;
  const calls = num(v.calls);
  if (calls === undefined) return undefined;
  return { windowH: 24, calls, failed: num(v.failed) ?? 0, rateLimited: num(v.rateLimited) ?? 0, scope: v.scope as ReliabilityEntry['scope'] };
};

const asFit = (v: unknown): FitReason | undefined => {
  if (!isObject(v) || !FIT_CODES.has(String(v.code)) || (v.severity !== 'block' && v.severity !== 'warn')) return undefined;
  const t = text(v.text, 240);
  return t ? { code: v.code as FitReason['code'], severity: v.severity, text: t } : undefined;
};

/** A well-formed catalog row, or undefined. Pure. */
export const asCatalogRow = (v: unknown): ModelCatalogRow | undefined => {
  if (!isObject(v)) return undefined;
  const id = text(v.id, 80);
  if (!id) return undefined;
  const price: ModelCatalogRow['price'] = {};
  if (isObject(v.price)) {
    for (const [res, p] of Object.entries(v.price)) {
      if (!RESOLUTIONS.has(res)) continue;
      const parsed = asPrice(p);
      if (parsed) price[res as Resolution] = parsed;
    }
  }
  const fetched = isObject(v.fetchedAt) ? v.fetchedAt : {};
  const pvc = isObject(v.priceVsCurrent) && text(v.priceVsCurrent.currentId, 80) && num(v.priceVsCurrent.ratio) !== undefined && RESOLUTIONS.has(String(v.priceVsCurrent.res))
    ? { currentId: text(v.priceVsCurrent.currentId, 80)!, ratio: num(v.priceVsCurrent.ratio)!, res: v.priceVsCurrent.res as Resolution }
    : undefined;
  const reliability = asReliability(v.reliability);
  return {
    id,
    nickname: text(v.nickname, 80) ?? id,
    providerModel: text(v.providerModel, 120) ?? '',
    ...opt('canonicalSlug', text(v.canonicalSlug, 160)),
    ...opt('openrouterCreated', text(v.openrouterCreated, 40)),
    pickable: v.pickable === true,
    lifecycle: LIFECYCLES.has(String(v.lifecycle)) ? (v.lifecycle as ModelCatalogRow['lifecycle']) : 'ga',
    price,
    perRefUsd: numOrNull(v.perRefUsd),
    endpoints: list(v.endpoints, asEndpoint, 20),
    quality: list(v.quality, asQuality, 12),
    observed: list(v.observed, asObserved, 40),
    ...(reliability ? { reliability } : {}),
    ...(Array.isArray(v.fit) ? { fit: list(v.fit, asFit, 20) } : {}),
    ...(typeof v.current === 'boolean' ? { current: v.current } : {}),
    ...(pvc ? { priceVsCurrent: pvc } : {}),
    fetchedAt: { ...opt('catalog', text(fetched.catalog, 40)), ...opt('uptime', text(fetched.uptime, 40)), ...opt('quality', text(fetched.quality, 40)) },
    stale: v.stale === true,
    ...(typeof v.qualityStale === 'boolean' ? { qualityStale: v.qualityStale } : {})
  };
};

const asMonthly = (v: unknown): MonthlyUsageRow | undefined => {
  if (!isObject(v)) return undefined;
  const month = text(v.month, 10);
  const model = text(v.model, 120);
  const requests = num(v.requests);
  return month && model && requests !== undefined ? { month, product: text(v.product, 40) ?? '', source: text(v.source, 40) ?? '', model, requests } : undefined;
};

const asPoint = (v: unknown): QualityHistoryPoint | undefined => {
  if (!isObject(v)) return undefined;
  const asOf = text(v.asOf, 40);
  const score = num(v.score);
  return asOf && score !== undefined ? { asOf, ...opt('rank', num(v.rank)), score, ...opt('name', text(v.name, 120)) } : undefined;
};

/** Well-formed trends (missing parts become empty, never invented). Pure. */
export const asTrends = (v: unknown, range: TrendRange): ModelTrends => {
  const o = isObject(v) ? v : {};
  const t2 = isObject(o.t2) ? o.t2 : {};
  const t2src = isObject(t2.source) ? t2.source : {};
  const t3 = isObject(o.t3) ? o.t3 : {};
  const t4 = isObject(o.t4) ? o.t4 : {};
  const t5 = isObject(o.t5) ? o.t5 : {};
  const t6 = isObject(o.t6) ? o.t6 : {};
  const t6src = isObject(t6.source) ? t6.source : {};
  const t7 = isObject(o.t7) ? o.t7 : {};
  return {
    range: o.range === '90d' || o.range === '30d' ? o.range : range,
    from: text(o.from, 40) ?? '',
    to: text(o.to, 40) ?? '',
    t2: {
      yours: list(t2.yours, (r) => {
        if (!isObject(r)) return undefined;
        const month = text(r.month, 10);
        const modelId = text(r.modelId, 80);
        const images = num(r.images);
        return month && modelId && images !== undefined ? { month, modelId, images } : undefined;
      }),
      platform: list(t2.platform, asMonthly),
      source: { yours: text(t2src.yours) ?? '', platform: text(t2src.platform) ?? '' }
    },
    t3: {
      trackingSince: text(t3.trackingSince, 40) ?? null,
      changes: list(t3.changes, (r) => {
        if (!isObject(r) || !RESOLUTIONS.has(String(r.res))) return undefined;
        const modelId = text(r.modelId, 80);
        const at = text(r.at, 40);
        if (!modelId || !at) return undefined;
        return { modelId, res: r.res as Resolution, usd: numOrNull(r.usd), basis: BASES.has(String(r.basis)) ? (r.basis as PriceBasis) : 'registry', at, note: text(r.note, 300) ?? null };
      }),
      note: text(t3.note, 120) ?? null
    },
    t4: {
      moves: list(t4.moves, (r) => {
        if (!isObject(r) || !BOARDS.has(String(r.board))) return undefined;
        const modelId = text(r.modelId, 80);
        const from = asPoint(r.from);
        const to = asPoint(r.to);
        const delta = num(r.delta);
        return modelId && from && to && delta !== undefined ? { modelId, board: r.board as QualityBoard, from, to, delta } : undefined;
      }),
      trackingSince: text(t4.trackingSince, 40) ?? null,
      ...opt('asOf', text(t4.asOf, 40)),
      source: text(t4.source) ?? ''
    },
    t5: {
      sinceDays: num(t5.sinceDays) ?? (range === '90d' ? 90 : 30),
      models: list(t5.models, (r) => {
        if (!isObject(r)) return undefined;
        const id = text(r.id, 120);
        const created = text(r.created, 40);
        return id && created ? { id, name: text(r.name, 120) ?? id, created } : undefined;
      }),
      ...opt('fetchedAt', text(t5.fetchedAt, 40)),
      stale: t5.stale === true
    },
    t6: {
      ours: list(t6.ours, (r) => {
        if (!isObject(r) || (r.window !== '24h' && r.window !== '7d') || !SCOPES.has(String(r.scope))) return undefined;
        const modelId = text(r.modelId, 80);
        const calls = num(r.calls);
        return modelId && calls !== undefined
          ? { modelId, window: r.window, calls, failed: num(r.failed) ?? 0, rateLimited: num(r.rateLimited) ?? 0, scope: r.scope as 'you' | 'platform' }
          : undefined;
      }),
      openrouter: list(t6.openrouter, (r) => {
        if (!isObject(r)) return undefined;
        const modelId = text(r.modelId, 120);
        const provider = text(r.provider, 80);
        const day = text(r.day, 10);
        const fetchedAt = text(r.fetchedAt, 40);
        return modelId && provider && day && fetchedAt ? { modelId, provider, day, uptime1d: numOrNull(r.uptime1d), uptime30m: numOrNull(r.uptime30m), fetchedAt } : undefined;
      }, 400),
      source: { ours: text(t6src.ours) ?? '', openrouter: text(t6src.openrouter) ?? '' }
    },
    t7: {
      available: t7.available === true && Array.isArray(t7.models),
      ...opt('copy', text(t7.copy, 120)),
      ...(t7.available === true && Array.isArray(t7.models)
        ? {
            models: list(t7.models, (r) => {
              if (!isObject(r)) return undefined;
              const modelId = text(r.modelId, 80);
              const calls = num(r.calls);
              const users = num(r.users);
              return modelId && calls !== undefined && users !== undefined ? { modelId, calls, users } : undefined;
            }, 20)
          }
        : {}),
      sinceDays: num(t7.sinceDays) ?? 30
    }
  };
};

/** The catalog for the signed-in user; with a projectId the rows carry `fit` / `current` for that comic. */
export async function fetchInsightsCatalog(projectId?: string, opts: { signal?: AbortSignal } = {}): Promise<ModelCatalogRow[]> {
  const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  try {
    const res = await get<unknown>(`${CATALOG_PATH}${q}`, { signal: opts.signal });
    return list(res, asCatalogRow, 100);
  } catch (err) {
    throw toStudioApiError(err, 'generic');
  }
}

/** T2–T7 for the signed-in user over 30 or 90 days. */
export async function fetchInsightsTrends(range: TrendRange, opts: { signal?: AbortSignal } = {}): Promise<ModelTrends> {
  const r: TrendRange = range === '90d' ? '90d' : '30d';
  try {
    return asTrends(await get<unknown>(`${TRENDS_PATH}?range=${r}`, { signal: opts.signal }), r);
  } catch (err) {
    throw toStudioApiError(err, 'generic');
  }
}
