/**
 * Request/reply over the monitor socket: `{t:'q', id, q, …}` → `{t:'r', id, …}`.
 * Resolves null on timeout or a dropped socket — callers show "couldn't load".
 */

export class MonQuery {
  private n = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; timer: number }>();

  constructor(private send: (msg: Record<string, unknown>) => void) {}

  ask<T>(q: string, args: Record<string, unknown> = {}, timeoutMs = 12_000): Promise<T | null> {
    const id = `q${++this.n}`;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, timer });
      this.send({ t: 'q', id, q, ...args });
    });
  }

  /** Feed `{t:'r'}` messages here. */
  handle(m: { id: string }): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    window.clearTimeout(p.timer);
    this.pending.delete(m.id);
    p.resolve(m);
  }

  cancelAll(): void {
    for (const p of this.pending.values()) {
      window.clearTimeout(p.timer);
      p.resolve(null);
    }
    this.pending.clear();
  }
}
