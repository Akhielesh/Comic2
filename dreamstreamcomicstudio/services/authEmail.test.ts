import { afterEach, describe, expect, it, vi } from 'vitest';
import { interpretAuthEmailResponse, requestAuthEmail } from './authEmail';
import { PENDING_SIGN_IN_KEY, consumeSignInIntent, hasFreshSignInIntent } from './pendingSignIn';

// The fallback contract (server: POST /api/auth/email/*):
//   unreachable (→ old direct Supabase call) ONLY when the backend isn't there or says
//   fallback:true; every route answer — 429 included — is final.
describe('interpretAuthEmailResponse', () => {
  it('passes a success body through', () => {
    expect(interpretAuthEmailResponse(200, { ok: true, confirmEmail: true })).toEqual({
      status: 'ok',
      data: { ok: true, confirmEmail: true }
    });
  });

  it('falls back when the backend is missing, down or not ready', () => {
    expect(interpretAuthEmailResponse(404, { error: { message: 'Not found' } })).toEqual({ status: 'unreachable' });
    expect(interpretAuthEmailResponse(405, {})).toEqual({ status: 'unreachable' });
    expect(interpretAuthEmailResponse(200, null)).toEqual({ status: 'unreachable' }); // HTML / non-JSON
    expect(interpretAuthEmailResponse(200, 'ok')).toEqual({ status: 'unreachable' });
    // The api-proxy's own "backend unreachable" answer carries no route code.
    expect(interpretAuthEmailResponse(502, { error: { message: 'Backend unavailable' } })).toEqual({ status: 'unreachable' });
    expect(interpretAuthEmailResponse(504, {})).toEqual({ status: 'unreachable' });
    expect(
      interpretAuthEmailResponse(503, { ok: false, code: 'email_unavailable', fallback: true, message: 'Email sending is unavailable right now.' })
    ).toEqual({ status: 'unreachable' });
    // The api-proxy while the container can't start: a nested code, not a route answer.
    expect(
      interpretAuthEmailResponse(503, { error: { code: 'backend_starting', message: 'The server is starting up — please retry in a few seconds.' } })
    ).toEqual({ status: 'unreachable' });
  });

  it('falls back when an older backend answers with its auth wall (deploy window)', () => {
    expect(interpretAuthEmailResponse(401, { error: { message: 'Missing Authorization header' } })).toEqual({ status: 'unreachable' });
    expect(interpretAuthEmailResponse(403, { error: { code: 'FORBIDDEN', message: 'nope' } })).toEqual({ status: 'unreachable' });
    // …but a route's own 4xx answer stays final.
    expect(interpretAuthEmailResponse(400, { ok: false, code: 'captcha_required', message: 'Please complete the verification challenge.' })).toMatchObject({
      status: 'error',
      code: 'captcha_required'
    });
  });

  it('treats throttles as final, keeping the wait time', () => {
    expect(
      interpretAuthEmailResponse(429, { ok: false, code: 'too_soon', retryAfterS: 42, message: 'Please wait 42 seconds before asking for another.' })
    ).toEqual({ status: 'error', code: 'too_soon', retryAfterS: 42, message: 'Please wait 42 seconds before asking for another.', httpStatus: 429 });
    // The per-IP limiter's shape gets a readable message.
    const ip = interpretAuthEmailResponse(429, {
      error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded for auth-email. Retry in 90s.', details: { retryAfterMs: 89_500 } }
    });
    expect(ip).toMatchObject({ status: 'error', code: 'RATE_LIMITED', retryAfterS: 90, httpStatus: 429 });
    expect(ip.status === 'error' && ip.message).toMatch(/90 seconds/);
    expect(interpretAuthEmailResponse(429, {}, '30')).toMatchObject({ status: 'error', retryAfterS: 30 });
  });

  it('treats route errors — including a send failure after sign-up — as final', () => {
    expect(interpretAuthEmailResponse(409, { ok: false, code: 'email_exists', message: 'exists' })).toMatchObject({
      status: 'error',
      code: 'email_exists'
    });
    expect(interpretAuthEmailResponse(502, { ok: false, code: 'send_failed', created: true, message: 'x' })).toMatchObject({
      status: 'error',
      code: 'send_failed',
      httpStatus: 502
    });
    expect(interpretAuthEmailResponse(500, { error: { message: 'Unexpected server error' } })).toMatchObject({
      status: 'error',
      code: 'http_500',
      message: 'Unexpected server error'
    });
    expect(interpretAuthEmailResponse(200, { ok: false })).toMatchObject({ status: 'error', code: 'http_200' });
  });
});

describe('requestAuthEmail', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('posts JSON (with the session token when given) to the route', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await requestAuthEmail('resend', { email: 'a@b.co' }, { accessToken: 'jwt' })).toEqual({ status: 'ok', data: { ok: true } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/auth\/email\/resend$/);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer jwt');
    // …plus the nonce our backend puts in the link (services/pendingSignIn).
    expect(JSON.parse(String(init.body))).toEqual({ email: 'a@b.co', sn: expect.stringMatching(/^[A-Za-z0-9-]{16,64}$/) });
  });

  it('is unreachable on a network error or a non-JSON page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await requestAuthEmail('signup', {})).toEqual({ status: 'unreachable' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200 })));
    expect(await requestAuthEmail('signup', {})).toEqual({ status: 'unreachable' });
  });

  it('gives up after the timeout (the container may be cold)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      )
    );
    const pending = requestAuthEmail('recovery', { email: 'a@b.co' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toEqual({ status: 'unreachable' });
  });

  it('a sent email records the nonce its link carries — only that link completes without a confirm step', async () => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, code: 'too_soon', message: 'wait' }), { status: 429 })));
    await requestAuthEmail('magiclink', { email: 'a@b.co' });
    expect(hasFreshSignInIntent()).toBe(false); // nothing was sent
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await requestAuthEmail('magiclink', { email: 'a@b.co' });
    expect(hasFreshSignInIntent()).toBe(false);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await requestAuthEmail('magiclink', { email: 'a@b.co' });
    expect(hasFreshSignInIntent()).toBe(true);
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { sn: string };
    // The record remembers the address the link went to, beside its nonce and kind.
    expect(JSON.parse(localStorage.getItem(PENDING_SIGN_IN_KEY) || '[]')).toEqual([expect.objectContaining({ nonce: sent.sn, kind: 'magiclink', email: 'a@b.co' })]);
    // A link without that nonce (an attacker's own link) is not waved through…
    expect(consumeSignInIntent('https://dreamstreamstudio.ai/auth/callback?token_hash=x&type=magiclink')).toBe(false);
    await requestAuthEmail('magiclink', { email: 'a@b.co' });
    const second = JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body)) as { sn: string };
    expect(second.sn).not.toBe(sent.sn);
    // …the link this request produced is.
    expect(consumeSignInIntent(`https://dreamstreamstudio.ai/auth/callback?token_hash=x&type=magiclink&sn=${second.sn}`)).toBe(true);
  });
});
