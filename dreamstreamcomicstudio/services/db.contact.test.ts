// Settings › Contact (CONTACT-1): savePublicContactMessage used to insert into public.contact_messages
// straight from the browser (supabase.from), a table no server/sql file created — so every send failed.
// It now POSTs to the authenticated, rate-limited /api/contact with the session token and nothing else,
// answers true only for a 2xx { ok: true }, and never throws.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sb = vi.hoisted(() => ({
  token: 'session-token-1' as string | null,
  sessionThrows: false,
  from: vi.fn(),
  getUser: vi.fn()
}));

vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => {
        if (sb.sessionThrows) throw new Error('storage blocked');
        return { data: { session: sb.token ? { access_token: sb.token, user: { id: 'u1' } } : null } };
      },
      getUser: sb.getUser
    },
    from: sb.from
  }
}));
vi.mock('./clientConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./clientConfig')>()),
  buildApiUrl: (path: string) => `https://api.example.test${path}`
}));

const { savePublicContactMessage } = await import('./db');

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];
let reply: () => Promise<Response> = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  sb.token = 'session-token-1';
  sb.sessionThrows = false;
  sb.from.mockReset();
  sb.getUser.mockReset();
  calls = [];
  reply = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return reply();
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (body: unknown, status: number) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('savePublicContactMessage', () => {
  it('POSTs { email, message } to /api/contact with the session token — never supabase.from', async () => {
    await expect(savePublicContactMessage('  reply@example.com ', '  [Phone: 555]\n\nHello  ')).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example.test/api/contact');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer session-token-1' });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ email: 'reply@example.com', message: '[Phone: 555]\n\nHello' });
    expect(sb.from).not.toHaveBeenCalled();
  });

  it('sends only the session token: no provider-key headers ride along', async () => {
    await savePublicContactMessage('reply@example.com', 'Hello');
    expect(Object.keys(calls[0].init.headers as Record<string, string>).sort()).toEqual(['Authorization', 'Content-Type']);
  });

  it.each([
    ['400 (invalid)', json({ error: { message: 'x', code: 'INVALID_CONTACT' } }, 400)],
    ['401 (signed out on the server)', json({ error: { message: 'x' } }, 401)],
    ['429 (rate limited)', json({ error: { message: 'x', code: 'RATE_LIMITED' } }, 429)],
    ['503 (store not there)', json({ error: { message: 'x', code: 'CONTACT_UNAVAILABLE' } }, 503)],
    ['500', json({ error: { message: 'x' } }, 500)],
    ['a 200 that is not { ok: true } (misrouted to the static site)', async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['a 200 with ok: false', json({ ok: false }, 200)]
  ])('false for %s', async (_label, r) => {
    reply = r;
    await expect(savePublicContactMessage('reply@example.com', 'Hello')).resolves.toBe(false);
    expect(sb.from).not.toHaveBeenCalled();
  });

  it('false, never a rejection, when the network fails', async () => {
    reply = async () => { throw new TypeError('Failed to fetch'); };
    await expect(savePublicContactMessage('reply@example.com', 'Hello')).resolves.toBe(false);
  });

  it('false without a session, and nothing is sent', async () => {
    sb.token = null;
    await expect(savePublicContactMessage('reply@example.com', 'Hello')).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it('false when reading the session throws', async () => {
    sb.sessionThrows = true;
    await expect(savePublicContactMessage('reply@example.com', 'Hello')).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it('false for a blank email or message, and nothing is sent', async () => {
    await expect(savePublicContactMessage('   ', 'Hello')).resolves.toBe(false);
    await expect(savePublicContactMessage('reply@example.com', ' \n ')).resolves.toBe(false);
    await expect(savePublicContactMessage(undefined as unknown as string, 'Hello')).resolves.toBe(false);
    expect(calls).toEqual([]);
  });
});
