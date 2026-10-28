// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { SupabaseClient } from '@supabase/supabase-js';

const h = vi.hoisted(() => {
  vi.stubEnv('APP_PUBLIC_URL', 'https://dreamstreamstudio.ai');
  vi.stubEnv('AUTH_LINK_ORIGINS', 'http://localhost:3000');
  const state = { adminThrows: false, linkError: null as null | { status: number }, linkUserId: null as string | null, verificationType: 'magiclink' };
  // GoTrue's adminGenerateLink for an existing account (supabase/auth internal/api/mail.go).
  const generateLink = vi.fn(async (params: { type: string; email: string; options?: { redirectTo?: string } }) => {
    if (state.linkError) return { data: { properties: null, user: null }, error: state.linkError };
    return {
      data: {
        properties: {
          action_link: 'https://example.supabase.co/auth/v1/verify?token=secret-hash&type=magiclink',
          email_otp: '123456',
          hashed_token: 'secret-hash',
          redirect_to: params.options?.redirectTo,
          verification_type: state.verificationType
        },
        user: { id: state.linkUserId ?? 'user-1', email: params.email }
      },
      error: null
    };
  });
  return { state, generateLink };
});

vi.mock('../services/supabase.js', () => ({ getSupabaseAdmin: () => ({ auth: { admin: { generateLink: h.generateLink } } }) }));

const { createAuthHandoffRouter } = await import('./authHandoff.js');

const STREAM = 'https://stream.dreamstreamstudio.ai';
const APP = 'https://dreamstreamstudio.ai';
const fakeAdmin = () => {
  if (h.state.adminThrows) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  return { auth: { admin: { generateLink: h.generateLink } } } as unknown as SupabaseClient;
};

// Mirrors the production mount (index.ts): the global requireAuth has already set req.user.
let signedIn: { id: string; email?: string } | null = { id: 'user-1', email: 'ada@example.com' };
const mount = (path: string, router: express.Router) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (!signedIn) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
    req.user = { id: signedIn.id, email: signedIn.email };
    next();
  });
  app.use(path, router);
  return app;
};
const appOn = mount('/api/auth/handoff', createAuthHandoffRouter({ streamHostOn: true, getAdmin: fakeAdmin, perMinute: 1000 }));
const appOff = mount('/api/auth/handoff', createAuthHandoffRouter({ streamHostOn: false, getAdmin: fakeAdmin }));
const appLimited = mount('/api/auth/handoff', createAuthHandoffRouter({ streamHostOn: true, getAdmin: fakeAdmin }));

const servers: Server[] = [];
const bases: Record<'on' | 'off' | 'limited', string> = { on: '', off: '', limited: '' };
beforeAll(async () => {
  for (const [name, app] of [['on', appOn], ['off', appOff], ['limited', appLimited]] as const) {
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    servers.push(server);
    bases[name] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});
beforeEach(() => {
  Object.assign(h.state, { adminThrows: false, linkError: null, linkUserId: null, verificationType: 'magiclink' });
  signedIn = { id: 'user-1', email: 'ada@example.com' };
  h.generateLink.mockClear();
});

const post = async (body: unknown, opts: { app?: keyof typeof bases; origin?: string } = {}) => {
  const res = await fetch(`${bases[opts.app ?? 'on']}/api/auth/handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.origin ? { origin: opts.origin } : {}) },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, headers: res.headers };
};

describe('POST /api/auth/handoff', () => {
  it('into Stream Studio: a one-time sign-in link for the caller, on the Stream Studio host', async () => {
    const r = await post({ to: 'live', path: '/live#/monitor' }, { origin: APP });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, url: `${STREAM}/?token_hash=secret-hash&type=magiclink&after=monitor` });
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(h.generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'ada@example.com', options: { redirectTo: `${STREAM}/` } });
    // Never Supabase's action link or the raw OTP.
    expect(JSON.stringify(r.json)).not.toContain('123456');
    expect(JSON.stringify(r.json)).not.toContain('supabase.co');
    expect((await post({ to: 'live' }, { origin: APP })).json.url).toBe(`${STREAM}/?token_hash=secret-hash&type=magiclink`);
  });

  it('into the main app: /auth/callback on the main origin with an allowlisted next path', async () => {
    const r = await post({ to: 'main', path: '/?view=chat' }, { origin: STREAM });
    expect(r.status).toBe(200);
    expect(r.json.url).toBe(`${APP}/auth/callback?token_hash=secret-hash&type=magiclink&next=%2F%3Fview%3Dchat`);
    expect((await post({ to: 'main' }, { origin: STREAM })).json.url).toBe(`${APP}/auth/callback?token_hash=secret-hash&type=magiclink&next=%2F`);
    // A developer's localhost keeps its own origin (it is on the strict allowlist).
    expect((await post({ to: 'main' }, { origin: 'http://localhost:3000' })).json.url).toBe('http://localhost:3000/auth/callback?token_hash=secret-hash&type=magiclink&next=%2F');
  });

  it('echoes the receiving app’s sign-in nonce (only a well-formed one)', async () => {
    const sn = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    expect((await post({ to: 'live', path: '#/monitor', sn }, { origin: APP })).json.url).toBe(
      `${STREAM}/?token_hash=secret-hash&type=magiclink&sn=${sn}&after=monitor`
    );
    expect((await post({ to: 'main', sn }, { origin: STREAM })).json.url).toBe(`${APP}/auth/callback?token_hash=secret-hash&type=magiclink&sn=${sn}&next=%2F`);
    expect((await post({ to: 'live', sn: 'x&next=//evil.example' }, { origin: APP })).json.url).toBe(`${STREAM}/?token_hash=secret-hash&type=magiclink`);
  });

  it('refuses unknown destinations and paths (no open redirect)', async () => {
    for (const body of [{}, { to: 'evil' }, { to: 'live', path: 'https://evil.example/' }, { to: 'live', path: '/live#/studio?k=x' }, { to: 'main', path: '//evil.example' }, { to: 'main', path: 'https://evil.example' }, { to: 'main', path: '/share/abc' }]) {
      const r = await post(body, { origin: APP });
      expect(r.status).toBe(400);
      expect(r.json.url).toBeUndefined();
    }
    expect(h.generateLink).not.toHaveBeenCalled();
  });

  it('only answers our own apps’ pages', async () => {
    for (const origin of ['https://evil.example', 'https://3000-abc-token.dreamstreamstudio.ai', 'http://dreamstreamstudio.ai', 'https://stream.dreamstreamstudio.ai.evil.com']) {
      const r = await post({ to: 'live' }, { origin });
      expect(r.status).toBe(403);
    }
    expect(h.generateLink).not.toHaveBeenCalled();
    // No Origin header (not a browser): the bearer token decides.
    expect((await post({ to: 'live' })).status).toBe(200);
  });

  it('never hands out a link for another account', async () => {
    h.state.linkUserId = 'someone-else';
    const r = await post({ to: 'live' }, { origin: APP });
    expect(r.status).toBe(409);
    expect(r.json.url).toBeUndefined();
  });

  it('fails plainly when GoTrue or the service role is unavailable', async () => {
    h.state.linkError = { status: 500 };
    expect((await post({ to: 'live' }, { origin: APP })).status).toBe(502);
    h.state.linkError = null;
    h.state.adminThrows = true;
    expect((await post({ to: 'live' }, { origin: APP })).status).toBe(503);
    h.state.adminThrows = false;
    signedIn = { id: 'user-2' };
    expect((await post({ to: 'live' }, { origin: APP })).json.code).toBe('no_email');
  });

  it('is off (404) while the Stream Studio host switch is off', async () => {
    // (Its own account: the limiter's counts are shared by every router in this file.)
    signedIn = { id: 'switch-off-user', email: 'off@example.com' };
    const r = await post({ to: 'live' }, { app: 'off', origin: APP });
    expect(r.status).toBe(404);
    expect(r.json.code).toBe('handoff_unavailable');
    expect(h.generateLink).not.toHaveBeenCalled();
  });

  it('is rate limited per account (10 a minute)', async () => {
    signedIn = { id: 'rate-limited-user', email: 'rl@example.com' };
    h.state.linkUserId = 'rate-limited-user';
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await post({ to: 'live' }, { app: 'limited', origin: APP })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('never logs the token or the link', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    await post({ to: 'live', path: '#/settings' }, { origin: APP });
    h.state.linkUserId = 'someone-else';
    await post({ to: 'main' }, { origin: APP });
    const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n');
    expect(logged).not.toContain('secret-hash');
    expect(logged).not.toContain('ada@example.com');
    spies.forEach((s) => s.mockRestore());
  });
});
