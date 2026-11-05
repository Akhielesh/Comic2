// validateApiKey sends exactly ONE key — the one being checked, in its provider header (never in
// the body or the URL) — plus the session token, because POST /api/keys/validate is signed-in
// only (BK-0). No other stored key rides along.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 'session-token' } } })) } }
}));

const { validateApiKey } = await import('./keyValidation');
const { PROVIDER_META } = await import('./apiKeys');

type Call = { url: string; headers: Record<string, string>; body: string };
const calls: Call[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? '') });
    return new Response(JSON.stringify({ provider: 'gemini', status: 'valid', valid: true, message: 'Valid Gemini key.' }), { status: 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('validateApiKey', () => {
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
});
