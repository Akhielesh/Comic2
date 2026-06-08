import { describe, it, expect, afterEach } from 'vitest';
import { runOnce, _clearIdempotency } from './idempotency.js';

afterEach(() => _clearIdempotency());

describe('runOnce', () => {
  it('runs the fn once for concurrent calls with the same key', async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return 'result';
    };
    const [a, b] = await Promise.all([runOnce('k', 1000, fn), runOnce('k', 1000, fn)]);
    expect(calls).toBe(1);
    expect(a).toBe('result');
    expect(b).toBe('result');
  });

  it('runs again once the TTL has elapsed', async () => {
    let t = 0;
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return calls;
    };
    await runOnce('k', 1000, fn, () => t);
    t = 1001;
    await runOnce('k', 1000, fn, () => t);
    expect(calls).toBe(2);
  });

  it('uses separate keys independently', async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return calls;
    };
    await runOnce('a', 1000, fn);
    await runOnce('b', 1000, fn);
    expect(calls).toBe(2);
  });

  it('evicts a rejected run so it can be retried', async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      throw new Error('boom');
    };
    await expect(runOnce('k', 1000, fn)).rejects.toThrow('boom');
    await expect(runOnce('k', 1000, fn)).rejects.toThrow('boom');
    expect(calls).toBe(2); // not cached after failure
  });
});
