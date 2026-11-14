import { Router } from 'express';
import type { ModelShowcaseResponse } from '../../../shared/modelShowcase.js';
import { getModelShowcase } from '../services/modelShowcase.js';

/** Optional-auth, read-only evidence; mount before the general models router. Never accepts an owner query. */
export function createModelShowcaseRouter(load: (userId?: string) => Promise<ModelShowcaseResponse> = getModelShowcase): Router {
  const router = Router();
  router.use((req, res, next) => {
    // Unpublishing must be reflected on the next read. No shared response cache contains revoked art.
    res.set('Cache-Control', req.user?.id ? 'private, no-store' : 'no-store');
    res.vary('Authorization');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  router.get('/', (req, res) => {
    load(req.user?.id).then((body) => res.json(body)).catch(() => res.status(503).json({
      error: { code: 'SHOWCASE_UNAVAILABLE', message: 'Model examples are unavailable right now. Try again shortly.' }
    }));
  });
  router.all('/', (_req, res) => {
    res.set('Allow', 'GET, HEAD');
    res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported here.' } });
  });
  return router;
}

export const modelShowcaseRouter = createModelShowcaseRouter();
