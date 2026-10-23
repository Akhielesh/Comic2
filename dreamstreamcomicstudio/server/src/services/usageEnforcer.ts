import crypto from 'node:crypto';
import type { Request } from 'express';
import type { BillingProvider, LimitExceededDetails, ReservationState, TokenEstimateRequest, TokenEstimateResponse } from '../../../shared/types/billing.js';
import { isTextProvider, type ProviderId } from '../../../shared/providers.js';
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
  if (!input.req.user?.id) {
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

  const userId = input.req.user.id;
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
  } catch (err) {
    if (!budgetChecked) throw err;
    return budgetRefusal(input.req, userId, provider, { kind: 'unavailable' }, err);
  }

  let reservationId: string | undefined;
  let governed = false;
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
    ...(budgetsOn ? { skipWalletLimits: true, governed, reservationId, costEventRecorded: governed } : {})
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
    // The RESERVED row stops counting after 20 minutes on its own.
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
    resetsAt: null,
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
  if (!input.req.user?.id || !reservation) {
    return null;
  }

  const actual = await buildSettleEstimateFromUsage(input.seed, input.usage, {
    imageUnits: input.imageUnits
  });

  const settled = await settleReservation({
    userId: input.req.user.id,
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
  if (reservation.governed) invalidateAllowanceStatus(input.req.user.id);

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
  if (!input.req.user?.id || !reservation || reservation.byokBypass) {
    return;
  }

  await releaseReservation({
    userId: input.req.user.id,
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
  if (reservation.governed) invalidateAllowanceStatus(input.req.user.id);
};

export const formatLimitErrorResponse = (details: LimitExceededDetails) => ({
  // The honest, human sentence when the gate wrote one (usage budget: percent-only).
  message: details.message || `Usage limit reached (${details.reason}).`,
  code: 'BILLING_LIMIT_EXCEEDED',
  details
});

export const attachBillingToPayload = <T extends Record<string, unknown>>(
  payload: T,
  reservation: ReservationState | undefined,
  settled: Awaited<ReturnType<typeof settleReservedOperation>>
): T & { billing?: { reservationId?: string; byokBypass?: boolean; estimated?: TokenEstimateResponse; settled?: Record<string, unknown> } } => {
  if (!reservation) return payload;

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
