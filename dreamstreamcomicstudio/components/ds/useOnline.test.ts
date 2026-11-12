/**
 * useOnline (redesign plan §4, §8 "Offline"): the browser's online / offline events and an appStatus network event
 * (a request that never reached the server, services/apiClient.ts) both flip it; the "unreachable" hold ends on its
 * own after UNREACHABLE_HOLD_MS (one timer, armed only after a failure), on the next `online` event or when a caller
 * confirms the server answered. Other app errors never flip it. Nothing fetches.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAppStatus, appStatus } from '../../services/appStatus';
import { __resetOnlineStore, markReachable, readConnectivity, UNREACHABLE_HOLD_MS, useConnectivity, useOnline } from './useOnline';

const fire = (type: 'online' | 'offline') => act(() => void window.dispatchEvent(new Event(type)));
const networkFailure = () => act(() => appStatus.report('error', "Couldn't reach the server", { source: 'network', detail: 'TypeError · /api/x' }));

beforeEach(() => {
  __resetAppStatus();
  __resetOnlineStore();
});

afterEach(() => {
  __resetOnlineStore();
  __resetAppStatus();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useOnline', () => {
  it('follows the browser: offline → false, online → true', () => {
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(true);
    fire('offline');
    expect(result.current).toBe(false);
    fire('online');
    expect(result.current).toBe(true);
  });

  it('an appStatus network event flips it to unreachable, and the reason says which', () => {
    const { result } = renderHook(() => useConnectivity());
    expect(result.current).toEqual({ online: true, reason: null });
    networkFailure();
    expect(result.current).toEqual({ online: false, reason: 'unreachable' });
    fire('offline');
    expect(result.current).toEqual({ online: false, reason: 'offline' });
    fire('online');
    expect(result.current).toEqual({ online: true, reason: null });
  });

  it('the unreachable hold ends by itself after the hold time, and a repeat failure restarts it', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useOnline());
    networkFailure();
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(2000));
    // The same failure two seconds later is coalesced into the same status event (same id, newer time): still a
    // fresh failure, so the hold restarts from now.
    networkFailure();
    expect(appStatus.getSnapshot().events[0].count).toBe(2);
    act(() => vi.advanceTimersByTime(UNREACHABLE_HOLD_MS - 1));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('markReachable ends the hold at once; an online event does too', () => {
    const { result } = renderHook(() => useOnline());
    networkFailure();
    expect(result.current).toBe(false);
    act(() => markReachable());
    expect(result.current).toBe(true);
    networkFailure();
    fire('online');
    expect(result.current).toBe(true);
  });

  it('a later request that reaches the server ends the hold at once, whatever its status (the safeFetch wiring)', async () => {
    vi.useFakeTimers();
    // services/apiClient.ts's safeFetch as the DS-R1 wave note wires it: a fetch that resolves calls markReachable();
    // one that rejects (the request never arrived) reports the network failure, as it does today.
    const safeFetch = async (url: string): Promise<Response> => {
      try {
        const res = await fetch(url);
        markReachable();
        return res;
      } catch (err) {
        appStatus.report('error', "Couldn't reach the server", { source: 'network', detail: `${(err as Error).message} · ${url}` });
        throw err;
      }
    };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('busy', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useConnectivity());
    await act(async () => {
      await safeFetch('/api/comic/x').catch(() => undefined);
    });
    // A cold-start blip: unreachable, held for up to UNREACHABLE_HOLD_MS ...
    expect(result.current).toEqual({ online: false, reason: 'unreachable' });
    act(() => vi.advanceTimersByTime(1500));
    expect(result.current.online).toBe(false);
    // ... but the next request gets an answer (a 503 still proves the server is there): online now, not in 28.5 s.
    await act(async () => {
      await safeFetch('/api/comic/x');
    });
    expect(result.current).toEqual({ online: true, reason: null });
    expect(vi.getTimerCount()).toBe(0);
    vi.unstubAllGlobals();
  });

  it('other app errors (a window error, a failed image) never flip it', () => {
    const { result } = renderHook(() => useOnline());
    act(() => appStatus.report('error', 'Something broke', { source: 'window' }));
    act(() => appStatus.report('warn', 'Failed to load img', { source: 'resource' }));
    expect(result.current).toBe(true);
  });

  it('is one shared answer for every component, and sets no timer while idle', () => {
    vi.useFakeTimers();
    const a = renderHook(() => useOnline());
    const b = renderHook(() => useOnline());
    expect(vi.getTimerCount()).toBe(0);
    fire('offline');
    expect(a.result.current).toBe(false);
    expect(b.result.current).toBe(false);
    expect(readConnectivity().reason).toBe('offline');
    fire('online');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a network failure from just before anything listened still counts; an old one does not', () => {
    act(() => appStatus.report('error', "Couldn't reach the server", { source: 'network' }));
    const { result, unmount } = renderHook(() => useOnline());
    expect(result.current).toBe(false);
    unmount();
    __resetOnlineStore();
    __resetAppStatus();
    vi.useFakeTimers();
    act(() => appStatus.report('error', "Couldn't reach the server", { source: 'network' }));
    vi.setSystemTime(Date.now() + UNREACHABLE_HOLD_MS + 1);
    const later = renderHook(() => useOnline());
    expect(later.result.current).toBe(true);
  });
});
