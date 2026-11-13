// validateApiKey sends exactly ONE key — the one being checked, in its provider header (never in
// the body or the URL) — plus the session token, because POST /api/keys/validate is signed-in
// only (BK-0). No other stored key rides along.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 'session-token' } } })) } }
}));

const { validateApiKey, KEY_CHECK_SIGNED_OUT_COPY, KEY_CHECK_UNAVAILABLE_COPY } = await import('./keyValidation');
const { PROVIDER_META } = await import('./apiKeys');

type Call = { url: string; headers: Record<string, string>; body: string };
const calls: Call[] = [];

beforeEach(() => {
  localStorage.clear();
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? '') });
    return new Response(JSON.stringify({ provider: 'gemini', status: 'valid', valid: true, message: 'Valid Gemini key.' }), { status: 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('validateApiKey', () => {
  it('checks an account-only key without sending any device secrets, preserving source governance', async () => {
    localStorage.setItem('dreamstream_source_governance', JSON.stringify({ openrouter: false }));
    await validateApiKey('openrouter');
    expect(Object.keys(calls[0].headers).filter((h) => /-key$/i.test(h))).toEqual([]);
    expect(calls[0].headers.Authorization).toBe('Bearer session-token');
    expect(calls[0].headers['X-Allowed-Sources'].split(',')).not.toContain('openrouter');
  });
  it('Gemini: the key travels only in X-Gemini-Key — not in the body or the URL — with the session token', async () => {
    const r = await validateApiKey('gemini', 'AIza-mine-secret');
    expect(r).toEqual({ provider: 'gemini', status: 'valid', valid: true, message: 'Valid Gemini key.' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toMatch(/\/api\/keys\/validate$/);
    expect(call.url).not.toContain('AIza-mine-secret');
    expect(JSON.parse(call.body)).toEqual({ provider: 'gemini' });
    expect(call.headers[PROVIDER_META.gemini.header]).toBe('AIza-mine-secret');
    expect(call.headers.Authorization).toBe('Bearer session-token');
  });

  it('sends no other provider key header', async () => {
    await validateApiKey('openrouter', 'sk-or-mine');
    const keyHeaders = Object.keys(calls[0].headers).filter((h) => /-key$/i.test(h));
    expect(keyHeaders).toEqual([PROVIDER_META.openrouter.header]);
  });

  // Only a 200 from the route is a verdict on the key. Our own route failing (expired session,
  // rate limit, 5xx, offline) must not come back as 'invalid' — the UI would store it and show a
  // good key as Invalid for a day.
  it.each([
    [401, KEY_CHECK_SIGNED_OUT_COPY],
    [429, KEY_CHECK_UNAVAILABLE_COPY],
    [503, KEY_CHECK_UNAVAILABLE_COPY]
  ])('the route answering HTTP %i is no verdict: unavailable, with fixed copy', async (status, message) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"x"}}', { status })));
    const r = await validateApiKey('nvidia', 'nvapi-mine');
    expect(r).toEqual({ provider: 'nvidia', status: 'unavailable', valid: false, message });
  });

  it('a network failure is no verdict either, and its text is not shown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('connect ECONNREFUSED 10.0.0.7:443'); }));
    const r = await validateApiKey('openai', 'sk-mine');
    expect(r).toEqual({ provider: 'openai', status: 'unavailable', valid: false, message: KEY_CHECK_UNAVAILABLE_COPY });
  });
});
