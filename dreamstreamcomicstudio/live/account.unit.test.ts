// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();
const verifyOtp = vi.fn();
const resend = vi.fn();
const signUp = vi.fn();
const rpc = vi.fn();
vi.mock('@/services/supabase', () => ({ supabase: { auth: { getSession, verifyOtp, resend, signUp }, rpc } }));
// The backend wrapper (its own contract is covered in services/authEmail.test.ts).
const api = vi.hoisted(() => ({ requestAuthEmail: vi.fn(), EMAIL_SERVICE_DOWN: 'email service down' }));
vi.mock('@/services/authEmail', () => api);

import { confirmRedirectUrl, consumeAuthReturn, createAccount, resendConfirmation, sendPasswordReset } from './account';

const go = (path: string) => history.replaceState(null, '', path);

beforeEach(() => {
  for (const fn of [getSession, verifyOtp, resend, signUp, rpc, api.requestAuthEmail]) fn.mockReset();
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
  it('ignores an ordinary page load', async () => {
    go('/live#/monitor');
    expect(await consumeAuthReturn()).toBeNull();
    expect(location.hash).toBe('#/monitor');
    expect(getSession).not.toHaveBeenCalled();
  });

  it('adopts the session from a confirmation link and lands on the start screen', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 't' } } });
    go('/live?after=monitor#access_token=t&refresh_token=r&type=signup');
    expect(await consumeAuthReturn()).toEqual({ confirmed: true });
    expect(getSession).toHaveBeenCalledOnce();
    expect(location.pathname + location.search + location.hash).toBe('/live#/monitor');
  });

  it('explains an expired or already-used link and cleans the URL', async () => {
    go('/live?after=monitor#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    expect(await consumeAuthReturn()).toEqual({ error: 'expired' });
    expect(getSession).not.toHaveBeenCalled();
    expect(location.search + location.hash).toBe('#/monitor');
  });

  it('reports a link that produced no session', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    go('/live#access_token=bad&type=signup');
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
  it('verifies the link, signs in and lands on the start screen with a clean URL', async () => {
    verifyOtp.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });
    go('/live?after=monitor&token_hash=abc123&type=signup');
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
    go('/live?token_hash=used&type=signup');
    expect(await consumeAuthReturn()).toEqual({ error: 'expired' });
    expect(location.search + location.hash).toBe('');
  });

  it('reports other failures with their message and defaults an unknown type to signup', async () => {
    verifyOtp.mockResolvedValue({ data: { session: null }, error: { status: 500, message: 'Network down' } });
    go('/live?after=settings&token_hash=h&type=bogus');
    expect(await consumeAuthReturn()).toEqual({ error: 'failed', message: 'Network down' });
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'h', type: 'signup' });
    expect(location.search + location.hash).toBe('#/settings');
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
