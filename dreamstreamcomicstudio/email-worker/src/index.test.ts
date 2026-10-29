// @vitest-environment node
import { describe, expect, it } from 'vitest';
import worker, { type Env } from './index';
import { brandForSend } from './authHook';
import { describeDevice, describeMethod, formatWhen, maskIp, parseSignInAlert, secureAccountUrl, verifySecuritySignature } from './securityAlert';

// POST /send — the backend's HMAC-signed route, end-to-end against a mock EMAIL binding.
// (The /auth-hook route is covered in authHook.test.ts.)

const SECRET = 'test-hmac-secret';
const APP = 'https://dreamstreamstudio.ai';

type Sent = { from: unknown; to: unknown; subject: string; html?: string; text?: string; replyTo?: unknown };

const makeEnv = (overrides: Partial<Env> = {}) => {
  const sent: Sent[] = [];
  const env = {
    EMAIL: {
      send: async (msg: Sent) => {
        sent.push(msg);
        return { messageId: `m${sent.length}` };
      }
    },
    EMAIL_HMAC_SECRET: SECRET,
    EMAIL_FROM: 'notifications@dreamstreamstudio.ai',
    EMAIL_FROM_NAME: 'DreamStream Studio',
    EMAIL_REPLY_TO: 'support@dreamstreamstudio.ai',
    APP_URL: APP,
    ...overrides
  } as Env;
  return { env, sent };
};

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const send = async (env: Env, body: unknown, secret = SECRET) => {
  const raw = JSON.stringify(body);
  const res = await worker.fetch(
    new Request('https://dreamstream-email.example.workers.dev/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-email-signature': `sha256=${await hmacHex(secret, raw)}` },
      body: raw
    }),
    env
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

const confirm = (extra: Record<string, unknown> = {}) => ({
  template: 'auth-confirm-signup',
  to: 'ada@example.com',
  params: { actionUrl: `${APP}/live?after=monitor&token_hash=h&type=signup` },
  ...extra
});

describe('POST /send (worker route)', () => {
  it('renders with the env brand by default, from no-reply@ for auth templates', async () => {
    const { env, sent } = makeEnv();
    expect(await send(env, confirm())).toEqual({ status: 200, json: { ok: true, messageId: 'm1' } });
    expect(sent[0].subject).toBe('Confirm your email — DreamStream Studio');
    expect(sent[0].from).toEqual({ email: 'no-reply@dreamstreamstudio.ai', name: 'DreamStream Studio' });
    expect(sent[0].replyTo).toBe('support@dreamstreamstudio.ai');
  });

  it('brands subject, body and From name as Stream Studio when asked', async () => {
    const { env, sent } = makeEnv();
    expect((await send(env, confirm({ brand: 'stream-studio' }))).status).toBe(200);
    expect(sent[0].subject).toBe('Confirm your email — Stream Studio');
    expect(sent[0].from).toEqual({ email: 'no-reply@dreamstreamstudio.ai', name: 'Stream Studio' });
    expect(sent[0].html).toContain('Welcome to Stream Studio!');
    // The link the backend built is used as-is.
    expect(sent[0].html).toContain('/live?after=monitor&amp;token_hash=h&amp;type=signup');
  });

  it('ignores unknown brand values', async () => {
    const { env, sent } = makeEnv();
    await send(env, confirm({ brand: 'evil-corp' }));
    await send(env, confirm({ brand: { productName: 'Injected' } }));
    expect(sent.map((m) => m.subject)).toEqual([
      'Confirm your email — DreamStream Studio',
      'Confirm your email — DreamStream Studio'
    ]);
    expect(sent.every((m) => (m.from as { name?: string }).name === 'DreamStream Studio')).toBe(true);
  });

  it('rejects a bad signature (401) and a missing template/recipient (400)', async () => {
    const { env, sent } = makeEnv();
    expect((await send(env, confirm({ brand: 'stream-studio' }), 'wrong-secret')).status).toBe(401);
    expect((await send(env, { template: 'auth-confirm-signup' })).status).toBe(400);
    expect((await send(env, { to: 'ada@example.com', template: 'not-a-template' })).status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});

describe('brandForSend', () => {
  it('maps only the known sub-brand', () => {
    expect(brandForSend('stream-studio', `${APP}/`)).toEqual({ productName: 'Stream Studio', appUrl: `${APP}/live` });
    expect(brandForSend('stream-studio')).toEqual({ productName: 'Stream Studio', appUrl: `${APP}/live` });
    expect(brandForSend('dreamstream', APP)).toEqual({});
    expect(brandForSend(undefined, APP)).toEqual({});
  });
});

// POST /security — new-sign-in alerts from the database's access-token hook (pg_net).

const HOOK = 'test-security-hook-secret';
const TOKEN = 'Q2hhbmdlIG1lIHBsZWFzZSBub3cgMTIz';

// The database sends jsonb text (spaces after `:` and `,`); the signature covers it byte for byte.
const pgPayload = (over: Record<string, unknown> = {}) => {
  const d: Record<string, unknown> = {
    at: Date.UTC(2026, 9, 28, 21, 5),
    ip: '203.0.113.x',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    kind: 'sign_in',
    name: 'Ada <b>',
    email: 'ada@example.com',
    token: TOKEN,
    method: 'password',
    v: 1,
    ...over
  };
  return '{' + Object.entries(d).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ') + '}';
};

const security = async (env: Env, p: string, o: { secret?: string; t?: number; tamper?: (p: string) => string; header?: string } = {}) => {
  const t = o.t ?? Math.floor(Date.now() / 1000);
  const sig = await hmacHex(o.secret ?? HOOK, `${t}.${p}`);
  const body = JSON.stringify({ p: o.tamper ? o.tamper(p) : p });
  const res = await worker.fetch(
    new Request('https://dreamstream-email.example.workers.dev/security', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ds-signature': o.header ?? `t=${t},v1=${sig}` },
      body
    }),
    env
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

describe('POST /security (new sign-in alert)', () => {
  it('says plainly that there was a new sign-in — never that the device is one we haven’t seen (we don’t know that)', async () => {
    for (const page of [undefined, 'on']) {
      const { env, sent } = makeEnv({ SECURITY_HOOK_SECRET: HOOK, SECURE_ACCOUNT_PAGE: page });
      expect((await security(env, pgPayload())).status).toBe(200);
      for (const body of [sent[0].html!, sent[0].text!]) {
        expect(body).toMatch(/there was a new sign-in to your DreamStream Studio account/);
        expect(body).not.toMatch(/haven.t seen|new device|unrecognised device|unknown device/i);
      }
    }
  });

  it('until the “Not you?” page exists, sends people to Settings → Security instead — no dead button, no token', async () => {
    const { env, sent } = makeEnv({ SECURITY_HOOK_SECRET: HOOK });
    expect(await security(env, pgPayload())).toEqual({ status: 200, json: { ok: true, messageId: 'm1' } });
    const m = sent[0];
    expect(m.subject).toBe('New sign-in to your DreamStream Studio account');
    const settings = `${APP}/?view=settings&amp;tab=security`;
    expect(m.html).toContain(settings);
    expect(m.text).toContain(`${APP}/?view=settings&tab=security`);
    for (const body of [m.html!, m.text!]) {
      expect(body).toContain('Chrome on macOS');
      expect(body).toContain('28 Oct 2026, 21:05 UTC');
      expect(body).toContain('Settings → Security');
      expect(body).toMatch(/change your password/i);
      expect(body).toContain('Sign out everywhere');
      expect(body).toContain('Forgot password?');
      // Nothing that leads to the page that doesn't exist yet, and no promise it would keep.
      expect(body).not.toContain('#/secure');
      expect(body).not.toContain(TOKEN);
      expect(body).not.toMatch(/Not you\? Secure my account|works once|two-step/);
    }
    // Anything but "on" keeps the button off.
    const odd = makeEnv({ SECURITY_HOOK_SECRET: HOOK, SECURE_ACCOUNT_PAGE: 'yes please' });
    await security(odd.env, pgPayload());
    expect(odd.sent[0].html).not.toContain('#/secure');
  });

  it('once the page has shipped (SECURE_ACCOUNT_PAGE=on): what signed in, when, from which network — and the one-time “Not you?” link', async () => {
    const { env, sent } = makeEnv({ SECURITY_HOOK_SECRET: HOOK, SECURE_ACCOUNT_PAGE: 'on' });
    expect(await security(env, pgPayload())).toEqual({ status: 200, json: { ok: true, messageId: 'm1' } });
    const m = sent[0];
    expect(m.to).toBe('ada@example.com');
    expect(m.subject).toBe('New sign-in to your DreamStream Studio account');
    expect(m.from).toEqual({ email: 'no-reply@dreamstreamstudio.ai', name: 'DreamStream Studio' });
    const link = `${APP}/live#/secure/${TOKEN}`;
    for (const body of [m.html!, m.text!]) {
      expect(body).toContain('Chrome on macOS');
      expect(body).toContain('28 Oct 2026, 21:05 UTC');
      expect(body).toContain('203.0.113.x');
      expect(body).toContain(link);
      expect(body).toContain('with your password');
    }
    expect(m.html).toContain('Not you? Secure my account');
    expect(m.html).toContain('Hi Ada &lt;b&gt;,');
    expect(m.html).not.toContain('<b>,');
    expect(m.html).toContain('required DreamStream Studio account notification');
    expect(m.text).not.toContain('Mozilla/5.0');
  });

  it('refuses unsigned, re-signed, stale and tampered requests', async () => {
    const { env, sent } = makeEnv({ SECURITY_HOOK_SECRET: HOOK });
    expect((await security(env, pgPayload(), { secret: 'wrong' })).status).toBe(401);
    expect((await security(env, pgPayload(), { t: Math.floor(Date.now() / 1000) - 600 })).status).toBe(401);
    expect((await security(env, pgPayload(), { tamper: (p) => p.replace('ada@example.com', 'eve@example.com') })).status).toBe(401);
    expect((await security(env, pgPayload(), { header: '' })).status).toBe(401);
    expect((await security(env, pgPayload(), { header: 't=abc,v1=00' })).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('is off without its secret, and rejects malformed payloads even when signed', async () => {
    const off = makeEnv();
    expect((await security(off.env, pgPayload())).status).toBe(503);
    const { env, sent } = makeEnv({ SECURITY_HOOK_SECRET: HOOK });
    expect((await security(env, pgPayload({ token: 'short' }))).status).toBe(400);
    expect((await security(env, pgPayload({ email: 'not an email' }))).status).toBe(400);
    expect((await security(env, pgPayload({ kind: 'other' }))).status).toBe(400);
    expect((await security(env, 'not json')).status).toBe(400);
    const res = await worker.fetch(new Request('https://x/security', { method: 'POST', body: JSON.stringify({ p: 42 }) }), env);
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('accepts either secret while one is being rotated', async () => {
    const { env } = makeEnv({ SECURITY_HOOK_SECRET: `old-secret|${HOOK}` });
    expect((await security(env, pgPayload())).status).toBe(200);
    expect((await security(env, pgPayload(), { secret: 'old-secret' })).status).toBe(200);
    expect(await verifySecuritySignature(undefined, 't=1,v1=00', '{}')).toEqual({ ok: false, reason: 'no-secret' });
  });

  it('two-step sign-in turned on: says so, and its own “Not you?” link undoes it (a stolen password can’t lock the parent out)', async () => {
    const { env, sent } = makeEnv({ SECURITY_HOOK_SECRET: HOOK, SECURE_ACCOUNT_PAGE: 'on' });
    expect((await security(env, pgPayload({ kind: 'mfa_on', method: null }))).status).toBe(200);
    const m = sent[0];
    expect(m.subject).toBe('Two-step sign-in was turned on for your DreamStream Studio account');
    const link = `${APP}/live#/secure/${TOKEN}`;
    for (const body of [m.html!, m.text!]) {
      expect(body).toContain(link);
      expect(body).toContain('Chrome on macOS');
      expect(body).toMatch(/switches off the two-step sign-in they just turned on/);
      expect(body).toMatch(/Devices that were already signed in stay signed in/);
      expect(body).not.toMatch(/new sign-in/);
    }
    expect(m.html).toContain('Not you? Secure my account');
  });

  it('another authenticator, and a recovery code used: each with the one-time link', async () => {
    const { env, sent } = makeEnv({ SECURITY_HOOK_SECRET: HOOK, SECURE_ACCOUNT_PAGE: 'on' });
    expect((await security(env, pgPayload({ kind: 'mfa_added' }))).status).toBe(200);
    expect((await security(env, pgPayload({ kind: 'mfa_recovered' }))).status).toBe(200);
    expect(sent[0].subject).toBe('An authenticator was added to your DreamStream Studio account');
    expect(sent[0].text).toMatch(/removes the authenticator that was just added/);
    expect(sent[1].subject).toBe('Two-step sign-in was switched off on your DreamStream Studio account');
    expect(sent[1].text).toMatch(/recovery code was just used/);
    expect(sent[1].text).toMatch(/turn two-step sign-in on again/);
    for (const m of sent) expect(m.text).toContain(`#/secure/${TOKEN}`);
  });

  it('without the “Not you?” page, a two-step change points to support — never to signing out everywhere, which could strand the parent', async () => {
    const { env, sent } = makeEnv({ SECURITY_HOOK_SECRET: HOOK });
    expect((await security(env, pgPayload({ kind: 'mfa_on' }))).status).toBe(200);
    for (const body of [sent[0].html!, sent[0].text!]) {
      expect(body).toContain('support@dreamstreamstudio.ai');
      expect(body).toMatch(/Don.t sign out of your other devices first/);
      expect(body).not.toContain('#/secure');
      expect(body).not.toContain(TOKEN);
    }
  });

  it('reports a failed send', async () => {
    const { env } = makeEnv({ SECURITY_HOOK_SECRET: HOOK });
    env.EMAIL = { send: async () => Promise.reject(new Error('mail down')) } as unknown as Env['EMAIL'];
    expect((await security(env, pgPayload())).status).toBe(502);
  });
});

describe('sign-in alert details', () => {
  it('names devices in plain words, never quoting the user agent', () => {
    expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone');
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0')).toBe('Edge on Windows');
    expect(describeDevice('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('Firefox on Linux');
    expect(describeDevice('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36')).toBe('Samsung Internet on Android');
    expect(describeDevice('DreamStream/1.0 (iPhone; iOS 18.1)')).toBe('The DreamStream app on iPhone');
    expect(describeDevice('curl/8.4.0')).toBe('An unrecognised browser or app');
    expect(describeDevice(null)).toBe('An unknown device');
  });

  it('never shows a whole address', () => {
    expect(maskIp('198.51.100.23')).toBe('198.51.100.x');
    expect(maskIp('198.51.100.x')).toBe('198.51.100.x');
    expect(maskIp('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    expect(maskIp('2001:db8:abcd::/48')).toBe('2001:db8:abcd::/48');
    expect(maskIp('nonsense')).toBeNull();
    expect(parseSignInAlert(pgPayload({ ip: '198.51.100.23' }))?.ip).toBe('198.51.100.x');
  });

  it('formats the time in UTC, says how they signed in, and links to the live app (following its host)', () => {
    expect(formatWhen(Date.UTC(2026, 0, 5, 7, 3))).toBe('5 Jan 2026, 07:03 UTC');
    expect(describeMethod('oauth_provider/google')).toMatch(/Google/);
    expect(describeMethod('something-new')).toBeNull();
    expect(secureAccountUrl('tok', 'https://dreamstreamstudio.ai/', false)).toBe('https://dreamstreamstudio.ai/live#/secure/tok');
    expect(secureAccountUrl('tok', 'https://dreamstreamstudio.ai', true)).toBe('https://stream.dreamstreamstudio.ai/#/secure/tok');
  });
});
