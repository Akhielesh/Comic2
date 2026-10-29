// @vitest-environment jsdom
// Probe: Sign out while the auth server can't be reached (offline, flaky mobile network, a cold
// backend is not involved — this is GoTrue). contexts/AuthContext.signOut purges local data and
// shows the signed-out state FIRST, then awaits supabase.auth.signOut({scope:'local'}) and ignores its
// result. supabase-js (auth-js 2.95 _signOut, verified in node_modules) returns { error } WITHOUT
// removing the stored session when POST /logout fails with anything but 401/403/404 — so the session
// stays in storage, the auto-refresh timer keeps it alive, and the next TOKEN_REFRESHED (or a reload)
// signs the account straight back in. On a shared device "Signed out" was not true.
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const A = '11111111-1111-4111-8111-111111111111';
type FakeSession = { user: { id: string; email: string }; access_token: string; expires_at: number };

const h = vi.hoisted(() => ({
  stored: null as FakeSession | null,
  offline: true,
  listeners: [] as ((event: string, session: unknown) => void)[],
  emit(event: string, session: unknown) {
    for (const l of [...h.listeners]) l(event, session);
  },
}));

vi.mock('../../services/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: h.stored } })),
      onAuthStateChange: vi.fn((cb: (event: string, session: unknown) => void) => {
        h.listeners.push(cb);
        queueMicrotask(() => cb('INITIAL_SESSION', h.stored));
        return { data: { subscription: { unsubscribe: () => (h.listeners = h.listeners.filter((l) => l !== cb)) } } };
      }),
      // auth-js _signOut: a failed POST /logout (not 401/403/404) returns the error and keeps the session.
      signOut: vi.fn(async () => {
        if (h.offline) return { error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 } };
        h.stored = null;
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
vi.mock('../../services/apiClient', () => ({
  get: vi.fn(async (path: string) => (path === '/api/account/settings' ? { ok: true, data: null } : { ok: true, keys: [] })),
  put: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../services/deviceSessions', () => ({ registerDevice: vi.fn(async () => undefined) }));

import { AuthProvider, useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../services/supabase';

const session = (id: string): FakeSession => ({ user: { id, email: 'a@example.com' }, access_token: `t-${id}`, expires_at: 9_999_999_999 });
let signOutFn: (() => Promise<void>) | null = null;
const WhoAmI = () => {
  const { user, loading, signOut } = useAuth();
  signOutFn = signOut;
  return <span data-testid="who">{loading ? 'loading' : (user?.id ?? 'signed-out')}</span>;
};
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

beforeEach(() => {
  localStorage.clear();
  h.stored = session(A);
  h.offline = true;
  h.listeners = [];
});

describe('Sign out while /logout cannot be reached', () => {
  it('either signs out for real or says it could not — never "signed out" with the session still live', async () => {
    await act(async () => {
      render(
        <AuthProvider>
          <WhoAmI />
        </AuthProvider>
      );
    });
    await flush();
    expect(screen.getByTestId('who').textContent).toBe(A);

    await act(async () => { await signOutFn!(); });
    await flush();
    const shownAfterSignOut = screen.getByTestId('who').textContent;
    const stillStored = (await supabase.auth.getSession()).data.session?.user.id ?? null;

    // The auto-refresh timer (still running: the session is still stored) refreshes the token.
    await act(async () => h.emit('TOKEN_REFRESHED', session(A)));
    await flush();
    const shownLater = screen.getByTestId('who').textContent;
    process.stderr.write(`probe auth4 ${JSON.stringify({ shownAfterSignOut, stillStored, shownLater })}\n`);

    // Expected: a sign-out that reports success leaves no session behind.
    expect(shownAfterSignOut).toBe('signed-out');
    expect(stillStored).toBeNull();
    expect(shownLater).toBe('signed-out');
  });
});
