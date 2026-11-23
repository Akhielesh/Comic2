// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationQueue } from './generationCapacity.js';

const latch = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
afterEach(() => vi.useRealTimers());

describe('per-instance creator-fair generation admission', () => {
  it('draws a page for each of 100 simultaneous creators with a 35-second provider and six slots', async () => {
    vi.useFakeTimers();
    const queue = new GenerationQueue(6, 3);
    let active = 0;
    let peak = 0;
    const started = Date.now();
    const work = Array.from({ length: 100 }, (_, owner) => queue.run(String(owner), undefined, async () => {
      peak = Math.max(peak, ++active);
      await new Promise(r => setTimeout(r, 35_000));
      active--;
      return owner;
    }));
    const finished = Promise.all(work);
    await vi.advanceTimersByTimeAsync(17 * 35_000);
    expect(new Set(await finished).size).toBe(100);
    expect(Date.now() - started).toBe(595_000);
    expect(peak).toBe(6);
  });

  it('rotates among waiting accounts in FIFO order even when an active creator has several projects', async () => {
    const queue = new GenerationQueue(1, 1);
    const gate = latch();
    const running = queue.run('a', undefined, () => gate.promise);
    const order: string[] = [];
    const work = ['a1', 'a2', 'b1', 'b2', 'c1'].map(label => queue.run(label[0], undefined, async () => { order.push(label); }));
    gate.release();
    await Promise.all([running, ...work]);
    expect(order).toEqual(['a1', 'b1', 'c1', 'a2', 'b2']);
  });

  it('keeps other accounts running when one creator hits their parallel ceiling', async () => {
    const queue = new GenerationQueue(3, 1);
    const gate = latch();
    const running = queue.run('a', undefined, () => gate.promise);
    const second = vi.fn(async () => {});
    const waiting = queue.run('a', undefined, second);
    await queue.run('b', undefined, async () => {});
    expect(second).not.toHaveBeenCalled();
    gate.release();
    await Promise.all([running, waiting]);
    expect(second).toHaveBeenCalledOnce();
  });

  it('keeps headroom for actual personal keys when shared upstream slots are saturated', async () => {
    const queue = new GenerationQueue(3, 1, { platformSlots: 2 });
    const gate = latch();
    const busy = ['a', 'b'].map(id => queue.run(id, undefined, () => gate.promise));
    const platform = vi.fn(async () => {});
    const third = queue.run('c', undefined, platform);
    await queue.run('d', undefined, async () => {}, { ownKey: true });
    expect(platform).not.toHaveBeenCalled();
    gate.release();
    await Promise.all([...busy, third]);
    expect(platform).toHaveBeenCalledOnce();
  });

  it('bounded queue, per-account cap, timeout and Stop all refuse before reserving allowance', async () => {
    vi.useFakeTimers();
    const queue = new GenerationQueue(1, 1, { maxWaiting: 2, maxCreatorWaiting: 1, maxBytes: 10 });
    const gate = latch();
    const running = queue.run('a', undefined, () => gate.promise);
    const operation = vi.fn(async () => {});
    const ctl = new AbortController();
    const one = queue.run('b', ctl.signal, operation, { bytes: 5 });
    await expect(queue.run('b', undefined, operation)).rejects.toMatchObject({ status: 429 });
    await expect(queue.run('c', undefined, operation, { bytes: 6 })).rejects.toMatchObject({ status: 429 });
    const expiring = expect(queue.run('c', undefined, operation, { bytes: 5, waitMs: 45_000 })).rejects.toMatchObject({ status: 429, retryable: true });
    await expect(queue.run('d', undefined, operation)).rejects.toMatchObject({ status: 429 });
    ctl.abort();
    await expect(one).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(45_000);
    await expiring;
    expect(operation).not.toHaveBeenCalled();
    const next = queue.run('d', undefined, operation, { bytes: 10 });
    gate.release();
    await Promise.all([running, next]);
    expect(operation).toHaveBeenCalledOnce();
  });
});
