// Model Lab routes (wm-plan M1-MODEL-LAB): the admin-only, click-driven paid checks D1–D4 (models.md §2.6).
// W-M seam: a stub that answers 501 on its OWN paths only — M1-MODEL-LAB replaces the handlers in place and
// keeps the export name. Mounted once in comicMounts.ts: /api/comic/models/lab sits behind requireAdmin and
// the admin rate limit (never the text limiter), so nothing here is reachable by a non-admin even when built.
// No timers; every run needs an explicit admin click with the quoted cost; hard cap $2 per day.
//
//   /api/comic/models/lab/*   (checks, runs, results)

import { Router } from 'express';
import { NOT_BUILT } from './comicModels.js';

export const comicModelLabRouter = Router();

comicModelLabRouter.all(['/models/lab', '/models/lab/*'], (_req, res) => {
  res.status(501).json(NOT_BUILT);
});
