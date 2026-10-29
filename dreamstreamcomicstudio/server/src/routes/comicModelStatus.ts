// Model health route (reliability.md §2 / wm-plan M1-RELIABILITY). W-M seam: a stub that answers 501 on its
// OWN path only — M1-RELIABILITY replaces the handler in place and keeps the export name. Mounted once in
// comicMounts.ts under /api/comic (owner routes, text rate limit; cheap and cached when built).
//
//   GET /api/comic/models/status?ids=a,b   ModelHealth[] for registry models

import { Router } from 'express';
import { NOT_BUILT } from './comicModels.js';

export const comicModelStatusRouter = Router();

comicModelStatusRouter.get('/models/status', (_req, res) => {
  res.status(501).json(NOT_BUILT);
});
