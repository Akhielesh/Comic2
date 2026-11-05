// @vitest-environment jsdom
// The login sync after a sign-out → sign-in while GET /api/account/settings fails (a backend
// still waking up behind the proxy's 502, a network blip). The purge has just emptied the
// device, so the account's snapshot must not be replaced by that empty state; the sync is run
// again instead — once after a short pause, then on the next session event. Real AuthContext,
// cloudSync, apiKeys and localOwner; only the Supabase auth client and apiClient are faked.
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const A = '11111111-1111-4111-8111-111111111111';
type FakeSession = { user: { id: string; email: string }; access_token: string; expires_at: number };

const h = vi.hoisted(() => ({
  session: null as FakeSession | null,
  listeners: [] as ((event: string, session: unknown) => void)[],
  emit(event: string, session: unknown) {
    for (const l of [...h.listeners]) l(event, session);
  },
}));

vi.mock('../services/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: h.session } })),
      onAuthStateChange: vi.fn((cb: (event: string, session: unknown) => void) => {
        h.listeners.push(cb);
        const initial = h.session;
        queueMicrotask(() => cb('INITIAL_SESSION', initial));
        return { data: { subscription: { unsubscribe: () => (h.listeners = h.listeners.filter((l) => l !== cb)) } } };
      }),
      signOut: vi.fn(async () => {
        h.session = null;
        h.emit('SIGNED_OUT', null);
        return { error: null };
      }),
    },
  },
  getAuthRedirectUrl: () => '/auth/callback',
  isSessionExpiredByInactivity: () => false,
  isStoredSession: () => true,
  forgetTabSession: vi.fn(),
  touchLastActivity: vi.fn(),
}));

const net = vi.hoisted(() => ({
  /** How many settings reads still fail (502) before one succeeds. */
  failReads: 0,
  reads: 0,
  puts: [] as { data: { keys: { key: string }[] } }[],
  cloud: null as Record<string, unknown> | null,
}));
vi.mock('../services/apiClient', () => ({
  get: vi.fn(async (path: string) => {
    if (path !== '/api/account/settings') return { ok: true, keys: [] };
    net.reads += 1;
    if (net.failReads > 0) {
      net.failReads -= 1;
      throw Object.assign(new Error('Bad Gateway'), { status: 502 });
    }
    return { ok: true, data: net.cloud };
  }),
  put: vi.fn(async (_path: string, body: { data: (typeof net.puts)[number]['data'] }) => {
    net.puts.push({ data: body.data });
    return { ok: true };
  }),
}));
vi.mock('../services/deviceSessions', () => ({ registerDevice: vi.fn(async () => undefined) }));

import { AuthProvider, useAuth } from './AuthContext';
import { CLOUD_SYNC_READ_FAILED_NOTICE } from '../services/cloudSync';
import { addKey, listKeys } from '../services/apiKeys';
import { appStatus } from '../services/appStatus';
import { getLocalOwner } from '../services/localOwner';

const session = (id: string): FakeSession => ({ user: { id, email: 'a@example.com' }, access_token: `t-${id}`, expires_at: 9_999_999_999 });
const WhoAmI = () => {
  const { user } = useAuth();
  return <span data-testid="who">{user?.id ?? 'signed-out'}</span>;
};
const mount = async () => {
  await act(async () => {
    render(
      <AuthProvider>
        <WhoAmI />
      </AuthProvider>
    );
  });
  await flush();
};
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const keysPushed = () => net.puts.map((p) => p.data.keys.map((k) => k.key).sort());

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  appStatus.clear();
  h.listeners = [];
  net.reads = 0;
  net.puts = [];
  net.failReads = 0;
  net.cloud = {
    version: 2,
    keys: [{ id: 'k1', provider: 'openai', label: 'OpenAI', key: 'sk-real-cloud-key', active: true, limitUsd: null, usedUsd: 0, periodStart: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }],
    settings: {},
    modelKeys: {},
    imageModelId: null,
  };
  // The device was signed out (owner marker cleared, data purged); A signs back in.
  h.session = session(A);
  expect(getLocalOwner()).toBeNull();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AuthProvider — the login sync when the account snapshot cannot be read', () => {
  it('writes nothing, says so, and reads again 5 s later: the account’s key comes back and the merge is pushed', async () => {
    net.failReads = 1;
    await mount();
    expect(screen.getByTestId('who')).toHaveTextContent(A);
    expect(net.reads).toBe(1);
    // Without the fix: one PUT with keys [] — the account's key gone, locally and in the cloud.
    expect(net.puts).toEqual([]);
    expect(listKeys()).toEqual([]);
    expect(appStatus.getSnapshot().events[0]).toMatchObject({ level: 'warn', message: CLOUD_SYNC_READ_FAILED_NOTICE });

    await advance(5_000);
    expect(net.reads).toBe(2);
    expect(listKeys().map((k) => k.key)).toEqual(['sk-real-cloud-key']);
    expect(keysPushed()).toEqual([['sk-real-cloud-key']]);
  });

  it('a key typed while the read had failed is not pushed on its own; the retry’s merge carries it with the account’s', async () => {
    net.failReads = 1;
    await mount();
    act(() => {
      addKey({ provider: 'openai', key: 'sk-typed-after-failed-read' });
    });
    await advance(2_000); // the debounced push (1.5 s) is dropped: the account has not been read yet
    expect(net.puts).toEqual([]);
    await advance(3_500); // the retry
    expect(net.reads).toBe(2);
    expect(keysPushed()).toEqual([['sk-real-cloud-key', 'sk-typed-after-failed-read']]);
    expect(listKeys().map((k) => k.key).sort()).toEqual(['sk-real-cloud-key', 'sk-typed-after-failed-read']);
  });

  it('when the retry fails too, the next session event (a token refresh) runs the sync again — and a synced account is not read twice', async () => {
    net.failReads = 2;
    await mount();
    await advance(5_000);
    expect(net.reads).toBe(2);
    expect(net.puts).toEqual([]);
    await act(async () => h.emit('TOKEN_REFRESHED', session(A)));
    await flush();
    expect(net.reads).toBe(3);
    expect(keysPushed()).toEqual([['sk-real-cloud-key']]);
    await act(async () => h.emit('TOKEN_REFRESHED', session(A)));
    await advance(10_000);
    expect(net.reads).toBe(3);
  });

  it('a sign-out before the retry drops it: nothing more is read or pushed for the account', async () => {
    net.failReads = 1;
    await mount();
    h.session = null;
    await act(async () => h.emit('SIGNED_OUT', null));
    await advance(10_000);
    expect(screen.getByTestId('who')).toHaveTextContent('signed-out');
    expect(net.reads).toBe(1);
    expect(net.puts).toEqual([]);
  });

  it('control: a read that succeeds at sign-in syncs once; later refreshes do not read again', async () => {
    await mount();
    await advance(10_000);
    expect(net.reads).toBe(1);
    expect(keysPushed()).toEqual([['sk-real-cloud-key']]);
    await act(async () => h.emit('TOKEN_REFRESHED', session(A)));
    await advance(10_000);
    expect(net.reads).toBe(1);
    expect(appStatus.getSnapshot().events).toEqual([]);
  });
});
