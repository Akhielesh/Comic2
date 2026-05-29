import type { Request } from 'express';
import type { LimitExceededDetails, ReservationState, TokenEstimateRequest, TokenEstimateResponse } from '../../../shared/types/billing.js';
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

declare module 'express-serve-static-core' {
  interface Request {
    usageReservation?: ReservationState;
    usageLimitDetails?: LimitExceededDetails;
  }
}

const resolveProviderFromOperation = (operation: string): 'gemini' | 'pixazo' | 'openrouter' | 'internal' => {
  const normalized = operation.toLowerCase();
  if (normalized.includes('openrouter')) return 'openrouter';
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

export const hasByokForProvider = (req: Request, provider: 'gemini' | 'pixazo' | 'openrouter' | 'internal') => {
  if (provider === 'gemini') return Boolean(req.header('X-Gemini-Key'));
  if (provider === 'pixazo') return Boolean(req.header('X-Pixazo-Key') || req.header('X-Flux-Key'));
  if (provider === 'openrouter') return Boolean(req.header('X-OpenRouter-Key'));
  return false;
};

export const reserveForOperation = async (input: {
  req: Request;
  operation: string;
  fallbackModel: string;
  provider?: 'gemini' | 'pixazo' | 'openrouter' | 'internal';
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
        provider: 'gemini' | 'pixazo' | 'openrouter' | 'internal';
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
      provider: 'gemini' | 'pixazo' | 'openrouter' | 'internal';
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
    provider: 'gemini' | 'pixazo' | 'openrouter' | 'internal';
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

  return settleReservation({
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
