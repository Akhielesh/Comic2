// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();
const verifyOtp = vi.fn();
const setSession = vi.fn();
const exchangeCodeForSession = vi.fn();
const getUser = vi.fn();
const signInWithPassword = vi.fn();
const resend = vi.fn();
const signUp = vi.fn();
const rpc = vi.fn();
const lookupAccessTokenEmail = vi.fn();
const onAuthStateChange = vi.fn(() => ({ data: { subscription: { unsubscribe: () => undefined } } }));
vi.mock('@/services/supabase', () => ({
  supabase: { auth: { getSession, verifyOtp, setSession, exchangeCodeForSession, getUser, signInWithPassword, resend, signUp, onAuthStateChange }, rpc },
  lookupAccessTokenEmail
}));
// The backend wrapper (its own contract is covered in services/authEmail.test.ts).
const api = vi.hoisted(() => ({ requestAuthEmail: vi.fn(), EMAIL_SERVICE_DOWN: 'email service down' }));
vi.mock('@/services/authEmail', () => api);

import { confirmRedirectUrl, consumeAuthReturn, createAccount, resendConfirmation, sendPasswordReset, signIn, type AuthReturnConfirm } from './account';
import { PENDING_SIGN_IN_KEY, hasFreshSignInIntent, markSignInStarted } from '@/services/pendingSignIn';

const go = (path: string) => history.replaceState(null, '', path);
/** The nonce of the sign-in this browser started (our backend echoes it into the link as `sn`). */
let sn = '';

beforeEach(() => {
  for (const fn of [getSession, verifyOtp, setSession, exchangeCodeForSession, getUser, signInWithPassword, resend, signUp, rpc, lookupAccessTokenEmail, api.requestAuthEmail]) fn.mockReset();
  localStorage.clear();
  go('/live');
});

describe('confirmRedirectUrl', () => {
  it('returns to the screen the user signed up from, with no fragment', () => {
    go('/live#/monitor/11111111-2222-4333-8444-555555555555/camera');
    expect(confirmRedirectUrl()).toBe(`${location.origin}/live?after=monitor`);
    go('/live#/settings');
    expect(confirmRedirectUrl()).toBe(`${location.origin}/live?after=settings`);
  });

  it('never carries private links or unknown screens', () => {
    go('/live?e=abc#/studio?k=secret');
    expect(confirmRedirectUrl()).toBe(`${location.origin}/live`);
    go('/live');
    expect(confirmRedirectUrl()).toBe(`${location.origin}/live`);
  });
});

describe('consumeAuthReturn', () => {
  // These links were asked for in this browser (sign-up / resend / handoff started here): they
  // carry the nonce of that sign-in.
  beforeEach(() => {
    sn = markSignInStarted('signup');
  });

  it('ignores an ordinary page load', async () => {
    go('/live#/monitor');
    expect(await consumeAuthReturn()).toBeNull();
    expect(location.hash).toBe('#/monitor');
    expect(getSession).not.toHaveBeenCalled();
  });

  it('signs in with an older #access_token confirmation link and lands on the start screen', async () => {
    setSession.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });
    go(`/live?after=monitor&sn=${sn}#access_token=t&refresh_token=r&type=signup`);
    expect(await consumeAuthReturn()).toEqual({ confirmed: true });
    // Explicitly — supabase-js no longer reads tokens out of the URL by itself.
    expect(setSession).toHaveBeenCalledWith({ access_token: 't', refresh_token: 'r' });
    expect(getSession).not.toHaveBeenCalled();
    expect(location.pathname + location.search + location.hash).toBe('/live#/monitor');
  });

  it('explains an expired or already-used link and cleans the URL', async () => {
    go('/live?after=monitor#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    expect(await consumeAuthReturn()).toEqual({ error: 'expired' });
    expect(getSession).not.toHaveBeenCalled();
    expect(location.search + location.hash).toBe('#/monitor');
  });

  it('reports a link that produced no session', async () => {
    go('/live#access_token=bad&type=signup'); // no refresh token: can't make a session
    expect(await consumeAuthReturn()).toEqual({ error: 'failed' });
    expect(setSession).not.toHaveBeenCalled();
    expect(location.hash).toBe('');
    sn = markSignInStarted('signup');
    setSession.mockResolvedValue({ data: { session: null }, error: { message: 'Invalid JWT', status: 401 } });
    go(`/live?sn=${sn}#access_token=bad&refresh_token=r&type=signup`);
    expect(await consumeAuthReturn()).toEqual({ error: 'failed' });
    expect(location.hash).toBe('');
  });

  it('drops an unknown ?after= screen', async () => {
    go('/live?after=studio');
    expect(await consumeAuthReturn()).toBeNull();
    expect(location.search + location.hash).toBe('');
  });
});

describe('consumeAuthReturn — token_hash links from our backend', () => {
  beforeEach(() => {
    sn = markSignInStarted('signup');
  });

  it('verifies the link, signs in and lands on the start screen with a clean URL', async () => {
    verifyOtp.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });
    go(`/live?after=monitor&token_hash=abc123&type=signup&sn=${sn}`);
    expect(await consumeAuthReturn()).toEqual({ confirmed: true });
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'abc123', type: 'signup' });
    expect(getSession).not.toHaveBeenCalled();
    expect(location.pathname + location.search + location.hash).toBe('/live#/monitor');
  });

  it('explains an expired or already-used link', async () => {
    verifyOtp.mockResolvedValue({
      data: { session: null },
      error: { code: 'otp_expired', status: 403, message: 'Email link is invalid or has expired' }
    });
    go(`/live?token_hash=used&type=signup&sn=${sn}`);
    expect(await consumeAuthReturn()).toEqual({ error: 'expired' });
    expect(location.search + location.hash).toBe('');
  });

  it('finishes the sign-in handoff from DreamStream (type=magiclink) and cleans the URL', async () => {
    verifyOtp.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });
    sn = markSignInStarted('handoff'); // started here ("Continue with DreamStream")
    go(`/live?token_hash=hand0ff&type=magiclink&sn=${sn}&after=calls`);
    expect(await consumeAuthReturn()).toEqual({ confirmed: true, handoff: true });
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'hand0ff', type: 'magiclink' });
    expect(location.pathname + location.search + location.hash).toBe('/live#/calls');
    // A used or stale handoff link says so (the app then offers sign-in).
    sn = markSignInStarted('handoff');
    verifyOtp.mockResolvedValue({ data: { session: null }, error: { code: 'otp_expired', status: 403, message: 'expired' } });
    go(`/live?token_hash=used&type=magiclink&sn=${sn}`);
    expect(await consumeAuthReturn()).toEqual({ error: 'expired', handoff: true });
    expect(location.search).toBe('');
  });

  it('reports other failures with their message and defaults an unknown type to signup', async () => {
    verifyOtp.mockResolvedValue({ data: { session: null }, error: { status: 500, message: 'Network down' } });
    go(`/live?after=settings&token_hash=h&type=bogus&sn=${sn}`);
    expect(await consumeAuthReturn()).toEqual({ error: 'failed', message: 'Network down' });
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'h', type: 'signup' });
    expect(location.search + location.hash).toBe('#/settings');
  });
});

describe('consumeAuthReturn — a link this browser didn’t ask for asks first', () => {
  it('a token_hash link does nothing until Continue, then signs in and cleans the URL', async () => {
    verifyOtp.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });
    go('/live?after=monitor&token_hash=abc123&type=signup');
    const r = (await consumeAuthReturn()) as AuthReturnConfirm;
    expect(r).toMatchObject({ confirm: true });
    expect(await r.email).toBeNull(); // a token hash can't be read without using it
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(location.search).toBe('?after=monitor&token_hash=abc123&type=signup');

    expect(await r.proceed()).toEqual({ confirmed: true });
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'abc123', type: 'signup' });
    expect(location.pathname + location.search + location.hash).toBe('/live#/monitor');
  });

  it('an older #access_token link names its account (without signing in); Not now drops it', async () => {
    lookupAccessTokenEmail.mockResolvedValue({ email: 'mallory@example.com', dead: false });
    go('/live?after=settings#access_token=at&refresh_token=rt&type=magiclink');
    const r = (await consumeAuthReturn()) as AuthReturnConfirm;
    expect(r).toMatchObject({ confirm: true });
    expect(await r.email).toBe('mallory@example.com');
    expect(lookupAccessTokenEmail).toHaveBeenCalledWith('at');
    expect(getUser).not.toHaveBeenCalled();
    r.dismiss();
    expect(setSession).not.toHaveBeenCalled();
    expect(location.pathname + location.search + location.hash).toBe('/live#/settings');
  });

  it('the handoff asks too when it wasn’t started here', async () => {
    verifyOtp.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });
    go('/live?token_hash=hand0ff&type=magiclink&after=calls');
    const r = (await consumeAuthReturn()) as AuthReturnConfirm;
    expect(r).toMatchObject({ confirm: true, handoff: true });
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(await r.proceed()).toEqual({ confirmed: true, handoff: true });
  });

  it('a started sign-in lets exactly one link through', async () => {
    verifyOtp.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });
    sn = markSignInStarted('resend');
    go(`/live?token_hash=one&type=signup&sn=${sn}`);
    expect(await consumeAuthReturn()).toEqual({ confirmed: true });
    expect(hasFreshSignInIntent()).toBe(false);
    go(`/live?token_hash=two&type=signup&sn=${sn}`);
    expect(await consumeAuthReturn()).toMatchObject({ confirm: true });
    expect(verifyOtp).toHaveBeenCalledTimes(1);
  });

  it('a PKCE ?code= link is exchanged only after Continue', async () => {
    exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });
    go('/live?code=c0de');
    const r = (await consumeAuthReturn()) as AuthReturnConfirm;
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(await r.proceed()).toEqual({ confirmed: true });
    expect(exchangeCodeForSession).toHaveBeenCalledWith('c0de');
    expect(location.search).toBe('');
  });

  it('error links explain themselves without asking (nothing to sign in with)', async () => {
    go('/live#error=access_denied&error_code=otp_expired');
    expect(await consumeAuthReturn()).toEqual({ error: 'expired' });
  });

  it('never repeats a link’s own error text (anyone can write it into a URL)', async () => {
    go('/live?error=server_error&error_description=Your+account+was+locked.+Re-enter+your+key+at+evil.example');
    const r = await consumeAuthReturn();
    expect(r).toEqual({ error: 'failed' });
    expect(JSON.stringify(r)).not.toContain('evil.example');
  });

  it('an intent recorded for ANOTHER sign-in (a password reset in the main app, say) never waves an attacker’s link through', async () => {
    markSignInStarted('recovery'); // same origin, same storage — but the attacker’s link can’t carry its nonce
    verifyOtp.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });
    go('/live?token_hash=ATTACKER&type=magiclink');
    expect(await consumeAuthReturn()).toMatchObject({ confirm: true, handoff: true });
    go(`/live?token_hash=ATTACKER&type=magiclink&sn=${'f'.repeat(36)}`); // a guessed nonce
    expect(await consumeAuthReturn()).toMatchObject({ confirm: true });
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('asks at once — never waits for the account lookup — and fills the email in later', async () => {
    let answer!: (v: { email: string | null; dead: boolean }) => void;
    lookupAccessTokenEmail.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    go('/live#access_token=at&refresh_token=rt&type=magiclink');
    const r = (await consumeAuthReturn()) as AuthReturnConfirm;
    expect(r).toMatchObject({ confirm: true });
    answer({ email: 'mallory@example.com', dead: false });
    expect(await r.email).toBe('mallory@example.com');
  });

  it('Continue on a fragment-token link the auth server refuses reports it expired — setSession (which would sign the current account out) never runs', async () => {
    lookupAccessTokenEmail.mockResolvedValue({ email: null, dead: true });
    go('/live?after=settings#access_token=gone&refresh_token=spent&type=magiclink');
    const r = (await consumeAuthReturn()) as AuthReturnConfirm;
    expect(await r.proceed()).toEqual({ error: 'expired' });
    expect(setSession).not.toHaveBeenCalled();
    expect(location.pathname + location.search + location.hash).toBe('/live#/settings');
  });

  it('inside a frame no link signs in, not even after a click (clickjacking)', async () => {
    const top = vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window);
    try {
      sn = markSignInStarted('signup');
      go(`/live?after=monitor&token_hash=abc&type=signup&sn=${sn}`);
      expect(await consumeAuthReturn()).toEqual({ error: 'framed' });
      expect(verifyOtp).not.toHaveBeenCalled();
      expect(location.search).toBe('');
    } finally {
      top.mockRestore();
    }
  });
});

describe('signIn — an unconfirmed email', () => {
  it('says so, and records no sign-in intent (a link mailed earlier can’t carry a nonce made now)', async () => {
    signInWithPassword.mockResolvedValue({ error: { message: 'Email not confirmed', code: 'email_not_confirmed' } });
    expect(await signIn('ada@example.com', 'pw')).toMatchObject({ ok: false, unconfirmed: true });
    expect(localStorage.getItem(PENDING_SIGN_IN_KEY)).toBeNull();
  });
});

describe('pending sign-ins are forgotten once nothing waits for a link', () => {
  it('a password sign-in that succeeds (the person no longer needs the emailed link)', async () => {
    markSignInStarted('recovery');
    signInWithPassword.mockResolvedValue({ error: null });
    getSession.mockResolvedValue({ data: { session: null } });
    expect(await signIn('ada@example.com', 'pw')).toEqual({ ok: true });
    expect(hasFreshSignInIntent()).toBe(false);
  });

  it('an error link, and Not now', async () => {
    markSignInStarted('signup');
    go('/live#error=access_denied&error_code=otp_expired');
    expect(await consumeAuthReturn()).toEqual({ error: 'expired' });
    expect(hasFreshSignInIntent()).toBe(false);
    markSignInStarted('signup');
    go('/live?token_hash=h&type=signup');
    const r = (await consumeAuthReturn()) as AuthReturnConfirm;
    r.dismiss();
    expect(hasFreshSignInIntent()).toBe(false);
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});

describe('auth emails through the backend', () => {
  const unreachable = { status: 'unreachable' };

  it('resendConfirmation: one-a-minute answers read as before; never falls back to Supabase’s mailer', async () => {
    go('/live#/monitor');
    api.requestAuthEmail.mockResolvedValueOnce({ status: 'ok', data: { ok: true } });
    expect(await resendConfirmation(' Ada@Example.com ')).toEqual({ ok: true });
    expect(api.requestAuthEmail).toHaveBeenLastCalledWith('resend', { email: 'ada@example.com', app: 'live', after: 'monitor' });

    api.requestAuthEmail.mockResolvedValueOnce({ status: 'error', code: 'too_soon', httpStatus: 429, retryAfterS: 30, message: 'wait 30 seconds' });
    expect(await resendConfirmation('ada@example.com')).toEqual({ ok: false, error: 'Just sent one — wait a minute before asking again.' });

    api.requestAuthEmail.mockResolvedValueOnce({ status: 'error', code: 'too_many', httpStatus: 429, message: 'Try again later.' });
    expect(await resendConfirmation('ada@example.com')).toEqual({ ok: false, error: 'Try again later.' });
    expect(resend).not.toHaveBeenCalled();

    api.requestAuthEmail.mockResolvedValueOnce(unreachable);
    expect(await resendConfirmation('ada@example.com')).toEqual({ ok: false, error: 'email service down' });
    expect(resend).not.toHaveBeenCalled();
  });

  it('sendPasswordReset always asks for a main-app link', async () => {
    api.requestAuthEmail.mockResolvedValueOnce({ status: 'ok', data: { ok: true } });
    expect(await sendPasswordReset('ada@example.com')).toEqual({ ok: true });
    expect(api.requestAuthEmail).toHaveBeenLastCalledWith('recovery', { email: 'ada@example.com', app: 'main' });
  });

  describe('createAccount', () => {
    const input = { name: 'Ada Lovelace', email: 'Ada@Example.com', password: 'correct horse', dob: '1990-12-10', code: 'WELCOME' };
    beforeEach(() => {
      rpc.mockResolvedValue({ data: { ok: true, ticket: 't'.repeat(48) }, error: null });
      go('/live#/create');
    });

    it('creates through the backend with the welcome ticket and the return screen', async () => {
      api.requestAuthEmail.mockResolvedValueOnce({ status: 'ok', data: { ok: true, confirmEmail: true } });
      expect(await createAccount(input)).toEqual({ ok: true, confirmEmail: true });
      const [kind, body] = api.requestAuthEmail.mock.calls[0];
      expect(kind).toBe('signup');
      expect(body).toMatchObject({
        app: 'live',
        after: 'create',
        email: 'ada@example.com',
        password: 'correct horse',
        data: { first_name: 'Ada', last_name: 'Lovelace', display_name: 'Ada Lovelace', live_ticket: 't'.repeat(48), signup_source: 'stream_studio' }
      });
      expect(signUp).not.toHaveBeenCalled();
    });

    it('retries a username collision with a new suffix', async () => {
      api.requestAuthEmail
        .mockResolvedValueOnce({ status: 'error', code: 'database_error', httpStatus: 422, message: 'Database error saving new user' })
        .mockResolvedValueOnce({ status: 'ok', data: { ok: true } });
      expect(await createAccount(input)).toEqual({ ok: true, confirmEmail: true });
      const names = api.requestAuthEmail.mock.calls.map((c) => (c[1] as { data: { username: string } }).data.username);
      expect(names).toHaveLength(2);
      expect(names.every((n) => /^ada_\d{4}$/.test(n))).toBe(true);
    });

    it('keeps the existing-account message and offers a resend when only the email failed', async () => {
      api.requestAuthEmail.mockResolvedValueOnce({ status: 'error', code: 'email_exists', httpStatus: 409, message: 'x' });
      expect(await createAccount(input)).toEqual({ ok: false, error: 'An account with this email already exists — sign in instead.' });

      api.requestAuthEmail.mockResolvedValueOnce({ status: 'error', code: 'send_failed', httpStatus: 502, message: 'x' });
      expect(await createAccount(input)).toMatchObject({ ok: true, confirmEmail: true, note: expect.stringMatching(/Resend email/) });
      expect(signUp).not.toHaveBeenCalled();
    });

    it('never signs up through Supabase’s own mailer when the backend is unreachable', async () => {
      api.requestAuthEmail.mockResolvedValueOnce(unreachable);
      expect(await createAccount(input)).toEqual({ ok: false, error: 'email service down' });
      expect(signUp).not.toHaveBeenCalled();
    });
  });
});
