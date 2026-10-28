// @vitest-environment jsdom
// apiClient keeps the session's access token in memory. supabase-js announces every auth event
// to every tab (BroadcastChannel) without storing the session there, so with "Remember me" off
// a token announced by ANOTHER tab's sign-in must not become this tab's bearer token: this tab's
// requests would otherwise ride on an account whose session this tab never held.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  listeners: [] as ((event: string, session: unknown) => void)[],
  stored: 'tab-own-token' as string | null,
  /** The account of the stored session. */
  user: 'user-a',
  isStored: vi.fn((session: { access_token?: string } | null) => !session?.access_token || !h.stored || session.access_token === h.stored),
  emit(event: string, session: unknown) {
    for (const l of [...h.listeners]) l(event, session);
  }
}));
vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn((cb: (event: string, session: unknown) => void) => {
        h.listeners.push(cb);
        return { data: { subscription: { unsubscribe: () => undefined } } };
      }),
      getSession: vi.fn(async () => ({ data: { session: h.stored ? { access_token: h.stored, user: { id: h.user } } : null } }))
    }
  },
  isStoredSession: h.isStored
}));

import { get } from './apiClient';

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
const lastAuth = () => ((fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit])[1].headers as Record<string, string>).Authorization;

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  h.stored = 'tab-own-token';
  h.user = 'user-a';
  h.emit('SIGNED_OUT', null); // forget whatever an earlier test cached
});
afterEach(() => vi.unstubAllGlobals());

describe('apiClient bearer token — follows this tab’s own session', () => {
  it('an event for a session this tab stores is adopted; one another tab announced is not', async () => {
    await get('/api/x');
    expect(lastAuth()).toBe('Bearer tab-own-token');
    // Another tab (its own sessionStorage) signed in as someone else and broadcast it here.
    h.emit('SIGNED_IN', { access_token: 'other-tabs-token' });
    await get('/api/x');
    expect(lastAuth()).toBe('Bearer tab-own-token');
    // This tab's own refresh: stored first, then announced — adopted.
    h.stored = 'tab-own-token-2';
    h.emit('TOKEN_REFRESHED', { access_token: 'tab-own-token-2' });
    await get('/api/x');
    expect(lastAuth()).toBe('Bearer tab-own-token-2');
    // A sign-out is always honoured (the stored session is gone by then).
    h.stored = null;
    h.emit('SIGNED_OUT', null);
    await get('/api/x');
    expect(lastAuth()).toBeUndefined();
  });

  it('another tab signed in as a DIFFERENT account (this tab steps aside and forgets its session): the cached token goes with it — nothing rides on the old account', async () => {
    await get('/api/x');
    expect(lastAuth()).toBe('Bearer tab-own-token');
    // The same account's token refreshed in another tab: ignored, the cache stays.
    h.emit('TOKEN_REFRESHED', { access_token: 'other-tabs-token', user: { id: 'user-a' } });
    await get('/api/x');
    expect(lastAuth()).toBe('Bearer tab-own-token');
    // Another account took the device in another tab; AuthContext forgets this tab's stored session.
    h.emit('SIGNED_IN', { access_token: 'tab-2-token-b', user: { id: 'user-b' } });
    h.stored = null;
    await get('/api/x');
    expect(lastAuth()).toBeUndefined();
    // Never the other tab's token either.
    expect((fetchMock.mock.calls as unknown as [string, RequestInit][]).some((c) => JSON.stringify(c[1].headers).includes('tab-2-token-b'))).toBe(false);
  });
});
