import { Router, type Request, type Response } from 'express';
import { getCatalog, filterCatalog, getProviderModels, type CatalogFilters } from '../services/modelCatalog.js';
import { fetchOpenRouterKeyStatus, fetchOpenRouterCredits } from '../ai/providers/openrouter.js';
import { persistHarvestedModels, loadPersistedModels, loadCallabilityMap } from '../services/modelCatalogStore.js';
import { getModelLatency } from '../services/telemetryAnalytics.js';
import { getModelPopularity, parsePopularityWindow } from '../services/usageAnalytics.js';
import { requireAuth } from '../middleware/auth.js';
import { listModelScores, listMonthlyUsage, loadScoreMap } from '../services/modelStats.js';
import type { AnnotatedModel } from '../ai/catalogAnnotations.js';

export const modelsRouter = Router();

const parseBool = (value: unknown): boolean => value === 'true' || value === '1';

const parseSource = (value: unknown): CatalogFilters['source'] =>
  value === 'nvidia' ? 'nvidia' : value === 'openrouter' ? 'openrouter' : undefined;

// NVIDIA's catalog needs an authenticated /models call (unlike OpenRouter's public list).
// With a key (BYOK X-Nvidia-Key or a platform NVIDIA_API_KEY) we fetch live AND harvest the
// public metadata into the cache. Without a key — i.e. a logged-out/anonymous visitor on the
// public models page — we serve the cached NVIDIA catalog so it's still populated. We never
// store the key; only the public model list (the same data on build.nvidia.com) is cached.
const withNvidiaModels = async (req: Request, base: AnnotatedModel[]): Promise<AnnotatedModel[]> => {
  // Attach the probed hosted-API callability so the UI can flag NVIDIA's download-only
  // NIMs (which 404 "not found for account") — whether the list is live or cached.
  const attachCallability = (models: AnnotatedModel[], map: Map<string, boolean>): AnnotatedModel[] =>
    models.map((m) => (map.has(m.id) ? { ...m, apiCallable: map.get(m.id) } : m));

  const nvidiaKey = req.header('X-Nvidia-Key') || process.env.NVIDIA_API_KEY || null;
  if (nvidiaKey) {
    const nvidia = await getProviderModels('nvidia', nvidiaKey);
    if (nvidia.length) {
      void persistHarvestedModels('nvidia', nvidia); // fire-and-forget cache top-up
      const callability = await loadCallabilityMap('nvidia');
      return [...base, ...attachCallability(nvidia, callability)];
    }
  }
  // No key or the live fetch failed → fall back to the harvested cache (already merges
  // api_callable in loadPersistedModels).
  const cached = await loadPersistedModels('nvidia');
  return cached.length ? [...base, ...cached] : base;
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
  const allModels = await withNvidiaModels(req, result.models);
  let models = filterCatalog(allModels, filters);
  // Attach the latest DRS Benchmark Score (when a bench run has been published)
  // so the Library can rank and badge models by measured behavior, not vibes.
  const scoreMap = await loadScoreMap().catch(() => new Map<string, number>());
  if (scoreMap.size) {
    models = models.map((m) => (scoreMap.has(m.id) ? { ...m, drsScore: scoreMap.get(m.id) } : m));
  }

  res.json({
    models,
    count: models.length,
    total: allModels.length,
    sources: {
      openrouter: allModels.filter((m) => m.source === 'openrouter').length,
      nvidia: allModels.filter((m) => m.source === 'nvidia').length
    },
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
  const allModels = await withNvidiaModels(req, result.models);

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
    }
  });
});
