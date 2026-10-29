// @vitest-environment jsdom
// The real services/supabase.ts: which announced session is THIS tab's, and the two helpers
// that touch only this tab's stored session. supabase-js announces every auth event to every
// tab of the origin (BroadcastChannel) without storing the session there; with "Remember me"
// off each tab keeps its own session in sessionStorage.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { forgetTabSession, isStoredSession, supabase } from './supabase';

const KEY = 'dreamstream_auth_token';
const PERSIST = 'dreamstream_auth_persist'; // what AuthPage's "Remember me" writes: 'session' when unticked
const stored = (token: string) => JSON.stringify({ access_token: token, refresh_token: 'r', user: { id: 'u' } });

afterAll(() => {
  void supabase.auth.stopAutoRefresh();
});
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('isStoredSession — is the announced session this tab’s?', () => {
  it('"Remember me" off and nothing stored here: a definite no (the tab holds no session at all)', () => {
    localStorage.setItem(PERSIST, 'session');
    // Without the fix: true ("can't tell") — the tab that asked for a magic link then adopts the
    // session the link's tab signed in to, without having it.
    expect(isStoredSession({ access_token: 'announced-by-the-tab-the-link-opened' })).toBe(false);
  });

  it('"Remember me" off with this tab’s own session stored: compared by token', () => {
    localStorage.setItem(PERSIST, 'session');
    sessionStorage.setItem(KEY, stored('mine'));
    expect(isStoredSession({ access_token: 'mine' })).toBe(true);
    expect(isStoredSession({ access_token: 'another-tabs' })).toBe(false);
  });

  it('"Remember me" on: storage is shared — compared by token, and when nothing is stored it can’t tell (true)', () => {
    localStorage.setItem(KEY, stored('shared'));
    expect(isStoredSession({ access_token: 'shared' })).toBe(true);
    expect(isStoredSession({ access_token: 'stale' })).toBe(false);
    localStorage.removeItem(KEY);
    expect(isStoredSession({ access_token: 'anything' })).toBe(true);
  });

  it('nothing to compare: true (sign-outs are honoured by callers)', () => {
    localStorage.setItem(PERSIST, 'session');
    expect(isStoredSession(null)).toBe(true);
    expect(isStoredSession({ access_token: null })).toBe(true);
  });

  it('reads either storage, without moving the token', () => {
    localStorage.setItem(PERSIST, 'session');
    localStorage.setItem(KEY, stored('left-by-an-older-build'));
    expect(isStoredSession({ access_token: 'left-by-an-older-build' })).toBe(true);
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem(KEY)).not.toBeNull();
  });
});

describe('this tab’s stored session', () => {
  it('forgetTabSession touches only the per-tab store (a shared "Remember me" session is every tab’s)', () => {
    localStorage.setItem(KEY, stored('remembered'));
    sessionStorage.setItem(KEY, stored('not-remembered'));
    forgetTabSession();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem(KEY)).not.toBeNull();
  });
});
