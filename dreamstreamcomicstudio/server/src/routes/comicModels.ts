// Model catalog routes (models.md §4.3 / §5.1 M1-CATALOG). W-M seam: a stub that answers 501 on its OWN paths
// only — M1-CATALOG replaces the handlers in place and keeps the export name. Mounted once in comicMounts.ts
// under /api/comic (owner routes, text rate limit). The static GET /api/comic/models (routes/comic.ts) is not
// touched: this router never matches the bare /models path, and /models/status and /models/lab/* belong to
// their own routers.
//
//   GET /api/comic/models/catalog?projectId=   ModelCatalogRow[] with fit
//   GET /api/comic/models/trends?range=30d|90d  T2–T7
//   GET /api/comic/models/:id                   one model's detail

import { Router } from 'express';

export const NOT_BUILT = { error: 'not built yet' } as const;
/** Sub-paths of /models that other routers own (never treated as a model id). */
const RESERVED_MODEL_SEGMENTS: ReadonlySet<string> = new Set(['status', 'lab']);

export const comicModelsRouter = Router();

comicModelsRouter.get('/models/catalog', (_req, res) => {
  res.status(501).json(NOT_BUILT);
});

comicModelsRouter.get('/models/trends', (_req, res) => {
  res.status(501).json(NOT_BUILT);
});

comicModelsRouter.get('/models/:id', (req, res, next) => {
  if (RESERVED_MODEL_SEGMENTS.has(String(req.params.id).toLowerCase())) return next();
  res.status(501).json(NOT_BUILT);
});
