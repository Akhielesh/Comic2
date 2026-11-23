// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const verifyOtp = vi.hoisted(() => vi.fn());
vi.mock('./supabase', () => ({ supabase: { auth: { verifyOtp } } }));
vi.mock('./clientConfig', () => ({ buildApiUrl: (p: string) => p }));
vi.mock('./memberReferrals', () => ({ getSignupReferralCode: () => 'a'.repeat(32) }));
import { completeGoogleSignIn, googleSignInAvailable, pendingGoogleSignIn, startGoogleSignIn } from './googleSignIn';

beforeEach(() => {
  sessionStorage.clear();
  verifyOtp.mockReset().mockResolvedValue({ error: null });
  vi.stubGlobal('crypto', webcrypto);
  window.history.replaceState({}, '', '/?view=auth');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function startThenReturn(fetcher: ReturnType<typeof vi.fn>) {
  fetcher.mockResolvedValueOnce(Response.json({ authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=login.test' }));
  await startGoogleSignIn('voice', 'captcha');
  const req = JSON.parse(fetcher.mock.calls[0][1].body);
  expect(req).toMatchObject({ captchaToken: 'captcha', browserChallenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  expect(req).not.toHaveProperty('browserSecret');
  window.history.replaceState({}, '', '/?view=auth#google_finish=' + 'g'.repeat(43));
  expect(pendingGoogleSignIn()).toBe('ready');
  expect(location.hash).toBe('');
}

describe('Google login', () => {
  it('registers a new account after profile completion and returns to the original voice workspace', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await startThenReturn(fetcher);
    fetcher.mockResolvedValueOnce(Response.json({ needsProfile: true, firstName: 'Ada', email: 'ada@example.test' }));
    expect(await completeGoogleSignIn()).toMatchObject({ needsProfile: true });
    const profile = { firstName: 'Ada', username: 'ada', dob: '2000-01-01', acceptedTerms: true };
    fetcher.mockResolvedValueOnce(Response.json({ message: 'Choose another username.', grant: 'r'.repeat(43) }, { status: 422 }));
    await expect(completeGoogleSignIn(profile)).rejects.toThrow('Choose another username');
    fetcher.mockResolvedValueOnce(Response.json({ tokenHash: 'one-time-hash' }));
    expect(await completeGoogleSignIn({ ...profile, username: 'ada2' })).toEqual({ needsProfile: false, destination: '/?view=chat&voice=1' });
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toMatchObject({ grant: 'r'.repeat(43), profile: { referralCode: 'a'.repeat(32) } });
    expect(verifyOtp).toHaveBeenCalledWith({ type: 'magiclink', token_hash: 'one-time-hash' });
    await expect(completeGoogleSignIn()).rejects.toThrow(/expired/);
  });
  it('rejects a callback pasted into an unrelated tab without making a request', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    window.history.replaceState({}, '', '/?view=auth#google_finish=' + 'g'.repeat(43));
    expect(pendingGoogleSignIn()).toBe('error');
    expect(location.hash).toBe('');
    await expect(completeGoogleSignIn()).rejects.toThrow(/expired/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('only offers Google when the backend verifies the prerequisites', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ enabled: false }))
      .mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValueOnce(Response.json({ enabled: true }));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    expect(await googleSignInAvailable(signal)).toBe(false);
    expect(await googleSignInAvailable(signal)).toBe(false);
    expect(await googleSignInAvailable(signal)).toBe(true);
  });
});
