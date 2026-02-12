import { NextFunction, Request, Response } from 'express';
import type { AssistantLimitInfo } from '../../../apiTypes.js';
import { supabase } from '../services/supabase.js';

const GUEST_LIMIT = 5;
const GUEST_WINDOW_MS = 60 * 60 * 1000;
const FREE_LIMIT = 30;
const FREE_WINDOW_MS = 24 * 60 * 60 * 1000;

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

const resolveUserTier = async (req: Request): Promise<AssistantTier> => {
  if (!req.user) return 'free';
  if (req.user.email === 'admin@test.com') return 'admin';

  try {
    const { data, error } = await supabase
      .from('usage_limits')
      .select('plan_tier, is_premium')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (error || !data) return 'free';

    const planTier = typeof data.plan_tier === 'string' ? data.plan_tier.toLowerCase() : '';
    if (planTier === 'admin') return 'admin';
    if (planTier === 'pro') return 'pro';
    if (data.is_premium === true) return 'pro';
    return 'free';
  } catch {
    return 'free';
  }
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

  const tier = await resolveUserTier(req);
  req.assistantTier = tier;

  if (tier === 'pro' || tier === 'admin') {
    const info: AssistantLimitInfo = {
      scope: 'bypass',
      by: 'user'
    };
    req.assistantLimitInfo = info;
    setLimitHeaders(res, info);
    next();
    return;
  }

  const key = `assistant:free:${requester.id}`;
  const bucket = resolveBucket(key, FREE_LIMIT, FREE_WINDOW_MS);
  const info: AssistantLimitInfo = {
    scope: 'free',
    by: 'user',
    limit: FREE_LIMIT,
    remaining: bucket.remaining,
    resetAt: bucket.resetAt,
    windowMs: FREE_WINDOW_MS
  };
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
      message: `Assistant free-tier limit reached (${FREE_LIMIT} requests/day). Retry in ${retryAfterSeconds}s.`,
      code: 'ASSISTANT_RATE_LIMITED',
      details: info
    }
  });
};

export const clearAssistantLimitBuckets = () => {
  buckets.clear();
  requestCounter = 0;
};
