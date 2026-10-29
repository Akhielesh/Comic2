// @vitest-environment jsdom
// Local data never crosses accounts. Real AuthContext, cloudSync, modelSelection, apiKeys,
// appSettings, chatStorage memory and Stream Studio's accountPurge; only the Supabase auth
// client (sessions + events) and the HTTP layer (apiClient) are faked. Every request records
// the account whose token it rides on, so a PUT of one account's data with another account's
// session shows up.
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

type FakeSession = { user: { id: string; email: string }; access_token: string; expires_at: number };

const h = vi.hoisted(() => ({
  session: null as FakeSession | null,
  listeners: [] as ((event: string, session: unknown) => void)[],
  expired: false,
  /** This tab's own stored session token (null = nothing stored, or storage shared with every tab). */
  storedToken: null as string | null,
  emit(event: string, session: unknown) {
    for (const l of [...h.listeners]) l(event, session);
  }
}));

vi.mock('../services/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: h.session } })),
      onAuthStateChange: vi.fn((cb: (event: string, session: unknown) => void) => {
        h.listeners.push(cb);
        // Like supabase-js: the stored session is announced once the client is ready.
        const initial = h.session;
        queueMicrotask(() => cb('INITIAL_SESSION', initial));
        return { data: { subscription: { unsubscribe: () => (h.listeners = h.listeners.filter((l) => l !== cb)) } } };
      }),
      signOut: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 20)); // POST /logout
        h.session = null;
        h.emit('SIGNED_OUT', null);
        return { error: null };
      })
    }
  },
  getAuthRedirectUrl: () => '/auth/callback',
  isSessionExpiredByInactivity: () => h.expired,
  // Like the real one: compared with the session stored for this tab; a tab that stores nothing
  // while "Remember me" is off holds no session (a definite no), and with "Remember me" on
  // (shared storage) it can't tell (true).
  isStoredSession: (session: { access_token?: string } | null) => {
    if (!session?.access_token) return true;
    if (h.storedToken) return session.access_token === h.storedToken;
    return localStorage.getItem('dreamstream_auth_persist') !== 'session';
  },
  // Like the real one: this tab's stored session is gone from then on.
  forgetTabSession: vi.fn(() => {
    h.storedToken = null;
    h.session = null;
  }),
  touchLastActivity: vi.fn()
}));

const net = vi.hoisted(() => ({
  cloud: {} as Record<string, unknown>,
  gets: [] as { as: string | null; path: string }[],
  puts: [] as { as: string | null; data: { keys: { key: string }[]; chat?: { memory?: string }; modelSelection?: unknown } }[],
  getDelayMs: 0
}));
vi.mock('../services/apiClient', () => ({
  get: vi.fn(async (path: string) => {
    const as = h.session?.user.id ?? null;
    net.gets.push({ as, path });
    if (net.getDelayMs) await new Promise((r) => setTimeout(r, net.getDelayMs));
    if (path === '/api/account/settings') return { ok: true, data: as ? (net.cloud[as] ?? null) : null };
    return { ok: true, keys: [] };
  }),
  put: vi.fn(async (_path: string, body: { data: (typeof net.puts)[number]['data'] }) => {
    net.puts.push({ as: h.session?.user.id ?? null, data: body.data });
    return { ok: true };
  })
}));
vi.mock('../services/deviceSessions', () => ({ registerDevice: vi.fn(async () => undefined) }));

import { AuthProvider, OTHER_TAB_SIGN_IN_NOTICE, useAuth } from './AuthContext';
import { appStatus } from '../services/appStatus';
import { forgetTabSession } from '../services/supabase';
import { adoptStoredSessionOwner, getLocalOwner, getUnownedDataOwner, setLocalOwner } from '../services/localOwner';
import { getGovernanceMap, setProviderEnabled } from '../services/sourceGovernance';
import { getPendingInviteCode } from '../services/invites';
import { addKey, listKeys } from '../services/apiKeys';
import { getChatMemory, setChatMemory } from '../services/chatStorage';
import { getStoredModelSelection, setSelectedModel } from '../services/modelSelection';
import { OWNER_KEY as LIVE_OWNER_KEY } from '../live/accountPurge';
import { hasFreshSignInIntent, markSignInStarted } from '../services/pendingSignIn';

const session = (id: string): FakeSession => ({ user: { id, email: `${id.slice(0, 1)}@example.com` }, access_token: `t-${id}`, expires_at: 9_999_999_999 });

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
/** Did any request carry account `secret`-bearing data while signed in as `as`? */
const putsAs = (as: string) => net.puts.filter((p) => p.as === as);
const leaked = (as: string, needle: string) => putsAs(as).some((p) => JSON.stringify(p.data).includes(needle));

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  appStatus.clear();
  vi.mocked(forgetTabSession).mockClear();
  h.session = null;
  h.listeners = [];
  h.expired = false;
  h.storedToken = null;
  net.cloud = {};
  net.gets = [];
  net.puts = [];
  net.getDelayMs = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AuthProvider — an account switch never carries data across', () => {
  it('a push queued for A before a switch to B never runs, and nothing of A’s goes up with B’s session', async () => {
    h.session = session(A);
    setLocalOwner(A);
    addKey({ provider: 'openai', key: 'sk-A-secret' });
    setChatMemory('- A private: my therapist is Dr X', A);
    await mount();
    await advance(2_000);
    expect(putsAs(A).length).toBeGreaterThan(0); // A's own login sync

    // A changes a model choice: a debounced push for A is now queued (1.5 s).
    act(() => setSelectedModel('text', 'gpt-a', 'specific', 'openai'));
    // Before it fires, a session for B arrives (a link, another tab).
    net.cloud[B] = { version: 2, keys: [], settings: {}, chat: { memory: '- B note', agents: [] } };
    h.session = session(B);
    await act(async () => h.emit('SIGNED_IN', session(B)));
    await advance(5_000);

    expect(getLocalOwner()).toBe(B);
    expect(putsAs(B).length).toBeGreaterThan(0); // B's own login sync ran
    expect(leaked(B, 'sk-A-secret')).toBe(false);
    expect(leaked(B, 'A private')).toBe(false);
    expect(leaked(B, 'gpt-a')).toBe(false);
    expect(listKeys()).toEqual([]);
    expect(getStoredModelSelection()).toBeNull();
    // A's chat memory stays on the device under A's id (it follows A, never B).
    expect(getChatMemory(A)).toContain('A private');
    expect(getChatMemory(B)).toBe('- B note');
  });

  it('PASSWORD_RECOVERY for B after A purges A’s keys before any sync or push, and B owns the device', async () => {
    h.session = session(A);
    setLocalOwner(A);
    addKey({ provider: 'openai', key: 'sk-A-secret' });
    await mount();
    await advance(2_000);
    net.puts = [];
    net.gets = [];

    h.session = session(B);
    await act(async () => h.emit('PASSWORD_RECOVERY', session(B)));
    expect(listKeys()).toEqual([]); // purged synchronously, before the sync's first await
    expect(getLocalOwner()).toBe(B);
    await act(async () => h.emit('USER_UPDATED', session(B))); // the new password is saved
    act(() => {
      addKey({ provider: 'anthropic', key: 'sk-B-new' });
    });
    await advance(5_000);

    expect(net.gets.filter((g) => g.path === '/api/account/settings').map((g) => g.as)).toEqual([B]);
    expect(leaked(B, 'sk-A-secret')).toBe(false);
    expect(leaked(B, 'sk-B-new')).toBe(true); // B's own change follows B
  });

  it('Stream Studio data that B already owns (ds-live-owner = B) survives a switch from A to B', async () => {
    setLocalOwner(A);
    localStorage.setItem(LIVE_OWNER_KEY, B);
    localStorage.setItem('ds-live-my-events', '[{"id":"e1","hostKey":"k"}]');
    localStorage.setItem('ds-monitor-setup-n1', '{"done":true}');
    h.session = session(B);
    await mount();
    await advance(2_000);
    expect(getLocalOwner()).toBe(B);
    expect(localStorage.getItem('ds-live-my-events')).toBe('[{"id":"e1","hostKey":"k"}]');
    expect(localStorage.getItem('ds-monitor-setup-n1')).toBe('{"done":true}');
    expect(localStorage.getItem(LIVE_OWNER_KEY)).toBe(B);
  });

  it('…but Stream Studio data owned by someone else goes on that switch', async () => {
    setLocalOwner(A);
    localStorage.setItem(LIVE_OWNER_KEY, C);
    localStorage.setItem('ds-live-my-events', '[{"id":"e1","hostKey":"k"}]');
    h.session = session(B);
    await mount();
    expect(localStorage.getItem('ds-live-my-events')).toBeNull();
    expect(localStorage.getItem(LIVE_OWNER_KEY)).toBe(B);
  });

  it('the same account keeps its data (owner adopted at boot from its stored session)', async () => {
    adoptStoredSessionOwner(JSON.stringify({ user: { id: A } })); // what services/supabase does at load
    addKey({ provider: 'openai', key: 'sk-mine' });
    h.session = session(A);
    await mount();
    await advance(2_000);
    expect(getLocalOwner()).toBe(A);
    expect(getUnownedDataOwner()).toBe(A);
    expect(listKeys().map((k) => k.key)).toEqual(['sk-mine']);
    await act(async () => h.emit('TOKEN_REFRESHED', session(A)));
    expect(listKeys().map((k) => k.key)).toEqual(['sk-mine']);
  });

  it('data nobody owns (a session that ended without a sign-out) never goes to the first account that signs in — e.g. an attacker link the visitor confirmed', async () => {
    addKey({ provider: 'openai', key: 'sk-VICTIM-residue' });
    setProviderEnabled('openrouter', false);
    act(() => setSelectedModel('text', 'gpt-residue', 'specific', 'openai'));
    expect(getLocalOwner()).toBeNull();
    await mount(); // signed out: no stored session to adopt
    net.cloud[B] = { version: 2, keys: [], settings: {}, chat: { memory: '', agents: [] } };
    h.session = session(B);
    await act(async () => h.emit('SIGNED_IN', session(B)));
    await advance(5_000);
    expect(getLocalOwner()).toBe(B);
    expect(putsAs(B).length).toBeGreaterThan(0); // B's own login sync ran
    expect(leaked(B, 'sk-VICTIM-residue')).toBe(false);
    expect(leaked(B, 'gpt-residue')).toBe(false);
    expect(putsAs(B).some((p) => JSON.stringify((p.data as { sourceGovernance?: unknown }).sourceGovernance ?? {}).includes('openrouter'))).toBe(false);
    expect(listKeys()).toEqual([]);
    // Untagged chat rows stay unclaimed (hidden), never handed to whoever signs in first.
    expect(getUnownedDataOwner()).toBeNull();
  });

  it('a switch purges A’s source choices too, so they never go up into B’s snapshot', async () => {
    h.session = session(A);
    setLocalOwner(A);
    await mount();
    await advance(2_000);
    act(() => setProviderEnabled('openrouter', false));
    await advance(2_000);
    net.cloud[B] = { version: 2, keys: [], settings: {}, chat: { memory: '', agents: [] } };
    h.session = session(B);
    await act(async () => h.emit('SIGNED_IN', session(B)));
    await advance(5_000);
    expect(getGovernanceMap()).toEqual({});
    expect(putsAs(B).some((p) => JSON.stringify((p.data as { sourceGovernance?: unknown }).sourceGovernance ?? {}).includes('openrouter'))).toBe(false);
  });

  it('a switch drops one-time codes and Stream Studio data nobody owns: the next account never redeems or inherits them', async () => {
    setLocalOwner(A);
    localStorage.setItem('ds_pending_invite_code', 'INVITE-FOR-A');
    localStorage.setItem('ds-live-welcome-ticket', 'TICKET-FOR-A');
    localStorage.setItem('ds-live-my-events', '[{"id":"e1","hostKey":"k-unowned"}]'); // no ds-live-owner
    h.session = session(B);
    await mount();
    await advance(2_000);
    expect(getLocalOwner()).toBe(B);
    expect(getPendingInviteCode()).toBeNull();
    expect(localStorage.getItem('ds-live-welcome-ticket')).toBeNull();
    expect(localStorage.getItem('ds-live-my-events')).toBeNull();
    expect(localStorage.getItem(LIVE_OWNER_KEY)).toBe(B);
  });

  it('…but a first sign-in on a fresh device keeps the invite it came with (the invite flow)', async () => {
    localStorage.setItem('ds_pending_invite_code', 'INVITE-NEW');
    await mount();
    h.session = session(B);
    await act(async () => h.emit('SIGNED_IN', session(B)));
    await advance(2_000);
    expect(getPendingInviteCode()).toBe('INVITE-NEW');
  });

  it('sign-out purges everything (Stream Studio’s copy included) and clears the owner', async () => {
    adoptStoredSessionOwner(JSON.stringify({ user: { id: A } }));
    h.session = session(A);
    addKey({ provider: 'openai', key: 'sk-A' });
    localStorage.setItem(LIVE_OWNER_KEY, A);
    localStorage.setItem('ds-live-my-events', '[]');
    markSignInStarted('magiclink'); // a link asked for while signed in (a re-sent confirmation, say)
    await mount();
    h.session = null;
    await act(async () => h.emit('SIGNED_OUT', null));
    expect(getLocalOwner()).toBeNull();
    expect(listKeys()).toEqual([]);
    expect(localStorage.getItem('ds-live-my-events')).toBeNull();
    expect(getUnownedDataOwner()).toBe(A); // untagged data stays A's, never the next account's
    // Nothing here waits for a link any more: the next link asks, whoever it is for.
    expect(hasFreshSignInIntent()).toBe(false);
  });
});

describe('AuthProvider — "Remember me" off, two tabs', () => {
  it('the same account’s session announced by another tab (not the one this tab stores) changes nothing here; this tab’s own events and sign-outs still do', async () => {
    localStorage.setItem('dreamstream_auth_persist', 'session'); // "Remember me" off: one session per tab
    // Tab 1 is A, with A's session in its own sessionStorage.
    h.session = session(A);
    h.storedToken = session(A).access_token;
    setLocalOwner(A);
    addKey({ provider: 'openai', key: 'sk-A-secret' });
    await mount();
    await advance(2_000);
    // Another tab of A's refreshed its token: supabase-js broadcasts it here without storing it.
    await act(async () => h.emit('TOKEN_REFRESHED', { ...session(A), access_token: 't-A-other-tab' }));
    await advance(5_000);
    expect(screen.getByTestId('who')).toHaveTextContent(A);
    expect(getLocalOwner()).toBe(A);
    expect(listKeys().map((k) => k.key)).toEqual(['sk-A-secret']);
    expect(forgetTabSession).not.toHaveBeenCalled();
    // Tab 1's own refresh (stored first, then announced) is still A's.
    h.storedToken = 't-A-2';
    await act(async () => h.emit('TOKEN_REFRESHED', { ...session(A), access_token: 't-A-2' }));
    expect(getLocalOwner()).toBe(A);
    expect(listKeys().length).toBe(1);
    // A switch stored in THIS tab (its own sign-in as B) matches, and purges.
    h.storedToken = session(B).access_token;
    net.cloud[B] = { version: 2, keys: [], settings: {}, chat: { memory: '', agents: [] } };
    h.session = session(B);
    await act(async () => h.emit('SIGNED_IN', session(B)));
    await advance(5_000);
    expect(getLocalOwner()).toBe(B);
    expect(listKeys()).toEqual([]);
    expect(leaked(B, 'sk-A-secret')).toBe(false);
    // A sign-out announced from anywhere is always honoured.
    h.session = null;
    await act(async () => h.emit('SIGNED_OUT', null));
    expect(getLocalOwner()).toBeNull();
  });

  it('another ACCOUNT’s session announced by another tab: that tab took the device, so this one steps aside — signed out here, no purge, no sign-out call, its stored session forgotten, a notice shown', async () => {
    localStorage.setItem('dreamstream_auth_persist', 'session'); // "Remember me" off: one session per tab
    h.session = session(A);
    h.storedToken = session(A).access_token;
    setLocalOwner(A);
    addKey({ provider: 'openai', key: 'sk-A-secret' });
    await mount();
    await advance(2_000);
    // A changes a model choice: a debounced push for A is queued (1.5 s)…
    act(() => setSelectedModel('text', 'gpt-a', 'specific', 'openai'));
    net.puts = [];
    // …then tab 2 signs in as B (B's session stored THERE; here only announced). Tab 2's own
    // AuthProvider purged A's data and made the device B's — modelled here directly.
    setLocalOwner(B);
    await act(async () => h.emit('SIGNED_IN', session(B)));
    await advance(5_000);

    expect(screen.getByTestId('who')).toHaveTextContent('signed-out');
    expect(forgetTabSession).toHaveBeenCalledOnce();
    expect(h.storedToken).toBeNull();
    expect(getLocalOwner()).toBe(B); // not touched here: the other tab owns the device now
    expect(listKeys().map((k) => k.key)).toEqual(['sk-A-secret']); // no purge here either (the other tab did)
    expect(net.puts).toEqual([]); // A's queued push was dropped, not sent into B's account
    expect(appStatus.getSnapshot().events[0]).toMatchObject({ level: 'warn', message: OTHER_TAB_SIGN_IN_NOTICE });
    // This tab writes nothing more as A: a change here no longer schedules a push.
    act(() => setSelectedModel('text', 'gpt-a2', 'specific', 'openai'));
    await advance(5_000);
    expect(net.puts).toEqual([]);
    // A sign-out announced from anywhere is still honoured.
    h.session = null;
    await act(async () => h.emit('SIGNED_OUT', null));
    expect(getLocalOwner()).toBeNull();
  });
});

describe('AuthProvider — inactivity sign-out at boot', () => {
  it('never starts the login sync for a session that is being signed out, so no keys are written back without an owner', async () => {
    h.expired = true;
    h.session = session(A);
    setLocalOwner(A);
    addKey({ provider: 'openai', key: 'sk-A-secret' });
    net.cloud[A] = { version: 2, keys: [{ id: 'k1', provider: 'openai', key: 'sk-A-secret', active: true }], settings: {} };
    net.getDelayMs = 300;
    await mount();
    await advance(1_000);

    expect(net.gets.filter((g) => g.path === '/api/account/settings')).toEqual([]);
    expect(net.puts).toEqual([]);
    expect(getLocalOwner()).toBeNull();
    expect(listKeys()).toEqual([]);
  });

  it('a later password sign-in on the same page still works', async () => {
    h.expired = true;
    h.session = session(A);
    await mount();
    await advance(1_000);
    expect(getLocalOwner()).toBeNull();
    h.session = session(B);
    await act(async () => h.emit('SIGNED_IN', session(B)));
    await advance(2_000);
    expect(getLocalOwner()).toBe(B);
    expect(net.gets.filter((g) => g.path === '/api/account/settings').map((g) => g.as)).toEqual([B]);
  });
});
