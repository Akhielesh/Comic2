import { Router, type Request, type Response } from 'express';
import { getCatalog, filterCatalog, getProviderModels, type CatalogFilters } from '../services/modelCatalog.js';
import { fetchOpenRouterKeyStatus } from '../ai/providers/openrouter.js';
import type { AnnotatedModel } from '../ai/catalogAnnotations.js';

export const modelsRouter = Router();

const parseBool = (value: unknown): boolean => value === 'true' || value === '1';

const parseSource = (value: unknown): CatalogFilters['source'] =>
  value === 'nvidia' ? 'nvidia' : value === 'openrouter' ? 'openrouter' : undefined;

// NVIDIA's catalog needs a key (unlike OpenRouter's public list). Merge the caller's NVIDIA
// models (BYOK via X-Nvidia-Key, or a platform NVIDIA_API_KEY) on top of the cached catalog.
const withNvidiaModels = async (req: Request, base: AnnotatedModel[]): Promise<AnnotatedModel[]> => {
  const nvidiaKey = req.header('X-Nvidia-Key') || process.env.NVIDIA_API_KEY || null;
  if (!nvidiaKey) return base;
  const nvidia = await getProviderModels('nvidia', nvidiaKey);
  return nvidia.length ? [...base, ...nvidia] : base;
};

// GET /api/models/catalog
// Public reference data that powers the Model Library ("movie-site" browse).
// Query: ?free=&modality=image|text&refs=&source=openrouter|nvidia&q=&refresh=
modelsRouter.get('/catalog', async (req: Request, res: Response) => {
  const modalityParam = req.query.modality;
  const filters: CatalogFilters = {
    free: parseBool(req.query.free),
    supportsRefs: parseBool(req.query.refs),
    modality: modalityParam === 'image' ? 'image' : modalityParam === 'text' ? 'text' : undefined,
    source: parseSource(req.query.source),
    query: typeof req.query.q === 'string' ? req.query.q : undefined
  };

  const result = await getCatalog(parseBool(req.query.refresh));
  const allModels = await withNvidiaModels(req, result.models);
  const models = filterCatalog(allModels, filters);

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

// GET /api/models/verify
// Verification system: reconciles what we SHOW against LIVE source data — no guessing.
// - OpenRouter: GET /api/v1/key for the caller's real usage/limit/is_free_tier.
// - Per-source model counts from a freshly-forced catalog refresh.
modelsRouter.get('/verify', async (req: Request, res: Response) => {
  const openRouterKey = req.header('X-OpenRouter-Key') || process.env.OPENROUTER_API_KEY || null;
  const nvidiaKey = req.header('X-Nvidia-Key') || process.env.NVIDIA_API_KEY || null;

  const result = await getCatalog(true); // force live refresh of the OpenRouter catalog
  const allModels = await withNvidiaModels(req, result.models);

  // Live, authoritative OpenRouter key status (real usage vs. limit).
  const openRouterKeyStatus = openRouterKey ? await fetchOpenRouterKeyStatus(openRouterKey) : null;

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
        // Real OpenRouter account data (label/usage/limit/limit_remaining/is_free_tier/...).
        liveKey: openRouterKeyStatus
      },
      nvidia: {
        connected: Boolean(nvidiaKey),
        modelCount: allModels.filter((m) => m.source === 'nvidia').length,
        note: 'NVIDIA Build is credit-based (free tier ~1,000 credits, 40 req/min); per-call USD cost is not reported.'
      }
    }
  });
});
