// services/telemetry.ts (AV-0 #10): the client telemetry buffer. Best-effort and quiet by design: routine events
// wait for ONE 8 s one-shot flush, errors go at once, events inside the window share a POST, the queue keeps the
// newest 100, a failed POST is dropped (never retried), an empty queue never POSTs (the 8 s interval included), and
// page hide sends one sendBeacon only when something is queued. Fake timers; a fresh module (fresh queue) per test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('./apiClient', () => ({ post: mocks.post }));
vi.mock('./clientConfig', () => ({ buildApiUrl: (path: string) => `https://api.test${path}` }));

type Telemetry = typeof import('./telemetry');
const load = async (): Promise<Telemetry> => {
  vi.resetModules();
  return import('./telemetry');
};
/** The events of the n-th POST (0-based). */
const posted = (n: number) => (mocks.post.mock.calls[n][1] as { events: Array<{ message?: string; severity?: string }> }).events;
const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  mocks.post.mockReset();
  mocks.post.mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('services/telemetry', () => {
  it('an info or warn event schedules one 8 s one-shot flush, then nothing more', async () => {
    const t = await load();
    t.captureEvent({ eventType: 'log', severity: 'info', message: 'a' });
    expect(mocks.post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(7999);
    expect(mocks.post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0][0]).toBe('/api/telemetry/events');
    expect(posted(0).map((e) => e.message)).toEqual(['a']);
    t.captureEvent({ eventType: 'log', severity: 'warn', message: 'b' });
    await vi.advanceTimersByTimeAsync(8000);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(posted(1).map((e) => e.message)).toEqual(['b']);
    // One-shot: with nothing queued, no timer fires another POST.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it('an error or critical event flushes at once', async () => {
    const t = await load();
    t.captureEvent({ eventType: 'boom', severity: 'error', message: 'e1' });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    t.captureEvent({ eventType: 'boom', severity: 'critical', message: 'c1' });
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect([posted(0)[0].message, posted(1)[0].message]).toEqual(['e1', 'c1']);
  });

  it('two events inside the 8 s window share one POST', async () => {
    const t = await load();
    t.captureEvent({ eventType: 'log', severity: 'info', message: 'first' });
    await vi.advanceTimersByTimeAsync(3000);
    t.captureEvent({ eventType: 'log', severity: 'warn', message: 'second' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(posted(0).map((e) => e.message)).toEqual(['first', 'second']);
  });

  it('the queue is capped at 100 and keeps the newest (shipped 50 per POST)', async () => {
    const t = await load();
    for (let i = 1; i <= 105; i += 1) t.captureEvent({ eventType: 'log', severity: 'info', message: `m${i}` });
    await vi.advanceTimersByTimeAsync(8000);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(posted(0)).toHaveLength(50);
    expect(posted(0)[0].message).toBe('m6');
    // The rest drains on the next one-shot.
    await vi.advanceTimersByTimeAsync(8000);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(posted(1)).toHaveLength(50);
    expect(posted(1)[49].message).toBe('m105');
  });

  it('a failed POST drops its batch and never retries it', async () => {
    const t = await load();
    mocks.post.mockRejectedValueOnce(new Error('offline'));
    t.captureEvent({ eventType: 'boom', severity: 'error', message: 'lost' });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    // The next event goes out on its own, without the dropped one.
    t.captureEvent({ eventType: 'boom', severity: 'error', message: 'next' });
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(posted(1).map((e) => e.message)).toEqual(['next']);
  });

  it("with an empty queue, initTelemetry's 8 s interval never calls post", async () => {
    const t = await load();
    t.initTelemetry();
    await vi.advanceTimersByTimeAsync(80_000);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('page hide and a hidden tab send one sendBeacon only when something is queued', async () => {
    const realBeacon = navigator.sendBeacon;
    const realVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon });
    try {
      const t = await load();
      t.initTelemetry();
      window.dispatchEvent(new Event('pagehide'));
      expect(beacon).not.toHaveBeenCalled();

      t.captureEvent({ eventType: 'log', severity: 'info', message: 'queued' });
      window.dispatchEvent(new Event('pagehide'));
      expect(beacon).toHaveBeenCalledTimes(1);
      expect((beacon.mock.calls[0] as unknown as [string, Blob])[0]).toBe('https://api.test/api/telemetry/events');
      // The beacon took the queue: a second hide sends nothing, and the pending one-shot has nothing to POST.
      window.dispatchEvent(new Event('pagehide'));
      expect(beacon).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(8000);
      expect(mocks.post).not.toHaveBeenCalled();

      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(beacon).toHaveBeenCalledTimes(1);
      t.captureEvent({ eventType: 'log', severity: 'info', message: 'again' });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(beacon).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: realBeacon });
      if (realVisibility) Object.defineProperty(document, 'visibilityState', realVisibility);
      else delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    }
  });
});
