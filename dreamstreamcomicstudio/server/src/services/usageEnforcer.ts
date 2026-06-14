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
  bumpAllowanceCache,
  getAllowanceStatus,
  getBillingPrefs,
  isPlatformFundedProvider
} from './platformAllowance.js';
import { hasAccountKeyFor } from '../middleware/accountKeys.js';

declare module 'express-serve-static-core' {
  interface Request {
    usageReservation?: ReservationState;
    usageLimitDetails?: LimitExceededDetails;
    /** Allowance threshold notices produced at settlement (drained by consumeAllowanceNotices). */
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

  const provider = input.provider || resolveProviderFromOperation(input.operation);
  const byok = hasByokForProvider(input.req, provider);
  const model = resolveModelFromRequest(input.req, input.fallbackModel);

  // Platform-allowance gate (services/platformAllowance.ts): a platform-funded request
  // stops once the user's monthly allowance is exhausted. Runs BEFORE the wallet
  // reservation so the existing wallet/credit semantics stay untouched, and fails
  // OPEN — when metering is unavailable the status reports enabled:false. BYOK
  // requests (header or auto-fallback account key) never hit this gate.
  if (!byok && isPlatformFundedProvider(provider)) {
    try {
      const prefs = await getBillingPrefs(input.req.user.id);
      if (prefs.usePlatformAllowance) {
        const status = await getAllowanceStatus(input.req.user.id);
        if (status.enabled && status.exhausted) {
          const canFallbackToByok = await hasAccountKeyFor(input.req.user.id, provider);
          const details = buildAllowanceExhaustedDetails({
            status,
            canFallbackToByok,
            byokFallbackMode: prefs.byokFallbackMode
          });
          input.req.usageLimitDetails = details;
          return { allowed: false as const, details };
        }
      }
    } catch {
      // Allowance checks are best-effort; never block generation on a metering failure.
    }
  }

  const seed = buildEstimateFromRequestBody(provider, model, input.operation, input.req.body, {
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

  const estimate = await estimateCharge(seed);
  const reserved = await reserveUsageTokens({
    userId: input.req.user.id,
    estimate,
    provider,
    model,
    operation: input.operation,
    projectId: input.projectId,
    comicId: input.comicId,
    stage: input.stage,
    byok,
    metadata: input.metadata
  });

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
    byokBypass: reservation.byokBypass
  });

  // Platform-allowance metering: optimistically bump the cached month-to-date spend
  // with the ACTUAL settled platform cost so rapid-fire requests can't overshoot the
  // cap between 60s cache refreshes. Newly crossed 30/70/90 thresholds become
  // percent-only response notices, drained by consumeAllowanceNotices. Best-effort —
  // settlement above already persisted the authoritative spend.
  if (settled && !reservation.byokBypass && isPlatformFundedProvider(input.seed.provider)) {
    try {
      const actualPlatformUsd = settled.billableUsd || settled.providerCostUsd || 0;
      if (actualPlatformUsd > 0) {
        const status = await getAllowanceStatus(input.req.user.id);
        if (status.enabled) {
          const bump = bumpAllowanceCache(input.req.user.id, actualPlatformUsd);
          const notices = bump ? allowanceCrossingNotices(bump.crossedNow, status.resetsAt) : [];
          if (notices.length) {
            input.req.allowanceNotices = [...(input.req.allowanceNotices || []), ...notices];
          }
        }
      }
    } catch {
      // Never fail a settled request over allowance cache accounting.
    }
  }

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
    metadata: input.metadata
  });
};

export const formatLimitErrorResponse = (details: LimitExceededDetails) => ({
  message: `Usage limit reached (${details.reason}).`,
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
