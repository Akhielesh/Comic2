// What a user may do in Comic Studio (contract §3.3): plan, own key, admin and the
// account-age rating ceiling, resolved once per request into StudioCaps.
//
// Draft and Standard run on the everyday model and are open to everyone; every image and text
// call is metered against the user's usage budget by billing.ts (METERING_ENABLED, independent
// of Stripe). Pro quality and the advanced model picker cost ~2.6x per page:
//   - with Stripe billing ON they need a paid plan (a plan-lookup failure fails OPEN — a ledger
//     hiccup must never lock a paying user out of the tier they pay for);
//   - with billing OFF (production today) there are no plans, so they are for admins, the user's
//     own key (they pay the provider), exempt budget rows and rows with `allow_pro` only — a
//     governed user keeps the Easy AND Pro editors (decisions-final #1) but renders on
//     Draft/Standard. A failed budget lookup fails CLOSED to Draft/Standard (the cheap default).
// The admin lookup fails CLOSED (admin is only a UI hint; admin routes re-check requireAdmin).
// The account ceiling fails to PG: a lookup hiccup must never lift a young account's ceiling.

import type { Request } from 'express';
import type { QualityTier } from '../../../shared/comic/doc.js';
import { PAID_PLAN_IDS, resolveStudioCaps, type StudioCaps } from '../../../shared/comic/capabilities.js';
import { isContentRating, type ContentRating } from '../../../shared/comic/safety.js';
import { BILLING_ENABLED } from '../config.js';
import { TtlCache } from '../lib/cache.js';
import { logger } from '../lib/logger.js';
import { getBillingSummary } from '../services/billingLedger.js';
import { getAllowanceStatus, meteringEnabled } from '../services/platformAllowance.js';
import { getUserRoles, isBootstrapAdminEmail } from '../services/rbac.js';
import { accountCeilingFor } from './safety/index.js';

export const PRO_QUALITY_DENIED_MESSAGE =
  'Pro quality uses Nano Banana Pro and needs a paid plan or your own Gemini/OpenRouter key.';

/** Billing off + usage budget: Pro isn't part of the included usage (no plan to buy yet). */
export const PRO_QUALITY_USAGE_MESSAGE =
  "Pro quality uses Nano Banana Pro, which isn't part of your included usage yet — Standard looks great, or add your own Gemini/OpenRouter key in Settings → API keys for Pro.";

/** Plans that include Pro quality (single source: shared/comic/capabilities.ts PAID_PLAN_IDS). */
export const PAID_PLAN_TIERS: ReadonlySet<string> = new Set<string>(PAID_PLAN_IDS);

/** Ceiling used when the account-age lookup fails (never lifts a young account's ceiling). */
export const CEILING_ON_LOOKUP_FAILURE: ContentRating = 'PG';

/** userId → plan id, briefly cached (a render burst checks access once per page). */
const planCache = new TtlCache<string>(60_000, 2000);
/** userId → admin role, briefly cached (roles change rarely; admin routes re-check). */
const adminCache = new TtlCache<boolean>(60_000, 2000);

/** Test hook. */
export const __resetAccessCacheForTests = (): void => {
  planCache.clear();
  adminCache.clear();
};

export interface UsageBudgetFlags {
  /** The usage budget limits this user (non-admin, not exempt). */
  governed: boolean;
  /** Budget row flag: Pro quality + model picker while billing is off. */
  allowPro: boolean;
}

export interface QualityAccessDeps {
  planFor?: (userId: string) => Promise<string>;
  billingEnabled?: boolean;
  /** Override METERING_ENABLED (tests). */
  meteringEnabled?: boolean;
  /** Usage-budget flags (default: the cached usage status; throws when unavailable). */
  budgetFlagsFor?: (userId: string) => Promise<UsageBudgetFlags>;
  /** Admin role lookup (default: bootstrap admin emails + user_roles, cached 60 s). */
  isAdminFor?: (req: Request) => Promise<boolean>;
}

const defaultBudgetFlagsFor = async (userId: string): Promise<UsageBudgetFlags> => {
  const status = await getAllowanceStatus(userId);
  if (!status.enabled) throw new Error('usage status unavailable');
  return { governed: status.governed, allowPro: status.allowPro };
};

/** May a non-BYOK user render Pro while billing is off? Admin, exempt or `allow_pro` only; lookups fail closed. */
const proAllowedWithoutBilling = async (req: Request, deps: QualityAccessDeps, isAdmin?: boolean): Promise<boolean> => {
  if (!(deps.meteringEnabled ?? meteringEnabled())) return true; // nothing is metered: legacy open gate
  const userId = req?.user?.id;
  if (!userId) return false;
  const admin =
    isAdmin ??
    (await (deps.isAdminFor || defaultIsAdminFor)(req).catch((err) => {
      logger.warn('comic_caps_admin_lookup_failed', { userId, message: (err as Error)?.message });
      return false;
    }));
  if (admin) return true;
  try {
    const flags = await (deps.budgetFlagsFor || defaultBudgetFlagsFor)(userId);
    return !flags.governed || flags.allowPro;
  } catch (err) {
    logger.warn('comic_caps_budget_lookup_failed', { userId, message: (err as Error)?.message });
    return false;
  }
};

const defaultPlanFor = async (userId: string): Promise<string> => String((await getBillingSummary(userId)).plan.id || 'free');

const isPaidPlan = (plan: string | null | undefined): boolean => PAID_PLAN_TIERS.has(String(plan || '').trim().toLowerCase());

/** Legacy Pro-tier check (kept for `ctx.qualityDenied`; caps are the source of truth). */
export async function checkQualityAccess(
  req: Request,
  tier: QualityTier,
  byok: boolean,
  deps: QualityAccessDeps = {}
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (tier !== 'pro') return { ok: true };
  if (byok) return { ok: true };
  // Without billing there are no plans to gate on: the usage budget decides.
  if (!(deps.billingEnabled ?? BILLING_ENABLED)) {
    return (await proAllowedWithoutBilling(req, deps)) ? { ok: true } : { ok: false, message: PRO_QUALITY_USAGE_MESSAGE };
  }

  const userId = req?.user?.id;
  if (!userId) return { ok: false, message: PRO_QUALITY_DENIED_MESSAGE };

  let plan: string;
  try {
    plan = await planCache.getOrSet(userId, () => (deps.planFor || defaultPlanFor)(userId));
  } catch (err) {
    logger.warn('comic_quality_access_lookup_failed', { userId, message: (err as Error)?.message });
    return { ok: true };
  }
  return isPaidPlan(plan) ? { ok: true } : { ok: false, message: PRO_QUALITY_DENIED_MESSAGE };
}

// ── StudioCaps ───────────────────────────────────────────────────────────────

export interface StudioCapsDeps extends QualityAccessDeps {
  /** Account-age ceiling (default: the safety seam, profile_private.dob, 10-min LRU there). */
  accountCeilingFor?: (userId: string) => Promise<ContentRating>;
}

const defaultIsAdminFor = async (req: Request): Promise<boolean> => {
  if (req.accessProfile) return !!req.accessProfile.isAdmin;
  const userId = req.user?.id;
  if (!userId) return false;
  if (isBootstrapAdminEmail(req.user?.email)) return true;
  return adminCache.getOrSet(userId, async () => (await getUserRoles(userId)).includes('admin'));
};

/**
 * Resolve what this request's user may do (contract §3.3). Never throws: every lookup has a
 * documented failure mode (plan → fail open for tiers, admin → false, ceiling → PG).
 */
export async function studioCapsFor(req: Request, opts: { byok: boolean }, deps: StudioCapsDeps = {}): Promise<StudioCaps> {
  const userId = req?.user?.id;
  const billingOn = deps.billingEnabled ?? BILLING_ENABLED;

  const planP: Promise<{ planId: string | null; failed: boolean }> =
    !userId || !billingOn
      ? Promise.resolve({ planId: null, failed: false })
      : planCache
          .getOrSet(userId, () => (deps.planFor || defaultPlanFor)(userId))
          .then((planId) => ({ planId, failed: false }))
          .catch((err) => {
            logger.warn('comic_caps_plan_lookup_failed', { userId, message: (err as Error)?.message });
            return { planId: null, failed: true };
          });
  const adminP: Promise<boolean> = !userId
    ? Promise.resolve(false)
    : (deps.isAdminFor || defaultIsAdminFor)(req).catch((err) => {
        logger.warn('comic_caps_admin_lookup_failed', { userId, message: (err as Error)?.message });
        return false;
      });
  const ceilingP: Promise<ContentRating> = !userId
    ? Promise.resolve(CEILING_ON_LOOKUP_FAILURE)
    : (deps.accountCeilingFor || accountCeilingFor)(userId)
        .then((r) => (isContentRating(r) ? r : CEILING_ON_LOOKUP_FAILURE))
        .catch((err) => {
          logger.warn('comic_caps_ceiling_lookup_failed', { userId, message: (err as Error)?.message });
          return CEILING_ON_LOOKUP_FAILURE;
        });

  const [plan, isAdmin, ratingCeiling] = await Promise.all([planP, adminP, ceilingP]);
  const caps = resolveStudioCaps({ planId: plan.planId, byok: !!opts.byok, isAdmin, ratingCeiling });
  const full: StudioCaps = { ...caps, qualityTiers: ['draft', 'standard', 'pro'], modelOverride: true };
  // Billing on but the plan lookup failed: fail open for the tier, like checkQualityAccess.
  if (billingOn) return plan.failed ? full : caps;
  // Billing off: no plans to gate on. Admins and own-key users already have Pro from
  // resolveStudioCaps; everyone else is on the usage budget (Draft/Standard unless the budget
  // row is exempt or allows Pro). billing.ts meters every call either way.
  if (isAdmin || opts.byok) return full;
  if (!userId) return caps;
  return (await proAllowedWithoutBilling(req, deps, isAdmin)) ? full : caps;
}

/** The legacy `qualityDenied` text derived from caps (kept for old call sites). */
export const qualityDeniedFromCaps = (caps: StudioCaps): string | undefined =>
  caps.qualityTiers.includes('pro') ? undefined : PRO_QUALITY_DENIED_MESSAGE;
