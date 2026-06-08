import { describe, it, expect } from 'vitest';
import { InMemoryRateLimitStore, computeWindow } from './rateLimitStore.js';

describe('computeWindow', () => {
  it('aligns windows to the epoch', () => {
    expect(computeWindow(0, 1000)).toEqual({ index: 0, resetAt: 1000 });
    expect(computeWindow(1500, 1000)).toEqual({ index: 1, resetAt: 2000 });
    expect(computeWindow(1999, 1000)).toEqual({ index: 1, resetAt: 2000 });
  });
});

describe('InMemoryRateLimitStore', () => {
  it('increments within a window and resets after it', async () => {
    let t = 0;
    const s = new InMemoryRateLimitStore(() => t);
    expect((await s.hit('k', 1000)).count).toBe(1);
    expect((await s.hit('k', 1000)).count).toBe(2);
    const third = await s.hit('k', 1000);
    expect(third.count).toBe(3);
    expect(third.resetAt).toBe(1000);
    t = 1000; // window elapsed
    expect((await s.hit('k', 1000)).count).toBe(1);
  });

  it('keeps separate counts per key', async () => {
    const s = new InMemoryRateLimitStore(() => 0);
    await s.hit('a', 1000);
    await s.hit('a', 1000);
    expect((await s.hit('b', 1000)).count).toBe(1);
  });

  it('reports the in-memory kind', () => {
    expect(new InMemoryRateLimitStore().kind).toBe('memory');
  });
});
