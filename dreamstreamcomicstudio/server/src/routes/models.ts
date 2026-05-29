import { Router, type Request, type Response } from 'express';
import { getCatalog, filterCatalog, type CatalogFilters } from '../services/modelCatalog.js';

export const modelsRouter = Router();

const parseBool = (value: unknown): boolean => value === 'true' || value === '1';

// GET /api/models/catalog
// Public reference data that powers the Model Library ("movie-site" browse).
// Query: ?free=&modality=image|text&refs=&q=&refresh=
modelsRouter.get('/catalog', async (req: Request, res: Response) => {
  const modalityParam = req.query.modality;
  const filters: CatalogFilters = {
    free: parseBool(req.query.free),
    supportsRefs: parseBool(req.query.refs),
    modality: modalityParam === 'image' ? 'image' : modalityParam === 'text' ? 'text' : undefined,
    query: typeof req.query.q === 'string' ? req.query.q : undefined
  };

  const result = await getCatalog(parseBool(req.query.refresh));
  const models = filterCatalog(result.models, filters);

  res.json({
    models,
    count: models.length,
    total: result.models.length,
    fetchedAt: result.fetchedAt,
    degraded: result.degraded,
    message: result.message
  });
});
