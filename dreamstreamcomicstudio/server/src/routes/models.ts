import { Router, type Request, type Response } from 'express';
import { getCatalog, filterCatalog, getProviderModels, type CatalogFilters } from '../services/modelCatalog.js';
import { fetchOpenRouterKeyStatus, fetchOpenRouterCredits } from '../ai/providers/openrouter.js';
import { persistHarvestedModels, loadPersistedModels, loadCallabilityMap } from '../services/modelCatalogStore.js';
import { getModelLatency } from '../services/telemetryAnalytics.js';
import { getModelPopularity, getMonthlyEligibleModels, monthlyModelKey, parsePopularityWindow } from '../services/usageAnalytics.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { hydrateAccessProfile } from '../middleware/requireAdmin.js';
import { listModelScores, listMonthlyUsage, loadScoreMap } from '../services/modelStats.js';
import { annotateModels, type AnnotatedModel } from '../ai/catalogAnnotations.js';
import { getProvider } from '../ai/gateway.js';
import { getProviderDef, TEXT_PROVIDER_IDS, type ProviderId } from '../../../shared/providers.js';
import type { AIProviderId } from '../ai/providers/types.js';

export const modelsRouter = Router();

const parseBool = (value: unknown): boolean => value === 'true' || value === '1';

const parseSource = (value: unknown): CatalogFilters['source'] =>
  typeof value === 'string' && TEXT_PROVIDER_IDS.includes(value as ProviderId) ? (value as AIProviderId) : undefined;

/**
 * The BYOK request headers /catalog reads: one per text provider in the shared registry
 * (X-OpenRouter-Key, X-Nvidia-Key, X-OpenAI-Key, X-Anthropic-Key, X-Gemini-Key, X-DeepSeek-Key,
 * X-ZAI-Key, X-MiniMax-Key, X-Tencent-Key, X-XAI-Key). attachKeys also reads X-Pixazo-Key,
 * X-Flux-Key, X-Ideogram-Key and X-Allowed-Sources, but no /catalog response depends on them.
 */
export const CATALOG_BYOK_HEADERS: readonly string[] = TEXT_PROVIDER_IDS.map((id) => getProviderDef(id)?.header).filter(
  (header): header is string => Boolean(header)
);

// The caller's OWN key for a provider: its BYOK header, trimmed. A blank or whitespace-only value
// is no key, because resolveProviderContext trims it to '' and then uses the platform key.
const ownKey = (req: Request, id: ProviderId): string | null => {
  const def = getProviderDef(id);
  const value = def ? req.header(def.header) : undefined;
  return (typeof value === 'string' && value.trim()) || null;
};

const carriesOwnKey = (req: Request): boolean => TEXT_PROVIDER_IDS.some((id) => ownKey(req, id) !== null);

// Server-confirmed admin: the same role lookup requireAdmin runs (hydrateAccessProfile → rbac).
// A failed lookup counts as not admin, so this fails closed.
const isConfirmedAdmin = async (req: Request): Promise<boolean> => {
  if (!req.user?.id) return false;
  try {
    return (await hydrateAccessProfile(req)).isAdmin === true;
  } catch {
    return false;
  }
};

// For public routes: resolve the bearer token (when there is one) the same way optionalAuth does,
// so an admin can be recognised. Never rejects; a missing or bad token leaves the caller anonymous.
const resolveOptionalUser = (req: Request, res: Response): Promise<void> =>
  req.user?.id
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        optionalAuth(req, res, () => resolve()).catch(() => resolve());
      });

// A provider's listing with NO key at all: its curated seed (OpenAI-compatible, Anthropic) or
// nothing (NVIDIA). getProviderModels(id, null) cannot do this, because the gateway falls back to
// a platform key when the caller has none; this never touches the network.
const listWithoutKey = async (id: AIProviderId): Promise<AnnotatedModel[]> => {
  try {
    return annotateModels(await getProvider(id).listModels({ apiKey: '', byok: false }));
  } catch {
    return [];
  }
};

// Every direct provider beyond OpenRouter (which is the public `base` list). Each
// contributes its curated catalog (always — so logged-out visitors see the models) plus
// its live /models list when a key is present.
const DIRECT_SOURCES: AIProviderId[] = TEXT_PROVIDER_IDS.filter((id) => id !== 'openrouter') as AIProviderId[];

// Merge the direct providers' models into the base (OpenRouter) catalog.
//
// NVIDIA's /models needs auth (unlike OpenRouter's public list): with a key we fetch live
// AND harvest the public metadata into the cache; without one we serve the cached list so the
// public models page stays populated. The OpenAI-compatible / Anthropic providers ship a
// curated seed, so they're populated even keyless; a key augments them with live ids. We never
// store keys — only public model metadata is cached.
//
// Which keys may list live:
// - `ownKeysOnly: true` (/catalog): ONLY the caller's own BYOK header keys. Every provider the
//   caller has no key for comes from its seed, or (NVIDIA) the cache, with no network call, so a
//   request never reaches a provider on the platform's env keys.
// - default (/verify, which a separate hotfix owns): the BYOK header, else the platform env key.
const withDirectProviderModels = async (
  req: Request,
  base: AnnotatedModel[],
  opts: { ownKeysOnly?: boolean } = {}
): Promise<AnnotatedModel[]> => {
  const nvidiaCallability = await loadCallabilityMap('nvidia').catch(() => new Map<string, boolean>());
  const attachCallability = (models: AnnotatedModel[], map: Map<string, boolean>): AnnotatedModel[] =>
    models.map((m) => (map.has(m.id) ? { ...m, apiCallable: map.get(m.id) } : m));

  const listDirect = async (id: AIProviderId): Promise<AnnotatedModel[]> => {
    if (opts.ownKeysOnly) {
      const key = ownKey(req, id as ProviderId);
      return key ? getProviderModels(id, key) : listWithoutKey(id);
    }
    const def = getProviderDef(id);
    const key = (def ? req.header(def.header) : null) || (def ? process.env[def.keyEnv] : null) || null;
    return getProviderModels(id, key);
  };

  const lists = await Promise.all(
    DIRECT_SOURCES.map(async (id): Promise<AnnotatedModel[]> => {
      let models = await listDirect(id);
      if (id === 'nvidia') {
        if (!models.length) models = await loadPersistedModels('nvidia');
        else void persistHarvestedModels('nvidia', models); // fire-and-forget cache top-up
        models = attachCallability(models, nvidiaCallability);
      }
      return models;
    })
  );

  return [...base, ...lists.flat()];
};

// GET /api/models/catalog
// Public reference data that powers the Model Library ("movie-site" browse).
// Query: ?free=&modality=image|text&refs=&source=openrouter|nvidia&q=&refresh=
//        &product=chat_studio|stream_studio|comic_studio (capability-gated list)
// - `refresh` (1|true) forces a live upstream refresh, so it is honoured only for a
//   server-confirmed admin (bearer token → role lookup, done only when the param is present).
//   Anyone else, and any failed lookup, gets the cache.
// - Direct providers list live only on the caller's own BYOK keys (see withDirectProviderModels);
//   without one, their models come from the seed or cache. Never a platform-key call.
// - Cache-Control, by what the request carries (Vary on every BYOK header either way, so a cached
//   keyless copy is never reused for a request that carries a key):
//     a direct-provider own key → `private, no-store` (the body holds that caller's live listing);
//     only an X-OpenRouter-Key  → `private, no-cache` (the body does not depend on it: the base list is
//                                 the shared catalog; the browser may keep it and revalidate by ETag,
//                                 and no shared cache ever stores a request that carried a key);
//     no own key                → `public, max-age=60`.
modelsRouter.get('/catalog', async (req: Request, res: Response) => {
  const modalityParam = req.query.modality;
  const filters: CatalogFilters = {
    free: parseBool(req.query.free),
    supportsRefs: parseBool(req.query.refs),
    modality: modalityParam === 'image' ? 'image' : modalityParam === 'text' ? 'text' : undefined,
    source: parseSource(req.query.source),
    query: typeof req.query.q === 'string' ? req.query.q : undefined,
    product: typeof req.query.product === 'string' ? req.query.product : undefined
  };

  let forceRefresh = false;
  if (parseBool(req.query.refresh)) {
    await resolveOptionalUser(req, res);
    forceRefresh = await isConfirmedAdmin(req);
  }

  const result = await getCatalog(forceRefresh);
  const allModels = await withDirectProviderModels(req, result.models, { ownKeysOnly: true });
  let models = filterCatalog(allModels, filters);
  // Attach the latest DRS Benchmark Score (when a bench run has been published)
  // so the Library can rank and badge models by measured behavior, not vibes.
  const scoreMap = await loadScoreMap().catch(() => new Map<string, number>());
  if (scoreMap.size) {
    models = models.map((m) => (scoreMap.has(m.id) ? { ...m, drsScore: scoreMap.get(m.id) } : m));
  }

  // Per-source counts for every provider (openrouter, nvidia, openai, anthropic, …).
  const sources: Record<string, number> = {};
  for (const id of TEXT_PROVIDER_IDS) sources[id] = allModels.filter((m) => m.source === id).length;

  for (const header of CATALOG_BYOK_HEADERS) res.vary(header);
  res.setHeader(
    'Cache-Control',
    DIRECT_SOURCES.some((id) => ownKey(req, id as ProviderId) !== null)
      ? 'private, no-store'
      : carriesOwnKey(req)
        ? 'private, no-cache'
        : 'public, max-age=60'
  );
  res.json({
    models,
    count: models.length,
    total: allModels.length,
    sources,
    fetchedAt: result.fetchedAt,
    degraded: result.degraded,
    message: result.message
  });
});

// GET /api/models/bench-scores — the published DRS Benchmark Scores (latest bench
// run, one row per model). Benches can only be RUN by admins/researchers; the
// RESULTS are public reference data: scores, per-phase pass/fail and timings —
// never raw provider error bodies.
modelsRouter.get('/bench-scores', async (_req: Request, res: Response, next) => {
  try {
    const { runId, runAt, scores } = await listModelScores();
    res.json({ runId, runAt, scores });
  } catch (err) {
    next(err);
  }
});

// GET /api/models/usage-monthly?months=6 — aggregate monthly model-choice counts
// per studio: counters only (month × product × source × model), no user ids.
// Signed in only, and k-anonymous like /popularity: a row is returned only when the ledger shows
// that model, from that provider, run by at least POPULARITY_MIN_USERS distinct people in that
// month (getMonthlyEligibleModels). A row it cannot match is dropped, and with nothing eligible the
// list is empty, so a model one beta user ran never shows here with its count.
modelsRouter.get('/usage-monthly', requireAuth, async (req: Request, res: Response, next) => {
  try {
    const months = Number(req.query.months) || 6;
    const rows = await listMonthlyUsage(months);
    if (!rows.length) {
      res.json({ rows: [] });
      return;
    }
    const sinceMonth = rows.reduce((min, r) => (r.month < min ? r.month : min), rows[0].month);
    const eligible = await getMonthlyEligibleModels(sinceMonth);
    res.json({ rows: rows.filter((r) => eligible.has(monthlyModelKey(r.month, r.source, r.model))) });
  } catch (err) {
    next(err);
  }
});

// GET /api/models/speed — per-model typical latency (from chat_turn telemetry) so the
// model picker can flag slow models. Public + non-sensitive (aggregate timings only).
modelsRouter.get('/speed', async (req: Request, res: Response, next) => {
  try {
    res.json({ models: await getModelLatency(req.query.days) });
  } catch (err) {
    next(err);
  }
});

// GET /api/models/popularity?window=week|month|all
// What models people ACTUALLY run, aggregated from SETTLED generation events: request counts,
// distinct users and share, top 15. Counts only, never cost, never user ids. This router is
// public (mounted before the global requireAuth), so auth is enforced per-route here.
// k-anonymity lives in the service (getModelPopularity): a row backed by fewer than
// POPULARITY_MIN_USERS distinct users is never returned, and shares are computed over the rows
// that clear the floor, so no total reveals the suppressed volume. `generatedAt` (ISO) is when
// the cached aggregate was built.
modelsRouter.get('/popularity', requireAuth, async (req: Request, res: Response, next) => {
  try {
    const window = parsePopularityWindow(req.query.window);
    const { generatedAt, models } = await getModelPopularity(window);
    res.json({ window, generatedAt, models });
  } catch (err) {
    next(err);
  }
});

// GET /api/models/verify
// Verification system: reconciles what we SHOW against LIVE source data — no guessing.
// - OpenRouter: GET /api/v1/key for the caller's real usage/limit/is_free_tier.
// - Per-source model counts from a freshly-forced catalog refresh.
// requireAuth: with no BYOK header this falls back to PLATFORM keys and reports
// their live usage/limits/credits — that's operator telemetry, not public data.
modelsRouter.get('/verify', requireAuth, async (req: Request, res: Response) => {
  const openRouterKey = req.header('X-OpenRouter-Key') || process.env.OPENROUTER_API_KEY || null;
  const nvidiaKey = req.header('X-Nvidia-Key') || process.env.NVIDIA_API_KEY || null;

  const result = await getCatalog(true); // force live refresh of the OpenRouter catalog
  const allModels = await withDirectProviderModels(req, result.models);

  // Per-provider connection + model count (which sources have a usable key right now).
  const providers: Record<string, { connected: boolean; modelCount: number }> = {};
  for (const id of TEXT_PROVIDER_IDS) {
    const def = getProviderDef(id);
    const key = (def ? req.header(def.header) : null) || (def ? process.env[def.keyEnv] : null) || null;
    providers[id] = { connected: Boolean(key), modelCount: allModels.filter((m) => m.source === id).length };
  }

  // Live, authoritative OpenRouter data: per-KEY status (/key) AND account CREDITS (/credits).
  // These can differ — a key may carry its own spend cap distinct from account credits remaining.
  const [openRouterKeyStatus, openRouterCredits] = openRouterKey
    ? await Promise.all([fetchOpenRouterKeyStatus(openRouterKey), fetchOpenRouterCredits(openRouterKey)])
    : [null, null];

  res.json({
    verifiedAt: Date.now(),
    catalog: {
      fetchedAt: result.fetchedAt,
      degraded: result.degraded,
      message: result.message,
      total: allModels.length,
      freeCount: allModels.filter((m) => m.isFree).length
    },
    sources: {
      openrouter: {
        connected: Boolean(openRouterKey),
        modelCount: allModels.filter((m) => m.source === 'openrouter').length,
        // Real OpenRouter key data (label/usage/limit/limit_remaining/is_free_tier/rate_limit/...).
        liveKey: openRouterKeyStatus,
        // Account-level credits (total/usage/remaining), independent of the per-key limit above.
        credits: openRouterCredits
      },
      nvidia: {
        connected: Boolean(nvidiaKey),
        modelCount: allModels.filter((m) => m.source === 'nvidia').length,
        note: 'NVIDIA Build is credit-based (free tier ~1,000 credits, 40 req/min); per-call USD cost is not reported.'
      }
    },
    // Per-provider connection + counts for every direct source (openrouter, nvidia, openai,
    // anthropic, gemini, deepseek, zai, minimax, tencent, xai).
    providers
  });
});
