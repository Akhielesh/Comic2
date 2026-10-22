// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// Every dependency with I/O is faked: GoTrue's admin API (with its real semantics for existing,
// confirmed and unknown users — see the research in docs/email/SETUP.md), the profiles /
// live_welcome_tickets lookups, the mailer, Turnstile and the email_log throttle counts.
const h = vi.hoisted(() => {
  vi.stubEnv('APP_PUBLIC_URL', 'https://dreamstreamstudio.ai');
  vi.stubEnv('AUTH_LINK_ORIGINS', 'http://localhost:3000');

  const state = {
    adminThrows: false,
    mailerConfigured: true,
    usage: { day: 0, month: 0, maxPerDay: 200, maxPerMonth: 2500 },
    turnstileConfigured: true,
    latest: null as string | null,
    hourCount: 0,
    dayCount: 0,
    /** profiles.email → id */
    profiles: new Map<string, string>(),
    /** auth.users id → confirmation */
    users: new Map<string, { email_confirmed_at: string | null }>(),
    /** sha256 hex of unredeemed, unexpired live welcome tickets */
    tickets: new Set<string>()
  };

  const query = (table: string) => {
    const filters: Record<string, unknown> = {};
    const q = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return q;
      },
      is: () => q,
      gt: () => q,
      limit: () => q,
      maybeSingle: async () => {
        if (table === 'profiles') {
          const id = state.profiles.get(String(filters.email));
          return { data: id ? { id } : null, error: null };
        }
        if (table === 'live_welcome_tickets') {
          return { data: state.tickets.has(String(filters.token_hash)) ? { token_hash: filters.token_hash } : null, error: null };
        }
        return { data: null, error: { message: `unexpected table ${table}` } };
      }
    };
    return q;
  };

  // GoTrue's adminGenerateLink, per supabase/auth internal/api/mail.go.
  const generateLink = vi.fn(async (params: { type: string; email: string; password?: string; options?: { data?: object; redirectTo?: string } }) => {
    const id = state.profiles.get(params.email);
    const user = id ? state.users.get(id) : undefined;
    if (params.type === 'recovery' && !id) {
      return { data: { properties: null, user: null }, error: { status: 404, code: 'user_not_found', message: 'User with this email not found' } };
    }
    if (params.type === 'signup' && user?.email_confirmed_at) {
      return {
        data: { properties: null, user: null },
        error: { status: 422, code: 'email_exists', message: 'A user with this email address has already been registered' }
      };
    }
    let uid = id;
    if (!uid) {
      uid = `user-${state.users.size + 1}`;
      state.profiles.set(params.email, uid);
      state.users.set(uid, { email_confirmed_at: null });
    }
    return {
      data: {
        properties: {
          action_link: `https://example.supabase.co/auth/v1/verify?token=hash-${params.type}&type=${params.type}`,
          email_otp: '987654',
          hashed_token: `hash-${params.type}`,
          redirect_to: 'https://dreamstreamstudio.ai',
          // A magic link for an unknown address silently becomes a sign-up.
          verification_type: params.type === 'magiclink' && !id ? 'signup' : params.type
        },
        user: { id: uid }
      },
      error: null
    };
  });

  const getUserById = vi.fn(async (id: string) => {
    const user = state.users.get(id);
    return user
      ? { data: { user: { id, ...user } }, error: null }
      : { data: { user: null }, error: { status: 404, message: 'User not found' } };
  });

  const admin = { from: query, auth: { admin: { generateLink, getUserById } } };
  const sendEmail = vi.fn(async (_opts: Record<string, unknown>) => ({ ok: true, messageId: 'm1' }) as { ok: boolean; error?: string });
  const verifyTurnstile = vi.fn(async (token?: string) => token === 'good-token');
  return { state, admin, generateLink, getUserById, sendEmail, verifyTurnstile };
});

vi.mock('../services/supabase.js', () => ({
  getSupabaseAdmin: () => {
    if (h.state.adminThrows) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
    return h.admin;
  }
}));
vi.mock('../services/mailer.js', () => ({
  mailerConfigured: () => h.state.mailerConfigured,
  getEmailUsageStatus: async () => ({ ...h.state.usage }),
  sendEmail: h.sendEmail
}));
vi.mock('../services/turnstile.js', () => ({
  turnstileConfigured: () => h.state.turnstileConfigured,
  verifyTurnstile: h.verifyTurnstile
}));
vi.mock('../services/emailStore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/emailStore.js')>()),
  latestAuthEmailAt: vi.fn(async () => h.state.latest),
  // The route asks for a 1 h and a 24 h window.
  countRecentAuthEmails: vi.fn(async (_email: string, sinceIso: string) =>
    Date.now() - Date.parse(sinceIso) > 2 * 3_600_000 ? h.state.dayCount : h.state.hourCount
  )
}));

const { authEmailRouter, dobProblem } = await import('./authEmail.js');

// Mirrors the production mount (index.ts), minus the IP limiter:
//   app.use('/api/auth/email', authEmailRateLimit, optionalAuth, authEmailRouter)
// with a stand-in for optionalAuth.
let signedInEmail: string | null = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (signedInEmail) req.user = { id: 'signed-in-user', email: signedInEmail };
  next();
});
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

const APP = 'https://dreamstreamstudio.ai';
const TICKET = 'a'.repeat(48);
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

beforeEach(() => {
  Object.assign(h.state, {
    adminThrows: false,
    mailerConfigured: true,
    usage: { day: 0, month: 0, maxPerDay: 200, maxPerMonth: 2500 },
    turnstileConfigured: true,
    latest: null,
    hourCount: 0,
    dayCount: 0
  });
  h.state.profiles.clear();
  h.state.users.clear();
  h.state.tickets.clear();
  signedInEmail = null;
  h.generateLink.mockClear();
  h.getUserById.mockClear();
  h.sendEmail.mockClear();
  h.verifyTurnstile.mockClear();
});

const addUser = (email: string, confirmed: boolean) => {
  const id = `existing-${h.state.users.size + 1}`;
  h.state.profiles.set(email, id);
  h.state.users.set(id, { email_confirmed_at: confirmed ? '2026-10-01T00:00:00Z' : null });
  return id;
};

// Resend / reset / magic link need a solved challenge; tests send one unless they say
// otherwise with `captchaToken: null`.
const NEEDS_CAPTCHA = new Set(['/resend', '/recovery', '/magiclink']);
const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  if (NEEDS_CAPTCHA.has(path) && body && typeof body === 'object' && !('captchaToken' in body)) {
    body = { ...(body as Record<string, unknown>), captchaToken: 'good-token' };
  }
  const res = await fetch(`${base}/api/auth/email${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, headers: res.headers };
};

const signupBody = (overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
  app: 'main',
  email: 'Ada@Example.com ',
  password: 'correct horse',
  captchaToken: 'good-token',
  data: {
    username: 'ada_l',
    first_name: 'Ada',
    last_name: '',
    phone_number: '',
    dob: '1990-12-10',
    terms_accepted: true,
    marketing_consent: false,
    email_pref_product_updates: true,
    email_pref_marketing: false,
    ...data
  },
  ...overrides
});

const lastSend = () => h.sendEmail.mock.calls.at(-1)?.[0] as { to: string; template: string; params: { actionUrl: string }; brand?: string; track?: boolean };

describe('readiness preflight', () => {
  it('answers 503 with fallback:true — before spending the captcha — when the service role is missing', async () => {
    h.state.adminThrows = true;
    const res = await post('/signup', signupBody());
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ ok: false, code: 'email_unavailable', fallback: true });
    expect(h.verifyTurnstile).not.toHaveBeenCalled();
    expect(h.generateLink).not.toHaveBeenCalled();
  });

  it('falls back when the mailer is unconfigured or the email cost cap is reached', async () => {
    h.state.mailerConfigured = false;
    expect((await post('/recovery', { email: 'ada@example.com', captchaToken: 'good-token' })).json).toMatchObject({ fallback: true });
    h.state.mailerConfigured = true;
    h.state.usage = { day: 200, month: 300, maxPerDay: 200, maxPerMonth: 2500 };
    const res = await post('/magiclink', { email: 'ada@example.com', captchaToken: 'good-token' });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('email_unavailable');
    expect(h.verifyTurnstile).not.toHaveBeenCalled();
  });

  it('rejects malformed emails as a final 400', async () => {
    for (const email of ['', 'nope', 'a@b', `${'x'.repeat(320)}@example.com`, 42]) {
      const res = await post('/resend', { email });
      expect(res.status).toBe(400);
      expect(res.json.code).toBe('invalid_email');
    }
  });
});

describe('captcha policy', () => {
  it('requires a token for sign-up when Turnstile is configured', async () => {
    const res = await post('/signup', signupBody({ captchaToken: undefined }));
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('captcha_required');
    expect(h.generateLink).not.toHaveBeenCalled();
  });

  it('rejects a token that fails verification on every route', async () => {
    for (const path of ['/signup', '/resend', '/recovery', '/magiclink']) {
      const res = await post(path, { ...signupBody(), captchaToken: 'bad-token' });
      expect(res.status, path).toBe(400);
      expect(res.json.code, path).toBe('captcha_failed');
    }
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('is a no-op when Turnstile is not configured', async () => {
    h.state.turnstileConfigured = false;
    const res = await post('/signup', signupBody({ captchaToken: undefined }));
    expect(res.json).toEqual({ ok: true, confirmEmail: true });
  });

  it('lets a live sign-up through on a valid welcome ticket instead of a captcha', async () => {
    h.state.tickets.add(sha256(TICKET));
    const ok = await post('/signup', signupBody({ app: 'live', captchaToken: undefined }, { live_ticket: TICKET }));
    expect(ok.json).toEqual({ ok: true, confirmEmail: true });

    const bogus = await post('/signup', signupBody({ app: 'live', email: 'bo@example.com', captchaToken: undefined }, { live_ticket: 'b'.repeat(48) }));
    expect(bogus.json.code).toBe('captcha_required');

    // The ticket exemption is for the live app only.
    const main = await post('/signup', signupBody({ app: 'main', email: 'cy@example.com', captchaToken: undefined }, { live_ticket: TICKET }));
    expect(main.json.code).toBe('captcha_required');
  });

  it('requires a solved challenge for resend / reset / magic link (no stranger can spend an address’s allowance)', async () => {
    addUser('ada@example.com', true);
    for (const path of ['/resend', '/recovery', '/magiclink']) {
      const res = await post(path, { email: 'ada@example.com', captchaToken: null });
      expect(res.status, path).toBe(400);
      expect(res.json.code, path).toBe('captcha_required');
      expect((await post(path, { email: 'ada@example.com' })).json, path).toEqual({ ok: true });
    }
    expect(h.sendEmail).toHaveBeenCalledTimes(2); // recovery + magic link (resend: already confirmed)
  });

  it('skips the captcha for a signed-in user re-sending their own confirmation', async () => {
    addUser('ada@example.com', false);
    signedInEmail = 'ADA@example.com';
    const res = await post('/resend', { email: 'ada@example.com', captchaToken: 'stale-token' });
    expect(res.json).toEqual({ ok: true });
    expect(h.verifyTurnstile).not.toHaveBeenCalled();
    expect(h.sendEmail).toHaveBeenCalledOnce();

    signedInEmail = 'someone-else@example.com';
    expect((await post('/resend', { email: 'ada@example.com', captchaToken: 'stale-token' })).json.code).toBe('captcha_failed');
  });
});

describe('per-recipient throttle', () => {
  it('holds under a burst: concurrent requests for one address send exactly one email', async () => {
    addUser('ada@example.com', true);
    // The throttle sees a send only once the mailer has logged it, like production.
    h.sendEmail.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      h.state.latest = new Date().toISOString();
      return { ok: true, messageId: 'm' };
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => post('/recovery', { email: 'ada@example.com' })));
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 429).every((r) => r.json.code === 'too_soon')).toBe(true);
    h.sendEmail.mockImplementation(async () => ({ ok: true, messageId: 'm1' }));
  });

  it('asks for a short wait right after a send, in seconds', async () => {
    h.state.latest = new Date(Date.now() - 20_000).toISOString();
    const res = await post('/recovery', { email: 'ada@example.com' });
    expect(res.status).toBe(429);
    expect(res.json).toMatchObject({ ok: false, code: 'too_soon' });
    expect(res.json.retryAfterS).toBeGreaterThanOrEqual(39);
    expect(res.json.retryAfterS).toBeLessThanOrEqual(40);
    expect(String(res.json.message)).toMatch(/seconds/);
    expect(res.headers.get('retry-after')).toBe(String(res.json.retryAfterS));
    expect(h.generateLink).not.toHaveBeenCalled();
  });

  it('caps each address at 5 an hour and 10 a day', async () => {
    h.state.latest = new Date(Date.now() - 120_000).toISOString();
    h.state.hourCount = 5;
    const hour = await post('/signup', signupBody());
    expect(hour.status).toBe(429);
    expect(hour.json.code).toBe('too_many');

    h.state.hourCount = 2;
    h.state.dayCount = 10;
    const day = await post('/magiclink', { email: 'ada@example.com' });
    expect(day.status).toBe(429);
    expect(day.json.code).toBe('too_many');
    expect(h.generateLink).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('lets the next email through once the minute has passed', async () => {
    h.state.latest = new Date(Date.now() - 61_000).toISOString();
    h.state.hourCount = 1;
    h.state.dayCount = 1;
    expect((await post('/signup', signupBody())).json).toEqual({ ok: true, confirmEmail: true });
  });
});

describe('POST /signup', () => {
  it('creates the account with whitelisted metadata and mails a main-app token_hash link', async () => {
    const res = await post('/signup', signupBody({}, { role: 'admin', is_admin: true, display_name: '  Ada   Lovelace ' }));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, confirmEmail: true });

    const params = h.generateLink.mock.calls[0][0] as { type: string; email: string; password: string; options: { data: Record<string, unknown>; redirectTo: string } };
    expect(params).toMatchObject({ type: 'signup', email: 'ada@example.com', password: 'correct horse' });
    expect(params.options.redirectTo).toBe(`${APP}/auth/callback`);
    expect(params.options.data).toEqual({
      username: 'ada_l',
      first_name: 'Ada',
      last_name: null,
      phone_number: null,
      dob: '1990-12-10',
      display_name: 'Ada Lovelace',
      terms_accepted: true,
      marketing_consent: false,
      email_pref_product_updates: true,
      email_pref_marketing: false
    });

    const sent = lastSend();
    expect(sent).toMatchObject({ to: 'ada@example.com', template: 'auth-confirm-signup', track: false, brand: undefined });
    expect(sent.params.actionUrl).toBe(`${APP}/auth/callback?token_hash=hash-signup&type=signup`);
    expect(sent.params).not.toHaveProperty('token'); // never the raw OTP
    expect(JSON.stringify(sent)).not.toContain('987654');
  });

  it('brands live sign-ups as Stream Studio and links back into the live app', async () => {
    h.state.tickets.add(sha256(TICKET));
    await post('/signup', signupBody({ app: 'live', after: 'monitor', captchaToken: undefined }, { live_ticket: TICKET, signup_source: 'stream_studio' }));
    expect((h.generateLink.mock.calls[0][0] as { options: { data: Record<string, unknown> } }).options.data).toMatchObject({
      live_ticket: TICKET,
      signup_source: 'stream_studio'
    });
    const sent = lastSend();
    expect(sent.brand).toBe('stream-studio');
    expect(sent.params.actionUrl).toBe(`${APP}/live?after=monitor&token_hash=hash-signup&type=signup`);
  });

  it('answers 409 email_exists for a confirmed account without touching it', async () => {
    addUser('ada@example.com', true);
    const res = await post('/signup', signupBody());
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ ok: false, code: 'email_exists' });
    expect(String(res.json.message)).toMatch(/already exists/);
    expect(h.generateLink).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('re-sends the confirmation for an unconfirmed account — without new metadata or password', async () => {
    addUser('ada@example.com', false);
    const res = await post('/signup', signupBody());
    expect(res.json).toEqual({ ok: true, confirmEmail: true });
    const params = h.generateLink.mock.calls[0][0] as { type: string; password: string; options: Record<string, unknown> };
    expect(params.type).toBe('signup');
    expect(params.options).not.toHaveProperty('data');
    expect(params.password).not.toBe('correct horse');
    expect(lastSend().template).toBe('auth-confirm-signup');
  });

  it('maps GoTrue’s "Database error saving new user" to database_error (the live app retries)', async () => {
    h.generateLink.mockResolvedValueOnce({
      data: { properties: null, user: null },
      error: { status: 500, code: 'unexpected_failure', message: 'Database error saving new user' }
    } as never);
    const res = await post('/signup', signupBody());
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('database_error');
    expect(String(res.json.message)).toMatch(/database error/i);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('maps a racing email_exists from GoTrue to 409', async () => {
    h.generateLink.mockResolvedValueOnce({
      data: { properties: null, user: null },
      error: { status: 422, code: 'email_exists', message: 'A user with this email address has already been registered' }
    } as never);
    expect((await post('/signup', signupBody())).status).toBe(409);
  });

  it('reports send_failed (created, no fallback) when the mail cannot go out', async () => {
    h.sendEmail.mockResolvedValueOnce({ ok: false, error: 'worker responded 502' });
    const res = await post('/signup', signupBody());
    expect(res.status).toBe(502);
    expect(res.json).toMatchObject({ ok: false, code: 'send_failed', created: true });
    expect(res.json).not.toHaveProperty('fallback');
  });

  it('validates input like the clients do (and enforces the minimum age the DB does not)', async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>, RegExp]> = [
      [{ password: 'short' }, {}, /at least 8/],
      [{ password: 'x'.repeat(73) }, {}, /at most 72/],
      [{}, { username: 'no spaces!' }, /Username/],
      [{}, { first_name: '  ' }, /First name/],
      [{}, { dob: '' }, /Date of birth is required/],
      [{}, { dob: '2020-02-30' }, /valid/],
      [{}, { dob: '2999-01-01' }, /future/],
      [{}, { dob: new Date(Date.now() - 5 * 365 * 86_400_000).toISOString().slice(0, 10) }, /at least 8/],
      [{}, { terms_accepted: 'yes' }, /Terms/],
      [{}, { display_name: 'x'.repeat(41) }, /40/]
    ];
    for (const [overrides, data, message] of cases) {
      const res = await post('/signup', signupBody(overrides, data));
      expect(res.status, JSON.stringify({ overrides, data })).toBe(400);
      expect(res.json.code).toBe('invalid_input');
      expect(String(res.json.message)).toMatch(message);
    }
    expect(h.generateLink).not.toHaveBeenCalled();
  });
});

describe('dobProblem', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  it('accepts an 8th birthday today (with a day of time-zone slack) and rejects a day later', () => {
    expect(dobProblem('2018-10-22', now)).toBeNull();
    expect(dobProblem('2018-10-23', now)).toBeNull(); // already the 23rd east of UTC
    expect(dobProblem('2018-10-24', now)).toMatch(/at least 8/);
    expect(dobProblem('1899-12-31', now)).toMatch(/valid/);
  });
});

describe('no enumeration, no account creation', () => {
  it('/resend answers ok for unknown and confirmed addresses and sends nothing', async () => {
    addUser('done@example.com', true);
    for (const email of ['ghost@example.com', 'done@example.com']) {
      expect(await post('/resend', { email })).toMatchObject({ status: 200, json: { ok: true } });
    }
    expect(h.generateLink).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.state.profiles.has('ghost@example.com')).toBe(false);
  });

  it('/resend re-issues a confirmation for an unconfirmed account (live link when asked)', async () => {
    addUser('ada@example.com', false);
    expect((await post('/resend', { email: 'ada@example.com', app: 'live', after: 'settings' })).json).toEqual({ ok: true });
    const params = h.generateLink.mock.calls[0][0] as { type: string; options: Record<string, unknown> };
    expect(params.type).toBe('signup');
    expect(params.options).not.toHaveProperty('data');
    expect(lastSend()).toMatchObject({ brand: 'stream-studio', template: 'auth-confirm-signup' });
    expect(lastSend().params.actionUrl).toBe(`${APP}/live?after=settings&token_hash=hash-signup&type=signup`);
  });

  it('/recovery answers ok for an unknown address without creating anyone', async () => {
    expect(await post('/recovery', { email: 'ghost@example.com' })).toMatchObject({ status: 200, json: { ok: true } });
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.state.profiles.has('ghost@example.com')).toBe(false);
  });

  it('/recovery always links to the main app, even when asked from the live app', async () => {
    addUser('ada@example.com', true);
    expect((await post('/recovery', { email: 'ada@example.com', app: 'live', after: 'monitor' })).json).toEqual({ ok: true });
    expect(lastSend()).toMatchObject({ template: 'auth-recovery', brand: undefined, track: false });
    expect(lastSend().params.actionUrl).toBe(`${APP}/auth/callback?token_hash=hash-recovery&type=recovery`);
  });

  it('/magiclink never calls generateLink for an unknown address (GoTrue would create the user)', async () => {
    expect(await post('/magiclink', { email: 'ghost@example.com' })).toMatchObject({ status: 200, json: { ok: true } });
    expect(h.generateLink).not.toHaveBeenCalled();
    expect(h.state.profiles.has('ghost@example.com')).toBe(false);
  });

  it('/magiclink mails a magic link for a known address, typed by what GoTrue issued', async () => {
    addUser('ada@example.com', true);
    expect((await post('/magiclink', { email: 'ada@example.com' })).json).toEqual({ ok: true });
    expect(lastSend().template).toBe('auth-magic-link');
    expect(lastSend().params.actionUrl).toBe(`${APP}/auth/callback?token_hash=hash-magiclink&type=magiclink`);
  });

  it('reports send failures honestly instead of claiming success', async () => {
    addUser('ada@example.com', true);
    h.sendEmail.mockResolvedValueOnce({ ok: false, error: 'boom' });
    const res = await post('/recovery', { email: 'ada@example.com' });
    expect(res.status).toBe(502);
    expect(res.json.code).toBe('send_failed');
  });
});

describe('link origin allowlist', () => {
  it('uses an exactly-allowlisted request Origin (local dev)', async () => {
    addUser('ada@example.com', true);
    await post('/recovery', { email: 'ada@example.com' }, { origin: 'http://localhost:3000' });
    expect(lastSend().params.actionUrl).toBe('http://localhost:3000/auth/callback?token_hash=hash-recovery&type=recovery');
    expect((h.generateLink.mock.calls[0][0] as { options: { redirectTo: string } }).options.redirectTo).toBe('http://localhost:3000/auth/callback');
  });

  it('ignores a hostile Origin — even a dreamstreamstudio.ai preview subdomain', async () => {
    addUser('ada@example.com', true);
    for (const origin of ['https://3000-abc-tok.dreamstreamstudio.ai', 'https://evil.example', 'http://localhost:3001']) {
      h.state.latest = null;
      await post('/magiclink', { email: 'ada@example.com' }, { origin });
      expect(lastSend().params.actionUrl.startsWith(`${APP}/auth/callback?`), origin).toBe(true);
    }
    for (const call of h.generateLink.mock.calls) {
      expect((call[0] as { options: { redirectTo: string } }).options.redirectTo).toBe(`${APP}/auth/callback`);
    }
  });
});
