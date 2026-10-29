import crypto from 'node:crypto';
import type { Request } from 'express';
import type { BillingProvider, LimitExceededDetails, ReservationState, TokenEstimateRequest, TokenEstimateResponse } from '../../../shared/types/billing.js';
import { isTextProvider, type ProviderId } from '../../../shared/providers.js';
import { hasFreeSuffix } from '../../../shared/pricing.js';
import type { CapabilityNotice } from '../../../apiTypes.js';
import {
  reserveUsageTokens,
  releaseReservation,
  settleReservation,
  getBillingSummary
} from './billingLedger.js';
import {
  buildEstimateFromRequestBody,
  buildSettleEstimateFromUsage,
  estimateCharge,
  type UsagePayload
} from './costEstimator.js';
import {
  allowanceCrossingNotices,
  buildAllowanceExhaustedDetails,
  getBillingPrefs,
  invalidateAllowanceStatus,
  isUsageExemptAdmin,
  meteringEnabled,
  tryReserveAllowance,
  type BudgetReserveOutcome
} from './platformAllowance.js';
import { hasAccountKeyFor } from '../middleware/accountKeys.js';
import { logger } from '../lib/logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    usageReservation?: ReservationState;
    usageLimitDetails?: LimitExceededDetails;
    /** Usage threshold notices (30/70/90%) raised by the budget reserve (drained by consumeAllowanceNotices). */
    allowanceNotices?: CapabilityNotice[];
  }
}

// The authenticated user (middleware/auth.ts augments Request with it). Read through one
// structural helper so this module also typechecks where that augmentation isn't in scope
// (the client tsconfig reaches it via shared/comic/plan.test.ts → comic/jobs.ts).
type WithAuthUser = { user?: { id: string; email?: string } };
const userIdOf = (req: Request): string | undefined => (req as Request & WithAuthUser).user?.id;

const resolveProviderFromOperation = (operation: string): BillingProvider => {
  const normalized = operation.toLowerCase();
  if (normalized.includes('openrouter')) return 'openrouter';
  if (normalized.includes('ideogram')) return 'ideogram';
  if (normalized.includes('flux') || normalized.includes('pixazo')) return 'pixazo';
  if (normalized.includes('gemini') || normalized.includes('assistant') || normalized.includes('text') || normalized.includes('vision')) return 'gemini';
  return 'internal';
};

const resolveModelFromRequest = (req: Request, fallbackModel: string) => {
  const fromHeader = req.header('X-Gemini-Model')?.trim();
  if (fromHeader) return fromHeader;
  const bodyModel = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  if (bodyModel) return bodyModel;
  return fallbackModel;
};

// BYOK-ness comes from the resolved req.apiKeys flags (set by attachKeys and the
// account-key fallback in middleware/accountKeys.ts), NOT from raw headers — a key
// resolved from the user's account store is still the user's key, and billing it as
// platform usage would double-charge them. Header checks remain as a fallback for
// callers that run before the middleware.
export const hasByokForProvider = (req: Request, provider: BillingProvider) => {
  if (provider === 'pixazo') return Boolean(req.apiKeys?.pixazoByok ?? (req.header('X-Pixazo-Key') || req.header('X-Flux-Key')));
  if (provider === 'ideogram') return Boolean(req.apiKeys?.ideogramByok ?? req.header('X-Ideogram-Key'));
  // Every text provider's BYOK-ness comes from the resolved generic key map.
  if (isTextProvider(provider)) {
    const pk = req.apiKeys?.providerKeys?.[provider as ProviderId];
    if (pk) return Boolean(pk.byok);
    // Fallbacks for the named legacy fields (callers that ran before the middleware).
    if (provider === 'gemini') return Boolean(req.apiKeys?.geminiByok ?? req.header('X-Gemini-Key'));
    if (provider === 'openrouter') return Boolean(req.apiKeys?.openRouterByok ?? req.header('X-OpenRouter-Key'));
    if (provider === 'nvidia') return Boolean(req.apiKeys?.nvidiaByok ?? req.header('X-Nvidia-Key'));
  }
  return false;
};

export const reserveForOperation = async (input: {
  req: Request;
  operation: string;
  fallbackModel: string;
  provider?: BillingProvider;
  resolution?: TokenEstimateRequest['resolution'];
  imageUnits?: number;
  inputTokens?: number;
  outputTokens?: number;
  projectId?: string;
  comicId?: string;
  stage?: string;
  metadata?: Record<string, unknown>;
  /**
   * Usage budget only: every other model this call may fall back to (e.g. an OpenRouter
   * `models` chain). The hold is priced at the most expensive of them, so a `:free` primary
   * with a paid fallback can never slip past an exhausted budget at $0.
   */
  pricedModels?: string[];
  /**
   * Usage budget only: the caller's own provider-cost estimate for this call (e.g. Comic
   * Studio's registry price for the resolution it actually renders). The hold is never lower.
   */
  estimateFloorUsd?: number;
}): Promise<
  | {
      allowed: true;
      reservation: ReservationState;
      seed: {
        provider: BillingProvider;
        model: string;
        operation: string;
        inputTokens?: number;
        outputTokens?: number;
        imageUnits?: number;
        resolution?: TokenEstimateRequest['resolution'];
        otherBillableUnits?: number;
        otherBillableUnitPriceUsd?: number;
        projectId?: string;
        comicId?: string;
        stage?: string;
        byok?: boolean;
        metadata?: Record<string, unknown>;
      };
      provider: BillingProvider;
      model: string;
    }
  | { allowed: false; details: LimitExceededDetails }
> => {
  if (!userIdOf(input.req)) {
    return {
      allowed: false as const,
      details: {
        reason: 'INSUFFICIENT_CREDITS' as const,
        requiredCt: 0,
        availableCt: 0,
        resetAt: new Date().toISOString(),
        usage: {
          planTier: 'free' as const,
          dailyGuardrailCt: 0,
          dailyUsedCt: 0,
          dailyRemainingCt: 0,
          monthlyResetAt: new Date().toISOString(),
          dailyResetAt: new Date().toISOString()
        },
        options: {
          canUpgrade: true,
          canAddCredits: false,
          canWaitForReset: false,
          paymentMethodRequired: false,
          recommendedAction: 'upgrade' as const
        }
      }
    };
  }

  const userId = userIdOf(input.req)!;
  const provider = input.provider || resolveProviderFromOperation(input.operation);
  const byok = hasByokForProvider(input.req, provider);
  const model = resolveModelFromRequest(input.req, input.fallbackModel);

  // Usage budget (P1-LIMITS, services/platformAllowance.ts): ONE meter for platform-paid usage
  // across every studio. BYOK never counts; admins are exempt; everyone else is checked by the
  // atomic database reservation below — after the estimate, before the provider call — and
  // fails CLOSED: if the budget can't be checked, nothing is spent.
  const budgetsOn = meteringEnabled() && !byok;
  const isAdmin = budgetsOn ? await isUsageExemptAdmin(input.req) : false;
  const budgetChecked = budgetsOn && !isAdmin;

  let seed: ReturnType<typeof buildEstimateFromRequestBody>;
  let estimate: Awaited<ReturnType<typeof estimateCharge>>;
  try {
    seed = buildEstimateFromRequestBody(provider, model, input.operation, input.req.body, {
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      imageUnits: input.imageUnits,
      resolution: input.resolution,
      projectId: input.projectId,
      comicId: input.comicId,
      stage: input.stage,
      byok,
      metadata: input.metadata
    });
    estimate = await estimateCharge(seed);
    if (budgetChecked) {
      estimate = await budgetEstimateFor(seed, estimate, model, input.fallbackModel, {
        pricedModels: input.pricedModels,
        floorUsd: input.estimateFloorUsd
      });
    }
  } catch (err) {
    if (!budgetChecked) throw err;
    return budgetRefusal(input.req, userId, provider, { kind: 'unavailable' }, err);
  }

  let reservationId: string | undefined;
  let governed = false;
  // The token wallet is skipped only when ONE meter already decided: the budget (governed), the
  // admin rule, or an admin-granted exempt row. A user with no budget at all (no row and no
  // default) keeps the wallet's own limits — never unlimited.
  let skipWallet = budgetsOn && isAdmin;
  if (budgetChecked) {
    reservationId = crypto.randomUUID();
    const outcome = await tryReserveAllowance({
      userId,
      reservationId,
      estimateUsd: estimate.estimatedProviderCostUsd,
      event: {
        projectId: input.projectId,
        comicId: input.comicId,
        operation: input.operation,
        stage: input.stage,
        provider,
        model,
        estimatedCt: estimate.estimatedCt,
        billableUsd: estimate.estimatedBillableUsd,
        metadata: input.metadata
      }
    });
    if (outcome.kind === 'denied' || outcome.kind === 'unavailable') {
      return budgetRefusal(input.req, userId, provider, outcome);
    }
    governed = outcome.kind === 'reserved';
    skipWallet = governed || (outcome.kind === 'ungoverned' && outcome.exempt);
    if (outcome.kind === 'reserved' && outcome.crossedNow.length) {
      const notices = allowanceCrossingNotices(outcome.crossedNow);
      if (notices.length) input.req.allowanceNotices = [...(input.req.allowanceNotices || []), ...notices];
    }
  }

  const reserveInput = {
    userId,
    estimate,
    provider,
    model,
    operation: input.operation,
    projectId: input.projectId,
    comicId: input.comicId,
    stage: input.stage,
    byok,
    metadata: input.metadata,
    // Budgets on: the budget (or the admin/exempt rule) is the one meter, so the token wallet's
    // limits are skipped; governed reservations reuse the RPC's id and RESERVED row.
    ...(skipWallet ? { skipWalletLimits: true, governed, reservationId, costEventRecorded: governed } : {})
  };

  let reserved: Awaited<ReturnType<typeof reserveUsageTokens>>;
  if (governed) {
    try {
      reserved = await reserveUsageTokens(reserveInput);
    } catch (err) {
      // The budget row is held; without a ledger we can't settle honestly — free the hold and
      // refuse (fail closed), so nothing unmetered is ever spent.
      await releaseUsageReservation(userId, reservationId!, estimate.estimatedCt, input, 'ledger_unavailable');
      return budgetRefusal(input.req, userId, provider, { kind: 'unavailable' }, err);
    }
  } else {
    reserved = await reserveUsageTokens(reserveInput);
  }

  if ('details' in reserved) {
    input.req.usageLimitDetails = reserved.details;
    return { allowed: false, details: reserved.details };
  }

  input.req.usageReservation = reserved.reservation;
  return {
    allowed: true as const,
    reservation: reserved.reservation,
    seed,
    provider,
    model
  };
};

/** Hold for a paid call whose price we can't verify (the catalog matched another row at $0). */
export const UNVERIFIED_PRICE_FLOOR_USD = 0.001;

/**
 * The estimate the usage budget reserves. These rules keep a governed user from walking past an
 * exhausted budget with a $0 (or too-low) estimate (the database gate lets $0 calls through, so
 * `:free` models keep working):
 *  1. The priced model comes from the X-Gemini-Model header / body.model, which the CLIENT
 *     controls — every call site passes the model it actually calls as `fallbackModel`, so the
 *     hold is never lower than that model's estimate.
 *  2. A $0 estimate only stands for a verified-free model (`:free` suffix, or its own catalog row
 *     at $0). An unknown model that fell back to some other $0 row holds a small floor instead;
 *     settle records the real cost either way.
 *  3. `pricedModels` (a fallback chain) is priced at its most expensive member.
 *  4. `floorUsd` (the caller's own estimate, e.g. a registry image price) is a floor.
 */
const budgetEstimateFor = async (
  seed: ReturnType<typeof buildEstimateFromRequestBody>,
  estimate: TokenEstimateResponse,
  model: string,
  fallbackModel: string,
  opts: { pricedModels?: string[]; floorUsd?: number } = {}
): Promise<TokenEstimateResponse> => {
  const called = String(fallbackModel || '').trim();
  let best = estimate;
  let calledEstimate = estimate;
  if (called && called !== model.trim()) {
    calledEstimate = await estimateCharge({ ...seed, model: called });
    if (calledEstimate.estimatedProviderCostUsd > best.estimatedProviderCostUsd) best = calledEstimate;
  }
  // 3. A fallback chain is priced at its most expensive member (OpenRouter may route to any).
  const seen = new Set([model.trim(), called]);
  for (const raw of (opts.pricedModels || []).slice(0, 8)) {
    const m = String(raw || '').trim();
    if (!m || seen.has(m)) continue;
    seen.add(m);
    const alt = await estimateCharge({ ...seed, model: m });
    if (alt.estimatedProviderCostUsd > best.estimatedProviderCostUsd) best = alt;
  }
  // 4. The caller's own estimate (e.g. the registry price at the real resolution) is a floor.
  const floor = Number(opts.floorUsd);
  if (Number.isFinite(floor) && floor > best.estimatedProviderCostUsd) best = withProviderCost(best, floor);
  if (best.estimatedProviderCostUsd > 0) return best;
  const calledModel = called || model.trim();
  const verifiedFree = hasFreeSuffix(calledModel) || calledEstimate.modelPricing?.model === calledModel;
  if (verifiedFree) return best;
  return withProviderCost(best, UNVERIFIED_PRICE_FLOOR_USD);
};

/** The same estimate, re-priced at `providerUsd` (billable and CT follow the markup). */
const withProviderCost = (estimate: TokenEstimateResponse, providerUsd: number): TokenEstimateResponse => {
  const markup = Number.isFinite(estimate.markup) && estimate.markup > 0 ? estimate.markup : 1;
  const billable = providerUsd * markup;
  return {
    ...estimate,
    estimatedProviderCostUsd: Number(providerUsd.toFixed(6)),
    estimatedBillableUsd: Number(billable.toFixed(6)),
    estimatedCt: Math.ceil(billable * (estimate.ctPerUsd || 10_000))
  };
};

/** Best-effort release of a budget hold the ledger never picked up. */
const releaseUsageReservation = async (
  userId: string,
  reservationId: string,
  estimatedCt: number,
  input: { operation: string; projectId?: string; metadata?: Record<string, unknown> },
  reason: string
) => {
  try {
    await releaseReservation({
      userId,
      reservationId,
      estimatedCt,
      reason,
      operation: input.operation,
      projectId: input.projectId,
      metadata: input.metadata,
      walletSkipped: true
    });
  } catch {
    // The RESERVED row stops counting after 20 minutes; the reconciliation sweep (jobs/strandedHolds.ts)
    // releases it when it runs (no RESERVE ledger entry, so nothing ran), never charges it.
  } finally {
    invalidateAllowanceStatus(userId);
  }
};

/** Turn a budget denial/outage into the honest, percent-only refusal every route already handles. */
const budgetRefusal = async (
  req: Request,
  userId: string,
  provider: BillingProvider,
  outcome: Extract<BudgetReserveOutcome, { kind: 'denied' } | { kind: 'unavailable' }>,
  err?: unknown
): Promise<{ allowed: false; details: LimitExceededDetails }> => {
  if (err) logger.error('usage_budget_reserve_error', { message: (err as Error)?.message });
  let canFallbackToByok = false;
  let byokFallbackMode: 'ask' | 'auto' | 'never' = 'ask';
  try {
    const [prefs, hasKey] = await Promise.all([getBillingPrefs(userId), hasAccountKeyFor(userId, provider)]);
    byokFallbackMode = prefs.byokFallbackMode;
    canFallbackToByok = hasKey;
  } catch {
    // Hints only.
  }
  const details = buildAllowanceExhaustedDetails({
    pctLeft: outcome.kind === 'denied' ? outcome.pctLeft : 100,
    resetsAt: outcome.kind === 'denied' ? outcome.resetsAt : null,
    canFallbackToByok,
    byokFallbackMode,
    unavailable: outcome.kind === 'unavailable'
  });
  req.usageLimitDetails = details;
  return { allowed: false as const, details };
};

export const settleReservedOperation = async (input: {
  req: Request;
  operation: string;
  provider: string;
  model: string;
  seed: {
    provider: BillingProvider;
    model: string;
    operation: string;
    inputTokens?: number;
    outputTokens?: number;
    imageUnits?: number;
    resolution?: TokenEstimateRequest['resolution'];
    otherBillableUnits?: number;
    otherBillableUnitPriceUsd?: number;
    projectId?: string;
    comicId?: string;
    stage?: string;
    byok?: boolean;
    metadata?: Record<string, unknown>;
  };
  usage?: UsagePayload;
  imageUnits?: number;
  metadata?: Record<string, unknown>;
}) => {
  const reservation = input.req.usageReservation;
  if (!userIdOf(input.req) || !reservation) {
    return null;
  }

  let actual: TokenEstimateResponse;
  try {
    actual = await buildSettleEstimateFromUsage(input.seed, input.usage, {
      imageUnits: input.imageUnits
    });
  } catch (err) {
    // The provider call already happened. For a governed reservation, record the hold's own
    // estimate (or the provider's reported cost) rather than throwing — a throw makes the caller
    // RELEASE the row, which would erase real platform spend from the user's usage.
    if (!reservation.governed) throw err;
    logger.error('usage_budget_settle_estimate_failed', { message: (err as Error)?.message, operation: input.operation });
    const reported = Number(input.usage?.providerCostUsd);
    // A partially reported cost is a floor, not the whole bill: never below the hold's estimate.
    const partial = Number(input.usage?.partialProviderCostUsd);
    actual =
      Number.isFinite(reported) && reported > 0
        ? withProviderCost(reservation.estimated, reported)
        : Number.isFinite(partial) && partial > (reservation.estimated.estimatedProviderCostUsd || 0)
          ? withProviderCost(reservation.estimated, partial)
          : reservation.estimated;
  }

  const settled = await settleReservation({
    userId: userIdOf(input.req)!,
    reservationId: reservation.reservationId,
    estimatedCt: reservation.estimated.estimatedCt,
    actual,
    operation: input.operation,
    provider: input.provider,
    model: input.model,
    projectId: input.seed.projectId,
    metadata: input.metadata,
    byokBypass: reservation.byokBypass,
    walletSkipped: reservation.walletSkipped
  });

  // The settled row now carries the real provider cost; the next status read sees it. The
  // 30/70/90% notices were raised atomically at reserve time (percent-only).
  if (reservation.governed) invalidateAllowanceStatus(userIdOf(input.req)!);

  return settled;
};

/** Drain the allowance threshold notices settlement attached to this request. */
export const consumeAllowanceNotices = (req: Request): CapabilityNotice[] => {
  const notices = req.allowanceNotices || [];
  req.allowanceNotices = undefined;
  return notices;
};

export const releaseReservedOperation = async (input: {
  req: Request;
  operation: string;
  provider: string;
  model: string;
  projectId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}) => {
  const reservation = input.req.usageReservation;
  if (!userIdOf(input.req) || !reservation || reservation.byokBypass) {
    return;
  }

  await releaseReservation({
    userId: userIdOf(input.req)!,
    reservationId: reservation.reservationId,
    estimatedCt: reservation.estimated.estimatedCt,
    reason: input.reason,
    operation: input.operation,
    provider: input.provider,
    model: input.model,
    projectId: input.projectId,
    metadata: input.metadata,
    walletSkipped: reservation.walletSkipped
  });
  if (reservation.governed) invalidateAllowanceStatus(userIdOf(input.req)!);
};

export const formatLimitErrorResponse = (details: LimitExceededDetails) => ({
  // The honest, human sentence when the gate wrote one (usage budget: percent-only).
  message: details.message || `Usage limit reached (${details.reason}).`,
  code: 'BILLING_LIMIT_EXCEEDED',
  details
});

/**
 * The payload with the dollar figures in `usage` removed (`providerCostUsd`, and the partial
 * reported cost a multi-call turn may carry), everything else untouched.
 */
const withoutProviderCost = <T extends Record<string, unknown>>(payload: T): T => {
  const usage = payload.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return payload;
  if (!('providerCostUsd' in usage) && !('partialProviderCostUsd' in usage)) return payload;
  const { providerCostUsd: _dollars, partialProviderCostUsd: _partialDollars, ...rest } = usage as Record<string, unknown>;
  return { ...payload, usage: rest };
};

export const attachBillingToPayload = <T extends Record<string, unknown>>(
  payload: T,
  reservation: ReservationState | undefined,
  settled: Awaited<ReturnType<typeof settleReservedOperation>>
): T & { billing?: { reservationId?: string; byokBypass?: boolean; governed?: boolean; estimated?: TokenEstimateResponse; settled?: Record<string, unknown> } } => {
  if (!reservation) return payload;

  // Governed users never see dollars for their usage (P1-LIMITS): their responses carry no
  // estimate/settlement amounts — the usage meter (GET /api/usage/allowance) shows percent left.
  // That includes the provider's real cost inside the response's own `usage` record (chat,
  // swarm and recipe turns now carry it so settlement is exact); token counts stay.
  if (reservation.governed) {
    return {
      ...withoutProviderCost(payload),
      billing: {
        reservationId: reservation.reservationId,
        byokBypass: false,
        governed: true,
        settled: settled ? { reservationReleased: settled.reservationReleased } : undefined
      }
    };
  }

  return {
    ...payload,
    billing: {
      reservationId: reservation.reservationId,
      byokBypass: reservation.byokBypass,
      estimated: reservation.estimated,
      settled: settled
        ? {
            actualCt: settled.actualCt,
            billableUsd: settled.billableUsd,
            providerCostUsd: settled.providerCostUsd,
            reservationReleased: settled.reservationReleased,
            autoReload: settled.autoReload,
            overageCapture: settled.overageCapture
          }
        : undefined
    }
  };
};

export const getUserUsageSnapshot = async (userId: string) => {
  const summary = await getBillingSummary(userId);
  return {
    planTier: summary.plan.id,
    availableCt: summary.wallet.availableCt,
    dailyRemainingCt: summary.usage.dailyRemainingCt,
    dailyResetAt: summary.usage.dailyResetAt,
    monthlyResetAt: summary.usage.monthlyResetAt
  };
};
