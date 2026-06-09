import { describe, it, expect, vi } from 'vitest';
import { withRetry, backoffDelay } from './retry';

const noSleep = async () => {};

describe('withRetry', () => {
  it('returns immediately on success without retrying', async () => {
    const fn = vi.fn(async () => 'ok');
    const out = await withRetry(fn, () => true, { attempts: 3 }, noSleep);
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure then succeeds', async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n < 3) throw { status: 0 };
      return 'recovered';
    });
    const out = await withRetry(fn, () => true, { attempts: 3 }, noSleep);
    expect(out).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops immediately when shouldRetry returns false', async () => {
    const fn = vi.fn(async () => { throw { status: 401 }; });
    await expect(withRetry(fn, () => false, { attempts: 5 }, noSleep)).rejects.toEqual({ status: 401 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws the last error after exhausting all attempts', async () => {
    const fn = vi.fn(async () => { throw new Error('still down'); });
    await expect(withRetry(fn, () => true, { attempts: 3 }, noSleep)).rejects.toThrow('still down');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('treats attempts < 1 as a single try', async () => {
    const fn = vi.fn(async () => { throw new Error('x'); });
    await expect(withRetry(fn, () => true, { attempts: 0 }, noSleep)).rejects.toThrow('x');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('waits between tries (sleep is called once per retry, not after the last)', async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => { throw { status: 503 }; });
    await expect(withRetry(fn, () => true, { attempts: 3 }, sleep)).rejects.toBeDefined();
    expect(sleep).toHaveBeenCalledTimes(2); // between try1→2 and try2→3, not after the final failure
  });
});

describe('backoffDelay', () => {
  it('grows exponentially from the base and is capped at max', () => {
    const fixed = () => 1; // top of the jitter window → equals the full window
    expect(backoffDelay(0, 400, 4000, fixed)).toBe(400);
    expect(backoffDelay(1, 400, 4000, fixed)).toBe(800);
    expect(backoffDelay(2, 400, 4000, fixed)).toBe(1600);
    expect(backoffDelay(5, 400, 4000, fixed)).toBe(4000); // capped
  });

  it('applies jitter within 50–100% of the window', () => {
    expect(backoffDelay(1, 400, 4000, () => 0)).toBe(400); // 50% of 800
    expect(backoffDelay(1, 400, 4000, () => 1)).toBe(800); // 100% of 800
  });
});
