import { Router, type Request, type Response } from 'express';
import { getCatalog, filterCatalog, getProviderModels, type CatalogFilters } from '../services/modelCatalog.js';
import { fetchOpenRouterKeyStatus, fetchOpenRouterCredits } from '../ai/providers/openrouter.js';
import { persistHarvestedModels, loadPersistedModels, loadCallabilityMap } from '../services/modelCatalogStore.js';
import { getModelLatency } from '../services/telemetryAnalytics.js';
import { getModelPopularity, parsePopularityWindow } from '../services/usageAnalytics.js';
import { requireAuth } from '../middleware/auth.js';
import { listModelScores, listMonthlyUsage, loadScoreMap } from '../services/modelStats.js';
import type { AnnotatedModel } from '../ai/catalogAnnotations.js';
import { getProviderDef, TEXT_PROVIDER_IDS, type ProviderId } from '../../../shared/providers.js';
import type { AIProviderId } from '../ai/providers/types.js';

export const modelsRouter = Router();

const parseBool = (value: unknown): boolean => value === 'true' || value === '1';

const parseSource = (value: unknown): CatalogFilters['source'] =>
  typeof value === 'string' && TEXT_PROVIDER_IDS.includes(value as ProviderId) ? (value as AIProviderId) : undefined;

// Every direct provider beyond OpenRouter (which is the public `base` list). Each
// contributes its curated catalog (always — so logged-out visitors see the models) plus
// its live /models list when a key is present (BYOK header or a platform env key).
const DIRECT_SOURCES: AIProviderId[] = TEXT_PROVIDER_IDS.filter((id) => id !== 'openrouter') as AIProviderId[];

// Merge the direct providers' models into the base (OpenRouter) catalog.
//
// NVIDIA's /models needs auth (unlike OpenRouter's public list): with a key we fetch live
// AND harvest the public metadata into the cache; without one we serve the cached list so the
// public models page stays populated. The OpenAI-compatible / Anthropic providers ship a
// curated seed, so they're populated even keyless; a key augments them with live ids. We never
// store keys — only public model metadata is cached.
const withDirectProviderModels = async (req: Request, base: AnnotatedModel[]): Promise<AnnotatedModel[]> => {
  const nvidiaCallability = await loadCallabilityMap('nvidia').catch(() => new Map<string, boolean>());
  const attachCallability = (models: AnnotatedModel[], map: Map<string, boolean>): AnnotatedModel[] =>
    models.map((m) => (map.has(m.id) ? { ...m, apiCallable: map.get(m.id) } : m));

  const lists = await Promise.all(
    DIRECT_SOURCES.map(async (id): Promise<AnnotatedModel[]> => {
      const def = getProviderDef(id);
      const key = (def ? req.header(def.header) : null) || (def ? process.env[def.keyEnv] : null) || null;
      let models = await getProviderModels(id, key);
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
    res.json({ models: await getModelLatency(req.query.days) });
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
