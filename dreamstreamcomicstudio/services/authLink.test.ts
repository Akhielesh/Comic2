import { describe, expect, it, vi } from 'vitest';
import {
  cleanMainAuthUrl,
  completeLinkSignIn,
  linkErrorMessage,
  peekLinkAccount,
  readLinkTokens,
  readMainAuthLink,
  type LinkAuthApi
} from './authLink';

const O = 'https://dreamstreamstudio.ai';
const at = (path: string) => new URL(`${O}${path}`);

describe('readLinkTokens — every token shape', () => {
  it('reads a token hash (query or fragment), a PKCE code, fragment tokens and errors', () => {
    expect(readLinkTokens(at('/auth/callback?token_hash=h&type=signup'))).toEqual({ kind: 'token_hash', tokenHash: 'h', type: 'signup' });
    expect(readLinkTokens(at('/auth/callback#token_hash=h'))).toEqual({ kind: 'token_hash', tokenHash: 'h', type: null });
    expect(readLinkTokens(at('/?code=c0de'))).toEqual({ kind: 'code', code: 'c0de' });
    expect(readLinkTokens(at('/#access_token=a&refresh_token=r&type=magiclink'))).toEqual({
      kind: 'session',
      accessToken: 'a',
      refreshToken: 'r',
      type: 'magiclink'
    });
    expect(readLinkTokens(at('/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'))).toEqual({
      kind: 'error',
      code: 'otp_expired',
      description: 'Email link is invalid or has expired'
    });
    expect(readLinkTokens(at('/auth/callback?error_description=Nope'))).toEqual({ kind: 'error', code: null, description: 'Nope' });
  });

  it('an access token without its refresh token is an unusable link; no tokens is null', () => {
    expect(readLinkTokens(at('/#access_token=a'))).toEqual({ kind: 'error', code: null, description: null });
    expect(readLinkTokens(at('/'))).toBeNull();
    expect(readLinkTokens(at('/?view=read&id=x#/studio'))).toBeNull();
    expect(readLinkTokens(at('/?error=not-ours'))).toBeNull(); // a bare ?error= on some page is not an auth answer
  });
});

describe('readMainAuthLink — where the main app acts on tokens', () => {
  it('handles /auth/callback (with or without a trailing slash) and / when it carries tokens', () => {
    expect(readMainAuthLink(at('/auth/callback?token_hash=h&type=recovery'))).toMatchObject({
      tokens: { kind: 'token_hash', tokenHash: 'h' },
      flow: 'recovery',
      otpType: 'recovery'
    });
    expect(readMainAuthLink(at('/auth/callback/?token_hash=h'))).toMatchObject({ flow: 'magiclink', otpType: 'magiclink' });
    expect(readMainAuthLink(at('/?token_hash=h&type=email_change'))).toMatchObject({ flow: 'unknown', otpType: 'email_change' });
    expect(readMainAuthLink(at('/?view=read&id=x#access_token=a&refresh_token=r'))).toMatchObject({ tokens: { kind: 'session' } });
    expect(readMainAuthLink(at('/auth/callback?token_hash=h&next=%2Fmodels'))?.next).toBe('/models');
  });

  it('/auth/callback with nothing usable is an honest error; a tokenless / does nothing', () => {
    expect(readMainAuthLink(at('/auth/callback'))).toMatchObject({ tokens: null });
    expect(readMainAuthLink(at('/'))).toBeNull();
    expect(readMainAuthLink(at('/?view=chat'))).toBeNull();
  });

  it('ignores tokens on every other page (/models, share links, the reader, look-alike paths)', () => {
    for (const path of [
      '/models#access_token=a&refresh_token=r',
      '/models?token_hash=h&type=magiclink',
      '/c/aB3dE5fG7hJ9kL1mN?token_hash=h',
      '/share/x#access_token=a&refresh_token=r',
      '/auth/callbackx?token_hash=h',
      '/live?token_hash=h&type=signup' // Stream Studio's own handler (live/account.ts) owns /live
    ]) {
      expect(readMainAuthLink(at(path)), path).toBeNull();
    }
  });

  it('cleans every sign-in parameter, the fragment and the callback path', () => {
    expect(cleanMainAuthUrl(`${O}/auth/callback?token_hash=h&type=magiclink&next=%2F`)).toBe('/');
    expect(cleanMainAuthUrl(`${O}/auth/callback/?code=c`)).toBe('/');
    expect(cleanMainAuthUrl(`${O}/?view=read&id=x#access_token=a&refresh_token=r`)).toBe('/?view=read&id=x');
  });

  it('explains errors honestly', () => {
    expect(linkErrorMessage(null)).toMatch(/Invalid callback link/);
    expect(linkErrorMessage({ kind: 'error', code: 'otp_expired', description: null })).toMatch(/expired or was already used/);
    // Only the code is read — a link's description is free text anyone can put in a URL.
    const crafted = 'Your account was locked. Re-enter your OpenAI key at evil.example';
    expect(linkErrorMessage({ kind: 'error', code: null, description: crafted })).toBe('This link is invalid or expired. Request a new one and try again.');
    expect(linkErrorMessage({ kind: 'error', code: 'access_denied', description: crafted })).toMatch(/expired or was already used/);
  });

  it('removes the sign-in nonce with the tokens', () => {
    expect(cleanMainAuthUrl(`${O}/auth/callback?token_hash=h&type=magiclink&sn=abc-123&next=%2F`)).toBe('/');
    expect(cleanMainAuthUrl(`${O}/?view=chat&sn=abc#access_token=a&refresh_token=r`)).toBe('/?view=chat');
  });
});

const fakeAuth = () => {
  const auth = {
    verifyOtp: vi.fn(async () => ({ error: null })),
    exchangeCodeForSession: vi.fn(async () => ({ error: null })),
    setSession: vi.fn(async () => ({ error: null }))
  };
  return auth as typeof auth & LinkAuthApi;
};

describe('completeLinkSignIn / peekLinkAccount', () => {
  it('uses the auth call that matches the token shape', async () => {
    const auth = fakeAuth();
    expect(await completeLinkSignIn(auth, { kind: 'token_hash', tokenHash: 'h', type: 'signup' }, 'signup')).toEqual({ error: null });
    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'h', type: 'signup' });
    await completeLinkSignIn(auth, { kind: 'code', code: 'c' }, 'magiclink');
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith('c');
    await completeLinkSignIn(auth, { kind: 'session', accessToken: 'a', refreshToken: 'r', type: null }, 'magiclink');
    expect(auth.setSession).toHaveBeenCalledWith({ access_token: 'a', refresh_token: 'r' });
  });

  it('reports failures without throwing', async () => {
    const auth = fakeAuth();
    auth.verifyOtp.mockResolvedValueOnce({ error: { message: 'Email link is invalid or has expired', code: 'otp_expired', status: 403 } } as never);
    expect(await completeLinkSignIn(auth, { kind: 'token_hash', tokenHash: 'h', type: null }, 'magiclink')).toEqual({
      error: { message: 'Email link is invalid or has expired', code: 'otp_expired', status: 403 }
    });
    auth.setSession.mockRejectedValueOnce(new Error('network'));
    expect(await completeLinkSignIn(auth, { kind: 'session', accessToken: 'a', refreshToken: 'r', type: null }, 'x')).toEqual({
      error: { message: 'network', code: undefined, status: undefined }
    });
  });

  it('names the account only for fragment tokens, through the server lookup (never signing in)', async () => {
    const session = { kind: 'session', accessToken: 'a', refreshToken: 'r', type: null } as const;
    const unknown = { email: null, dead: false };
    const lookup = vi.fn(async () => ({ email: 'mallory@example.com', dead: false }));
    expect(await peekLinkAccount(lookup, session)).toEqual({ email: 'mallory@example.com', dead: false });
    expect(lookup).toHaveBeenCalledWith('a');
    expect(await peekLinkAccount(lookup, { kind: 'token_hash', tokenHash: 'h', type: null })).toEqual(unknown);
    expect(lookup).toHaveBeenCalledTimes(1);
    // A refused token is dead; a failed lookup is only unknown.
    expect(await peekLinkAccount(vi.fn(async () => ({ email: null, dead: true })), session)).toEqual({ email: null, dead: true });
    expect(await peekLinkAccount(vi.fn(async () => Promise.reject(new Error('offline'))), session)).toEqual(unknown);
    expect(await peekLinkAccount(null, session)).toEqual(unknown);
  });

  it('an error token never carries its description into the failure', async () => {
    expect(await completeLinkSignIn(fakeAuth(), { kind: 'error', code: 'bad', description: 'visit evil.example' }, 'magiclink')).toEqual({ error: { code: 'bad' } });
  });
});
