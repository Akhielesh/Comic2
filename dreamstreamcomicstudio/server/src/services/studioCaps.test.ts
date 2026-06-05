import { describe, it, expect } from 'vitest';
import { evaluateLaunchAllowed } from './studioCaps.js';

const limits = { maxConcurrentPerUser: 2, dailyBuildMinutes: 120 };

describe('evaluateLaunchAllowed', () => {
  it('allows when under both caps', () => {
    expect(evaluateLaunchAllowed({ activeRuns: 1, dailyAwakeSeconds: 600 }, limits).allowed).toBe(true);
  });

  it('blocks at the concurrency cap', () => {
    const d = evaluateLaunchAllowed({ activeRuns: 2, dailyAwakeSeconds: 0 }, limits);
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('STUDIO_TOO_MANY_CONCURRENT');
  });

  it('blocks at the daily-minutes cap', () => {
    const d = evaluateLaunchAllowed({ activeRuns: 0, dailyAwakeSeconds: 120 * 60 }, limits);
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('STUDIO_DAILY_LIMIT');
  });

  it('concurrency takes precedence when both are exceeded', () => {
    const d = evaluateLaunchAllowed({ activeRuns: 5, dailyAwakeSeconds: 999999 }, limits);
    expect(d.code).toBe('STUDIO_TOO_MANY_CONCURRENT');
  });
});
