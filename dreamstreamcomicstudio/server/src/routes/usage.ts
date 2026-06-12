// Read-only provider usage snapshot for the Tools dashboard — per-provider call
// counts, error rates, budgets and health flags. Counts only: no API keys, no
// queries, no user data ever leave this endpoint.

import { Router } from 'express';
import { getProviderUsageSnapshot } from '../lib/providerUsage.js';
import { requireAuth } from '../middleware/auth.js';
import { accountKeyProviders } from '../middleware/accountKeys.js';
import { getAllowanceStatus, getBillingPrefs, PLATFORM_FUNDED_PROVIDERS } from '../services/platformAllowance.js';

export const usageRouter = Router();

usageRouter.get('/providers', (_req, res) => {
  res.json({ generatedAt: new Date().toISOString(), providers: getProviderUsageSnapshot() });
});

// Per-user platform allowance status — PERCENT ONLY. capUsd/usedUsd are server-only
// and must never appear here. This router mounts before the global requireAuth
// (it serves the public /providers snapshot), so auth is enforced per-route.
usageRouter.get('/allowance', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const [status, prefs, storedKeyProviders] = await Promise.all([
      getAllowanceStatus(userId),
      getBillingPrefs(userId),
      accountKeyProviders(userId)
    ]);
    res.json({
      enabled: status.enabled,
      pctUsed: status.pctUsed,
      exhausted: status.exhausted,
      crossed: status.crossed,
      resetsAt: status.resetsAt,
      usePlatformAllowance: prefs.usePlatformAllowance,
      byokFallbackMode: prefs.byokFallbackMode,
      byokAvailable: storedKeyProviders.some((p) => (PLATFORM_FUNDED_PROVIDERS as readonly string[]).includes(p))
    });
  } catch (err) {
    next(err);
  }
});
