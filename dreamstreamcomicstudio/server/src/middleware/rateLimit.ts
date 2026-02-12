import { NextFunction, Request, Response } from 'express';

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

type RateLimitConfig = {
  maxRequests: number;
  scope: string;
  windowMs: number;
};

const buckets = new Map<string, RateLimitBucket>();
let requestCounter = 0;

const cleanupExpiredBuckets = (now: number) => {
  for (const [key, value] of buckets.entries()) {
    if (value.resetAt <= now) {
      buckets.delete(key);
    }
  }
};

const resolveRequesterKey = (req: Request) => {
  if (req.user?.id) {
    return `user:${req.user.id}`;
  }
  return `ip:${req.ip || 'unknown'}`;
};

const clampToPositive = (value: number) => Math.max(0, value);

export const createRateLimit = ({ scope, windowMs, maxRequests }: RateLimitConfig) =>
  (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    requestCounter += 1;

    if (requestCounter % 200 === 0) {
      cleanupExpiredBuckets(now);
      requestCounter = 0;
    }

    const requester = resolveRequesterKey(req);
    const bucketKey = `${scope}:${requester}`;
    const existing = buckets.get(bucketKey);
    const activeBucket = !existing || existing.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : existing;

    activeBucket.count += 1;
    buckets.set(bucketKey, activeBucket);

    const remaining = clampToPositive(maxRequests - activeBucket.count);
    const retryAfterMs = clampToPositive(activeBucket.resetAt - now);
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));

    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.floor(activeBucket.resetAt / 1000)));
    res.setHeader('RateLimit-Policy', `${scope};w=${Math.floor(windowMs / 1000)};q=${maxRequests}`);

    if (activeBucket.count <= maxRequests) {
      next();
      return;
    }

    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({
      error: {
        message: `Rate limit exceeded for ${scope}. Retry in ${retryAfterSeconds}s.`,
        code: 'RATE_LIMITED',
        requestId: req.requestId,
        details: {
          scope,
          limit: maxRequests,
          windowMs,
          retryAfterMs,
          keyType: req.user?.id ? 'user' : 'ip'
        }
      }
    });
  };
