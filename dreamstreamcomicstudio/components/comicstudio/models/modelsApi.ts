// The model catalog over HTTP (models.md §4.3; M1-CATALOG's routes): GET /api/comic/models/catalog?projectId=
// (bare ModelCatalogRow[]; with a projectId the server fills `fit` with THIS user's caps and `current`) and
// GET /api/comic/models/:id?projectId= (ModelCatalogDetail). Answers are validated field by field so a newer or
// broken server reaches the picker only as well-formed rows (unknown fields dropped, malformed rows skipped).
// Requests go through services/apiClient (auth + the user's own provider-key headers). Nothing here polls: the
// picker asks when it opens (useModelCatalog).
//
// When the catalog cannot be loaded at all, `registryCatalogRows` gives the picker the registry's own dated facts
// (models.md §4.6 "Fetch failed, no cache → registry facts with 'from our price list, {factsAsOf}'"; no uptime,
// no live rankings) so the user can still choose — every figure says where it came from.

import { get } from '../../../services/apiClient';
import { StudioApiError, toStudioApiError } from '../studioApi';
import type { Resolution } from '../../../shared/comic/doc';
import type {
  CatalogEndpoint,
  CatalogPrice,
  ModelCatalogDetail,
  ModelCatalogRow,
  ObservedEntry,
  PriceBasis,
  QualityBoard,
  QualityEntry,
  ReliabilityEntry
} from '../../../shared/comic/modelCatalog';
import type { FitReason } from '../../../shared/comic/modelLock';
import { IMAGE_MODELS, type ImageModelSpec } from '../../../shared/comic/models';
import { PRICE_UNPUBLISHED, fromPriceList } from './copy';
import { QC_SERVED_MAX_USD, type ServedCatalogRow } from './priceBook';

export const MODEL_CATALOG_PATH = '/api/comic/models/catalog';
export const modelDetailPath = (id: string) => `/api/comic/models/${encodeURIComponent(id)}`;

const RESOLUTIONS: readonly Resolution[] = ['512', '1K', '2K', '4K'];
const PRICE_BASES: ReadonlySet<string> = new Set<PriceBasis>(['openrouter_endpoint', 'vendor_table', 'derived_mp', 'registry']);
const BOARDS: ReadonlySet<string> = new Set<QualityBoard>(['lmarena_t2i', 'lmarena_edit', 'lmarena_multi_image', 'aa_t2i', 'aa_edit', 'design_arena']);
const LIFECYCLES: ReadonlySet<string> = new Set<ImageModelSpec['lifecycle']>(['ga', 'preview', 'deprecated', 'experimental']);
const FIT_CODES: ReadonlySet<string> = new Set<FitReason['code']>([
  'aspect', 'characters', 'resolution', 'refs', 'lettering', 'access', 'experimental', 'price_unverified', 'transport', 'hidden', 'price'
]);
const OBSERVED_KINDS: ReadonlySet<string> = new Set(['page', 'sheet', 'cover']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PROJECT_RE = /^[A-Za-z0-9-]{1,64}$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const text = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/\s+/g, ' ').trim().slice(0, max);
  return s || undefined;
};
const list = <T>(v: unknown, map: (x: unknown) => T | undefined, max: number): T[] =>
  Array.isArray(v) ? v.slice(0, max).map(map).filter((x): x is T => x !== undefined) : [];

const asPrice = (v: unknown): CatalogPrice | undefined => {
  if (!isObject(v) || !PRICE_BASES.has(String(v.basis))) return undefined;
  const usd = v.usd === null ? null : num(v.usd);
  if (usd === undefined || (usd !== null && usd < 0)) return undefined;
  const note = text(v.note, 240);
  return { usd, basis: v.basis as PriceBasis, ...(note ? { note } : {}) };
};

const asEndpoint = (v: unknown): CatalogEndpoint | undefined => {
  if (!isObject(v)) return undefined;
  const provider = text(v.provider, 80);
  if (!provider) return undefined;
  const pct = (x: unknown) => {
    const n = num(x);
    return n === undefined || n < 0 || n > 100 ? null : n;
  };
  return { provider, uptime1d: pct(v.uptime1d), uptime30m: pct(v.uptime30m) };
};

const asQuality = (v: unknown): QualityEntry | undefined => {
  if (!isObject(v) || !BOARDS.has(String(v.board))) return undefined;
  const score = num(v.score);
  const asOf = text(v.asOf, 40);
  if (score === undefined || !asOf) return undefined;
  const rank = num(v.rank);
  const of = num(v.of);
  const ci = Array.isArray(v.ci) && v.ci.length === 2 && v.ci.every((x) => num(x) !== undefined) ? ([v.ci[0], v.ci[1]] as [number, number]) : undefined;
  return {
    board: v.board as QualityBoard,
    ...(rank !== undefined && rank >= 1 ? { rank: Math.round(rank) } : {}),
    ...(of !== undefined && of >= 1 ? { of: Math.round(of) } : {}),
    score,
    ...(ci ? { ci } : {}),
    asOf,
    source: text(v.source, 300) || 'unknown source'
  };
};

const asObserved = (v: unknown): ObservedEntry | undefined => {
  if (!isObject(v) || !OBSERVED_KINDS.has(String(v.kind)) || !RESOLUTIONS.includes(v.res as Resolution)) return undefined;
  const n = num(v.n);
  const medianUsd = num(v.medianUsd);
  const minUsd = num(v.minUsd);
  const maxUsd = num(v.maxUsd);
  if (n === undefined || n < 1 || medianUsd === undefined || minUsd === undefined || maxUsd === undefined) return undefined;
  if (v.scope !== 'you' && v.scope !== 'platform') return undefined;
  return {
    kind: v.kind as ObservedEntry['kind'],
    res: v.res as Resolution,
    n: Math.round(n),
    medianUsd,
    minUsd,
    maxUsd,
    from: text(v.from, 40) || '',
    to: text(v.to, 40) || '',
    scope: v.scope
  };
};

const asReliability = (v: unknown): ReliabilityEntry | undefined => {
  if (!isObject(v) || (v.scope !== 'you' && v.scope !== 'platform')) return undefined;
  const calls = num(v.calls);
  const failed = num(v.failed);
  const rateLimited = num(v.rateLimited);
  if (calls === undefined || failed === undefined || rateLimited === undefined) return undefined;
  return { windowH: 24, calls, failed, rateLimited, scope: v.scope };
};

const asFit = (v: unknown): FitReason | undefined => {
  if (!isObject(v) || !FIT_CODES.has(String(v.code)) || (v.severity !== 'block' && v.severity !== 'warn')) return undefined;
  const t = text(v.text, 200);
  return t ? { code: v.code as FitReason['code'], severity: v.severity, text: t } : undefined;
};

/** A well-formed catalog row (with the served QC per page when present and sane), or undefined. Pure. */
export const asCatalogRow = (v: unknown): ServedCatalogRow | undefined => {
  if (!isObject(v)) return undefined;
  const id = typeof v.id === 'string' && ID_RE.test(v.id) ? v.id : undefined;
  const nickname = text(v.nickname, 80);
  if (!id || !nickname || typeof v.pickable !== 'boolean' || !LIFECYCLES.has(String(v.lifecycle))) return undefined;
  const price: Partial<Record<Resolution, CatalogPrice>> = {};
  if (isObject(v.price)) {
    for (const r of RESOLUTIONS) {
      const p = asPrice(v.price[r]);
      if (p) price[r] = p;
    }
  }
  const fetched = isObject(v.fetchedAt) ? v.fetchedAt : {};
  const fetchedAt: ModelCatalogRow['fetchedAt'] = {};
  for (const k of ['catalog', 'uptime', 'quality'] as const) {
    const t = text(fetched[k], 40);
    if (t) fetchedAt[k] = t;
  }
  const reliability = asReliability(v.reliability);
  const pvc = isObject(v.priceVsCurrent) ? v.priceVsCurrent : undefined;
  const ratio = num(pvc?.ratio);
  const priceVsCurrent =
    pvc && typeof pvc.currentId === 'string' && ID_RE.test(pvc.currentId) && ratio !== undefined && ratio > 0 && RESOLUTIONS.includes(pvc.res as Resolution)
      ? { currentId: pvc.currentId, ratio, res: pvc.res as Resolution }
      : undefined;
  const perRef = v.perRefUsd === null ? null : num(v.perRefUsd);
  const qc = num(v.qcUsd);
  return {
    id,
    nickname,
    providerModel: text(v.providerModel, 160) || id,
    ...(text(v.canonicalSlug, 160) ? { canonicalSlug: text(v.canonicalSlug, 160) } : {}),
    ...(text(v.openrouterCreated, 40) ? { openrouterCreated: text(v.openrouterCreated, 40) } : {}),
    pickable: v.pickable,
    lifecycle: v.lifecycle as ImageModelSpec['lifecycle'],
    price,
    perRefUsd: perRef === undefined || (perRef !== null && perRef < 0) ? null : perRef,
    endpoints: list(v.endpoints, asEndpoint, 24),
    quality: list(v.quality, asQuality, 12),
    observed: list(v.observed, asObserved, 24),
    ...(reliability ? { reliability } : {}),
    ...(Array.isArray(v.fit) ? { fit: list(v.fit, asFit, 16) } : {}),
    ...(typeof v.current === 'boolean' ? { current: v.current } : {}),
    ...(priceVsCurrent ? { priceVsCurrent } : {}),
    fetchedAt,
    stale: v.stale === true,
    ...(typeof v.qualityStale === 'boolean' ? { qualityStale: v.qualityStale } : {}),
    ...(qc !== undefined && qc >= 0 && qc <= QC_SERVED_MAX_USD ? { qcUsd: qc } : {})
  };
};

/** A well-formed model detail, or undefined. Pure. */
export const asCatalogDetail = (v: unknown): ModelCatalogDetail | undefined => {
  const row = asCatalogRow(v);
  if (!row || !isObject(v)) return undefined;
  const f = isObject(v.facts) ? v.facts : {};
  const spec = IMAGE_MODELS.find((m) => m.id === row.id);
  const factsAsOf = text(f.factsAsOf, 40) || spec?.factsAsOf || '';
  const refs = isObject(f.refs) && [f.refs.total, f.refs.characters, f.refs.objects, f.refs.style].every((x) => num(x) !== undefined)
    ? { total: f.refs.total as number, characters: f.refs.characters as number, objects: f.refs.objects as number, style: f.refs.style as number }
    : spec?.refs ?? { total: 0, characters: 0, objects: 0, style: 0 };
  const strings = (x: unknown, max: number) => list(x, (s) => text(s, 16), max);
  const gradeSources = isObject(f.gradeSources)
    ? Object.fromEntries((['text', 'pages', 'edit'] as const).map((k) => [k, text((f.gradeSources as Record<string, unknown>)[k], 160)]).filter(([, s]) => !!s))
    : undefined;
  const priceBasis = ['per_image', 'per_token_table', 'per_megapixel', 'unverified'].includes(String(f.priceBasis))
    ? (f.priceBasis as ImageModelSpec['priceBasis'])
    : spec?.priceBasis ?? 'unverified';
  const fixedQuality = ['low', 'medium', 'high', 'xhigh', 'max'].includes(String(f.fixedQuality)) ? (f.fixedQuality as ImageModelSpec['fixedQuality']) : undefined;
  const replacement = typeof f.replacement === 'string' && ID_RE.test(f.replacement) ? f.replacement : undefined;
  const qualityNote = text(v.qualityNote, 200);
  return {
    ...row,
    facts: {
      factsAsOf,
      priceBasis,
      refs,
      aspects: strings(f.aspects, 20) as ImageModelSpec['aspects'],
      resolutions: strings(f.resolutions, 4).filter((r): r is Resolution => RESOLUTIONS.includes(r as Resolution)),
      ...(fixedQuality ? { fixedQuality } : {}),
      ...(gradeSources && Object.keys(gradeSources).length ? { gradeSources: gradeSources as ImageModelSpec['gradeSources'] } : {}),
      ...(replacement ? { replacement } : {})
    },
    priceHistory: list(
      v.priceHistory,
      (x) => {
        if (!isObject(x) || !RESOLUTIONS.includes(x.res as Resolution) || !PRICE_BASES.has(String(x.basis))) return undefined;
        const at = text(x.at, 40);
        const usd = x.usd === null ? null : num(x.usd);
        if (!at || usd === undefined) return undefined;
        const note = text(x.note, 200);
        return { res: x.res as Resolution, usd, basis: x.basis as PriceBasis, at, ...(note ? { note } : {}) };
      },
      60
    ),
    qualityHistory: list(
      v.qualityHistory,
      (x) => {
        if (!isObject(x) || !BOARDS.has(String(x.board))) return undefined;
        const asOf = text(x.asOf, 40);
        const score = num(x.score);
        const rank = num(x.rank);
        if (!asOf || score === undefined) return undefined;
        return { board: x.board as QualityBoard, asOf, score, ...(rank !== undefined ? { rank } : {}) };
      },
      120
    ),
    ...(qualityNote ? { qualityNote } : {})
  };
};

/** The catalog for the signed-in user (with a projectId: `fit` and `current` for that comic). */
export async function fetchModelCatalog(projectId?: string, opts: { signal?: AbortSignal } = {}): Promise<ModelCatalogRow[]> {
  const q = projectId && PROJECT_RE.test(projectId) ? `?projectId=${encodeURIComponent(projectId)}` : '';
  try {
    const res = await get<unknown>(`${MODEL_CATALOG_PATH}${q}`, { signal: opts.signal });
    return list(res, asCatalogRow, 64);
  } catch (err) {
    throw toStudioApiError(err, 'generic');
  }
}

/** One model's detail (row + registry facts + the history we hold). */
export async function fetchModelDetail(id: string, projectId?: string, opts: { signal?: AbortSignal } = {}): Promise<ModelCatalogDetail> {
  if (!ID_RE.test(id)) throw new StudioApiError('not_found', "That model isn't in Comic Studio.", { status: 404 });
  const q = projectId && PROJECT_RE.test(projectId) ? `?projectId=${encodeURIComponent(projectId)}` : '';
  try {
    const res = await get<unknown>(`${modelDetailPath(id)}${q}`, { signal: opts.signal });
    const detail = asCatalogDetail(res);
    if (!detail) throw new StudioApiError('server', "Couldn't read this model's details right now.", { status: 200, retryable: true });
    return detail;
  } catch (err) {
    throw toStudioApiError(err, 'generic');
  }
}

/**
 * Registry rows for when the catalog cannot be loaded: the registry's dated prices labelled "from our price list,
 * {factsAsOf}", no endpoints (the picker says "No uptime data right now"), no rankings, `fit` left to the client.
 */
export const registryCatalogRows = (specs: readonly ImageModelSpec[] = IMAGE_MODELS): ModelCatalogRow[] =>
  specs.map((spec) => {
    const price: Partial<Record<Resolution, CatalogPrice>> = {};
    for (const r of spec.resolutions.length ? spec.resolutions : (['1K'] as Resolution[])) {
      const usd = spec.priceUsd[r];
      price[r] =
        spec.priceBasis !== 'unverified' && typeof usd === 'number' && Number.isFinite(usd)
          ? { usd, basis: 'registry', note: fromPriceList(spec.factsAsOf) }
          : { usd: null, basis: 'registry', note: PRICE_UNPUBLISHED };
    }
    return {
      id: spec.id,
      nickname: spec.nickname,
      providerModel: spec.routes.openrouter || spec.routes.gemini || spec.id,
      pickable: spec.pickable,
      lifecycle: spec.lifecycle,
      price,
      perRefUsd: typeof spec.perRefUsd === 'number' ? spec.perRefUsd : null,
      endpoints: [],
      quality: [],
      observed: [],
      fetchedAt: {},
      stale: false
    };
  });
