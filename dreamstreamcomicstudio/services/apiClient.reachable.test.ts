// @vitest-environment jsdom
// DS-R1 #12: the real safeFetch ends useOnline's "unreachable" hold as soon as any request gets an answer, whatever
// its status (a 503 still proves the server is there). Without it, one cold-start "Couldn't reach the server" keeps
// every content-kit screen offline for UNREACHABLE_HOLD_MS. components/ds/useOnline.test.ts pins the store itself.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: () => undefined } } })),
      getSession: vi.fn(async () => ({ data: { session: null } }))
    }
  },
  isStoredSession: () => true
}));

import { __resetAppStatus } from './appStatus';
import { __resetOnlineStore, useConnectivity } from '../components/ds/useOnline';
import { get } from './apiClient';

beforeEach(() => {
  __resetAppStatus();
  __resetOnlineStore();
});
afterEach(() => {
  __resetOnlineStore();
  __resetAppStatus();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('apiClient safeFetch → useOnline', () => {
  it('a request that never arrives holds "unreachable"; the next one that gets any answer ends the hold at once', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'busy' }), { status: 503, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    // A mounted screen is what makes useOnline listen to the app's network signal.
    const { result } = renderHook(() => useConnectivity());

    await act(async () => {
      await expect(get('/api/x')).rejects.toThrow();
    });
    expect(result.current).toEqual({ online: false, reason: 'unreachable' });

    // The server answers with an error status: still an answer, so connectivity is back now, not in 30 s.
    await act(async () => {
      await expect(get('/api/x')).rejects.toThrow();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ online: true, reason: null });
  });
});
