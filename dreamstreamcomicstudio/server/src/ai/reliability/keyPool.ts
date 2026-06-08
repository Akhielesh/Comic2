// API-key pool with per-key rate-limit cooldown. Epic F1.
// Round-robins across N keys for a provider and skips any key that's in cooldown after a 429,
// so one rate-limited key no longer throttles the whole platform (the audit's "single key, no
// pool/rotation" finding). Pure + deterministic (inject `now` for tests).

export interface KeyPoolOptions {
  /** How long a key stays benched after a rate-limit (429). */
  cooldownMs?: number;
  now?: () => number;
}

export class KeyPool {
  private idx = 0;
  private readonly cooldownUntil = new Map<string, number>();
  private readonly keys: string[];
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(keys: string[], opts: KeyPoolOptions = {}) {
    // De-dupe + drop empties so a misconfigured env can't create phantom keys.
    this.keys = [...new Set(keys.filter((k) => k && k.trim()))];
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? 60_000);
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.keys.length;
  }

  /** How many keys are usable right now (not in cooldown). */
  available(): number {
    const t = this.now();
    return this.keys.filter((k) => (this.cooldownUntil.get(k) ?? 0) <= t).length;
  }

  /** Next usable key (round-robin, skipping cooled-down keys), or null if all are benched. */
  next(): string | null {
    const t = this.now();
    const n = this.keys.length;
    for (let i = 0; i < n; i++) {
      const pos = (this.idx + i) % n;
      const key = this.keys[pos];
      if ((this.cooldownUntil.get(key) ?? 0) <= t) {
        this.idx = (pos + 1) % n;
        return key;
      }
    }
    return null;
  }

  /** Bench a key after a 429 for the cooldown window. */
  markRateLimited(key: string): void {
    this.cooldownUntil.set(key, this.now() + this.cooldownMs);
  }
}
