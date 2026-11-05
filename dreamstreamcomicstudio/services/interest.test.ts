// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('./clientConfig', () => ({ buildApiUrl: (p: string) => p }));

import { interpretInterestResponse, registerInterest } from './interest';

// The /api/interest answer contract (server/src/routes/interest.ts).
describe('interpretInterestResponse', () => {
  it('passes pending through, keeping only known studios', () => {
    expect(
      interpretInterestResponse(200, { ok: true, status: 'pending', studios: ['comic_studio', 'code_studio'], message: 'Check your inbox.' })
    ).toEqual({ ok: true, status: 'pending', message: 'Check your inbox.', studios: ['comic_studio'] });
  });

  it('has no "already subscribed" success: the backend never says so, and the page never shows it', () => {
    expect(interpretInterestResponse(200, { ok: true, status: 'confirmed', studios: [], message: 'Already in.' }).ok).toBe(false);
    // Throttle details from an older answer aren't carried through.
    expect(interpretInterestResponse(200, { ok: true, status: 'pending', message: 'x', retryAfterS: 300 })).not.toHaveProperty('retryAfterS');
  });

  it('passes known error codes and their messages through', () => {
    for (const [status, code] of [
      [400, 'invalid_email'],
      [400, 'captcha_failed'],
      [503, 'email_unavailable'],
      [503, 'try_again'],
      [503, 'interest_unavailable']
    ] as const) {
      expect(interpretInterestResponse(status, { ok: false, code, message: `m-${code}` })).toEqual({ ok: false, code, message: `m-${code}` });
    }
  });

  it('maps the per-IP limiter’s own 429 to rate_limited', () => {
    expect(interpretInterestResponse(429, { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } })).toMatchObject({
      ok: false,
      code: 'rate_limited'
    });
  });

  it('never turns an unexpected answer into a success', () => {
    expect(interpretInterestResponse(200, null).ok).toBe(false);
    expect(interpretInterestResponse(200, { ok: true }).ok).toBe(false);
    expect(interpretInterestResponse(200, { ok: true, status: 'joined', message: 'x' }).ok).toBe(false);
    expect(interpretInterestResponse(500, '<html>').ok).toBe(false);
    expect(interpretInterestResponse(502, { ok: false, code: 'something_new' })).toEqual({
      ok: false,
      message: 'Something went wrong on our end. Please try again in a minute.'
    });
  });
});

describe('registerInterest (client)', () => {
  it('validates before calling the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await registerInterest({ email: '', studios: ['comic_studio'] })).toMatchObject({ ok: false, code: 'invalid_email' });
    expect(await registerInterest({ email: 'nope', studios: ['comic_studio'] })).toMatchObject({ ok: false, code: 'invalid_email' });
    expect(await registerInterest({ email: 'a@b.io', studios: ['code_studio'] })).toMatchObject({ ok: false, code: 'invalid_studios' });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
