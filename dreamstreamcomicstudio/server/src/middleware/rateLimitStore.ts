// Rate-limit counter store (Epic F2 — distributed correctness).
//
// The audit flagged the in-memory limiter as broken across instances (each process keeps its own
// Map, so N instances = N× the real limit). This store abstracts the counter so it can live in
// Redis (shared across instances) when REDIS_URL is set, while falling back to the EXACT existing
// in-memory behavior when it isn't — so single-instance / no-Redis deployments are unchanged.
// The Redis path fails OPEN (allow) on any Redis error so a cache hiccup never blocks real traffic.

import * as IORedis from 'ioredis';
import { REDIS_URL } from '../config.js';

export interface RateLimitHit {
  count: number;
  resetAt: number;
}

export interface RateLimitStore {
  hit(key: string, windowMs: number, maxRequests: number): Promise<RateLimitHit>;
  readonly kind: 'memory' | 'redis';
}

/** Pure: the epoch-aligned fixed window an instant falls in (used by the Redis store). */
export const computeWindow = (now: number, windowMs: number): { index: number; resetAt: number } => {
  const index = Math.floor(now / windowMs);
  return { index, resetAt: (index + 1) * windowMs };
};

// --- In-memory (default; preserves the original rolling-window behavior exactly) ---------
type Bucket = { count: number; resetAt: number };

export class InMemoryRateLimitStore implements RateLimitStore {
  readonly kind = 'memory' as const;
  private readonly buckets = new Map<string, Bucket>();
  private hits = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private cleanup(now: number): void {
    for (const [k, v] of this.buckets.entries()) if (v.resetAt <= now) this.buckets.delete(k);
  }

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const now = this.now();
    if (++this.hits % 200 === 0) {
      this.cleanup(now);
      this.hits = 0;
    }
    const existing = this.buckets.get(key);
    const bucket = !existing || existing.resetAt <= now ? { count: 0, resetAt: now + windowMs } : existing;
    bucket.count += 1;
    this.buckets.set(key, bucket);
    return { count: bucket.count, resetAt: bucket.resetAt };
  }
}

// --- Redis (shared across instances; epoch-aligned fixed window) -------------------------
class RedisRateLimitStore implements RateLimitStore {
  readonly kind = 'redis' as const;
  private readonly redis: any;

  constructor(redis: any) {
    this.redis = redis;
  }

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const now = Date.now();
    const { index, resetAt } = computeWindow(now, windowMs);
    const rkey = `rl:${key}:${index}`;
    const count: number = await this.redis.incr(rkey);
    if (count === 1) await this.redis.pexpire(rkey, windowMs + 1000);
    return { count, resetAt };
  }
}

let store: RateLimitStore | null = null;

/** Singleton store: Redis when REDIS_URL is configured, else the in-memory fallback. */
export const getRateLimitStore = (): RateLimitStore => {
  if (store) return store;
  if (REDIS_URL && REDIS_URL.trim()) {
    try {
      const RedisCtor = (IORedis as any).default || (IORedis as any);
      const redis = new RedisCtor(REDIS_URL, { maxRetriesPerRequest: 2, enableReadyCheck: false, lazyConnect: false });
      store = new RedisRateLimitStore(redis);
    } catch {
      store = new InMemoryRateLimitStore();
    }
  } else {
    store = new InMemoryRateLimitStore();
  }
  return store;
};
