// useInsights + insightsApi (models.md §4.5 cadence rule, AT-8): on demand only, single-flight, cached, never a
// timer; a failed refresh keeps the last answer (stale), and answers are validated field by field.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../../services/apiClient', () => ({ get: getMock }));
// The auth state the insights cache follows (services/supabase), driven by the tests.
const auth = vi.hoisted(() => ({ cb: null as null | ((event: string, session: unknown) => void) }));
vi.mock('../../../services/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        auth.cb = cb;
        return { data: { subscription: { unsubscribe: () => undefined } } };
      }
    }
  }
}));

import { asCatalogRow, asTrends, fetchInsightsCatalog, fetchInsightsTrends } from './insightsApi';
import { INSIGHTS_FRESH_MS, __resetInsightsCacheForTests, useHeldCatalog, useInsightsCatalog, useInsightsTrends } from './useInsights';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'nano-banana-2.1',
  nickname: 'Nano Banana 2.1',
  providerModel: 'google/gemini-nano-banana-2.1',
  pickable: true,
  lifecycle: 'ga',
  price: { '1K': { usd: 0.0336, basis: 'vendor_table', note: '1120 tokens' }, '2K': { usd: 0.0504, basis: 'vendor_table' } },
  perRefUsd: null,
  endpoints: [{ provider: 'Google AI Studio', uptime1d: 97.72, uptime30m: null }],
  quality: [],
  observed: [],
  fetchedAt: { catalog: '2026-10-29T10:00:00Z' },
  stale: false,
  ...over
});

const Probe: React.FC<{ enabled?: boolean; projectId?: string }> = ({ enabled = true, projectId = 'p1' }) => {
  const c = useInsightsCatalog(projectId, enabled);
  return (
    <div data-testid="probe">
      {c.loading ? 'loading' : 'idle'}|{c.data ? c.data.map((r) => r.id).join(',') : 'none'}|{c.stale ? 'stale' : 'fresh'}|{c.error ?? ''}
      <button type="button" onClick={c.refresh}>retry</button>
    </div>
  );
};

beforeEach(() => {
  getMock.mockReset();
  __resetInsightsCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('insightsApi', () => {
  it('asks the catalog with the comic’s projectId and drops malformed rows and fields', async () => {
    getMock.mockResolvedValueOnce([row({ extra: 'x', price: { '1K': { usd: -1, basis: 'nope' }, '8K': { usd: 1, basis: 'registry' } } }), { nope: true }, 'junk']);
    const rows = await fetchInsightsCatalog('p 1');
    expect(getMock).toHaveBeenCalledWith('/api/comic/models/catalog?projectId=p%201', { signal: undefined });
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toEqual({ '1K': { usd: null, basis: 'registry' } }); // a negative price is no price, never a number
    expect(rows[0]).not.toHaveProperty('extra');
  });

  it('a row keeps null uptimes as null (never 0) and the stale flags', () => {
    const r = asCatalogRow(row({ stale: true, qualityStale: true, endpoints: [{ provider: 'A', uptime1d: null, uptime30m: 'x' }] }))!;
    expect(r.endpoints).toEqual([{ provider: 'A', uptime1d: null, uptime30m: null }]);
    expect(r).toMatchObject({ stale: true, qualityStale: true });
  });

  it('trends: only 30d / 90d are asked; missing parts are empty, T7 stays unavailable unless the server says otherwise', async () => {
    getMock.mockResolvedValueOnce({ t7: { available: true } });
    const t = await fetchInsightsTrends('7d' as never);
    expect(getMock).toHaveBeenCalledWith('/api/comic/models/trends?range=30d', { signal: undefined });
    expect(t.t7.available).toBe(false); // "available" without models is not data
    expect(t.t3).toEqual({ trackingSince: null, changes: [], note: null });
    expect(asTrends({ t7: { available: false, copy: 'Not enough data yet', sinceDays: 30 } }, '90d').t7).toEqual({ available: false, copy: 'Not enough data yet', sinceDays: 30 });
  });
});

describe('useInsightsCatalog (on demand, no timers)', () => {
  it('asks nothing until enabled; then once; a second card shares the answer', async () => {
    getMock.mockResolvedValue([row()]);
    const { rerender } = render(<Probe enabled={false} />);
    expect(getMock).not.toHaveBeenCalled();
    rerender(
      <>
        <Probe />
        <Probe />
      </>
    );
    await act(async () => {});
    expect(getMock).toHaveBeenCalledTimes(1); // single-flight across both
    expect(screen.getAllByTestId('probe')[0]).toHaveTextContent('idle|nano-banana-2.1|fresh|');
  });

  it('an hour of fake time makes no request (nothing is scheduled)', async () => {
    vi.useFakeTimers();
    getMock.mockResolvedValue([row()]);
    render(<Probe />);
    await act(async () => {});
    expect(getMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(60 * 60_000);
    });
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failed refresh keeps the last answer and marks it stale; with nothing held it reports the error', async () => {
    getMock.mockRejectedValueOnce(Object.assign(new Error('Server error'), { status: 500 }));
    const { unmount } = render(<Probe projectId="p2" />);
    await act(async () => {});
    expect(screen.getByTestId('probe')).toHaveTextContent(/idle\|none\|fresh\|.+/);
    unmount();

    getMock.mockResolvedValueOnce([row()]);
    render(<Probe projectId="p3" />);
    await act(async () => {});
    getMock.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      screen.getByRole('button', { name: 'retry' }).click();
    });
    expect(screen.getByTestId('probe')).toHaveTextContent(/idle\|nano-banana-2\.1\|stale\|.+/);
  });

  it('a fresh answer is reused when the tab opens again; an old one is asked again on the next open', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    getMock.mockResolvedValue([row()]);
    const first = render(<Probe projectId="p4" />);
    await act(async () => {});
    first.unmount();
    render(<Probe projectId="p4" />);
    await act(async () => {});
    expect(getMock).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + INSIGHTS_FRESH_MS + 1);
    const third = render(<Probe projectId="p4" />);
    await act(async () => {});
    expect(getMock).toHaveBeenCalledTimes(2);
    third.unmount();
    now.mockRestore();
  });

  it('answers belong to the signed-in account: another account on the same tab never sees them; an open tab asks again', async () => {
    const authEvent = (event: string, userId: string | null) =>
      act(async () => {
        auth.cb!(event, userId ? { user: { id: userId }, access_token: `tok-${userId}` } : null);
      });
    expect(auth.cb).toBeTypeOf('function');
    await authEvent('SIGNED_IN', 'user-a');
    getMock.mockResolvedValue([row()]);
    const Held: React.FC = () => <div data-testid="held">{useHeldCatalog('p5')?.map((r) => r.id).join(',') ?? 'none'}</div>;
    render(
      <>
        <Probe projectId="p5" />
        <Held />
      </>
    );
    await act(async () => {});
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('held')).toHaveTextContent('nano-banana-2.1');

    // A token refresh for the same account keeps the answer (no request).
    await authEvent('TOKEN_REFRESHED', 'user-a');
    expect(getMock).toHaveBeenCalledTimes(1);

    // Another account signs in on this tab within the 5 minutes: user A's rows are gone, the open tab asks again.
    let answer!: (rows: unknown) => void;
    getMock.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    await authEvent('SIGNED_IN', 'user-b');
    expect(screen.getByTestId('held')).toHaveTextContent('none');
    expect(screen.getByTestId('probe')).toHaveTextContent('loading|none|fresh|');
    expect(getMock).toHaveBeenCalledTimes(2);
    await act(async () => answer([row({ id: 'nano-banana-pro', nickname: 'Nano Banana Pro' })]));
    expect(screen.getByTestId('probe')).toHaveTextContent('idle|nano-banana-pro|fresh|');

    // Signing out drops it too (the open tab's new ask is refused without a session: nothing is shown).
    getMock.mockRejectedValueOnce(Object.assign(new Error('Sign in again.'), { status: 401 }));
    await authEvent('SIGNED_OUT', null);
    expect(screen.getByTestId('held')).toHaveTextContent('none');
    expect(screen.getByTestId('probe')).toHaveTextContent(/idle\|none\|fresh\|.*sign in again/i);
  });

  it('trends are keyed by range', async () => {
    getMock.mockResolvedValue({});
    const T: React.FC<{ range: '30d' | '90d' }> = ({ range }) => {
      useInsightsTrends(range);
      return null;
    };
    const { rerender } = render(<T range="30d" />);
    await act(async () => {});
    rerender(<T range="90d" />);
    await act(async () => {});
    expect(getMock.mock.calls.map((c) => c[0])).toEqual(['/api/comic/models/trends?range=30d', '/api/comic/models/trends?range=90d']);
  });
});
