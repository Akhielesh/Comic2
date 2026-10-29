// @vitest-environment jsdom
// This tab's session versus what the auth client announces or fails to do:
//  - "Remember me" OFF + a magic link: the link opens in a NEW tab, which signs in there (its
//    sessionStorage); supabase-js announces SIGNED_IN to the tab that asked without storing it.
//    That tab must not adopt a session it does not hold (it would show the account with an empty
//    dashboard, drop every direct Supabase save and sign out on reload).
//  - Sign out while POST /logout cannot be reached: auth-js keeps the stored session and fires no
//    SIGNED_OUT, so the next refresh tick or reload would sign the account straight back in after
//    "Signed out" was shown. The local session must go regardless, the person be told, and the
//    browser's other tabs hear SIGNED_OUT as they do for a recorded sign-out. A POST /logout that
//    never answers (auth-js sets no timeout) must not keep the session stored meanwhile.
// Real AuthContext and the REAL services/supabase module (isStoredSession, dropStoredSession,
// forgetTabSession, the inactivity clock); only the Supabase client is a fake that keeps the
// session in this tab's real storage the way supabase-js does, and apiClient is faked.
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
type FakeSession = { user: { id: string; email: string }; access_token: string; expires_at: number };

const h = vi.hoisted(() => {
  const KEY = 'dreamstream_auth_token';
  const OFFLINE = { error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 } };
  const state = {
    /** POST /logout cannot be reached. */
    offline: false,
    /** POST /logout gets no answer until the test gives one with `answerLogout`. */
    hang: false,
    answerLogout: null as null | ((answer: 'ok' | 'error') => void),
    /** auth-js runs one auth call at a time (its lock): a call waits for the one before it to settle. */
    lock: Promise.resolve() as Promise<unknown>,
    /** auth-js _signOut, run under the lock: POST /logout only when a session is stored. */
    async signOut(scope: 'local' | 'global' | 'others') {
      if (state.stored()) {
        // A failed POST /logout (anything but 401/403/404) returns the error and keeps the stored session.
        if (state.hang) {
          const answer = await new Promise<'ok' | 'error'>((resolve) => (state.answerLogout = resolve));
          state.answerLogout = null;
          if (answer === 'error') return OFFLINE;
        } else if (state.offline) return OFFLINE;
      }
      // _removeSession: whatever is stored goes, and SIGNED_OUT is announced here and to every other tab.
      if (scope !== 'others') {
        sessionStorage.removeItem(KEY);
        localStorage.removeItem(KEY);
        state.emit('SIGNED_OUT', null);
      }
      return { error: null };
    },
    listeners: [] as ((event: string, session: unknown) => void)[],
    emit(event: string, session: unknown) {
      for (const l of [...state.listeners]) l(event, session);
    },
    /** What this tab's storage holds — read on every call, as supabase-js does (either storage). */
    stored(): FakeSession | null {
      const raw = sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as FakeSession) : null;
    },
    /** supabase-js _saveSession through the app's authStorage: the storage the "Remember me" choice names. */
    store(session: FakeSession) {
      const target = localStorage.getItem('dreamstream_auth_persist') === 'session' ? sessionStorage : localStorage;
      target.setItem(KEY, JSON.stringify(session));
    },
    /** The auto-refresh tick: refreshes — stores, then announces — only a session that is stored. */
    refreshTick() {
      const s = state.stored();
      if (!s) return;
      const refreshed = { ...s, access_token: `${s.access_token}-refreshed` };
      state.store(refreshed);
      state.emit('TOKEN_REFRESHED', refreshed);
    },
  };
  return state;
});

vi.mock('../services/supabase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/supabase')>();
  void actual.supabase.auth.stopAutoRefresh();
  return {
    ...actual,
    supabase: {
      auth: {
        getSession: vi.fn(async () => ({ data: { session: h.stored() } })),
        onAuthStateChange: vi.fn((cb: (event: string, session: unknown) => void) => {
          h.listeners.push(cb);
          queueMicrotask(() => cb('INITIAL_SESSION', h.stored()));
          return { data: { subscription: { unsubscribe: () => (h.listeners = h.listeners.filter((l) => l !== cb)) } } };
        }),
        signOut: vi.fn(({ scope }: { scope: 'local' | 'global' | 'others' }) => {
          const call = h.lock.then(() => h.signOut(scope));
          h.lock = call.catch(() => undefined);
          return call;
        }),
      },
    },
  };
});

const net = vi.hoisted(() => ({ gets: [] as string[] }));
vi.mock('../services/apiClient', () => ({
  get: vi.fn(async (path: string) => {
    net.gets.push(path);
    return path === '/api/account/settings' ? { ok: true, data: null } : { ok: true, keys: [] };
  }),
  put: vi.fn(async () => ({ ok: true })),
  clearCachedAuthToken: vi.fn(),
}));
vi.mock('../services/deviceSessions', () => ({ registerDevice: vi.fn(async () => undefined) }));

import { AuthProvider, SIGNED_IN_IN_OTHER_TAB_NOTICE, SIGN_OUT_SERVER_UNREACHABLE_NOTICE, useAuth } from './AuthContext';
import { clearCachedAuthToken } from '../services/apiClient';
import { addKey, listKeys } from '../services/apiKeys';
import { appStatus } from '../services/appStatus';
import { getLocalOwner, setLocalOwner } from '../services/localOwner';
import { INACTIVITY_SIGNOUT_MS } from '../services/supabase';

const session = (id: string): FakeSession => ({ user: { id, email: `${id.slice(0, 1)}@example.com` }, access_token: `t-${id}`, expires_at: 9_999_999_999 });
let auth: ReturnType<typeof useAuth> | null = null;
const WhoAmI = () => {
  auth = useAuth();
  return <span data-testid="who">{auth.loading ? 'loading' : (auth.user?.id ?? 'signed-out')}</span>;
};
const who = () => screen.getByTestId('who').textContent;
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
const settingsReads = () => net.gets.filter((p) => p === '/api/account/settings');

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  appStatus.clear();
  h.offline = false;
  h.hang = false;
  h.answerLogout = null;
  h.lock = Promise.resolve();
  h.listeners = [];
  net.gets = [];
  vi.mocked(clearCachedAuthToken).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AuthProvider — "Remember me" off: a session another tab signed in to is not this tab’s', () => {
  it('the tab that asked for the magic link stays signed out when the link’s tab signs in — and is told', async () => {
    localStorage.setItem('dreamstream_auth_persist', 'session'); // AuthPage: "Remember me" unticked, link requested
    await mount();
    expect(who()).toBe('signed-out');
    // The link's tab: verifyOtp stored B's session in ITS sessionStorage and supabase-js announced it here.
    await act(async () => h.emit('SIGNED_IN', session(B)));
    await flush();
    // Without the fix: this tab shows B — with no session of its own (an empty dashboard, saves dropped).
    expect(who()).toBe('signed-out');
    expect(h.stored()).toBeNull();
    expect(getLocalOwner()).toBeNull();
    expect(settingsReads()).toEqual([]); // no login sync as B here either
    expect(appStatus.getSnapshot().events[0]).toMatchObject({ level: 'info', message: SIGNED_IN_IN_OTHER_TAB_NOTICE });
  });

  it('its own sign-in (the session is stored before the event, as supabase-js does) still signs it in', async () => {
    localStorage.setItem('dreamstream_auth_persist', 'session');
    await mount();
    h.store(session(B)); // signInWithPassword / verifyOtp in THIS tab
    await act(async () => h.emit('SIGNED_IN', session(B)));
    await flush();
    expect(who()).toBe(B);
    expect(getLocalOwner()).toBe(B);
    expect(settingsReads()).toHaveLength(1);
    expect(appStatus.getSnapshot().events).toEqual([]);
  });

  it('with "Remember me" on, storage is shared: the other tab’s sign-in is this tab’s too', async () => {
    await mount();
    h.store(session(B)); // the other tab's _saveSession landed in the shared localStorage
    await act(async () => h.emit('SIGNED_IN', session(B)));
    await flush();
    expect(who()).toBe(B);
    expect(appStatus.getSnapshot().events).toEqual([]);
  });

  it('another tab’s token refresh is nothing to tell a signed-out tab about', async () => {
    localStorage.setItem('dreamstream_auth_persist', 'session');
    await mount();
    await act(async () => h.emit('TOKEN_REFRESHED', session(B)));
    await flush();
    expect(who()).toBe('signed-out');
    expect(appStatus.getSnapshot().events).toEqual([]);
  });
});

describe('AuthProvider — sign out while the auth server cannot be reached', () => {
  /** A remembered session for A on this device, A owning its data (as adopted at boot). */
  const startAsA = async () => {
    h.store(session(A));
    setLocalOwner(A);
    addKey({ provider: 'openai', key: 'sk-A-secret' });
    await mount();
    expect(who()).toBe(A);
  };

  it('signs out on this device for real: the stored session goes, a refresh tick or reload brings nobody back, and the person is told', async () => {
    await startAsA();
    h.offline = true;
    await act(async () => { await auth!.signOut(); });
    await flush();
    expect(who()).toBe('signed-out');
    // Without the fix: the session is still stored, the refresh tick re-applies it, a reload resumes it.
    expect(h.stored()).toBeNull();
    expect(clearCachedAuthToken).toHaveBeenCalled();
    await act(async () => h.refreshTick());
    await flush();
    expect(who()).toBe('signed-out');
    expect(listKeys()).toEqual([]);
    expect(getLocalOwner()).toBeNull();
    expect(appStatus.getSnapshot().events[0]).toMatchObject({ level: 'warn', message: SIGN_OUT_SERVER_UNREACHABLE_NOTICE });
    // A reload: nothing to resume.
    h.listeners = [];
    await mount();
    expect(screen.getAllByTestId('who').at(-1)?.textContent).toBe('signed-out');
  });

  it('tells the browser’s other tabs, as a recorded sign-out does: they hear SIGNED_OUT', async () => {
    await startAsA();
    // Another tab of this browser ("Remember me" on: the same stored session): its auth client and
    // apiClient act on what supabase-js broadcasts to it.
    const otherTab: string[] = [];
    h.listeners.push((event) => otherTab.push(event));
    h.offline = true;
    await act(async () => { await auth!.signOut(); });
    await flush();
    // Without the fix: [] — the other tab keeps showing A and sending A's token, which the server
    // still accepts (the sign-out was never recorded there).
    expect(otherTab).toContain('SIGNED_OUT');
    expect(h.stored()).toBeNull();
    expect(who()).toBe('signed-out');
    expect(appStatus.getSnapshot().events[0]).toMatchObject({ level: 'warn', message: SIGN_OUT_SERVER_UNREACHABLE_NOTICE });
  });

  it('a POST /logout that never answers: after 8 s this device is signed out anyway — the stored session goes, the person is told — and the other tabs hear it once the call settles', async () => {
    vi.useFakeTimers();
    await startAsA();
    const otherTab: string[] = [];
    h.listeners.push((event) => otherTab.push(event));
    h.hang = true; // a captive portal, a lossy mobile link: auth-js sets no timeout on the request
    let returned = false;
    await act(async () => { void auth!.signOut().then(() => { returned = true; }); });
    await flush();
    expect(who()).toBe('signed-out'); // the screen clears at once…
    expect(h.stored()).not.toBeNull(); // …while the server is still being asked
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    // Without the fix: still stored after any wait — closing the tab or reloading resumes A.
    expect(returned).toBe(true);
    expect(h.stored()).toBeNull();
    expect(clearCachedAuthToken).toHaveBeenCalled();
    expect(listKeys()).toEqual([]);
    expect(getLocalOwner()).toBeNull();
    expect(appStatus.getSnapshot().events[0]).toMatchObject({ level: 'warn', message: SIGN_OUT_SERVER_UNREACHABLE_NOTICE });
    // auth-js runs one call at a time: the announcement waits for the abandoned call.
    expect(otherTab).not.toContain('SIGNED_OUT');
    await act(async () => h.answerLogout!('error'));
    await flush();
    expect(otherTab).toContain('SIGNED_OUT');
    expect(h.stored()).toBeNull();
    expect(who()).toBe('signed-out');
  });

  it('a token refresh finishing inside the abandoned call (auth-js refreshes an expired session before POST /logout) does not sign the account back in', async () => {
    vi.useFakeTimers();
    await startAsA();
    const otherTab: string[] = [];
    h.listeners.push((event) => otherTab.push(event));
    h.hang = true;
    await act(async () => { void auth!.signOut(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(h.stored()).toBeNull();
    const readsBefore = settingsReads().length;
    // The refresh retried inside the abandoned call gets through: auth-js stores it and announces it.
    const late = { ...session(A), access_token: 't-A-refreshed-late' };
    h.store(late);
    await act(async () => h.emit('TOKEN_REFRESHED', late));
    await flush();
    expect(who()).toBe('signed-out');
    expect(getLocalOwner()).toBeNull();
    expect(settingsReads()).toHaveLength(readsBefore); // no login sync pulling A's keys back
    // POST /logout then fails as well: the session it stored goes too, and every tab is told.
    await act(async () => h.answerLogout!('error'));
    await flush();
    expect(h.stored()).toBeNull();
    expect(otherTab).toContain('SIGNED_OUT');
    expect(who()).toBe('signed-out');
  });

  it('signing in again while the abandoned call is still pending works, and that call’s late failure leaves the new session alone', async () => {
    vi.useFakeTimers();
    await startAsA();
    const otherTab: string[] = [];
    h.listeners.push((event) => otherTab.push(event));
    h.hang = true;
    await act(async () => { void auth!.signOut(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(who()).toBe('signed-out');
    // signInWithPassword in this tab (it takes no lock): stored, then announced.
    const again = { ...session(A), access_token: 't-A-signed-in-again' };
    h.store(again);
    await act(async () => h.emit('SIGNED_IN', again));
    await flush();
    expect(who()).toBe(A);
    await act(async () => h.answerLogout!('error'));
    await flush();
    expect(who()).toBe(A);
    expect(h.stored()?.access_token).toBe('t-A-signed-in-again');
    expect(otherTab).not.toContain('SIGNED_OUT');
    // Its own token refresh is acted on as ever.
    await act(async () => h.refreshTick());
    await flush();
    expect(who()).toBe(A);
    expect(auth!.session?.access_token).toBe('t-A-signed-in-again-refreshed');
  });

  it('"Sign out everywhere" while unreachable: the same on this device, and the notice says other devices stay signed in', async () => {
    await startAsA();
    h.offline = true;
    await act(async () => { await auth!.signOutAll(); });
    await flush();
    expect(who()).toBe('signed-out');
    expect(h.stored()).toBeNull();
    expect(appStatus.getSnapshot().events[0]).toMatchObject({ level: 'warn', message: SIGN_OUT_SERVER_UNREACHABLE_NOTICE });
    expect(SIGN_OUT_SERVER_UNREACHABLE_NOTICE).toMatch(/other devices/i);
  });

  it('control: a sign-out the server records needs no notice — SIGNED_OUT does the rest', async () => {
    await startAsA();
    await act(async () => { await auth!.signOut(); });
    await flush();
    expect(who()).toBe('signed-out');
    expect(h.stored()).toBeNull();
    expect(listKeys()).toEqual([]);
    expect(getLocalOwner()).toBeNull();
    expect(appStatus.getSnapshot().events).toEqual([]);
  });

  it('the inactivity sign-out at boot drops the session and purges even when the server cannot be reached', async () => {
    h.store(session(A));
    setLocalOwner(A);
    addKey({ provider: 'openai', key: 'sk-A-secret' });
    localStorage.setItem('dreamstream_last_active_at', String(Date.now() - INACTIVITY_SIGNOUT_MS - 1));
    const otherTab: string[] = [];
    h.listeners.push((event) => otherTab.push(event));
    h.offline = true;
    await mount();
    expect(who()).toBe('signed-out');
    expect(h.stored()).toBeNull();
    expect(otherTab).toContain('SIGNED_OUT');
    expect(listKeys()).toEqual([]);
    expect(getLocalOwner()).toBeNull();
    expect(settingsReads()).toEqual([]); // no login sync for a session on its way out
    await act(async () => h.refreshTick());
    await flush();
    expect(who()).toBe('signed-out');
  });
});
