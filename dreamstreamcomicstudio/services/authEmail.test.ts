import { afterEach, describe, expect, it, vi } from 'vitest';
import { interpretAuthEmailResponse, requestAuthEmail } from './authEmail';

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
    expect(JSON.parse(String(init.body))).toEqual({ email: 'a@b.co' });
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
});
