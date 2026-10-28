// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// ADR 0006 WS-4 additions to the auth-email routes: the breached-password check at sign-up and
// POST /secure ("Not you? Secure my account"). Same fakes as authEmail.test.ts, plus the
// live_secure_account RPC.
const h = vi.hoisted(() => {
  vi.stubEnv('APP_PUBLIC_URL', 'https://dreamstreamstudio.ai');
  vi.stubEnv('AUTH_LINK_ORIGINS', 'http://localhost:3000');
  const state = {
    mailerConfigured: true,
    latest: null as string | null,
    rpc: { data: null as unknown, error: null as unknown },
    adminThrows: false
  };
  const generateLink = vi.fn(async (params: { type: string; email: string }) => ({
    data: { properties: { hashed_token: `hash-${params.type}`, verification_type: params.type }, user: { id: 'u-1' } },
    error: null as unknown
  }));
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data: state.rpc.data, error: state.rpc.error }));
  const query = () => {
    const q = { select: () => q, eq: () => q, is: () => q, gt: () => q, limit: () => q, maybeSingle: async () => ({ data: null, error: null }) };
    return q;
  };
  const admin = { rpc, from: query, auth: { admin: { generateLink, getUserById: vi.fn(async () => ({ data: { user: null }, error: { status: 404 } })) } } };
  const sendEmail = vi.fn(async (_opts: Record<string, unknown>) => ({ ok: true, messageId: 'm1' }) as { ok: boolean });
  const verifyTurnstile = vi.fn(async (token?: string) => token === 'good-token');
  return { state, admin, rpc, generateLink, sendEmail, verifyTurnstile };
});

vi.mock('../services/supabase.js', () => ({
  getSupabaseAdmin: () => {
    if (h.state.adminThrows) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
    return h.admin;
  }
}));
vi.mock('../services/mailer.js', () => ({
  mailerConfigured: () => h.state.mailerConfigured,
  getEmailUsageStatus: async () => ({ day: 0, month: 0, maxPerDay: 200, maxPerMonth: 2500 }),
  sendEmail: h.sendEmail
}));
vi.mock('../services/turnstile.js', () => ({
  turnstileConfigured: () => true,
  verifyTurnstile: h.verifyTurnstile
}));
vi.mock('../services/emailStore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/emailStore.js')>()),
  latestAuthEmailAt: vi.fn(async () => h.state.latest),
  countRecentAuthEmails: vi.fn(async () => 0)
}));

const { authEmailRouter, breachedPasswordCheckOn, pwnedPasswordCount, setPwnedFetcher, BREACHED_PASSWORD_MESSAGE } = await import('./authEmail.js');

const app = express();
app.use(express.json());
app.use('/api/auth/email', authEmailRouter);
let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  Object.assign(h.state, { mailerConfigured: true, latest: null, adminThrows: false, rpc: { data: null, error: null } });
  h.generateLink.mockClear();
  h.sendEmail.mockClear();
  h.rpc.mockClear();
  h.verifyTurnstile.mockClear();
});
afterEach(() => setPwnedFetcher());

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}/api/auth/email${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex').toUpperCase();

/** A fake range API that knows these passwords (and pads its answer like the real one). */
const rangeApi = (breached: Record<string, number>) => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const prefix = url.slice(-5);
    const lines = ['0018A45C4D1DEF81644B54AB7F969B88D65:0', '00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2'];
    for (const [pw, n] of Object.entries(breached)) if (sha1(pw).startsWith(prefix)) lines.push(`${sha1(pw).slice(5)}:${n}`);
    return new Response(lines.join('\r\n'), { status: 200 });
  }) as typeof fetch;
  return { f, seen };
};

describe('pwnedPasswordCount (k-anonymity)', () => {
  it('sends only the first 5 characters of the SHA-1, with padding, and reads the count', async () => {
    const api = rangeApi({ 'correct horse': 3_861 });
    expect(await pwnedPasswordCount('correct horse', { fetcher: api.f })).toBe(3861);
    expect(api.seen[0].url).toBe(`https://api.pwnedpasswords.com/range/${sha1('correct horse').slice(0, 5)}`);
    expect(api.seen[0].headers['Add-Padding']).toBe('true');
    expect(JSON.stringify(api.seen)).not.toContain('correct horse');
    expect(JSON.stringify(api.seen)).not.toContain(sha1('correct horse').slice(5));
    expect(await pwnedPasswordCount('a long unusual passphrase 9q', { fetcher: api.f })).toBe(0);
  });

  it('padding rows (count 0) are not breaches; failures are "unknown", not "fine"', async () => {
    const pad = (async () => new Response(`${sha1('pw-x').slice(5)}:0\n`, { status: 200 })) as unknown as typeof fetch;
    expect(await pwnedPasswordCount('pw-x', { fetcher: pad })).toBe(0);
    expect(await pwnedPasswordCount('pw', { fetcher: (async () => new Response('', { status: 503 })) as unknown as typeof fetch })).toBeNull();
    expect(await pwnedPasswordCount('pw', { fetcher: (async () => Promise.reject(new Error('dns'))) as unknown as typeof fetch })).toBeNull();
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    expect(await pwnedPasswordCount('pw', { fetcher: hang, timeoutMs: 20 })).toBeNull();
  });

  it('is on in production, off under the test runner unless forced, and can be switched off', () => {
    vi.stubEnv('PWNED_PASSWORDS_CHECK', '');
    expect(breachedPasswordCheckOn()).toBe(false); // NODE_ENV=test
    vi.stubEnv('NODE_ENV', 'production');
    expect(breachedPasswordCheckOn()).toBe(true);
    vi.stubEnv('PWNED_PASSWORDS_CHECK', 'off');
    expect(breachedPasswordCheckOn()).toBe(false);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('PWNED_PASSWORDS_CHECK', 'on');
    expect(breachedPasswordCheckOn()).toBe(true);
    vi.stubEnv('PWNED_PASSWORDS_CHECK', '');
  });
});

describe('sign-up refuses breached passwords', () => {
  const signup = (password: string) => ({
    app: 'main',
    email: 'ada@example.com',
    password,
    captchaToken: 'good-token',
    data: { username: 'ada_l', first_name: 'Ada', dob: '1990-12-10', terms_accepted: true }
  });

  it('before spending the captcha, with a plain reason', async () => {
    vi.stubEnv('PWNED_PASSWORDS_CHECK', 'on');
    setPwnedFetcher(rangeApi({ 'password123!': 120_000 }).f);
    const res = await post('/signup', signup('password123!'));
    expect(res).toEqual({ status: 400, json: { ok: false, code: 'breached_password', message: BREACHED_PASSWORD_MESSAGE } });
    expect(h.verifyTurnstile).not.toHaveBeenCalled();
    expect(h.generateLink).not.toHaveBeenCalled();
    const ok = await post('/signup', signup('an unusual long phrase 42'));
    expect(ok.status).toBe(200);
    vi.stubEnv('PWNED_PASSWORDS_CHECK', '');
  });

  it('fails open when the range API is down (with a log line)', async () => {
    vi.stubEnv('PWNED_PASSWORDS_CHECK', 'on');
    setPwnedFetcher((async () => new Response('', { status: 500 })) as unknown as typeof fetch);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await post('/signup', signup('password123!'))).status).toBe(200);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('breached-password check unavailable'))).toBe(true);
    warn.mockRestore();
    vi.stubEnv('PWNED_PASSWORDS_CHECK', '');
  });
});

describe('POST /secure (“Not you? Secure my account”)', () => {
  const TOKEN = 'Q2hhbmdlIG1lIHBsZWFzZSBub3cgMTIz';
  const secured = { ok: true, sessions_ended: 3, devices_revoked: [{ id: 'd1', thumb: 't' }], email: 'ada@example.com', user_id: 'u-1', email_hint: 'a•••@example.com' };

  it('ends every session, then emails a password-reset link — and says exactly that', async () => {
    h.state.rpc.data = secured;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const res = await post('/secure', { token: TOKEN });
    expect(res).toEqual({
      status: 200,
      json: { ok: true, sessionsEnded: 3, signedOutEverywhere: true, devicesRevoked: 1, resetEmail: 'sent', emailHint: 'a•••@example.com' }
    });
    expect(h.rpc).toHaveBeenCalledWith('live_secure_account', { p_token: TOKEN });
    expect(h.generateLink).toHaveBeenCalledWith(expect.objectContaining({ type: 'recovery', email: 'ada@example.com' }));
    expect(h.sendEmail.mock.calls[0][0]).toMatchObject({ to: 'ada@example.com', template: 'auth-recovery' });
    expect(h.verifyTurnstile).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(log.mock.calls)).not.toContain('ada@example.com');
    log.mockRestore();
  });

  it('is honest when the reset email can’t go out, or sessions couldn’t be ended', async () => {
    h.state.rpc.data = { ...secured, sessions_ended: -1 };
    h.state.mailerConfigured = false;
    expect((await post('/secure', { token: TOKEN })).json).toMatchObject({ ok: true, signedOutEverywhere: false, sessionsEnded: null, resetEmail: 'unavailable' });
    h.state.mailerConfigured = true;
    h.state.latest = new Date().toISOString(); // an email went out a moment ago
    h.state.rpc.data = secured;
    expect((await post('/secure', { token: TOKEN })).json).toMatchObject({ ok: true, signedOutEverywhere: true, resetEmail: 'throttled' });
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('explains used, expired and invalid links; refuses junk before asking the database', async () => {
    h.state.rpc.data = { ok: false, error: 'used', secured_at: '2026-10-28T21:00:00Z' };
    expect(await post('/secure', { token: TOKEN })).toMatchObject({ status: 409, json: { code: 'used', securedAt: '2026-10-28T21:00:00Z' } });
    h.state.rpc.data = { ok: false, error: 'expired' };
    expect((await post('/secure', { token: TOKEN })).status).toBe(410);
    h.state.rpc.data = { ok: false, error: 'invalid' };
    expect((await post('/secure', { token: TOKEN })).status).toBe(400);
    h.rpc.mockClear();
    for (const token of ['', 'short', 'has spaces in it but long enough', 42]) expect((await post('/secure', { token })).status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.generateLink).not.toHaveBeenCalled();
  });

  it('says “try again” when the database or the service role is unavailable (e.g. SQL not applied yet)', async () => {
    h.state.rpc.error = { code: 'PGRST202', message: 'Could not find the function' };
    expect((await post('/secure', { token: TOKEN })).status).toBe(503);
    h.state.rpc.error = null;
    h.state.adminThrows = true;
    expect((await post('/secure', { token: TOKEN })).status).toBe(503);
  });
});
