// Read-only provider usage snapshot for the Tools dashboard — per-provider call
// counts, error rates, budgets and health flags. Counts only: no API keys, no
// queries, no user data ever leave this endpoint.

import { accountProviderUsage } from '../services/accountProviderUsage.js';
import { Router } from 'express';
import { getProviderUsageSnapshot } from '../lib/providerUsage.js';
import { isSharedKeyCapped, sharedKeyCappedForMs } from '../ai/providerCircuit.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { allowedProviderFilter } from '../middleware/keys.js';
import { requireAuth } from '../middleware/auth.js';
import { accountKeyProviders } from '../middleware/accountKeys.js';
import {
  friendlyUnitsFor,
  getAllowanceStatus,
  getBillingPrefs,
  isUsageExemptAdmin,
  PLATFORM_FUNDED_PROVIDERS,
  type AllowanceStatus,
  type BillingPrefs,
  type FriendlyUnits
} from '../services/platformAllowance.js';

export const usageRouter = Router();

usageRouter.get('/account-providers', requireAuth, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await accountProviderUsage(req.user!.id, new Date(), allowedProviderFilter(req)));
  } catch (error) { next(error); }
});

usageRouter.get('/providers', requireAuth, requireAdmin, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    generatedAt: new Date().toISOString(),
    providers: getProviderUsageSnapshot(),
    // Reactive resilience signal: when the shared platform LLM key hits its spend cap, the
    // chat router fails auto turns over to free models for a cooldown window. Surface it so
    // ops can see "platform key capped" directly instead of inferring it from a free-model
    // usage spike. Counts/booleans only — no keys, spend, or user data.
    llmCircuit: {
      sharedKeyCapped: isSharedKeyCapped(),
      cooldownMsRemaining: sharedKeyCappedForMs()
    }
  });
});

/** The user-facing shape of GET /api/usage/allowance. PERCENT ONLY — no money anywhere. */
export type AllowanceResponse = {
  enabled: boolean;
  /** False for admins and exempt accounts: no usage limit applies. */
  governed: boolean;
  pctUsed: number;
  pctLeft: number;
  exhausted: boolean;
  crossed: number[];
  /** null for lifetime usage (it doesn't reset on its own). */
  resetsAt: string | null;
  friendlyUnits: FriendlyUnits | null;
  usePlatformAllowance: boolean;
  byokFallbackMode: BillingPrefs['byokFallbackMode'];
  byokAvailable: boolean;
};

/**
 * Map the server-side status (which carries dollars) to the user payload (which never does).
 * An explicit allow-list: a new server field can never leak by accident.
 */
export const toAllowanceResponse = (status: AllowanceStatus, prefs: BillingPrefs, byokAvailable: boolean): AllowanceResponse => {
  const governed = status.governed && status.enabled;
  return {
    enabled: status.enabled,
    governed: status.governed,
    pctUsed: governed ? status.pctUsed : 0,
    pctLeft: governed ? status.pctLeft : 100,
    exhausted: governed ? status.exhausted : false,
    crossed: governed ? [...status.crossed] : [],
    resetsAt: status.period === 'monthly' ? status.resetsAt : null,
    friendlyUnits: governed ? friendlyUnitsFor(Math.max(0, status.capUsd - status.usedUsd), status.capUsd) : null,
    usePlatformAllowance: prefs.usePlatformAllowance,
    byokFallbackMode: prefs.byokFallbackMode,
    byokAvailable
  };
};

// Per-user usage left — PERCENT ONLY plus friendly units ("about 150 standard comic pages
// left"). The budget and spend in dollars are server-only and never appear here. This router
// mounts before the global requireAuth (each report has its own access control), so auth is
// enforced per-route. Read on demand (mount / focus / after a render) — never polled.
usageRouter.get('/allowance', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const isAdmin = await isUsageExemptAdmin(req);
    const [status, prefs, storedKeyProviders] = await Promise.all([
      getAllowanceStatus(userId, { isAdmin }),
      getBillingPrefs(userId),
      accountKeyProviders(userId)
    ]);
    res.setHeader('Cache-Control', 'no-store');
    res.json(
      toAllowanceResponse(
        status,
        prefs,
        storedKeyProviders.some((p) => (PLATFORM_FUNDED_PROVIDERS as readonly string[]).includes(p))
      )
    );
  } catch (err) {
    next(err);
  }
});
