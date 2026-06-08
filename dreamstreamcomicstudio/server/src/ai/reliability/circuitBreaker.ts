// Circuit breaker for an upstream (a provider, or a provider+model). Epic F1.
// Pure + deterministic (inject `now` for tests). Trips OPEN after `failureThreshold`
// consecutive failures and fails fast for `cooldownMs`; then HALF-OPEN lets one probe through —
// success closes it, failure re-opens. Stops the platform from eating full retry latency on a
// known-down upstream (the audit's "no circuit breaker" finding).

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: CircuitState = 'closed';
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitOptions = {}) {
    this.threshold = Math.max(1, opts.failureThreshold ?? 5);
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? 30_000);
    this.now = opts.now ?? Date.now;
  }

  /** Current state, lazily transitioning open → half-open once the cooldown elapses. */
  getState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half-open';
    }
    return this.state;
  }

  /** May a request go through right now? (False only while fully OPEN.) */
  canRequest(): boolean {
    return this.getState() !== 'open';
  }

  onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  onFailure(): void {
    // A failure during a half-open probe immediately re-opens.
    if (this.getState() === 'half-open') {
      this.trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.threshold) this.trip();
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = this.now();
    this.failures = 0;
  }
}
