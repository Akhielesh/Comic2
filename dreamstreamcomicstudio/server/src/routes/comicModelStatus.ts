// Model health routes (reliability.md §2 / wm-plan M1-RELIABILITY). Mounted once in comicMounts.ts under
// /api/comic (owner routes; the text limiter sits on /api/comic/models/* exact paths). Cheap: every answer comes
// from the in-memory health port (OpenRouter's public data cached 3 min + this container's own observations);
// nothing here calls a paid API, reads storage or logs a key.
//
//   GET /api/comic/models/status?ids=a,b   ModelHealth[] for registry ids (auth; unknown ids dropped; no ids = pickable)
//   GET /api/comic/models/status/admin     { models, breakerEvents, bootedAt, now } for EVERY registry model (requireAdmin)
//
// `routes` in a status answer are the ones THIS caller can reach with their keys (a model that is fine only on a
// route they have no key for is still down for them); the admin answer lists every route.

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { IMAGE_MODELS, getImageModel, pickableImageModels, type ImageModelSpec } from '../../../shared/comic/models.js';
import type { ModelHealth } from '../../../shared/comic/modelHealth.js';
import { logger } from '../lib/logger.js';
import { requireAdmin as requireAdminMiddleware } from '../middleware/requireAdmin.js';
import { studioKeysFromRequest } from '../comic/keys.js';
import { modelHealth, type BreakerEvent, type ModelHealthPort } from '../comic/models/health.js';
import { StudioError, type StudioKeys } from '../comic/types.js';

export const MODEL_STATUS_PATHS = ['/models/status', '/models/status/admin'] as const;
/** Most ids one status call may ask for (the registry is far smaller). */
export const MODEL_STATUS_MAX_IDS = 20;
const MAX_IDS_PARAM = 1_000;

export interface ComicModelStatusRouterDeps {
  /** The health port (default: the process-wide one). */
  health?: ModelHealthPort;
  /** Keys override for tests (default: the request's resolved account keys). */
  keysFor?: (req: Request) => StudioKeys;
  /** Admin guard override for tests (default: middleware/requireAdmin). */
  requireAdmin?: RequestHandler;
}

export interface ProviderStatusReport {
  models: ModelHealth[];
  breakerEvents: BreakerEvent[];
  bootedAt: number;
  now: number;
}

/** Registry specs for a comma-separated ids param: unknown ids dropped, duplicates folded, at most MODEL_STATUS_MAX_IDS. */
export const specsForIds = (raw: unknown): ImageModelSpec[] | null => {
  if (typeof raw !== 'string') return null;
  const ids = raw
    .slice(0, MAX_IDS_PARAM)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MODEL_STATUS_MAX_IDS);
  if (!ids.length) return null;
  const out: ImageModelSpec[] = [];
  for (const id of ids) {
    const spec = getImageModel(id);
    if (spec && !out.some((s) => s.id === spec.id)) out.push(spec);
  }
  return out;
};

function sendError(res: Response, err: unknown, next: NextFunction): void {
  if (res.headersSent) return next(err);
  res.set('Cache-Control', 'private, no-store');
  if (err instanceof StudioError) {
    res.status(err.status).json({ error: { message: err.userMessage, code: err.code } });
    return;
  }
  logger.error('comic_model_status_failed', { message: String((err as Error)?.message || err).slice(0, 200) });
  res.status(500).json({ error: { message: "Couldn't read model status right now — the studio still works; try again in a moment.", code: 'INTERNAL' } });
}

export function createComicModelStatusRouter(deps: ComicModelStatusRouterDeps = {}): Router {
  const router = Router();
  const health = () => deps.health || modelHealth();
  const keysFor = deps.keysFor || studioKeysFromRequest;
  const requireAdmin = deps.requireAdmin || requireAdminMiddleware;

  router.get(MODEL_STATUS_PATHS[1], requireAdmin, (req: Request, res: Response, next: NextFunction) => {
    res.vary('Authorization');
    (async () => {
      const port = health();
      const models = await Promise.all(IMAGE_MODELS.map((spec) => port.getModelHealth(spec)));
      const report: ProviderStatusReport = { models, breakerEvents: port.breakerEvents().slice(), bootedAt: port.bootedAt, now: Date.now() };
      res.set('Cache-Control', 'private, no-store');
      res.json(report);
    })().catch((err) => sendError(res, err, next));
  });

  router.get(MODEL_STATUS_PATHS[0], (req: Request, res: Response, next: NextFunction) => {
    res.vary('Authorization');
    (async () => {
      if (!req.user?.id) throw new StudioError('FORBIDDEN', 'Sign in to use the comic studio.', { status: 401 });
      const specs = specsForIds(req.query.ids) ?? pickableImageModels();
      const keys = keysFor(req);
      const port = health();
      const list = await Promise.all(specs.map((spec) => port.getModelHealth(spec, { keys })));
      res.set('Cache-Control', 'private, no-store');
      res.json(list);
    })().catch((err) => sendError(res, err, next));
  });

  return router;
}

export const comicModelStatusRouter = createComicModelStatusRouter();
