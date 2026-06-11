// Read-only provider usage snapshot for the Tools dashboard — per-provider call
// counts, error rates, budgets and health flags. Counts only: no API keys, no
// queries, no user data ever leave this endpoint.

import { Router } from 'express';
import { getProviderUsageSnapshot } from '../lib/providerUsage.js';

export const usageRouter = Router();

usageRouter.get('/providers', (_req, res) => {
  res.json({ generatedAt: new Date().toISOString(), providers: getProviderUsageSnapshot() });
});
