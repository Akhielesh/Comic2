// useModelStatus + useAutoRetry (reliability.md §3/§5): no polling while everything is ok; one re-check per
// 60 s only while something is wrong AND the tab is visible; stops when hidden, ok, or after 30 min; an armed
// "wait and retry" re-sends its blocked action exactly once when the model reads ok (never on unsteady or "no
// data"), never while hidden, and keeps checking while it waits.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthState, ModelHealth } from '../../../shared/comic/modelHealth';
import type { StudioAction } from '../../../shared/comic/ops';
import type { StudioActOutcome } from '../types';
import { __resetRetries, armRetry, getRetry } from './retryIntents';
import { __resetStatusStore, __setStatusFetcherForTests, incidentSince, loadStatus, putStatus } from './statusStore';
import { STATUS_POLL_MAX_MS, STATUS_POLL_MS, isBack, useAutoRetry, useModelStatus } from './useModelStatus';

const NB21 = 'nano-banana-2.1';
const OR_MODEL = 'google/gemini-nano-banana-2.1';

const healthOf = (modelId: string, state: HealthState, at = Date.now()): ModelHealth => ({
  modelId,
  state,
  checkedAt: at,
  routes: [{ route: 'openrouter', model: OR_MODEL, state, checkedAt: at, source: state === 'unknown' ? 'none' : 'openrouter' }]
});

let states: Record<string, HealthState>;
const answerFromStates = async (ids: readonly string[]) => ids.map((id) => healthOf(id, states[id] ?? 'ok'));
const fetcher = vi.fn(answerFromStates);

let visibility: DocumentVisibilityState = 'visible';
const setVisibility = (v: DocumentVisibilityState) => {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T16:52:00Z'));
  states = {};
  fetcher.mockReset();
  fetcher.mockImplementation(answerFromStates);
  __resetStatusStore();
  __resetRetries();
  __setStatusFetcherForTests(fetcher);
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterEach(() => {
  __setStatusFetcherForTests(null);
  vi.useRealTimers();
});

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('useModelStatus', () => {
  it('asks once and never polls while every watched model is ok (1 h of fake time → 1 request)', async () => {
    states = { [NB21]: 'ok' };
    const { result } = renderHook(() => useModelStatus([NB21]));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.byId[NB21]?.state).toBe('ok');
    expect(result.current.watching).toBe(false);
    await flush(60 * 60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('unknown never polls either (no data is not an incident)', async () => {
    states = { [NB21]: 'unknown' };
    renderHook(() => useModelStatus([NB21]));
    await flush(10 * 60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('re-checks every 60 s while down and visible, and stops as soon as the model is ok', async () => {
    states = { [NB21]: 'down' };
    const { result } = renderHook(() => useModelStatus([NB21]));
    await flush();
    expect(result.current.worst?.state).toBe('down');
    expect(result.current.watching).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await flush(STATUS_POLL_MS - 1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await flush(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await flush(STATUS_POLL_MS);
    expect(fetcher).toHaveBeenCalledTimes(3);
    states = { [NB21]: 'ok' };
    await flush(STATUS_POLL_MS);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(result.current.byId[NB21]?.state).toBe('ok');
    expect(result.current.watching).toBe(false);
    await flush(30 * 60_000);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('stops while the tab is hidden, re-checks once on return, and gives up after 30 min until refreshed', async () => {
    states = { [NB21]: 'degraded' };
    const { result } = renderHook(() => useModelStatus([NB21]));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    act(() => setVisibility('hidden'));
    await flush(10 * STATUS_POLL_MS);
    expect(fetcher).toHaveBeenCalledTimes(1); // nothing while hidden
    expect(result.current.watching).toBe(false);
    act(() => setVisibility('visible'));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2); // one look on return
    await flush(STATUS_POLL_MAX_MS);
    const calls = fetcher.mock.calls.length;
    expect(result.current.expired).toBe(true);
    expect(result.current.watching).toBe(false);
    await flush(30 * 60_000);
    expect(fetcher).toHaveBeenCalledTimes(calls); // stopped for good
    act(() => result.current.refresh());
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(calls + 1);
    expect(result.current.expired).toBe(false);
    expect(result.current.watching).toBe(true);
  });

  it('the incident is seen since the earliest server evidence, never later than this page’s first look', async () => {
    const now = Date.now();
    const failedAt = now - 38 * 60_000;
    putStatus([
      { modelId: NB21, state: 'down', checkedAt: now, routes: [{ route: 'openrouter', model: OR_MODEL, state: 'down', observed: { ok: 0, upstreamFailures: 3, lastCode: 'RATE_LIMIT', lastFailureAt: failedAt }, checkedAt: failedAt, source: 'observed' }] }
    ]);
    expect(incidentSince(NB21)).toBe(failedAt);
    // A later read with a newer failure keeps the earliest evidence; a server clock ahead of ours never moves it later.
    putStatus([{ modelId: NB21, state: 'down', checkedAt: now, routes: [{ route: 'openrouter', model: OR_MODEL, state: 'down', observed: { ok: 0, upstreamFailures: 4, lastFailureAt: now + 60_000 }, checkedAt: now, source: 'observed' }] }], now + 1000);
    expect(incidentSince(NB21)).toBe(failedAt);
  });

  it('shares one request between components and remembers when the incident started', async () => {
    states = { [NB21]: 'down' };
    renderHook(() => useModelStatus([NB21]));
    renderHook(() => useModelStatus([NB21, NB21]));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const since = incidentSince(NB21);
    expect(since).toBe(Date.now());
    await flush(STATUS_POLL_MS);
    expect(incidentSince(NB21)).toBe(since); // the same incident
    states = { [NB21]: 'ok' };
    await flush(STATUS_POLL_MS);
    expect(incidentSince(NB21)).toBeUndefined();
  });

  it('keeps the old answer and reports the error when a request fails', async () => {
    putStatus([healthOf(NB21, 'down')], Date.now() - 60_000);
    fetcher.mockRejectedValueOnce(new Error('offline'));
    await loadStatus([NB21]);
    const { result } = renderHook(() => useModelStatus([NB21]));
    expect(result.current.byId[NB21]?.state).toBe('down');
    expect(result.current.error).toBe('offline');
  });
});

describe('useAutoRetry (wait and retry automatically)', () => {
  const action: StudioAction = { type: 'render_style_options', quotedUsd: 0.12 };

  it('isBack: only ok (unsteady may be a half-open probe; unknown is no data)', () => {
    expect(isBack('ok')).toBe(true);
    expect(isBack('degraded')).toBe(false);
    expect(isBack('unknown')).toBe(false);
    expect(isBack('down')).toBe(false);
    expect(isBack(undefined)).toBe(false);
  });

  it('never fires on an unsteady or "no data" read; keeps checking every 60 s while it waits, even when a check fails', async () => {
    states = { [NB21]: 'down' };
    const send = vi.fn(async () => undefined);
    renderHook(() => useAutoRetry({ act: send }));
    await flush();
    act(() => void armRetry('card_5', NB21, action));
    states = { [NB21]: 'degraded' };
    await flush(STATUS_POLL_MS);
    states = { [NB21]: 'unknown' };
    await flush(STATUS_POLL_MS);
    expect(send).not.toHaveBeenCalled();
    const calls = fetcher.mock.calls.length;
    fetcher.mockRejectedValueOnce(new Error('offline'));
    await flush(STATUS_POLL_MS);
    await flush(STATUS_POLL_MS); // unknown + a failed check: still re-checking (no silent hang)
    expect(fetcher.mock.calls.length).toBe(calls + 2);
    states = { [NB21]: 'ok' };
    await flush(STATUS_POLL_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(getRetry('card_5')?.state).toBe('sent');
  });

  it('a waiting intent re-checks for at most 30 min, and two runners make one request per check', async () => {
    states = { [NB21]: 'unknown' };
    renderHook(() => useAutoRetry({ act: vi.fn(async () => undefined) }));
    const { result } = renderHook(() => useAutoRetry({ act: vi.fn(async () => undefined) }));
    await flush();
    act(() => void armRetry('card_6', NB21, action));
    await flush();
    const start = fetcher.mock.calls.length;
    fetcher.mockRejectedValue(new Error('offline'));
    await flush(5 * STATUS_POLL_MS);
    expect(fetcher.mock.calls.length - start).toBe(5); // two pollers, one request a minute (even while failing)
    fetcher.mockImplementation(answerFromStates);
    expect(result.current.watching).toBe(true);
    await flush(STATUS_POLL_MAX_MS);
    expect(result.current.expired).toBe(true);
    const calls = fetcher.mock.calls.length;
    await flush(10 * STATUS_POLL_MS);
    expect(fetcher.mock.calls.length).toBe(calls);
  });

  it('re-sends the blocked action exactly once when the model is back (two runners mounted)', async () => {
    states = { [NB21]: 'down' };
    const act1 = vi.fn(async (_a: StudioAction) => ({ ok: true, aborted: false, gated: false }) as unknown as StudioActOutcome);
    const act2 = vi.fn(async () => undefined);
    renderHook(() => useAutoRetry({ act: act1 }));
    renderHook(() => useAutoRetry({ act: act2 }));
    await flush();
    act(() => void armRetry('card_1', NB21, action));
    await flush(STATUS_POLL_MS);
    expect(act1).not.toHaveBeenCalled();
    expect(act2).not.toHaveBeenCalled();
    states = { [NB21]: 'ok' };
    await flush(STATUS_POLL_MS);
    expect(act1.mock.calls.length + act2.mock.calls.length).toBe(1);
    expect(getRetry('card_1')?.state).toBe('sent');
    await flush(10 * STATUS_POLL_MS);
    expect(act1.mock.calls.length + act2.mock.calls.length).toBe(1);
  });

  it('never fires while the tab is hidden; fires on return once the model is back', async () => {
    states = { [NB21]: 'down' };
    const send = vi.fn(async () => undefined);
    renderHook(() => useAutoRetry({ act: send }));
    await flush();
    act(() => void armRetry('card_2', NB21, action));
    act(() => setVisibility('hidden'));
    states = { [NB21]: 'ok' };
    // Even a fresh "ok" arriving while hidden (another tab, a manual load) does not send.
    await act(async () => {
      await loadStatus([NB21], { maxAgeMs: 0 });
    });
    await flush(10 * STATUS_POLL_MS);
    expect(send).not.toHaveBeenCalled();
    expect(getRetry('card_2')?.state).toBe('waiting');
    act(() => setVisibility('visible'));
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(action);
  });

  it('an answer older than the click never fires it (the model must be seen back after arming)', async () => {
    putStatus([healthOf(NB21, 'ok')], Date.now());
    const send = vi.fn(async () => undefined);
    renderHook(() => useAutoRetry({ act: send }));
    vi.setSystemTime(Date.now() + 1000);
    act(() => void armRetry('card_3', NB21, action));
    await flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('a refused send is recorded as failed (the card offers to try again)', async () => {
    states = { [NB21]: 'down' };
    const send = vi.fn(async (_a: StudioAction) => ({ ok: false, aborted: false, gated: false }) as unknown as StudioActOutcome);
    renderHook(() => useAutoRetry({ act: send }));
    await flush();
    act(() => void armRetry('card_4', NB21, action));
    await flush(); // the runner's first look: still down
    states = { [NB21]: 'ok' };
    await flush(STATUS_POLL_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(getRetry('card_4')?.state).toBe('failed');
  });
});
