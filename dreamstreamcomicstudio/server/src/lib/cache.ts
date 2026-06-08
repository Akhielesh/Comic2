// Tiny in-process TTL cache. Dependency-free (no Redis required) — coalesces
// repeated expensive reads (dashboards, catalogs, aggregations) within a short
// window to cut latency and downstream cost. Per-process, so it's a best-effort
// speedup, not a correctness mechanism; values must tolerate being slightly stale.

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T = unknown> {
  private store = new Map<string, Entry<T>>();
  private inflight = new Map<string, Promise<T>>();

  constructor(private defaultTtlMs = 30_000, private maxEntries = 500) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs = this.defaultTtlMs): void {
    // Cheap LRU-ish bound: evict the oldest-inserted key when full.
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  /**
   * Return a cached value or compute it. Concurrent callers for the same key share
   * a single in-flight computation (request coalescing), so a burst of identical
   * requests triggers the expensive work once. Failures are not cached.
   */
  async getOrSet(key: string, compute: () => Promise<T>, ttlMs = this.defaultTtlMs): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const value = await compute();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }
}
