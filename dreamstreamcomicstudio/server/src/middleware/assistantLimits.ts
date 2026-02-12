import { NextFunction, Request, Response } from 'express';
import type { AssistantLimitInfo } from '../../../apiTypes.js';
import { getBillingSummary } from '../services/billingLedger.js';

const GUEST_LIMIT = 5;
const GUEST_WINDOW_MS = 60 * 60 * 1000;
const MIN_ASSISTANT_CT = 120;

type AssistantTier = 'free' | 'pro' | 'admin';

type BucketState = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, BucketState>();
let requestCounter = 0;

declare module 'express-serve-static-core' {
  interface Request {
    assistantLimitInfo?: AssistantLimitInfo;
    assistantTier?: AssistantTier;
  }
}

const cleanupExpiredBuckets = (now: number) => {
  for (const [key, value] of buckets.entries()) {
    if (value.resetAt <= now) buckets.delete(key);
  }
};

const resolveBucket = (key: string, limit: number, windowMs: number, now = Date.now()) => {
  requestCounter += 1;
  if (requestCounter % 200 === 0) {
    cleanupExpiredBuckets(now);
    requestCounter = 0;
  }

  const current = buckets.get(key);
  const active = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : current;

  active.count += 1;
  buckets.set(key, active);

  const remaining = Math.max(0, limit - active.count);
  return {
    allowed: active.count <= limit,
    remaining,
    resetAt: active.resetAt,
    retryAfterMs: Math.max(0, active.resetAt - now)
  };
};

const setLimitHeaders = (res: Response, limitInfo: AssistantLimitInfo) => {
  res.setHeader('X-Assistant-Limit-Scope', limitInfo.scope);
  if (typeof limitInfo.limit === 'number') res.setHeader('X-Assistant-Limit', String(limitInfo.limit));
  if (typeof limitInfo.remaining === 'number') res.setHeader('X-Assistant-Remaining', String(limitInfo.remaining));
  if (typeof limitInfo.resetAt === 'number') res.setHeader('X-Assistant-Reset', String(Math.floor(limitInfo.resetAt / 1000)));
};

export const assistantLimits = async (req: Request, res: Response, next: NextFunction) => {
  const requester = req.user;
  if (!requester) {
    const key = `assistant:guest:${req.ip || 'unknown'}`;
    const bucket = resolveBucket(key, GUEST_LIMIT, GUEST_WINDOW_MS);
    const info: AssistantLimitInfo = {
      scope: 'guest',
      by: 'ip',
      limit: GUEST_LIMIT,
      remaining: bucket.remaining,
      resetAt: bucket.resetAt,
      windowMs: GUEST_WINDOW_MS
    };
    req.assistantTier = 'free';
    req.assistantLimitInfo = info;
    setLimitHeaders(res, info);

    if (bucket.allowed) {
      next();
      return;
    }

    const retryAfterSeconds = Math.max(1, Math.ceil(bucket.retryAfterMs / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({
      error: {
        message: `Assistant guest limit reached (${GUEST_LIMIT} requests/hour). Retry in ${retryAfterSeconds}s.`,
        code: 'ASSISTANT_RATE_LIMITED',
        details: info
      }
    });
    return;
  }

  try {
    const summary = await getBillingSummary(requester.id);
    const tier = summary.plan.id === 'admin' ? 'admin' : summary.plan.id === 'pro' || summary.plan.id === 'studio' ? 'pro' : 'free';
    req.assistantTier = tier;

    const remainingCt = Math.min(summary.usage.dailyRemainingCt, summary.wallet.availableCt);
    const resetAt = new Date(summary.usage.dailyResetAt).getTime();

    const info: AssistantLimitInfo = {
      scope: tier === 'admin' ? 'bypass' : 'free',
      by: 'user',
      limit: summary.usage.dailyGuardrailCt,
      remaining: Math.max(0, remainingCt),
      resetAt,
      windowMs: Math.max(1, resetAt - Date.now())
    };

    req.assistantLimitInfo = info;
    setLimitHeaders(res, info);

    const canUseOverage = summary.hasPaymentMethodOnFile && summary.overageEnabled && summary.plan.id !== 'free';
    if (remainingCt < MIN_ASSISTANT_CT && !canUseOverage) {
      res.status(402).json({
        error: {
          message: `Assistant limit reached. At least ${MIN_ASSISTANT_CT} CT are required per request estimate.`,
          code: 'ASSISTANT_TOKEN_LIMIT_REACHED',
          details: {
            ...info,
            minRequiredCt: MIN_ASSISTANT_CT,
            options: {
              canUpgrade: true,
              canAddCredits: true,
              canWaitForReset: true
            }
          }
        }
      });
      return;
    }

    next();
  } catch {
    // If billing summary fails, allow the route to proceed and enforce inside route-level reserve.
    const info: AssistantLimitInfo = { scope: 'free', by: 'user' };
    req.assistantTier = 'free';
    req.assistantLimitInfo = info;
    setLimitHeaders(res, info);
    next();
  }
};

export const clearAssistantLimitBuckets = () => {
  buckets.clear();
  requestCounter = 0;
};
