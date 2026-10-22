// Quality-tier access for Comic Studio (v4).
//
// Draft and Standard run on Nano Banana 2.1 and are open to everyone (spend is still
// metered per image by billing.ts). Pro runs on Nano Banana Pro at ~3× the price, so it
// needs a paid plan — or the user's own key, in which case they pay the provider
// directly. A billing lookup failure fails OPEN: a ledger hiccup must never lock a
// paying user out of the tier they pay for.

import type { Request } from 'express';
import type { QualityTier } from '../../../shared/comic/doc.js';
import { BILLING_ENABLED } from '../config.js';
import { TtlCache } from '../lib/cache.js';
import { logger } from '../lib/logger.js';
import { getBillingSummary } from '../services/billingLedger.js';

export const PRO_QUALITY_DENIED_MESSAGE =
  'Pro quality uses Nano Banana Pro and needs a paid plan or your own Gemini/OpenRouter key.';

/** Plans that include Pro quality (`pro` is a legacy tier still present on old subscriptions). */
export const PAID_PLAN_TIERS: ReadonlySet<string> = new Set(['creator', 'pro', 'studio', 'custom', 'admin']);

/** userId → plan id, briefly cached (a render burst checks access once per page). */
const planCache = new TtlCache<string>(60_000, 2000);

/** Test hook. */
export const __resetAccessCacheForTests = (): void => planCache.clear();

export interface QualityAccessDeps {
  planFor?: (userId: string) => Promise<string>;
  billingEnabled?: boolean;
}

const defaultPlanFor = async (userId: string): Promise<string> => String((await getBillingSummary(userId)).plan.id || 'free');

export async function checkQualityAccess(
  req: Request,
  tier: QualityTier,
  byok: boolean,
  deps: QualityAccessDeps = {}
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (tier !== 'pro') return { ok: true };
  if (byok) return { ok: true };
  // Without billing there are no plans to gate on.
  if (!(deps.billingEnabled ?? BILLING_ENABLED)) return { ok: true };

  const userId = req?.user?.id;
  if (!userId) return { ok: false, message: PRO_QUALITY_DENIED_MESSAGE };

  let plan: string;
  try {
    plan = await planCache.getOrSet(userId, () => (deps.planFor || defaultPlanFor)(userId));
  } catch (err) {
    logger.warn('comic_quality_access_lookup_failed', { userId, message: (err as Error)?.message });
    return { ok: true };
  }
  return PAID_PLAN_TIERS.has(String(plan).trim().toLowerCase()) ? { ok: true } : { ok: false, message: PRO_QUALITY_DENIED_MESSAGE };
}
