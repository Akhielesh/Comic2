import { Router } from 'express';
import { getCostCentreReport, parseCostRangeDays } from '../services/costCentre.js';

// Admin cost centre API. Mounted at /api/admin/costs behind requireAuth + requireAdmin
// (server/src/index.ts), so every handler here is admin-only.
//
//   GET /api/admin/costs?days=7|30|90   → CostCentreReport (shared/types/costCentre.ts)
//                                         default 30; anything else falls back to 30.
//   &fresh=1                            → bypass the 60s report cache (the UI's Refresh).
export const adminCostsRouter = Router();

adminCostsRouter.get('/', async (req, res, next) => {
  try {
    const days = parseCostRangeDays(req.query.days);
    const report = await getCostCentreReport(days, { fresh: req.query.fresh === '1' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(report);
  } catch (error) {
    next(error);
  }
});
