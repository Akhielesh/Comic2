// @vitest-environment jsdom
// ADR 0006 WS-5: the session lifecycle (ds:token, revoked sessions, the two-step code), both
// sign-out paths and the TOTP helpers in live/account.ts + live/sync.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AuthCb = (event: string, session: { access_token: string } | null) => void;

const h = vi.hoisted(() => {
  const state = {
    session: { access_token: 'tok-1', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'ada@example.com', user_metadata: {} } } as Record<string, unknown> | null,
    aal: { currentLevel: 'aal1', nextLevel: 'aal1' } as { currentLevel: string; nextLevel: string },
    me: { member: true, profile: { display_name: 'Ada' } } as Record<string, unknown>,
    factors: [] as { id: string; factor_type: string; status: string; friendly_name?: string; created_at: string }[],
    authCb: null as AuthCb | null,
    /** Other RPCs' answers by name ({data, error}); live_me answers `me` (or `meError`). */
    rpcs: {} as Record<string, { data: unknown; error: unknown }>,
    meError: null as { message: string } | null,
  };
  const auth = {
    getSession: vi.fn(async () => ({ data: { session: state.session } })),
    refreshSession: vi.fn(async () => ({ data: { session: state.session }, error: null })),
    signOut: vi.fn(async (_o?: { scope?: string }) => {
      state.session = null;
      return { error: null as unknown };
    }),
    onAuthStateChange: vi.fn((cb: AuthCb) => {
      state.authCb = cb;
      return { data: { subscription: { unsubscribe: () => undefined } } };
    }),
    updateUser: vi.fn(async () => ({ data: {}, error: null })),
    signInWithPassword: vi.fn(async (_p: { email: string; password: string }) => {
      state.session = { ...(state.session ?? {}), access_token: 'tok-fresh' };
      return { data: {}, error: null as unknown };
    }),
    admin: { signOut: vi.fn(async (_jwt: string, _scope?: string) => ({ data: null, error: null })) },
    getUser: vi.fn(async (_t?: string) => ({ data: { user: { id: 'u1' } }, error: null as unknown })),
    mfa: {
      getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: state.aal, error: null })),
      listFactors: vi.fn(async () => ({ data: { all: state.factors, totp: state.factors.filter((f) => f.status === 'verified') }, error: null })),
      enroll: vi.fn(async (_p: Record<string, unknown>) => ({ data: { id: 'f-new', type: 'totp', totp: { qr_code: 'data:image/svg+xml;utf-8,<svg/>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' } }, error: null as unknown })),
      challengeAndVerify: vi.fn(async (_p: Record<string, unknown>) => ({ data: {}, error: null as unknown })),
      unenroll: vi.fn(async (_p: Record<string, unknown>) => ({ data: {}, error: null as unknown })),
    },
  };
  const rpc = vi.fn(async (fn: string, _args?: Record<string, unknown>) =>
    fn === 'live_me' ? (state.meError ? { data: null, error: state.meError } : { data: state.me, error: null }) : (state.rpcs[fn] ?? { data: null, error: null }),
  );
  return { state, auth, rpc };
});

vi.mock('@/services/supabase', () => ({ supabase: { auth: h.auth, rpc: h.rpc }, lookupAccessTokenEmail: vi.fn() }));
vi.mock('@/services/authEmail', () => ({ requestAuthEmail: vi.fn(), EMAIL_SERVICE_DOWN: 'down' }));

type AccountModule = typeof import('./account');
let account: AccountModule;
const fetchMock = vi.fn();

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  h.state.session = { access_token: 'tok-1', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'ada@example.com', user_metadata: {} } };
  h.state.aal = { currentLevel: 'aal1', nextLevel: 'aal1' };
  h.state.me = { member: true, profile: { display_name: 'Ada' } };
  h.state.factors = [];
  h.state.authCb = null;
  h.state.rpcs = {};
  h.state.meError = null;
  for (const fn of [h.auth.getSession, h.auth.signOut, h.auth.refreshSession, h.auth.signInWithPassword, h.auth.admin.signOut, h.rpc, ...Object.values(h.auth.mfa)]) (fn as ReturnType<typeof vi.fn>).mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  account = await import('./account');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ds:token — open sockets re-authenticate with every new token', () => {
  it('fires on sign-in, refresh and the two-step upgrade; once per token; never on other events', async () => {
    await account.refreshAccount();
    const seen: string[] = [];
    window.addEventListener(account.TOKEN_EVENT, (e) => seen.push((e as CustomEvent<string>).detail));
    const cb = h.state.authCb!;
    cb('TOKEN_REFRESHED', { access_token: 'tok-2' });
    cb('TOKEN_REFRESHED', { access_token: 'tok-2' }); // same token: no second reauth
    cb('MFA_CHALLENGE_VERIFIED', { access_token: 'tok-aal2' });
    cb('USER_UPDATED', { access_token: 'tok-x' });
    cb('INITIAL_SESSION', { access_token: 'tok-y' });
    cb('SIGNED_IN', { access_token: 'tok-3' });
    expect(seen).toEqual(['tok-2', 'tok-aal2', 'tok-3']);
    expect(account.TOKEN_EVENT).toBe('ds:token');
  });
});

describe('a session ended elsewhere', () => {
  it('signs this device out and says why, instead of looking "offline"', async () => {
    h.state.me = { signed_in: false, member: false, error: 'session_revoked' };
    localStorage.setItem('ds-live-my-events', '[{"id":"e1","hostKey":"secret"}]');
    const a = await account.refreshAccount();
    expect(a).toEqual({ status: 'signed_out', ended: 'revoked' });
    expect(h.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(localStorage.getItem('ds-live-my-events')).toBeNull(); // host keys never outlive the session
  });

  it('a second check that overlaps it (and then finds no session) keeps the reason — the notice isn’t lost', async () => {
    h.state.me = { signed_in: false, member: false, error: 'session_revoked' };
    expect(await account.refreshAccount()).toEqual({ status: 'signed_out', ended: 'revoked' });
    // The other screen's check, a moment later: the session is gone now.
    expect(await account.refreshAccount()).toEqual({ status: 'signed_out', ended: 'revoked' });
    // A sign-in and an ordinary sign-out later, there's no reason left to tell.
    h.state.session = { access_token: 'tok-2', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'ada@example.com', user_metadata: {} } };
    h.state.me = { member: true, profile: { display_name: 'Ada' } };
    expect((await account.refreshAccount()).status).toBe('member');
    await account.signOutThisDevice();
    expect(await account.refreshAccount()).toEqual({ status: 'signed_out' });
  });
});

describe('two-step sign-in at sign-in', () => {
  it('turning it on elsewhere never shuts a device that was already signed in — the nursery camera keeps watching', async () => {
    // Supabase lists an authenticator and this session is aal1, but the server says this session
    // was signed in before two-step sign-in was switched on: it stays a member (no code asked).
    h.state.aal = { currentLevel: 'aal1', nextLevel: 'aal2' };
    h.state.me = { member: true, mfa: true, aal: 'aal1', mfa_grace: true, profile: { display_name: 'Ada' } };
    const a = await account.refreshAccount();
    expect(a).toMatchObject({ status: 'member', mfa: true, aal: 'aal1', mfaGrace: true });
    // …and it isn't enforced on this device alone before the server does (no SQL yet: no mfa field).
    h.state.me = { member: true, profile: { display_name: 'Ada' } };
    expect((await account.refreshAccount()).status).toBe('member');
  });

  it('asks for the code when the server says mfa_required (live_security_v2.sql applied)', async () => {
    h.state.me = { signed_in: true, member: false, error: 'mfa_required', mfa_required: true, needs_code: false };
    const a = await account.refreshAccount();
    expect(a.status).toBe('needs_mfa');
    expect(h.rpc).not.toHaveBeenCalledWith('live_join', expect.anything());
  });

  it('is a member once the code was given, and knows two-step sign-in is on', async () => {
    h.state.aal = { currentLevel: 'aal2', nextLevel: 'aal2' };
    h.state.me = { member: true, mfa: true, aal: 'aal2', profile: { display_name: 'Ada' } };
    const a = await account.refreshAccount();
    expect(a).toMatchObject({ status: 'member', name: 'Ada', mfa: true });
  });

  it('works exactly as before for an account without an authenticator (and without the new SQL)', async () => {
    const a = await account.refreshAccount();
    expect(a).toMatchObject({ status: 'member' });
    expect(a.mfa).toBeUndefined(); // not known: no "turn it on" nudge until the server can run it
    h.state.me = { member: true, mfa: false, aal: 'aal1', profile: { display_name: 'Ada' } };
    expect(await account.refreshAccount()).toMatchObject({ status: 'member', mfa: false });
  });

  it('a request that fails while already signed in never signs a running monitor out of its screen', async () => {
    await account.refreshAccount();
    expect(account.getAccount().status).toBe('member');
    h.state.meError = { message: 'TypeError: Failed to fetch' };
    expect((await account.refreshAccount()).status).toBe('member');
    // A fresh page that can't reach the server says so.
    vi.resetModules();
    account = await import('./account');
    expect((await account.refreshAccount()).status).toBe('offline');
  });

  it('a reload while the internet is down (the stored session can’t be refreshed) is never "signed out", and wipes nothing', async () => {
    // Stream Studio's sign-in gate shows the sign-in screen only for a definite "signed out": a camera
    // phone reloaded during an outage must not land there, nor lose its nursery data.
    localStorage.setItem('ds-live-owner', 'u1');
    localStorage.setItem('ds-monitor-zones-n1', '[{"x":1}]');
    const unreachable = Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 });
    h.auth.getSession.mockResolvedValueOnce({ data: { session: null }, error: unreachable } as never);
    expect((await account.refreshAccount()).status).toBe('offline');
    expect(localStorage.getItem('ds-live-owner')).toBe('u1');
    expect(localStorage.getItem('ds-monitor-zones-n1')).toBe('[{"x":1}]');
    // Back online: in, as before.
    expect((await account.refreshAccount()).status).toBe('member');
    // Already in: a failed session read (unreachable, or thrown) keeps the member.
    h.auth.getSession.mockResolvedValueOnce({ data: { session: null }, error: unreachable } as never);
    expect((await account.refreshAccount()).status).toBe('member');
    h.auth.getSession.mockRejectedValueOnce(new Error('storage unavailable'));
    expect((await account.refreshAccount()).status).toBe('member');
  });

  it('a refresh token the server rejected IS signed out (the session is gone)', async () => {
    const rejected = Object.assign(new Error('Invalid Refresh Token: Refresh Token Not Found'), { name: 'AuthApiError', status: 400 });
    h.auth.getSession.mockResolvedValueOnce({ data: { session: null }, error: rejected } as never);
    expect((await account.refreshAccount()).status).toBe('signed_out');
  });

  it('picks up changes made elsewhere: after a token refresh and when the code was given in another tab', async () => {
    h.state.me = { signed_in: true, member: false, error: 'mfa_required', mfa_required: true, needs_code: false };
    expect((await account.refreshAccount()).status).toBe('needs_mfa');
    // Another tab typed the code: this tab hears MFA_CHALLENGE_VERIFIED and leaves needs_mfa.
    h.state.me = { member: true, mfa: true, aal: 'aal2', profile: { display_name: 'Ada' } };
    h.state.authCb!('MFA_CHALLENGE_VERIFIED', { access_token: 'tok-aal2' });
    await vi.waitFor(() => expect(account.getAccount().status).toBe('member'));
    // Turned off on another device: the next token refresh shows it.
    h.state.me = { member: true, mfa: false, aal: 'aal1', profile: { display_name: 'Ada' } };
    h.state.authCb!('TOKEN_REFRESHED', { access_token: 'tok-r' });
    await vi.waitFor(() => expect(account.getAccount().mfa).toBe(false));
  });

  it('"Sign in" anywhere in the app asks for the code rather than starting over', async () => {
    h.state.me = { signed_in: true, member: false, error: 'mfa_required', mfa_required: true, needs_code: false };
    await account.refreshAccount();
    const sheet = vi.fn();
    const code = vi.fn();
    account.registerAuthOpener(sheet);
    account.registerSecondStepOpener(code);
    account.openAuth('signin');
    expect(code).toHaveBeenCalledTimes(1);
    expect(sheet).not.toHaveBeenCalled();
  });
});

describe('sign out of this device', () => {
  it('ends only this session and wipes what the account left here', async () => {
    await account.refreshAccount();
    localStorage.setItem('ds-monitor-push-11111111-2222-4333-8444-555555555555', '1');
    localStorage.setItem('ds-theme', 'dark'); // a device preference, not personal: stays
    await account.signOutThisDevice();
    expect(h.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(h.auth.signOut).not.toHaveBeenCalledWith({ scope: 'global' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(account.getAccount().status).toBe('signed_out');
    expect(localStorage.getItem('ds-monitor-push-11111111-2222-4333-8444-555555555555')).toBeNull();
    expect(localStorage.getItem('ds-theme')).toBe('dark');
  });
});

describe('signing out leaves no alert that can act for the person who left', () => {
  it('closes the alerts on screen and tells the service worker (no "I’m on it" from before)', async () => {
    const close = vi.fn();
    const postMessage = vi.fn();
    const reg = {
      active: { postMessage },
      getNotifications: vi.fn(async () => [{ tag: 'n-cry', close }]),
      pushManager: { getSubscription: async () => null },
    };
    const sw = { getRegistration: vi.fn(async () => reg) };
    Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
    try {
      await account.refreshAccount();
      await account.signOutThisDevice();
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(postMessage).toHaveBeenCalledWith({ t: 'ds-signed-out' });
    } finally {
      Reflect.deleteProperty(navigator, 'serviceWorker');
    }
  });
});

describe('sign out everywhere', () => {
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('kicks every socket with the still-valid token FIRST, then ends every session, then wipes this device', async () => {
    await account.refreshAccount();
    const order: string[] = [];
    fetchMock.mockImplementation(async () => {
      order.push('kick');
      return ok({ ok: true });
    });
    h.auth.signOut.mockImplementationOnce(async (o?: { scope?: string }) => {
      order.push(`signOut:${o?.scope}`);
      h.state.session = null;
      return { error: null };
    });
    localStorage.setItem('ds-live-my-events', '[]');
    const r = await account.signOutEverywhere();
    expect(order).toEqual(['kick', 'signOut:global']);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/me\/kick$/);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
    expect(r).toEqual({ kicked: true, global: true });
    expect(account.signOutEverywhereMessage(r)).toMatch(/disconnected/);
    expect(localStorage.getItem('ds-live-my-events')).toBeNull();
    expect(account.getAccount().status).toBe('signed_out');
  });

  it('still ends every session when the kick route is missing — and says sockets may linger', async () => {
    await account.refreshAccount();
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));
    const r = await account.signOutEverywhere();
    expect(h.auth.signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(r).toEqual({ kicked: false, global: true });
    expect(account.signOutEverywhereMessage(r)).toMatch(/stays connected until it next reconnects/);
  });

  it('a kick that answers without ok:true is not reported as one', async () => {
    await account.refreshAccount();
    fetchMock.mockResolvedValue(ok({ ok: false, failed: 1 }));
    expect((await account.signOutEverywhere()).kicked).toBe(false);
  });

  it('offline: only this device signs out, and the message says so', async () => {
    await account.refreshAccount();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    h.auth.signOut.mockImplementationOnce(async () => {
      h.state.session = null; // supabase-js drops the local session even when the server call fails
      return { error: { status: 0, message: 'Failed to fetch' } };
    });
    const r = await account.signOutEverywhere();
    expect(r).toEqual({ kicked: false, global: false });
    expect(account.signOutEverywhereMessage(r)).toMatch(/only this device is signed out/);
    expect(account.getAccount().status).toBe('signed_out');
  });
});

describe('TOTP helpers', () => {
  it('enrolment clears half-done set-ups first and returns the QR code and setup key', async () => {
    h.state.factors = [{ id: 'stale', factor_type: 'totp', status: 'unverified', created_at: '2026-10-01' }];
    const r = await account.enrollTotp();
    expect(h.auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: 'stale' });
    expect(h.auth.mfa.enroll).toHaveBeenCalledWith(expect.objectContaining({ factorType: 'totp', issuer: 'DreamStream' }));
    expect(r).toEqual({ ok: true, factorId: 'f-new', qr: 'data:image/svg+xml;utf-8,<svg/>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' });
  });

  it('enrolment explains a server with TOTP switched off', async () => {
    h.auth.mfa.enroll.mockResolvedValueOnce({ data: null as never, error: { code: 'mfa_totp_enroll_not_enabled', status: 422, message: 'MFA enroll is disabled for TOTP' } });
    const r = await account.enrollTotp();
    expect(r).toMatchObject({ ok: false, code: 'disabled' });
  });

  it('verify sends the 6 digits (spaces and dashes ignored), switches it on with the server and returns the recovery codes', async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `abcd-efgh-jk${i}m`);
    h.state.rpcs.live_mfa_activate = { data: { ok: true, first: true, codes }, error: null };
    const r = await account.verifyTotp('f-new', ' 123-456 ');
    expect(h.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'f-new', code: '123456' });
    expect(h.rpc).toHaveBeenCalledWith('live_mfa_activate', { p_factor: 'f-new' });
    expect(r).toEqual({ ok: true, first: true, codes });
    expect(h.rpc).toHaveBeenCalledWith('live_me', {});
    expect(h.auth.mfa.unenroll).not.toHaveBeenCalled();
  });

  it('never leaves an authenticator half-on: if the server won’t switch it on, it is removed again', async () => {
    // A stale session (no fresh sign-in): the server refuses — the authenticator goes, and the person is told why.
    h.state.rpcs.live_mfa_activate = { data: { ok: false, error: 'reauth_required' }, error: null };
    expect(await account.verifyTotp('f-new', '123456')).toMatchObject({ ok: false, code: 'reauth' });
    expect(h.auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: 'f-new' });
    // The server can't run two-step sign-in yet (no recovery codes, no undo): not switched on.
    h.auth.mfa.unenroll.mockClear();
    h.state.rpcs.live_mfa_activate = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
    expect(await account.verifyTotp('f-new', '123456')).toMatchObject({ ok: false, code: 'disabled' });
    expect(h.auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: 'f-new' });
  });

  it('re-authentication: how long since the password (or an email link) was last used on this session', async () => {
    const jwt = (amr: unknown) => `x.${btoa(JSON.stringify({ amr })).replace(/=+$/, '')}.y`;
    const now = 1_800_000_000_000;
    expect(account.secondsSinceSignIn(jwt([{ method: 'password', timestamp: now / 1000 - 120 }, { method: 'totp', timestamp: now / 1000 }]), now)).toBe(120);
    // A code alone is not a sign-in; neither is a refresh.
    expect(account.secondsSinceSignIn(jwt([{ method: 'totp', timestamp: now / 1000 }]), now)).toBe(Infinity);
    expect(account.secondsSinceSignIn(jwt([{ method: 'magiclink', timestamp: now / 1000 - 30 }]), now)).toBe(30);
    expect(account.secondsSinceSignIn('garbage', now)).toBe(Infinity);
    expect(account.REAUTH_FRESH_S).toBe(600);
  });

  it('confirming the password signs in afresh and ends the session it replaces; a wrong password changes nothing', async () => {
    expect(await account.confirmPassword('correct horse')).toEqual({ ok: true });
    expect(h.auth.signInWithPassword).toHaveBeenCalledWith({ email: 'ada@example.com', password: 'correct horse' });
    expect(h.auth.admin.signOut).toHaveBeenCalledWith('tok-1', 'local');
    h.auth.signInWithPassword.mockResolvedValueOnce({ data: {}, error: { code: 'invalid_credentials', message: 'Invalid login credentials' } });
    h.auth.admin.signOut.mockClear();
    expect(await account.confirmPassword('nope')).toMatchObject({ ok: false, code: 'wrong_password' });
    expect(h.auth.admin.signOut).not.toHaveBeenCalled();
  });

  it('lost phone: a recovery code gets the parent back in (two-step sign-in off, set it up again)', async () => {
    h.state.me = { signed_in: true, member: false, error: 'mfa_required', mfa_required: true, needs_code: false };
    expect((await account.refreshAccount()).status).toBe('needs_mfa');
    expect(await account.recoverWithCode('abc')).toMatchObject({ ok: false, code: 'recovery_invalid' });
    h.state.rpcs.live_mfa_recover = { data: { ok: false, error: 'invalid_code' }, error: null };
    expect(await account.recoverWithCode('abcd-efgh-jkmn')).toMatchObject({ ok: false, code: 'recovery_invalid' });
    h.state.rpcs.live_mfa_recover = { data: { ok: false, error: 'too_many' }, error: null };
    expect(await account.recoverWithCode('abcd-efgh-jkmn')).toMatchObject({ ok: false, code: 'recovery_locked' });
    h.state.rpcs.live_mfa_recover = { data: { ok: true, removed: 2 }, error: null };
    h.state.me = { member: true, mfa: false, aal: 'aal1', profile: { display_name: 'Ada' } };
    expect(await account.recoverWithCode('ABCD EFGH JKMN')).toEqual({ ok: true, removed: 2 });
    expect(h.rpc).toHaveBeenCalledWith('live_mfa_recover', { p_code: 'ABCD EFGH JKMN' });
    expect(h.auth.refreshSession).toHaveBeenCalled();
    expect(account.getAccount()).toMatchObject({ status: 'member', mfa: false });
  });

  it('a wrong code is explained, not thrown', async () => {
    h.auth.mfa.challengeAndVerify.mockResolvedValueOnce({ data: {}, error: { code: 'mfa_verification_failed', status: 422, message: 'Invalid TOTP code entered' } });
    expect(await account.verifyTotp('f-new', '000000')).toMatchObject({ ok: false, code: 'invalid_code' });
    expect(await account.verifyTotp('f-new', '12')).toMatchObject({ ok: false, code: 'invalid_code' });
  });

  it('step-up uses the verified authenticator; with none there is nothing to step up to', async () => {
    // Stuck on "Enter code" after two-step sign-in was turned off on another device: the fresh
    // factor list is empty, so the session and the account are brought up to date — no dead end.
    h.state.me = { signed_in: true, member: false, error: 'mfa_required', mfa_required: true, needs_code: false };
    expect((await account.refreshAccount()).status).toBe('needs_mfa');
    h.state.me = { member: true, mfa: false, aal: 'aal1', profile: { display_name: 'Ada' } };
    expect(await account.stepUp('123456')).toEqual({ ok: true });
    expect(h.auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
    expect(h.auth.refreshSession).toHaveBeenCalled();
    expect(account.getAccount().status).toBe('member');
    h.state.factors = [{ id: 'f1', factor_type: 'totp', status: 'verified', created_at: '2026-10-01' }];
    expect(await account.stepUp('654321')).toEqual({ ok: true });
    expect(h.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'f1', code: '654321' });
  });

  it('step-up accepts a code from ANY verified authenticator — losing the first phone never locks a parent out', async () => {
    h.state.factors = [
      { id: 'f1', factor_type: 'totp', status: 'verified', friendly_name: 'Authenticator 1', created_at: '2026-10-01' },
      { id: 'f2', factor_type: 'totp', status: 'verified', friendly_name: 'Authenticator 2', created_at: '2026-10-05' },
    ];
    const wrong = { data: {}, error: { code: 'mfa_verification_failed', status: 422, message: 'Invalid TOTP code entered' } };
    // Each authenticator has its own secret: a code fits exactly one of them, whichever it is.
    try {
      for (const fits of ['f1', 'f2']) {
        h.auth.mfa.challengeAndVerify.mockClear();
        h.auth.mfa.challengeAndVerify.mockImplementation(async (p: Record<string, unknown>) => (p.factorId === fits ? { data: {}, error: null } : wrong));
        expect(await account.stepUp('123456'), fits).toEqual({ ok: true });
        const tried = h.auth.mfa.challengeAndVerify.mock.calls.map(([p]) => (p as { factorId: string }).factorId);
        expect(tried).toContain(fits);
        expect(tried.at(-1)).toBe(fits); // stops at the one that fits
      }
      // A code no authenticator makes is still refused, after every one was asked.
      h.auth.mfa.challengeAndVerify.mockClear();
      h.auth.mfa.challengeAndVerify.mockImplementation(async () => wrong);
      expect(await account.stepUp('000000')).toMatchObject({ ok: false, code: 'invalid_code' });
      expect(h.auth.mfa.challengeAndVerify).toHaveBeenCalledTimes(2);
      // Too many tries is final: the other authenticators aren't asked (it would only burn more tries).
      h.auth.mfa.challengeAndVerify.mockClear();
      h.auth.mfa.challengeAndVerify.mockImplementation(async () => ({ data: {}, error: { code: 'over_request_rate_limit', status: 429, message: 'Too many requests' } }));
      expect(await account.stepUp('111111')).toMatchObject({ ok: false, code: 'rate_limited' });
      expect(h.auth.mfa.challengeAndVerify).toHaveBeenCalledTimes(1);
      // The person may also say which authenticator the code came from.
      h.auth.mfa.challengeAndVerify.mockClear();
      h.auth.mfa.challengeAndVerify.mockImplementation(async () => ({ data: {}, error: null }));
      expect(await account.stepUp('222222', 'f2')).toEqual({ ok: true });
      expect(h.auth.mfa.challengeAndVerify).toHaveBeenCalledExactlyOnceWith({ factorId: 'f2', code: '222222' });
    } finally {
      h.auth.mfa.challengeAndVerify.mockImplementation(async () => ({ data: {}, error: null }));
    }
  });

  it('knows when an admin action needs the code first — asked of the server each time, never a stale copy on this device', async () => {
    expect(await account.stepUpNeeded()).toBe(false);
    // The session cached here still lists an authenticator that was removed elsewhere: no code asked.
    h.state.aal = { currentLevel: 'aal1', nextLevel: 'aal2' };
    h.state.me = { member: true, mfa: false, aal: 'aal1' };
    expect(await account.stepUpNeeded()).toBe(false);
    // Turned on elsewhere (nothing cached here knows yet): the code is asked for.
    h.state.aal = { currentLevel: 'aal1', nextLevel: 'aal1' };
    h.state.me = { member: true, mfa: true, aal: 'aal1', mfa_grace: true };
    expect(await account.stepUpNeeded()).toBe(true);
    h.state.me = { signed_in: true, member: false, error: 'mfa_required' };
    expect(await account.stepUpNeeded()).toBe(true);
    h.state.me = { member: true, mfa: true, aal: 'aal2' };
    expect(await account.stepUpNeeded()).toBe(false);
    expect(h.auth.mfa.getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
  });

  it('status is the server’s: authenticators switched on, recovery codes left, whether this session may watch without the code', async () => {
    h.state.rpcs.live_mfa_status = {
      data: { ok: true, on: true, aal: 'aal1', grace: true, codes_left: 8, factors: [{ id: 'f1', name: 'Authenticator 1', created_at: '2026-10-01' }] },
      error: null,
    };
    expect(await account.mfaStatus()).toEqual({
      ok: true,
      on: true,
      factors: [{ id: 'f1', name: 'Authenticator 1', createdAt: '2026-10-01' }],
      aal: 'aal1',
      available: true,
      codesLeft: 8,
      grace: true,
    });
    // Before the server can run it: off, and not available (it can't be turned on yet).
    h.state.rpcs.live_mfa_status = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
    expect(await account.mfaStatus()).toMatchObject({ ok: true, on: false, available: false });
  });

  it('turning it off needs aal2 — the password alone can’t', async () => {
    h.auth.mfa.unenroll.mockResolvedValueOnce({ data: {}, error: { code: 'insufficient_aal', status: 403, message: 'AAL2 required' } });
    expect(await account.unenrollTotp('f1')).toMatchObject({ ok: false, code: 'step_up' });
    expect(await account.unenrollTotp('f1')).toEqual({ ok: true });
    expect(h.auth.refreshSession).toHaveBeenCalled();
  });
});

describe('signing one device out', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const ID = 'd-1';

  it('through the live Worker, which tells every nursery: confirmed only when every room heard', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, already: false, rooms: 2, told: 2 }));
    expect(await account.revokeMyDevice(ID)).toEqual({ ok: true, confirmed: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/devices\/d-1$/);
    expect(init.method).toBe('DELETE');
    expect(h.rpc).not.toHaveBeenCalledWith('live_device_revoke', expect.anything());
    // One room didn't answer: signed out of the account, but not confirmed everywhere — retry stays.
    fetchMock.mockResolvedValueOnce(json({ ok: true, already: false, rooms: 2, told: 1 }));
    expect(await account.revokeMyDevice(ID)).toEqual({ ok: true, confirmed: false });
    expect(account.unconfirmedRevokes()).toContain(ID);
    fetchMock.mockResolvedValueOnce(json({ ok: true, already: true, rooms: 2, told: 2 }));
    expect(await account.revokeMyDevice(ID)).toEqual({ ok: true, confirmed: true });
    expect(account.unconfirmedRevokes()).not.toContain(ID);
  });

  it('a Worker that fails (busy, rate limited, offline) is NOT papered over with the plain revoke: nothing changes, and it can be retried', async () => {
    h.state.rpcs.live_device_revoke = { data: { ok: true }, error: null };
    for (const failure of [json({ error: 'unavailable' }, 503), json({ ok: false, error: 'rate_limited' }, 429), json({ error: 'internal error' }, 500)]) {
      fetchMock.mockResolvedValueOnce(failure);
      expect(await account.revokeMyDevice(ID)).toMatchObject({ ok: false, error: 'retry' });
    }
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await account.revokeMyDevice(ID)).toMatchObject({ ok: false, error: 'retry' });
    expect(h.rpc).not.toHaveBeenCalledWith('live_device_revoke', expect.anything());
  });

  it('only a Worker without the route falls back to the plain revoke — and that is never reported as confirmed', async () => {
    h.state.rpcs.live_device_revoke = { data: { ok: true }, error: null };
    fetchMock.mockResolvedValueOnce(json({ error: 'not found' }, 404));
    expect(await account.revokeMyDevice(ID)).toEqual({ ok: true, confirmed: false });
    expect(h.rpc).toHaveBeenCalledWith('live_device_revoke', { p_device: ID });
    expect(account.unconfirmedRevokes()).toContain(ID);
    // The device really isn't there (the Worker's own not_found): said so, no fallback.
    h.rpc.mockClear();
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: 'not_found' }, 404));
    expect(await account.revokeMyDevice('d-2')).toEqual({ ok: false, error: 'not_found' });
    expect(h.rpc).not.toHaveBeenCalledWith('live_device_revoke', expect.anything());
    // A device waiting on "Finish signing out" whose record is gone: no retry button left forever.
    expect(account.unconfirmedRevokes()).toContain(ID);
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: 'not_found' }, 404));
    expect(await account.revokeMyDevice(ID)).toEqual({ ok: false, error: 'not_found' });
    expect(account.unconfirmedRevokes()).not.toContain(ID);
    // Two-step code owed: the step-up prompt.
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: 'mfa_required' }, 403));
    expect(await account.revokeMyDevice(ID)).toEqual({ ok: false, error: 'mfa_required' });
  });
});

describe('"Not you? Secure my account"', () => {
  const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123';
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const secured = { ok: true, sessionsEnded: 2, signedOutEverywhere: true, devicesRevoked: 0, factorsRemoved: 0, kicked: false, resetEmail: 'sent', emailHint: 'a•••@example.com' };

  it('posts the token to the backend and, when this browser was in that account, signs it out and kicks with the old token', async () => {
    await account.refreshAccount();
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith('/api/auth/email/secure') ? answer(secured) : answer({ ok: true })));
    // The auth server no longer knows this browser's session: it was one of those just ended.
    h.auth.getUser.mockResolvedValueOnce({ data: { user: null } as never, error: { status: 403, code: 'session_not_found', message: 'Session not found' } });
    const r = await account.secureAccount(TOKEN);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/auth\/email\/secure$/);
    expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN });
    expect(h.auth.getUser).toHaveBeenCalledWith('tok-1');
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/me\/kick$/);
    expect(r).toEqual({ ok: true, signedOutEverywhere: true, sessionsEnded: 2, devicesRevoked: 0, factorsRemoved: 0, resetEmail: 'sent', emailHint: 'a•••@example.com', thisDevice: true, kicked: true });
    expect(h.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(account.getAccount().status).toBe('signed_out');
  });

  it('takes the server’s word that open sockets were closed — the account’s own tokens all died when it was secured', async () => {
    fetchMock.mockResolvedValue(answer({ ...secured, kicked: true, factorsRemoved: 1 }));
    const r = await account.secureAccount(TOKEN);
    expect(r).toMatchObject({ ok: true, kicked: true, factorsRemoved: 1, thisDevice: false });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no client-side kick needed (or possible)
  });

  it('leaves this browser alone when it is signed in to a different account', async () => {
    await account.refreshAccount();
    fetchMock.mockResolvedValue(answer(secured));
    const r = await account.secureAccount(TOKEN);
    expect(r).toMatchObject({ ok: true, thisDevice: false, kicked: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.auth.signOut).not.toHaveBeenCalled();
  });

  it('passes the server’s honest refusals through', async () => {
    fetchMock.mockResolvedValue(answer({ ok: false, code: 'used', message: 'This link was already used.' }, 409));
    expect(await account.secureAccount(TOKEN)).toEqual({ ok: false, code: 'used', message: 'This link was already used.' });
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await account.secureAccount(TOKEN)).toMatchObject({ ok: false, code: 'unreachable' });
    expect(await account.secureAccount('nope')).toMatchObject({ ok: false, code: 'invalid_token' });
  });
});
