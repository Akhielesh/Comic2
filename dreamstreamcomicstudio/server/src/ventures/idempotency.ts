// Lightweight idempotency for expensive ventures mutations (Epic F2). De-dupes concurrent or
// rapidly-repeated identical requests (e.g. a double-clicked "Draft a venture" that would
// otherwise create two ventures + spend on two roadmaps) by returning the SAME in-flight/recent
// promise for a key. In-process + TTL'd (per-process is fine for the low-volume, admin-gated
// intake path; a Redis-backed version can follow). A rejected run is evicted so it can be retried.

interface Entry {
  at: number;
  promise: Promise<unknown>;
}

const store = new Map<string, Entry>();

/** Run `fn` once per `key` within `ttlMs`; concurrent/recent calls share the same result. */
export const runOnce = async <T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  now: () => number = Date.now
): Promise<T> => {
  const t = now();
  for (const [k, e] of store) if (t - e.at > ttlMs) store.delete(k); // opportunistic cleanup

  const existing = store.get(key);
  if (existing && t - existing.at <= ttlMs) return existing.promise as Promise<T>;

  const promise = fn();
  store.set(key, { at: t, promise });
  // Evict on failure so a transient error doesn't poison the key for the whole TTL.
  promise.catch(() => {
    if (store.get(key)?.promise === promise) store.delete(key);
  });
  return promise;
};

/** Test/maintenance helper. */
export const _clearIdempotency = (): void => store.clear();
