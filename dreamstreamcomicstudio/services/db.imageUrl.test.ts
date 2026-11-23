import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Viewer = { user: { id: string }; access_token: string } | null;
type Change = (event: string, session: Viewer) => void;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ref = 'u/' + A + '/p/book/ref/portrait.webp';
const classic = A + '/cover.png';
const auth = vi.hoisted(() => ({
  session: null as Viewer,
  observe: undefined as Change | undefined,
  getSession: vi.fn(),
  publicUrl: vi.fn((path: string) => ({ data: { publicUrl: 'public/' + path } }))
}));
vi.mock('./supabase', () => ({
  getStoredSessionOwnerId: () => auth.session?.user.id ?? null,
  isStoredSession: (session: Viewer) => !session || session.access_token === auth.session?.access_token,
  supabase: {
    auth: {
      getSession: auth.getSession,
      onAuthStateChange: (callback: Change) => {
        auth.observe = callback;
      }
    },
    storage: { from: () => ({ getPublicUrl: auth.publicUrl }) }
  }
}));
vi.mock('./clientConfig', () => ({ buildApiUrl: (path: string) => 'https://fixture.test' + path }));
const sign = vi.fn<typeof fetch>();
const ok = (url: string, expiresIn?: number) => Response.json({ url, expiresIn });
const failed = (status: number) => new Response(null, { status });

function login(owner: string | null) {
  auth.session = owner ? { user: { id: owner }, access_token: 'token-' + owner } : null;
  auth.observe?.(owner ? 'SIGNED_IN' : 'SIGNED_OUT', auth.session);
}

let resolve: typeof import('./db').getImageUrl;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  auth.observe = undefined;
  login(A);
  auth.getSession.mockImplementation(async () => ({ data: { session: auth.session } }));
  sign.mockReset();
  vi.stubGlobal('fetch', sign);
  ({ getImageUrl: resolve } = await import('./db'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('image URL resolution', () => {
  it('respects the private five-minute lifetime and expiry margin; transforms use independent keys', async () => {
    const start = 100_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    sign.mockImplementation(async () => ok('signed-' + sign.mock.calls.length, 300));
    expect(await resolve(ref)).toBe('signed-1');
    now.mockReturnValue(start + 269_999);
    expect(await resolve(ref)).toBe('signed-1');
    expect(await resolve(ref, { transform: { width: 320 } })).toBe('signed-2');
    now.mockReturnValue(start + 270_000);
    expect(await resolve(ref)).toBe('signed-3');
    now.mockReturnValue(start + 301_000);
    expect(await resolve(ref)).toBe('signed-3');
    expect(auth.publicUrl).not.toHaveBeenCalled();
  });

  it('uses older responses without an expiry once and rejects already-expired private links', async () => {
    sign
      .mockResolvedValueOnce(ok('old-api'))
      .mockResolvedValueOnce(ok('new-api', 0))
      .mockResolvedValueOnce(ok('fresh', 5));
    expect(await resolve(ref)).toBe('old-api');
    expect(await resolve(ref)).toBeUndefined();
    expect(await resolve(ref)).toBe('fresh');
    expect(auth.publicUrl).not.toHaveBeenCalled();
  });

  it('coalesces concurrent requests only for the same viewer and transform; discards delayed old-account results', async () => {
    let done!: (resp: Response) => void;
    sign
      .mockImplementationOnce(
        () =>
          new Promise((complete) => {
            done = complete;
          })
      )
      .mockResolvedValueOnce(ok('b-link', 300));
    const results = [resolve(classic), resolve(classic)];
    await vi.waitFor(() => expect(sign).toHaveBeenCalledTimes(1));
    login(B);
    expect(await resolve(classic)).toBe('b-link');
    done(ok('a-link', 300));
    expect(await Promise.all(results)).toEqual([undefined, undefined]);
    expect(await resolve(classic)).toBe('b-link');
    expect(sign.mock.calls.map(([, init]) => (init?.headers as Record<string, string>).Authorization)).toEqual([
      'Bearer token-' + A,
      'Bearer token-' + B
    ]);
    login(null);
    sign.mockResolvedValueOnce(ok('guest-link', 90));
    expect(await resolve(classic)).toBe('guest-link');
    expect(sign.mock.lastCall![1]?.headers).toBeUndefined();
  });

  it('retains a valid in-flight URL when a token refresh stays on the same account', async () => {
    let done!: (response: Response) => void;
    sign.mockImplementationOnce(
      () =>
        new Promise((complete) => {
          done = complete;
        })
    );
    const image = resolve(ref);
    await vi.waitFor(() => expect(sign).toHaveBeenCalledTimes(1));
    auth.session = { user: { id: A }, access_token: 'renewed' };
    auth.observe?.('TOKEN_REFRESHED', auth.session);
    done(ok('still-valid', 300));
    expect(await image).toBe('still-valid');
    expect(await resolve(ref)).toBe('still-valid');
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('binds one session across retries and later extension candidates, sharing that work with duplicate readers', async () => {
    const path = A + '/cover';
    sign
      .mockResolvedValueOnce(failed(503))
      .mockResolvedValueOnce(failed(404))
      .mockResolvedValueOnce(ok('signed-png', 300));
    const readers = Array.from({ length: 6 }, () => resolve(path));
    expect(await Promise.all(readers)).toEqual(Array(6).fill('signed-png'));
    const attempted = sign.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('path'));
    expect(attempted).toEqual([path + '.webp', path + '.webp', path + '.png']);
    expect(auth.getSession).toHaveBeenCalledTimes(6);
    expect(auth.publicUrl).not.toHaveBeenCalled();
  });

  it('retries a transient private failure later and never falls back to a public URL', async () => {
    sign
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(failed(503))
      .mockResolvedValueOnce(ok('restored', 300));
    expect(await resolve(ref)).toBeUndefined();
    expect(await resolve(ref)).toBe('restored');
    expect(auth.publicUrl).not.toHaveBeenCalled();
  });

  it('never constructs public URLs for quarantine, private references or project working copies', async () => {
    sign.mockImplementation(async () => failed(404));
    expect(await resolve('/q/' + A + '/book/blocked.webp')).toBeUndefined();
    expect(await resolve(ref)).toBeUndefined();
    expect(await resolve('u/' + A + '/p/book/img/draft.webp')).toBeUndefined();
    login(B);
    const count = sign.mock.calls.length;
    expect(await resolve(ref)).toBeUndefined();
    login(null);
    expect(await resolve(ref)).toBeUndefined();
    expect(sign).toHaveBeenCalledTimes(count);
    expect(auth.publicUrl).not.toHaveBeenCalled();
  });

  it('preserves the legacy public fallback after all candidates fail and retries the signer on the next load', async () => {
    sign.mockImplementation(async () => failed(404));
    expect(await resolve(classic)).toBe('public/' + classic);
    expect(sign).toHaveBeenCalledTimes(2);
    sign.mockResolvedValueOnce(ok('recovered', 3600));
    expect(await resolve(classic)).toBe('recovered');
    expect(auth.publicUrl).toHaveBeenCalledTimes(1);
  });

  it('honors explicit access denial and refuses malformed or unsafe object paths before fallback', async () => {
    sign.mockImplementation(async () => failed(403));
    expect(await resolve(classic)).toBeUndefined();
    const count = sign.mock.calls.length;
    expect(await resolve('../' + ref)).toBeUndefined();
    expect(await resolve('u/guest/%2e%2e/secret.png')).toBeUndefined();
    expect(sign).toHaveBeenCalledTimes(count);
    expect(auth.publicUrl).not.toHaveBeenCalled();
  });
});
