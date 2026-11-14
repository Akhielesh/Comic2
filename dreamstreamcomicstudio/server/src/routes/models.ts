import { Router, type Request, type Response } from 'express';
import { getCatalog, filterCatalog, getProviderModels, type CatalogFilters } from '../services/modelCatalog.js';
import { fetchOpenRouterKeyStatus, fetchOpenRouterCredits } from '../ai/providers/openrouter.js';
import { persistHarvestedModels, loadPersistedModels, loadCallabilityMap } from '../services/modelCatalogStore.js';
import { getModelLatencyReport } from '../services/telemetryAnalytics.js';
import { getModelPopularity, parsePopularityWindow } from '../services/usageAnalytics.js';
import { requireAuth } from '../middleware/auth.js';
import { allowedProviderFilter } from '../middleware/keys.js';
import { attachAccountKeys } from '../middleware/accountKeys.js';
import { hydrateAccessProfile } from '../middleware/requireAdmin.js';
import { listModelScores, listMonthlyUsage, loadScoreMap } from '../services/modelStats.js';
import type { AnnotatedModel } from '../ai/catalogAnnotations.js';
import { getProviderDef, TEXT_PROVIDER_IDS, type ProviderId } from '../../../shared/providers.js';
import type { AIProviderId } from '../ai/providers/types.js';

export const modelsRouter = Router();

const parseBool = (value: unknown): boolean => value === 'true' || value === '1';

const parseSource = (value: unknown): CatalogFilters['source'] =>
  typeof value === 'string' && TEXT_PROVIDER_IDS.includes(value as ProviderId) ? (value as AIProviderId) : undefined;

// Every direct provider beyond OpenRouter (which is the public `base` list). Each
// contributes a curated fallback or its live /models list when a key is present
// (BYOK header or a platform env key).
const DIRECT_SOURCES: AIProviderId[] = TEXT_PROVIDER_IDS.filter((id) => id !== 'openrouter') as AIProviderId[];

// Merge the direct providers' models into the base (OpenRouter) catalog.
//
// NVIDIA's /models needs auth (unlike OpenRouter's public list): with a key we fetch live
// AND harvest the public metadata into the cache; without one we serve the cached list so the
// public models page stays populated. The OpenAI-compatible / Anthropic providers ship a
// curated seed, so they're populated even keyless; a successful keyed list supplies live ids. We never
// store keys — only public model metadata is cached.
// EGRESS-DB E4: the cached NVIDIA rows change only when a keyed fetch harvests them, so a catalog request reads
// them (and their callability) at most every 10 minutes per process, and a keyed list tops the cache up at most
// hourly. An empty answer (nothing cached, or Supabase unreachable) is never kept.
export const NVIDIA_CACHE_TTL_MS = 10 * 60_000;
export const NVIDIA_PERSIST_INTERVAL_MS = 60 * 60_000;

const memoNonEmpty = <T extends { size: number } | { length: number }>(ttlMs: number, load: () => Promise<T>) => {
  let entry: { at: number; value: Promise<T> } | null = null;
  return {
    get: (): Promise<T> => {
      if (entry && Date.now() - entry.at < ttlMs) return entry.value;
      const current = { at: Date.now(), value: load() };
      entry = current;
      const forget = () => { if (entry === current) entry = null; };
      current.value.then((v) => { if (('size' in v ? v.size : v.length) === 0) forget(); }, forget);
      return current.value;
    },
    reset: () => { entry = null; }
  };
};
const nvidiaCallabilityMemo = memoNonEmpty(NVIDIA_CACHE_TTL_MS, () => loadCallabilityMap('nvidia'));
const nvidiaPersistedMemo = memoNonEmpty(NVIDIA_CACHE_TTL_MS, () => loadPersistedModels('nvidia'));
let nvidiaPersistedAt = 0;

/** Forget the per-process catalog memos (tests). */
export const resetModelsRouteCaches = (): void => {
  nvidiaCallabilityMemo.reset();
  nvidiaPersistedMemo.reset();
  nvidiaPersistedAt = 0;
};

const withDirectProviderModels = async (req: Request, base: AnnotatedModel[], keyFor?: (id: AIProviderId) => string | null): Promise<AnnotatedModel[]> => {
  const allow = allowedProviderFilter(req);
  const nvidiaCallability = await nvidiaCallabilityMemo.get().catch(() => new Map<string, boolean>());
  const attachCallability = (models: AnnotatedModel[], map: Map<string, boolean>): AnnotatedModel[] =>
    models.map((m) => (map.has(m.id) ? { ...m, apiCallable: map.get(m.id) } : m));

  const lists = await Promise.all(
    DIRECT_SOURCES.map(async (id): Promise<AnnotatedModel[]> => {
      const def = getProviderDef(id);
      const key = !allow(id) ? null : keyFor ? keyFor(id)
        : req.apiKeys?.providerKeys ? req.apiKeys.providerKeys[id]?.key || null
        : (def ? req.header(def.header)?.trim() : null) || (def ? process.env[def.keyEnv]?.trim() : null) || null;
      let models = await getProviderModels(id, key, { platformFallback: false });
      if (id === 'nvidia') {
        if (!models.length) models = await nvidiaPersistedMemo.get();
        else if (Date.now() - nvidiaPersistedAt >= NVIDIA_PERSIST_INTERVAL_MS) {
          nvidiaPersistedAt = Date.now();
          void persistHarvestedModels('nvidia', models); // fire-and-forget cache top-up, at most hourly
        }
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
modelsRouter.get('/catalog', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const modalityParam = req.query.modality;
  const filters: CatalogFilters = {
    free: parseBool(req.query.free),
    supportsRefs: parseBool(req.query.refs),
    modality: modalityParam === 'image' ? 'image' : modalityParam === 'text' ? 'text' : undefined,
    source: parseSource(req.query.source),
    query: typeof req.query.q === 'string' ? req.query.q : undefined,
    product: typeof req.query.product === 'string' ? req.query.product : undefined
  };

  const result = await getCatalog(parseBool(req.query.refresh));
  const allModels = await withDirectProviderModels(req, result.models);
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

  res.json({
    models,
    count: models.length,
    total: allModels.length,
    sources,
    fetchedAt: result.fetchedAt,
    degraded: result.degraded,
    stale: result.stale,
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
// per studio. Privacy-first by construction: counters only (month × product ×
// model), no user ids, nothing finer than the month bucket.
modelsRouter.get('/usage-monthly', async (req: Request, res: Response, next) => {
  try {
    const months = Number(req.query.months) || 6;
    res.json({ rows: await listMonthlyUsage(months) });
  } catch (err) {
    next(err);
  }
});

// GET /api/models/speed — per-model typical latency (from chat_turn telemetry) so the
// model picker can flag slow models. Public + non-sensitive (aggregate timings only).
modelsRouter.get('/speed', async (req: Request, res: Response, next) => {
  try {
    res.json(await getModelLatencyReport(req.query.days));
  } catch (err) {
    next(err);
  }
});

// GET /api/models/popularity?window=week|month|all
// What models people ACTUALLY run, aggregated from generation events: request counts,
// distinct users and share — top 15. Counts only, never cost. This router is public
// (mounted before the global requireAuth), so auth is enforced per-route here.
modelsRouter.get('/popularity', requireAuth, async (req: Request, res: Response, next) => {
  try {
    const window = parsePopularityWindow(req.query.window);
    res.json({ window, models: await getModelPopularity(window) });
  } catch (err) {
    next(err);
  }
});

// GET /api/models/verify
// Verification system: reconciles what we SHOW against LIVE source data — no guessing.
// - OpenRouter: GET /api/v1/key for the caller's real usage/limit/is_free_tier.
// - Per-source model counts from a freshly-forced catalog refresh.
// requireAuth. The PLATFORM keys' live data — the platform OpenRouter key's /key record and
// account /credits, and which platform keys are configured — is operator telemetry: admins
// only. Everyone else gets connection status and live key data for their OWN keys only (the
// provider headers the client sends); with none, liveKey/credits are null and no /key or
// /credits call is made. Sign-up is open, so "signed in" is not a trust boundary.
modelsRouter.get('/verify', requireAuth, attachAccountKeys, async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store');
  // Fail closed: an unreadable role means "not an admin".
  const isAdmin = await hydrateAccessProfile(req).then((p) => p.isAdmin, () => false);
  const allow = allowedProviderFilter(req);
  const keyFor = (id: AIProviderId): string | null => {
    if (!allow(id)) return null;
    const resolved = req.apiKeys?.providerKeys?.[id];
    if (resolved) return resolved.byok || isAdmin ? resolved.key?.trim() || null : null;
    const def = getProviderDef(id);
    return (def ? req.header(def.header)?.trim() : null) || (isAdmin && def ? process.env[def.keyEnv]?.trim() : null) || null;
  };
  const openRouterKey = keyFor('openrouter');

  const result = await getCatalog(isAdmin);
  const allModels = await withDirectProviderModels(req, result.models, keyFor);

  // A stored key is only configuration. A successful authenticated provider response is
  // connection evidence; a curated/cached fallback must never turn a rejected key green.
  const [openRouterKeyStatus, openRouterCredits] = openRouterKey
    ? await Promise.all([fetchOpenRouterKeyStatus(openRouterKey), fetchOpenRouterCredits(openRouterKey)])
    : [null, null];
  const providers: Record<string, { connected: boolean; configured: boolean; status: 'verified' | 'unverified' | 'missing'; modelCount: number }> = {};
  for (const id of TEXT_PROVIDER_IDS) {
    const def = getProviderDef(id);
    const key = def ? keyFor(id) : null;
    const models = allModels.filter((model) => model.source === id);
    // NVIDIA's listing is public: discovering its models is not authentication evidence.
    const connected = Boolean(key) && id !== 'nvidia' && (id === 'openrouter'
      ? openRouterKeyStatus !== null
      : models.some((model) => model.catalogOrigin === 'live'));
    providers[id] = { connected, configured: Boolean(key), status: connected ? 'verified' : key ? 'unverified' : 'missing', modelCount: models.length };
  }

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
        connected: providers.openrouter.connected,
        modelCount: allModels.filter((m) => m.source === 'openrouter').length,
        // Real OpenRouter key data (label/usage/limit/limit_remaining/is_free_tier/rate_limit/...).
        liveKey: openRouterKeyStatus,
        // Account-level credits (total/usage/remaining), independent of the per-key limit above.
        credits: openRouterCredits
      },
      nvidia: {
        connected: providers.nvidia.connected,
        modelCount: allModels.filter((m) => m.source === 'nvidia').length,
        note: 'The public model list does not verify your NVIDIA key or model access. Access is checked when you use a model; per-call USD cost is not reported.'
      }
    },
    // Per-provider connection + counts for every direct source (openrouter, nvidia, openai,
    // anthropic, gemini, deepseek, zai, minimax, tencent, xai).
    providers
  });
});
