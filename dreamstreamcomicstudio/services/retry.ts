// Small, dependency-free retry helper for transient failures — a network blip, or a backend
// waking from cold start (the #1 cause of the studio "Couldn't reach the AI server" error on a
// sleepy host). Pure + injectable sleep so it's unit-testable without real timers or fetch.

export interface RetryOptions {
  /** Total attempts INCLUDING the first try (default 3). */
  attempts?: number;
  /** Base backoff in ms (default 400). */
  baseDelayMs?: number;
  /** Max backoff in ms (default 4000). */
  maxDelayMs?: number;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_MS = 400;
const DEFAULT_MAX_MS = 4000;

/**
 * Exponential backoff with jitter for retry index `i` (0-based). Grows 2^i from the base, capped
 * at max, then takes 50–100% of that window so parallel clients don't retry in lockstep. `rand`
 * is injectable for deterministic tests.
 */
export const backoffDelay = (
  i: number,
  baseDelayMs = DEFAULT_BASE_MS,
  maxDelayMs = DEFAULT_MAX_MS,
  rand: () => number = Math.random
): number => {
  const window = Math.min(maxDelayMs, baseDelayMs * 2 ** i);
  return Math.round(window * (0.5 + rand() * 0.5));
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying while `shouldRetry(err)` is true, up to `attempts` total, backing off between
 * tries. Re-throws the last error when retries are exhausted or `shouldRetry` returns false. `sleep`
 * is injectable so tests run instantly. The attempt index is passed to `fn` for logging/telemetry.
 */
export const withRetry = async <T>(
  fn: (attempt: number) => Promise<T>,
  shouldRetry: (err: unknown) => boolean,
  opts: RetryOptions = {},
  sleep: (ms: number) => Promise<void> = realSleep
): Promise<T> => {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !shouldRetry(err)) throw err;
      await sleep(backoffDelay(i, opts.baseDelayMs, opts.maxDelayMs));
    }
  }
  throw lastErr; // unreachable (loop either returns or throws), but keeps the type checker happy
};
