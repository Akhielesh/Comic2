// Reactive circuit breaker for the SHARED platform OpenRouter key.
//
// WHY: production telemetry showed the shared key hitting its spend cap ("403 Key limit
// exceeded (total limit)"). The default chat chains are all PAID models that draw that
// key, so once it's capped EVERY turn failed — a total outage surfaced as raw errors.
//
// This learns from the first cap: when a shared-key call returns a capacity error
// (403 spend-cap / 402 credits), we open the breaker for a cooldown. While it's open the
// chat router biases to FREE models (which cost $0 and keep working even when the key's
// paid budget is exhausted) instead of hammering the capped key. It self-heals when the
// cooldown expires (and re-trips immediately if the cap is still in force).
//
// CRITICAL: this is scoped to the PLATFORM key only. BYOK requests use the user's own key
// (which has its own, independent limits) and must NEVER be downgraded by a platform-key
// cap — callers gate on `ctx.byok === false` before tripping, and on the same condition
// before consulting the breaker.

const DEFAULT_COOLDOWN_MS = 30 * 60_000; // 30 min: long enough to stop hammering, short enough to recover

const cooldownMs = (): number => {
  const raw = Number(process.env.SHARED_KEY_COOLDOWN_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_COOLDOWN_MS;
};

let sharedKeyCappedUntil = 0;

/** Open the breaker for the platform key after a capacity error (spend-cap / out-of-credits). */
export const markSharedKeyCapped = (ttlMs = cooldownMs()): void => {
  sharedKeyCappedUntil = Date.now() + ttlMs;
};

/** True while the platform key is in its post-cap cooldown — route platform chat to free models. */
export const isSharedKeyCapped = (): boolean => Date.now() < sharedKeyCappedUntil;

/** Seconds remaining in the cooldown (0 when closed) — for ops/telemetry. */
export const sharedKeyCappedForMs = (): number => Math.max(0, sharedKeyCappedUntil - Date.now());

/** Test hook. */
export const __resetSharedKeyCircuit = (): void => {
  sharedKeyCappedUntil = 0;
};
