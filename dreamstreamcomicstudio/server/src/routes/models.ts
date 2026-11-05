import { Router, type NextFunction, type Request, type Response } from 'express';
import { getCatalog, filterCatalog, getProviderModels, type CatalogFilters } from '../services/modelCatalog.js';
import { fetchOpenRouterKeyStatus, fetchOpenRouterCredits } from '../ai/providers/openrouter.js';
import { persistHarvestedModels, loadPersistedModels, loadCallabilityMap } from '../services/modelCatalogStore.js';
import { getModelLatency } from '../services/telemetryAnalytics.js';
import { getModelPopularity, parsePopularityWindow } from '../services/usageAnalytics.js';
import { requireAuth } from '../middleware/auth.js';
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

// Server-confirmed admin: the same role lookup requireAdmin runs (hydrateAccessProfile → rbac).
// Fails closed: no user, an unknown user or a failed lookup all count as not admin.
const isConfirmedAdmin = async (req: Request): Promise<boolean> => {
  if (!req.user?.id) return false;
  try {
    return (await hydrateAccessProfile(req)).isAdmin === true;
  } catch {
    return false;
  }
};

// The caller's OWN key for a provider: a key sent in its request header, which attachKeys marks
// `byok` (after X-Allowed-Sources governance). Never the platform env fallback. A header that is
// only whitespace (a lone NBSP byte, say) is no key: it must not pass the 403 gate, because the
// gateway would trim it to '' and fall back to the platform key.
const ownHeaderKey = (req: Request, id: ProviderId): string | null => {
  const resolved = req.apiKeys?.providerKeys?.[id];
  return resolved?.byok ? (resolved.key?.trim() || null) : null;
};

// One direct provider's models for /verify, asked of the provider with exactly the key given and
// nothing else. It never goes through getProviderModels/resolveProviderContext, which turn a
// missing or blank key into a platform key. With a key: its live listing on that key. Without
// one: its curated seed (or nothing, for NVIDIA), with no network call. Nothing is persisted.
const listDirectForVerify = async (id: AIProviderId, key: string | null): Promise<AnnotatedModel[]> => {
  try {
    return annotateModels(await getProvider(id).listModels(key ? { apiKey: key, byok: true } : { apiKey: '', byok: false }));
  } catch {
    return [];
  }
};

// The response is per user (their admin role, their own key), so no cache may store it.
const noStore = (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
};

// GET /api/models/verify
// Verification system: reconciles what we SHOW against LIVE source data — no guessing.
// - OpenRouter: GET /api/v1/key + /credits for the key in use.
// - Never a forced catalog refresh, and the route itself never persists anything.
// Who gets what:
// - Server-confirmed admin: platform data (the platform OpenRouter key's status and account
//   credits, NVIDIA, providers[].connected from header or platform env keys), with model counts
//   from the shared catalog as cached (getCatalog() without force). That is operator telemetry,
//   so nobody else gets it. Known gap: on a stale or cold cache getCatalog() still revalidates in
//   the background (and that refresh upserts), as it does for /catalog; closing it needs a
//   read-only accessor in services/modelCatalog.ts (DreamStream's file).
// - Signed-in non-admin who sent their OWN key in a request header: only that key's status, for
//   that provider. No platform fallback, and `connected` reflects only their own header keys. The
//   shared catalog is not read for them at all (so their call can't start a catalog refresh or
//   upsert): `catalog` counts only the direct-provider lists, fetchedAt is null, and the
//   OpenRouter model count is 0.
// - Signed-in non-admin with no own key: 403, before any outbound call.
modelsRouter.get('/verify', noStore, requireAuth, async (req: Request, res: Response, next) => {
  try {
    const admin = await isConfirmedAdmin(req);
    const keyFor = (id: ProviderId): string | null => {
      if (!admin) return ownHeaderKey(req, id);
      const def = getProviderDef(id);
      return (def ? req.header(def.header) : null) || (def ? process.env[def.keyEnv] : null) || null;
    };
    if (!admin && !TEXT_PROVIDER_IDS.some((id) => keyFor(id))) {
      res.status(403).json({ error: { message: 'Admins only.' } });
      return;
    }

    const openRouterKey = keyFor('openrouter');
    const nvidiaKey = keyFor('nvidia');

    // Admin only: the shared catalog as cached; /verify never forces a refresh.
    const result = admin ? await getCatalog() : null;
    const directLists = await Promise.all(DIRECT_SOURCES.map((id) => listDirectForVerify(id, keyFor(id as ProviderId))));
    const allModels = [...(result?.models ?? []), ...directLists.flat()];

    // Per-provider connection + model count (which sources have a usable key right now).
    const providers: Record<string, { connected: boolean; modelCount: number }> = {};
    for (const id of TEXT_PROVIDER_IDS) {
      providers[id] = { connected: Boolean(keyFor(id)), modelCount: allModels.filter((m) => m.source === id).length };
    }

    // Live, authoritative OpenRouter data: per-KEY status (/key) AND account CREDITS (/credits).
    // These can differ — a key may carry its own spend cap distinct from account credits remaining.
    const [openRouterKeyStatus, openRouterCredits] = openRouterKey
      ? await Promise.all([fetchOpenRouterKeyStatus(openRouterKey), fetchOpenRouterCredits(openRouterKey)])
      : [null, null];

    res.json({
      verifiedAt: Date.now(),
      catalog: {
        fetchedAt: result?.fetchedAt ?? null,
        degraded: result?.degraded ?? false,
        message: result?.message,
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
  } catch (err) {
    next(err);
  }
});
