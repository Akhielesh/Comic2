// @vitest-environment jsdom
// A sign-out the auth server never hears of, with the REAL auth client (auth-js) and the real
// services/supabase module: two clients with the app's storage key stand in for two tabs of one
// browser with "Remember me" on (shared localStorage, BroadcastChannel). The network is down, so
// POST /logout fails and auth-js keeps the session and announces nothing. The other tab must
// still hear SIGNED_OUT — as it does for a recorded sign-out — or it keeps showing the account
// and sending its token, which the server still accepts. Only the app's HTTP layer is faked.
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

vi.mock('../services/apiClient', () => ({
  get: vi.fn(async (path: string) => (path === '/api/account/settings' ? { ok: true, data: null } : { ok: true, keys: [] })),
  put: vi.fn(async () => ({ ok: true })),
  clearCachedAuthToken: vi.fn(),
}));
vi.mock('../services/deviceSessions', () => ({ registerDevice: vi.fn(async () => undefined) }));

import { AuthProvider, SIGN_OUT_SERVER_UNREACHABLE_NOTICE, useAuth } from './AuthContext';
import { appStatus } from '../services/appStatus';
import { supabase } from '../services/supabase';

const KEY = 'dreamstream_auth_token';
const A = '11111111-1111-4111-8111-111111111111';
const now = Math.floor(Date.now() / 1000);
const jwt = (claims: Record<string, unknown>) => `header.${btoa(JSON.stringify(claims))}.sig`;
const sessionA = {
  access_token: jwt({ sub: A, exp: now + 3600, session_id: 's-a' }),
  refresh_token: 'refresh-a',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: now + 3600,
  user: { id: A, aud: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
};

/** Every request auth-js makes; each fails as it does offline. */
const requests: string[] = [];
vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
  requests.push(String(url));
  throw new TypeError('Failed to fetch');
}));

const otherTab = createClient('https://placeholder.supabase.co', 'placeholder', {
  auth: { storageKey: KEY, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
});
const otherTabEvents: string[] = [];
otherTab.auth.onAuthStateChange((event) => {
  otherTabEvents.push(event);
});

const channelOf = (client: { auth: unknown }) => (client.auth as { broadcastChannel?: BroadcastChannel | null }).broadcastChannel;
afterAll(() => {
  void supabase.auth.stopAutoRefresh();
  void otherTab.auth.stopAutoRefresh();
  channelOf(supabase)?.close();
  channelOf(otherTab)?.close();
});

/** BroadcastChannel delivers on a later task. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

let auth: ReturnType<typeof useAuth> | null = null;
const WhoAmI = () => {
  auth = useAuth();
  return <span data-testid="who">{auth.loading ? 'loading' : (auth.user?.id ?? 'signed-out')}</span>;
};

describe('AuthProvider with the real auth client — sign out while offline', () => {
  it('signs out here and announces it to the browser’s other tabs, without a second request', async () => {
    localStorage.setItem(KEY, JSON.stringify(sessionA)); // "Remember me" on: every tab's session
    await act(async () => {
      render(
        <AuthProvider>
          <WhoAmI />
        </AuthProvider>
      );
    });
    await settle();
    expect(screen.getByTestId('who').textContent).toBe(A);
    otherTabEvents.length = 0;

    await act(async () => { await auth!.signOut(); });
    await settle();

    expect(screen.getByTestId('who').textContent).toBe('signed-out');
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(requests.filter((url) => url.includes('/logout'))).toHaveLength(1); // the announcement asked nobody
    // Without the fix: [] — the other tab is never told and stays signed in as A.
    expect(otherTabEvents).toContain('SIGNED_OUT');
    expect(appStatus.getSnapshot().events.map((e) => e.message)).toContain(SIGN_OUT_SERVER_UNREACHABLE_NOTICE);
  });
});
