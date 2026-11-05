import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBackendWake, resetBackendWakeForTests, subscribeBackendWake, trackBackendWake, WAKE_HINT_AFTER_MS } from './backendWake';

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Let the probe's .then callbacks run. */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('backendWake: the boot status probe, read as "is the server still starting?"', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetBackendWakeForTests();
  });
  afterEach(() => {
    resetBackendWakeForTests();
    vi.useRealTimers();
  });

  it('is idle until a probe is tracked (a share link sends none)', () => {
    expect(getBackendWake()).toBe('idle');
  });

  it('a warm server answers before the hint threshold: checking → settled, never slow', async () => {
    const probe = deferred<{ status: string }>();
    trackBackendWake(probe.promise);
    expect(getBackendWake()).toBe('checking');
    vi.advanceTimersByTime(WAKE_HINT_AFTER_MS - 1);
    probe.resolve({ status: 'ok' });
    await flush();
    expect(getBackendWake()).toBe('settled');
    vi.advanceTimersByTime(WAKE_HINT_AFTER_MS * 4);
    expect(getBackendWake()).toBe('settled');
  });

  it('a cold container: slow after the threshold, settled once it answers', async () => {
    const probe = deferred<{ status: string }>();
    trackBackendWake(probe.promise);
    vi.advanceTimersByTime(WAKE_HINT_AFTER_MS);
    expect(getBackendWake()).toBe('slow');
    probe.resolve({ status: 'ok' });
    await flush();
    expect(getBackendWake()).toBe('settled');
  });

  it('an error answer or a rejection settles it too (the hint never reports an outage)', async () => {
    const failed = deferred<{ status: string }>();
    trackBackendWake(failed.promise);
    vi.advanceTimersByTime(WAKE_HINT_AFTER_MS);
    failed.resolve({ status: 'error' });
    await flush();
    expect(getBackendWake()).toBe('settled');

    resetBackendWakeForTests();
    const rejected = deferred<unknown>();
    const tracked = trackBackendWake(rejected.promise);
    tracked.catch(() => undefined);
    rejected.reject(new Error('offline'));
    await flush();
    expect(getBackendWake()).toBe('settled');
  });

  it('returns the very same promise, so the caller’s own .then / .catch are unchanged', () => {
    const probe = deferred<number>();
    expect(trackBackendWake(probe.promise)).toBe(probe.promise);
  });

  it('adds no unhandled rejection of its own', async () => {
    vi.useRealTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const probe = deferred<unknown>();
      trackBackendWake(probe.promise).catch(() => undefined);
      probe.reject(new Error('boom'));
      await flush();
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a newer probe replaces an older one: only the latest settles the state', async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    trackBackendWake(first.promise);
    trackBackendWake(second.promise);
    first.resolve(1);
    await flush();
    expect(getBackendWake()).toBe('checking');
    vi.advanceTimersByTime(WAKE_HINT_AFTER_MS);
    expect(getBackendWake()).toBe('slow');
    second.resolve(2);
    await flush();
    expect(getBackendWake()).toBe('settled');
  });

  it('notifies subscribers on each change, and stops after unsubscribe', async () => {
    const seen: string[] = [];
    const off = subscribeBackendWake(() => seen.push(getBackendWake()));
    const probe = deferred<number>();
    trackBackendWake(probe.promise, { slowAfterMs: 10 });
    vi.advanceTimersByTime(10);
    probe.resolve(1);
    await flush();
    expect(seen).toEqual(['checking', 'slow', 'settled']);
    off();
    trackBackendWake(deferred<number>().promise);
    expect(seen).toHaveLength(3);
  });

  it('sends nothing itself: no fetch, only the one timer', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    trackBackendWake(deferred<number>().promise);
    vi.advanceTimersByTime(WAKE_HINT_AFTER_MS * 10);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    fetchSpy.mockRestore();
  });
});
