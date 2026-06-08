import { NextFunction, Request, Response } from 'express';
import { getRateLimitStore } from './rateLimitStore.js';

type RateLimitConfig = {
  maxRequests: number;
  scope: string;
  windowMs: number;
};

const resolveRequesterKey = (req: Request) => {
  if (req.user?.id) {
    return `user:${req.user.id}`;
  }
  return `ip:${req.ip || 'unknown'}`;
};

const clampToPositive = (value: number) => Math.max(0, value);

// F2: counts live in a shared store (Redis when REDIS_URL is set, else in-memory — identical to
// the original behavior). This makes limits hold across instances instead of being per-process.
export const createRateLimit = ({ scope, windowMs, maxRequests }: RateLimitConfig) =>
  async (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const bucketKey = `${scope}:${resolveRequesterKey(req)}`;

    let count: number;
    let resetAt: number;
    try {
      const hit = await getRateLimitStore().hit(bucketKey, windowMs, maxRequests);
      count = hit.count;
      resetAt = hit.resetAt;
    } catch {
      // Fail open: a rate-limit store hiccup must never block legitimate traffic.
      next();
      return;
    }

    const remaining = clampToPositive(maxRequests - count);
    const retryAfterMs = clampToPositive(resetAt - now);
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));

    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.floor(resetAt / 1000)));
    res.setHeader('RateLimit-Policy', `${scope};w=${Math.floor(windowMs / 1000)};q=${maxRequests}`);

    if (count <= maxRequests) {
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
