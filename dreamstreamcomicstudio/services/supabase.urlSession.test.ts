// @vitest-environment jsdom
// The real services/supabase.ts (real supabase-js / GoTrueClient), only `fetch` stubbed:
//  - tokens in the address bar are never adopted by the client on its own (any path);
//  - a plain load of '/' recovers the stored session normally (no "No session defined in URL");
//  - boot records which account owns this device's data — from a "Remember me" session in
//    localStorage or a not-remembered one in sessionStorage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const A = '11111111-1111-4111-8111-111111111111';
const STORAGE_KEY = 'dreamstream_auth_token';
const now = () => Math.round(Date.now() / 1000);
const user = (id: string) => ({ id, aud: 'authenticated', role: 'authenticated', email: 'a@example.com', app_metadata: {}, user_metadata: {}, created_at: '' });
const stored = (id: string) =>
  JSON.stringify({ access_token: 'stored', refresh_token: 'r1', expires_in: 3600, expires_at: now() + 3600, token_type: 'bearer', user: user(id) });

let fetchCalls: string[] = [];

const boot = async (path: string) => {
  window.history.replaceState(null, '', path);
  vi.resetModules();
  const mod = await import('./supabase');
  const init = await mod.supabase.auth.initialize();
  const { data } = await mod.supabase.auth.getSession();
  mod.supabase.auth.stopAutoRefresh();
  return { init, session: data.session, mod };
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  fetchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return new Response(JSON.stringify(user('99999999-9999-4999-8999-999999999999')), { status: 200, headers: { 'content-type': 'application/json' } });
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('supabase client — no silent adoption from the URL', () => {
  it('a tokenless / recovers the stored session without errors or network', async () => {
    localStorage.setItem(STORAGE_KEY, stored(A));
    const { init, session } = await boot('/');
    expect(init.error).toBeNull();
    expect(session?.user.id).toBe(A);
    expect(fetchCalls).toEqual([]);
  });

  for (const path of ['/', '/auth/callback', '/live', '/models']) {
    it(`#access_token on ${path} is left for the page to decide (never adopted by the client)`, async () => {
      localStorage.setItem(STORAGE_KEY, stored(A));
      const { init, session } = await boot(`${path}#access_token=attacker&refresh_token=rt&expires_in=3600&expires_at=${now() + 3600}&token_type=bearer&type=magiclink`);
      expect(init.error).toBeNull();
      expect(session?.access_token).toBe('stored');
      expect(session?.user.id).toBe(A);
      expect(fetchCalls).toEqual([]); // no /user lookup for the URL's token
      expect(window.location.hash).toContain('access_token=attacker'); // untouched: App/Stream Studio handle it
    });
  }

  it('signed out + tokens in the URL: still no session', async () => {
    const { session } = await boot('/#access_token=attacker&refresh_token=rt&type=magiclink');
    expect(session).toBeNull();
  });
});

describe('lookupAccessTokenEmail — naming a link’s account on the confirm step', () => {
  it('asks the auth server with the link’s token and reads the email', async () => {
    const { mod } = await boot('/');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push(String(input));
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer link-token');
        return new Response(JSON.stringify({ ...user(A), email: 'mallory@example.com' }), { status: 200, headers: { 'content-type': 'application/json' } });
      })
    );
    expect(await mod.lookupAccessTokenEmail('link-token')).toEqual({ email: 'mallory@example.com', dead: false });
    expect(fetchCalls).toEqual(['https://placeholder.supabase.co/auth/v1/user']);
  });

  it('a token whose session is gone is reported dead — and the visitor stays signed in', async () => {
    localStorage.setItem(STORAGE_KEY, stored(A));
    const { mod } = await boot('/');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ code: 'session_not_found', message: 'Session not found' }), { status: 403, headers: { 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' } }))
    );
    expect(await mod.lookupAccessTokenEmail('revoked')).toEqual({ email: null, dead: true });
    const { data } = await mod.supabase.auth.getSession();
    expect(data.session?.user.id).toBe(A);
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('offline (or slow) is unknown, never dead — the link can still be tried', async () => {
    const { mod } = await boot('/');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await mod.lookupAccessTokenEmail('t')).toEqual({ email: null, dead: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
    expect(await mod.lookupAccessTokenEmail('t')).toEqual({ email: null, dead: false });
  });
});

describe('isStoredSession — is this event’s session the one THIS tab holds?', () => {
  // supabase-js broadcasts every auth event to every tab without storing the session there. With
  // "Remember me" off each tab keeps its own session (sessionStorage), so a session another tab
  // announced must not be acted on here.
  it('matches the session stored for this tab (either storage), and nothing else', async () => {
    localStorage.setItem('dreamstream_auth_persist', 'session');
    sessionStorage.setItem(STORAGE_KEY, stored(A));
    const { mod } = await boot('/');
    expect(mod.isStoredSession({ access_token: 'stored' })).toBe(true);
    expect(mod.isStoredSession({ access_token: 'announced-by-another-tab' })).toBe(false);
    // "Remember me" on: the shared localStorage copy is this tab's too.
    sessionStorage.clear();
    localStorage.setItem('dreamstream_auth_persist', 'local');
    localStorage.setItem(STORAGE_KEY, stored(A));
    expect(mod.isStoredSession({ access_token: 'stored' })).toBe(true);
    expect(mod.isStoredSession({ access_token: 'other' })).toBe(false);
  });

  it('with nothing stored (a signed-out tab, blocked storage) or no session it cannot tell — and says so by not refusing', async () => {
    const { mod } = await boot('/');
    expect(mod.isStoredSession({ access_token: 'anything' })).toBe(true);
    expect(mod.isStoredSession(null)).toBe(true);
    expect(mod.isStoredSession(undefined)).toBe(true);
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(mod.isStoredSession({ access_token: 'anything' })).toBe(true);
  });
});

describe('forgetTabSession — this tab steps aside without signing anyone out', () => {
  // Another tab switched the device to another account ("Remember me" off: one session per tab).
  it('drops the not-remembered session this tab holds: getSession is empty from then on, no SIGNED_OUT is announced, no /logout is called — and a shared "Remember me" session is not this tab’s to drop', async () => {
    localStorage.setItem('dreamstream_auth_persist', 'session');
    sessionStorage.setItem(STORAGE_KEY, stored(A));
    const { mod, session } = await boot('/');
    expect(session?.user.id).toBe(A);
    const events: string[] = [];
    mod.supabase.auth.onAuthStateChange((event) => {
      events.push(event);
    });
    mod.forgetTabSession();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    const { data } = await mod.supabase.auth.getSession();
    expect(data.session).toBeNull(); // supabase-js reads the session from storage: this tab has none now
    await new Promise((r) => setTimeout(r, 0));
    expect(events.filter((e) => e === 'SIGNED_OUT')).toEqual([]); // nothing announced to other tabs
    expect(fetchCalls).toEqual([]); // no /logout: the other tab's session stays valid
    // "Remember me" on: the localStorage copy is shared with every tab and stays.
    localStorage.setItem(STORAGE_KEY, stored(A));
    mod.forgetTabSession();
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });
});

describe('boot adoption of the device owner', () => {
  it('adopts the account of a "Remember me" session (localStorage)', async () => {
    localStorage.setItem(STORAGE_KEY, stored(A));
    const { mod } = await boot('/');
    const { getLocalOwner, getUnownedDataOwner } = await import('./localOwner');
    expect(getLocalOwner()).toBe(A);
    expect(getUnownedDataOwner()).toBe(A);
    expect(mod.getAuthPersistMode()).toBe('local');
  });

  it('adopts the account of a not-remembered session (sessionStorage)', async () => {
    localStorage.setItem('dreamstream_auth_persist', 'session');
    sessionStorage.setItem(STORAGE_KEY, stored(A));
    const { session } = await boot('/');
    const { getLocalOwner } = await import('./localOwner');
    expect(getLocalOwner()).toBe(A);
    expect(session?.user.id).toBe(A);
  });

  it('…also when the preference and the storage disagree (the self-healing read)', async () => {
    sessionStorage.setItem(STORAGE_KEY, stored(A)); // preference says "local"
    await boot('/');
    const { getLocalOwner } = await import('./localOwner');
    expect(getLocalOwner()).toBe(A);
  });

  it('no stored session: no owner yet', async () => {
    await boot('/');
    const { getLocalOwner } = await import('./localOwner');
    expect(getLocalOwner()).toBeNull();
  });
});
