// Worker-side LLM completion using PLATFORM keys, now resilient (Epic A4 + F1). The ventures
// worker has no per-request BYOK, so it draws from a provider KEY POOL (rotates off a
// rate-limited key) guarded by a CIRCUIT BREAKER, and FAILS OVER across providers
// (OpenRouter → NVIDIA). Returns null only when no platform key is configured at all. This
// hardens the autonomous build path against the audit's "single key / no breaker / model-only
// failover" findings — without touching the shared chat/image gateway.

import {
  NVIDIA_API_KEYS,
  NVIDIA_TEXT_MODEL,
  OPENROUTER_API_KEYS,
  STUDIO_REQUEST_TIMEOUT_MS
} from '../config.js';
import { runChat } from '../ai/chat.js';
import { pickCodingModel, TEXT_FALLBACK } from '../ai/autoRouter.js';
import { KeyPool } from '../ai/reliability/keyPool.js';
import { CircuitBreaker } from '../ai/reliability/circuitBreaker.js';
import { incr } from '../observability/metrics.js';
import type { AIProviderId } from '../ai/providers/types.js';

// Module-level pools + breakers (shared across ticks in the worker process).
const pools: Record<AIProviderId, KeyPool> = {
  openrouter: new KeyPool(OPENROUTER_API_KEYS),
  nvidia: new KeyPool(NVIDIA_API_KEYS)
};
const breakers: Record<AIProviderId, CircuitBreaker> = {
  openrouter: new CircuitBreaker({ failureThreshold: 4, cooldownMs: 30_000 }),
  nvidia: new CircuitBreaker({ failureThreshold: 4, cooldownMs: 30_000 })
};

const isRateLimit = (e: unknown): boolean => /429|rate.?limit|quota|too many requests/i.test((e as Error)?.message || '');

export interface PlatformComplete {
  complete: (prompt: string) => Promise<string>;
}

/** A resilient platform-key `complete(prompt)`, or null if no platform key is configured. */
export const getPlatformComplete = async (maxTokens = 4000): Promise<PlatformComplete | null> => {
  const candidates: AIProviderId[] = [];
  if (pools.openrouter.size > 0) candidates.push('openrouter');
  if (pools.nvidia.size > 0) candidates.push('nvidia');
  if (candidates.length === 0) return null;

  // Resolve a model per provider once. OpenRouter picks the strongest available coder; NVIDIA
  // uses its configured default (a pooled openrouter model id wouldn't be valid on NVIDIA).
  const orModel = await pickCodingModel().catch(() => TEXT_FALLBACK);
  const models: Record<AIProviderId, string> = { openrouter: orModel, nvidia: NVIDIA_TEXT_MODEL };

  const complete = async (prompt: string): Promise<string> => {
    let lastErr: unknown = new Error('No model provider available for the build.');
    for (const provider of candidates) {
      const pool = pools[provider];
      const breaker = breakers[provider];
      if (!breaker.canRequest()) continue; // provider is tripped open — skip to the next
      for (let attempt = 0; attempt < Math.max(1, pool.size); attempt++) {
        const key = pool.next();
        if (!key) break; // every key for this provider is cooling down
        incr('ai_request', { provider });
        try {
          const r = await runChat({
            provider,
            apiKey: key,
            model: models[provider],
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.4,
            maxTokens,
            fallbackModel: provider === 'openrouter' ? TEXT_FALLBACK : undefined,
            timeoutMs: STUDIO_REQUEST_TIMEOUT_MS
          });
          breaker.onSuccess();
          incr('ai_success', { provider });
          return r.text;
        } catch (e) {
          lastErr = e;
          if (isRateLimit(e)) {
            incr('ai_rate_limited', { provider });
            pool.markRateLimited(key); // bench this key, try the next key
            continue;
          }
          incr('ai_error', { provider });
          breaker.onFailure(); // real provider trouble — stop hammering it, fail over
          break;
        }
      }
    }
    throw lastErr;
  };

  return { complete };
};
