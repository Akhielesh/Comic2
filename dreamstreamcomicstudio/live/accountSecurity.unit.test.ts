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
    getUser: vi.fn(async (_t?: string) => ({ data: { user: { id: 'u1' } }, error: null as unknown })),
    mfa: {
      getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: state.aal, error: null })),
      listFactors: vi.fn(async () => ({ data: { all: state.factors, totp: state.factors.filter((f) => f.status === 'verified') }, error: null })),
      enroll: vi.fn(async (_p: Record<string, unknown>) => ({ data: { id: 'f-new', type: 'totp', totp: { qr_code: 'data:image/svg+xml;utf-8,<svg/>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' } }, error: null as unknown })),
      challengeAndVerify: vi.fn(async (_p: Record<string, unknown>) => ({ data: {}, error: null as unknown })),
      unenroll: vi.fn(async (_p: Record<string, unknown>) => ({ data: {}, error: null as unknown })),
    },
  };
  const rpc = vi.fn(async (fn: string) => (fn === 'live_me' ? { data: state.me, error: null } : { data: null, error: null }));
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
  for (const fn of [h.auth.getSession, h.auth.signOut, h.auth.refreshSession, h.rpc, ...Object.values(h.auth.mfa)]) (fn as ReturnType<typeof vi.fn>).mockClear();
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
});

describe('two-step sign-in at sign-in', () => {
  it('asks for the code when the session is aal1 and the account has an authenticator', async () => {
    h.state.aal = { currentLevel: 'aal1', nextLevel: 'aal2' };
    const a = await account.refreshAccount();
    expect(a.status).toBe('needs_mfa');
    expect(a.mfa).toBe(true);
  });

  it('also when the server says mfa_required (live_security_v2.sql applied)', async () => {
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
    expect(a).toMatchObject({ status: 'member', mfa: false });
  });

  it('"Sign in" anywhere in the app asks for the code rather than starting over', async () => {
    h.state.aal = { currentLevel: 'aal1', nextLevel: 'aal2' };
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

  it('verify sends the 6 digits (spaces and dashes ignored) and refreshes the account', async () => {
    const r = await account.verifyTotp('f-new', ' 123-456 ');
    expect(h.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'f-new', code: '123456' });
    expect(r).toEqual({ ok: true });
    expect(h.rpc).toHaveBeenCalledWith('live_me', {});
  });

  it('a wrong code is explained, not thrown', async () => {
    h.auth.mfa.challengeAndVerify.mockResolvedValueOnce({ data: {}, error: { code: 'mfa_verification_failed', status: 422, message: 'Invalid TOTP code entered' } });
    expect(await account.verifyTotp('f-new', '000000')).toMatchObject({ ok: false, code: 'invalid_code' });
    expect(await account.verifyTotp('f-new', '12')).toMatchObject({ ok: false, code: 'invalid_code' });
  });

  it('step-up uses the verified authenticator; with none there is nothing to step up to', async () => {
    expect(await account.stepUp('123456')).toEqual({ ok: true });
    expect(h.auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
    h.state.factors = [{ id: 'f1', factor_type: 'totp', status: 'verified', created_at: '2026-10-01' }];
    expect(await account.stepUp('654321')).toEqual({ ok: true });
    expect(h.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'f1', code: '654321' });
  });

  it('knows when an admin action needs the code first', async () => {
    expect(await account.stepUpNeeded()).toBe(false);
    h.state.aal = { currentLevel: 'aal1', nextLevel: 'aal2' };
    expect(await account.stepUpNeeded()).toBe(true);
    h.state.aal = { currentLevel: 'aal2', nextLevel: 'aal2' };
    expect(await account.stepUpNeeded()).toBe(false);
  });

  it('status lists only verified authenticators', async () => {
    h.state.factors = [
      { id: 'f1', factor_type: 'totp', status: 'verified', friendly_name: 'Authenticator 1', created_at: '2026-10-01' },
      { id: 'f2', factor_type: 'totp', status: 'unverified', created_at: '2026-10-02' },
    ];
    h.state.aal = { currentLevel: 'aal2', nextLevel: 'aal2' };
    expect(await account.mfaStatus()).toEqual({ ok: true, on: true, factors: [{ id: 'f1', name: 'Authenticator 1', createdAt: '2026-10-01' }], aal: 'aal2' });
  });

  it('turning it off needs aal2 — the password alone can’t', async () => {
    h.auth.mfa.unenroll.mockResolvedValueOnce({ data: {}, error: { code: 'insufficient_aal', status: 403, message: 'AAL2 required' } });
    expect(await account.unenrollTotp('f1')).toMatchObject({ ok: false, code: 'step_up' });
    expect(await account.unenrollTotp('f1')).toEqual({ ok: true });
    expect(h.auth.refreshSession).toHaveBeenCalled();
  });
});

describe('"Not you? Secure my account"', () => {
  const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123';
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const secured = { ok: true, sessionsEnded: 2, signedOutEverywhere: true, devicesRevoked: 0, resetEmail: 'sent', emailHint: 'a•••@example.com' };

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
    expect(r).toEqual({ ok: true, signedOutEverywhere: true, sessionsEnded: 2, devicesRevoked: 0, resetEmail: 'sent', emailHint: 'a•••@example.com', thisDevice: true, kicked: true });
    expect(h.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(account.getAccount().status).toBe('signed_out');
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
