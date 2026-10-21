// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { renderEmail } from '../../shared/email';
import worker, { type Env } from './index';
import {
  NOTIFICATION_ACTIONS,
  SUPPORTED_ACTIONS,
  VERIFICATION_ACTIONS,
  WEBHOOK_TOLERANCE_SECONDS,
  buildVerifyUrl,
  isLiveRedirect,
  maskEmail,
  parseSignatureHeader,
  planAuthEmails,
  verifyStandardWebhook,
  type AuthHookPayload
} from './authHook';

// ── Standard Webhooks test vectors ─────────────────────────────────────────────
// Computed independently here with WebCrypto: base64(HMAC-SHA256(key, `${id}.${ts}.${body}`))
// where key = base64-decode(secret after the `v1,whsec_` prefix).
const RAW_KEY = 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'; // the Standard Webhooks spec's example key
const SUPABASE_SECRET = `v1,whsec_${RAW_KEY}`;
const NOW = 1_800_000_000;

async function sign(base64Key: string, id: string, timestamp: number | string, body: string): Promise<string> {
  const keyBytes = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return btoa(String.fromCharCode(...mac));
}

const signedHeaders = async (body: string, opts: { id?: string; timestamp?: number; key?: string } = {}) => {
  const id = opts.id ?? 'msg_2cbQqFSXdN4pvtcVRf0X5rBRWm8';
  const timestamp = opts.timestamp ?? NOW;
  return { id, timestamp: String(timestamp), signature: `v1,${await sign(opts.key ?? RAW_KEY, id, timestamp, body)}` };
};

describe('verifyStandardWebhook', () => {
  const body = JSON.stringify({ user: { email: 'ada@example.com' }, email_data: { email_action_type: 'signup' } });

  it('matches the Standard Webhooks spec example vector', async () => {
    const verdict = await verifyStandardWebhook(
      `whsec_${RAW_KEY}`,
      {
        id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
        timestamp: '1614265330',
        signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='
      },
      '{"test": 2432232314}',
      1614265330
    );
    expect(verdict).toEqual({ ok: true });
  });

  it('accepts a valid signature made with the Supabase-format secret', async () => {
    expect(await verifyStandardWebhook(SUPABASE_SECRET, await signedHeaders(body), body, NOW)).toEqual({ ok: true });
  });

  it('rejects a tampered body, a wrong key, and a missing/garbled signature', async () => {
    const headers = await signedHeaders(body);
    expect(await verifyStandardWebhook(SUPABASE_SECRET, headers, body.replace('ada', 'eve'), NOW)).toEqual({ ok: false, reason: 'bad-signature' });

    const otherKey = btoa('a-completely-different-32-byte-k');
    expect(await verifyStandardWebhook(SUPABASE_SECRET, await signedHeaders(body, { key: otherKey }), body, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature'
    });
    expect(await verifyStandardWebhook(SUPABASE_SECRET, { ...headers, signature: 'v1,' }, body, NOW)).toMatchObject({ ok: false });
    expect(await verifyStandardWebhook(SUPABASE_SECRET, { ...headers, signature: headers.signature.replace('v1,', 'v2,') }, body, NOW)).toMatchObject({
      ok: false
    });
    expect(await verifyStandardWebhook(SUPABASE_SECRET, { ...headers, id: 'msg_other' }, body, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects missing headers and an unset/invalid secret', async () => {
    const headers = await signedHeaders(body);
    expect(await verifyStandardWebhook(SUPABASE_SECRET, { ...headers, id: null }, body, NOW)).toEqual({ ok: false, reason: 'missing-headers' });
    expect(await verifyStandardWebhook(SUPABASE_SECRET, { ...headers, signature: null }, body, NOW)).toEqual({ ok: false, reason: 'missing-headers' });
    expect(await verifyStandardWebhook(undefined, headers, body, NOW)).toEqual({ ok: false, reason: 'no-secret' });
    expect(await verifyStandardWebhook('v1,whsec_%%%not-base64%%%', headers, body, NOW)).toEqual({ ok: false, reason: 'bad-secret' });
  });

  it('enforces the replay window in both directions', async () => {
    const headers = await signedHeaders(body);
    const edge = WEBHOOK_TOLERANCE_SECONDS;
    expect(await verifyStandardWebhook(SUPABASE_SECRET, headers, body, NOW + edge)).toEqual({ ok: true });
    expect(await verifyStandardWebhook(SUPABASE_SECRET, headers, body, NOW - edge)).toEqual({ ok: true });
    expect(await verifyStandardWebhook(SUPABASE_SECRET, headers, body, NOW + edge + 1)).toEqual({ ok: false, reason: 'stale-timestamp' });
    expect(await verifyStandardWebhook(SUPABASE_SECRET, headers, body, NOW - edge - 1)).toEqual({ ok: false, reason: 'stale-timestamp' });
    expect(await verifyStandardWebhook(SUPABASE_SECRET, { ...headers, timestamp: 'soon' }, body, NOW)).toEqual({ ok: false, reason: 'bad-timestamp' });
  });

  it('accepts any v1 entry in a multi-signature header (GoTrue joins with ", ")', async () => {
    const headers = await signedHeaders(body);
    const decoy = `v1,${await sign(btoa('old-rotated-secret-old-rotated!!'), headers.id, NOW, body)}`;
    const verdict = await verifyStandardWebhook(SUPABASE_SECRET, { ...headers, signature: `${decoy}, ${headers.signature}` }, body, NOW);
    expect(verdict).toEqual({ ok: true });
    expect(parseSignatureHeader('v1,AAA=, v1,BBB= v2,CCC=')).toEqual(['AAA=', 'BBB=']);
  });

  it('supports overlapping secrets during rotation (pipe-separated)', async () => {
    const newKey = btoa('brand-new-hook-secret-32-bytes!!');
    const headers = await signedHeaders(body, { key: newKey });
    expect(await verifyStandardWebhook(`${SUPABASE_SECRET}|v1,whsec_${newKey}`, headers, body, NOW)).toEqual({ ok: true });
  });
});

// ── Payload → email plan ───────────────────────────────────────────────────────
const BASE = 'https://bdjfmxfmhqhzvgrhbbzm.supabase.co';
const APP = 'https://dreamstreamstudio.ai';
const opts = { verifyBaseUrl: BASE, appUrl: APP };

const payload = (email_data: NonNullable<AuthHookPayload['email_data']>, user: AuthHookPayload['user'] = {}): AuthHookPayload => ({
  user: { email: 'ada@example.com', user_metadata: { first_name: 'Ada' }, ...user },
  email_data: { token: '', token_hash: '', token_new: '', token_hash_new: '', site_url: 'http://localhost:9999', redirect_to: `${APP}/`, ...email_data }
});

const sendPlan = (p: ReturnType<typeof planAuthEmails>) => {
  if (p.kind !== 'send') throw new Error(`expected a send plan, got ${p.kind}: ${'reason' in p ? p.reason : ''}`);
  return p;
};

describe('planAuthEmails', () => {
  it('covers every email_action_type in the Supabase schema', () => {
    expect([...SUPPORTED_ACTIONS].sort()).toEqual(
      [
        'signup',
        'invite',
        'magiclink',
        'recovery',
        'email_change',
        'email',
        'reauthentication',
        'password_changed_notification',
        'email_changed_notification',
        'phone_changed_notification',
        'identity_linked_notification',
        'identity_unlinked_notification',
        'mfa_factor_enrolled_notification',
        'mfa_factor_unenrolled_notification'
      ].sort()
    );
    expect(VERIFICATION_ACTIONS).not.toContain('email_change_new');
  });

  it('builds the documented verify link for a signup', () => {
    const plan = sendPlan(planAuthEmails(payload({ email_action_type: 'signup', token: '305805', token_hash: 'pkce_abc123' }), opts));
    expect(plan.emails).toHaveLength(1);
    const [mail] = plan.emails;
    expect(mail.to).toBe('ada@example.com');
    expect(mail.template).toBe('auth-confirm-signup');
    expect(mail.params.actionUrl).toBe(`${BASE}/auth/v1/verify?token=pkce_abc123&type=signup&redirect_to=${encodeURIComponent(`${APP}/`)}`);
    expect(mail.params.token).toBe('305805');
    expect(mail.params.firstName).toBe('Ada');
  });

  it.each([
    ['invite', 'auth-invite'],
    ['magiclink', 'auth-magic-link'],
    ['recovery', 'auth-recovery']
  ])('maps %s to %s with a type=%s link', (action, template) => {
    const plan = sendPlan(planAuthEmails(payload({ email_action_type: action, token: '111111', token_hash: 'hash_x' }), opts));
    expect(plan.emails[0].template).toBe(template);
    expect(plan.emails[0].params.actionUrl).toContain(`type=${action}`);
  });

  describe('email_change', () => {
    const change = (data: NonNullable<AuthHookPayload['email_data']>) =>
      planAuthEmails(payload({ email_action_type: 'email_change', ...data }, { email: 'old@example.com', new_email: 'new@example.com' }), opts);

    it('Secure Email Change ON: two emails, hashes paired per the docs (reversed names)', () => {
      const plan = sendPlan(
        change({ token: '111111', token_hash_new: 'hash_for_current', token_new: '222222', token_hash: 'hash_for_new' })
      );
      expect(plan.emails).toHaveLength(2);
      const toCurrent = plan.emails.find((e) => e.to === 'old@example.com')!;
      const toNew = plan.emails.find((e) => e.to === 'new@example.com')!;

      // token_hash_new + token → CURRENT address
      expect(toCurrent.params.actionUrl).toBe(
        `${BASE}/auth/v1/verify?token=hash_for_current&type=email_change&redirect_to=${encodeURIComponent(`${APP}/`)}`
      );
      expect(toCurrent.params.token).toBe('111111');
      expect(toCurrent.params.emailChangeStep).toBe('current');
      // token_hash + token_new → NEW address
      expect(toNew.params.actionUrl).toBe(`${BASE}/auth/v1/verify?token=hash_for_new&type=email_change&redirect_to=${encodeURIComponent(`${APP}/`)}`);
      expect(toNew.params.token).toBe('222222');
      expect(toNew.params.emailChangeStep).toBe('new');
      expect(toNew.params.bothRequired).toBe('1');
      expect(plan.emails.every((e) => e.template === 'auth-email-change')).toBe(true);
    });

    it('Secure Email Change OFF: one email, to the NEW address only (token + token_hash)', () => {
      const plan = sendPlan(change({ token: '333333', token_hash: 'hash_for_new' }));
      expect(plan.emails).toHaveLength(1);
      expect(plan.emails[0].to).toBe('new@example.com');
      expect(plan.emails[0].params.actionUrl).toContain('token=hash_for_new&type=email_change');
      expect(plan.emails[0].params.token).toBe('333333');
      expect(plan.emails[0].params.bothRequired).toBeUndefined();
    });

    it('Secure Email Change OFF: falls back to token_new when that is the field present', () => {
      const plan = sendPlan(change({ token_new: '444444', token_hash: 'hash_for_new' }));
      expect(plan.emails[0].to).toBe('new@example.com');
      expect(plan.emails[0].params.token).toBe('444444');
    });

    it('never sends a confirm-new-address link to the old address when new_email is missing', () => {
      const plan = planAuthEmails(payload({ email_action_type: 'email_change', token: '1', token_hash: 'h' }, { email: 'old@example.com' }), opts);
      expect(plan.kind).toBe('invalid');
    });

    it('renders distinct copy for each side', () => {
      const plan = sendPlan(change({ token: '111111', token_hash_new: 'hc', token_new: '222222', token_hash: 'hn' }));
      const [current, next] = plan.emails.map((e) => renderEmail(e.template, e.params));
      expect(current.subject).toContain('Approve your email change');
      expect(current.html).toContain('new@example.com');
      expect(next.subject).toContain('Confirm your new email');
      expect(next.html).toContain('old@example.com'); // "we also sent a link to …"
      expect(next.text).toContain('both links');
    });
  });

  it('routes the `email` OTP action to the code-first magic-link template', () => {
    const plan = sendPlan(planAuthEmails(payload({ email_action_type: 'email', token: '654321', token_hash: 'hash_otp' }), opts));
    const [mail] = plan.emails;
    expect(mail.template).toBe('auth-magic-link');
    expect(mail.params.codeFirst).toBe('1');
    expect(mail.params.token).toBe('654321');
    expect(mail.params.actionUrl).toContain('type=email');
    const rendered = renderEmail(mail.template, mail.params);
    expect(rendered.subject).toContain('sign-in code');
    expect(rendered.html).toContain('654321');
    expect(rendered.text).toContain('654321');
  });

  it('sends reauthentication as a code-only email', () => {
    const plan = sendPlan(planAuthEmails(payload({ email_action_type: 'reauthentication', token: '777777' }), opts));
    expect(plan.emails[0]).toMatchObject({ to: 'ada@example.com', template: 'auth-reauthentication', params: { token: '777777' } });
  });

  it('sends security notifications through auth-security-notice', () => {
    const plan = sendPlan(
      planAuthEmails(
        { ...payload({ email_action_type: 'password_changed_notification' }), metadata: { time: '2026-10-21T10:00:00Z', ip_address: '203.0.113.7' } },
        opts
      )
    );
    const [mail] = plan.emails;
    expect(mail).toMatchObject({ to: 'ada@example.com', template: 'auth-security-notice', params: { notice: 'password_changed' } });
    const rendered = renderEmail(mail.template, mail.params);
    expect(rendered.subject).toBe('Your password was changed — DreamStream Studio');
    expect(rendered.html).toContain('203.0.113.7');
    expect(rendered.html).not.toContain('Unsubscribe');
  });

  it('delivers the email-changed notice to the OLD address (like GoTrue’s own mailer)', () => {
    const plan = sendPlan(
      planAuthEmails(payload({ email_action_type: 'email_changed_notification', old_email: 'old@example.com' }, { email: 'new@example.com' }), opts)
    );
    expect(plan.emails[0].to).toBe('old@example.com');
    const rendered = renderEmail(plan.emails[0].template, plan.emails[0].params);
    expect(rendered.text).toContain('from old@example.com to new@example.com');
  });

  it.each(NOTIFICATION_ACTIONS.map((a) => [a]))('renders %s with notice-specific copy', (action) => {
    const plan = sendPlan(
      planAuthEmails(payload({ email_action_type: action, provider: 'google', factor_type: 'totp', old_email: 'o@example.com', old_phone: '+15550001' }), opts)
    );
    const rendered = renderEmail(plan.emails[0].template, plan.emails[0].params);
    expect(rendered.subject).not.toContain('security settings changed'); // not the generic fallback
  });

  it('returns a 200-style skip (no email) for an unknown future action type', () => {
    const plan = planAuthEmails(payload({ email_action_type: 'passkey_added_notification', token_hash: 'x' }), opts);
    expect(plan).toEqual({ kind: 'skip', action: 'passkey_added_notification', reason: expect.stringContaining('unsupported') });
  });

  it('treats a payload with no action type as invalid', () => {
    expect(planAuthEmails({ user: { email: 'a@example.com' } }, opts).kind).toBe('invalid');
    expect(planAuthEmails(payload({ email_action_type: 'signup' }), opts).kind).toBe('invalid'); // no token_hash
  });

  it('brands live-app flows as Stream Studio', () => {
    const live = sendPlan(
      planAuthEmails(payload({ email_action_type: 'signup', token_hash: 'h', redirect_to: `${APP}/live?after=create` }), opts)
    );
    expect(live.brand).toEqual({ productName: 'Stream Studio', appUrl: `${APP}/live` });
    const rendered = renderEmail(live.emails[0].template, live.emails[0].params, live.brand);
    expect(rendered.subject).toBe('Confirm your email — Stream Studio');
    expect(rendered.html).toContain('Welcome to Stream Studio');
    expect(rendered.html).not.toContain('Welcome to DreamStream Studio');

    const main = sendPlan(planAuthEmails(payload({ email_action_type: 'signup', token_hash: 'h', redirect_to: `${APP}/auth/callback` }), opts));
    expect(main.brand).toEqual({});
    expect(renderEmail(main.emails[0].template, main.emails[0].params, main.brand).subject).toBe('Confirm your email — DreamStream Studio');

    expect(isLiveRedirect(`${APP}/live`)).toBe(true);
    expect(isLiveRedirect(`${APP}/live.html#/watch`)).toBe(true);
    expect(isLiveRedirect('http://localhost:7000/live/')).toBe(true);
    expect(isLiveRedirect(`${APP}/lively`)).toBe(false);
    expect(isLiveRedirect(`${APP}/?next=/live`)).toBe(false);
    expect(isLiveRedirect('not a url')).toBe(false);
  });

  it('falls back to site_url for the verify base and never doubles /auth/v1', () => {
    const plan = sendPlan(planAuthEmails(payload({ email_action_type: 'recovery', token_hash: 'h' }), {}));
    expect(plan.emails[0].params.actionUrl).toMatch(/^http:\/\/localhost:9999\/auth\/v1\/verify\?token=h&type=recovery/);
    expect(buildVerifyUrl(`${BASE}/auth/v1/`, 'h', 'signup')).toBe(`${BASE}/auth/v1/verify?token=h&type=signup`);
  });

  it('masks addresses for logs', () => {
    expect(maskEmail('ada@example.com')).toBe('a***@example.com');
    expect(maskEmail('nope')).toBe('***');
  });
});

// ── The Worker route end-to-end (mock EMAIL binding) ───────────────────────────
describe('POST /auth-hook (worker route)', () => {
  type Sent = { from: unknown; to: unknown; subject: string; html?: string; text?: string };
  const makeEnv = (overrides: Partial<Env> = {}, fail = false) => {
    const sent: Sent[] = [];
    const env = {
      EMAIL: {
        send: async (msg: Sent) => {
          if (fail) throw new Error('quota exceeded');
          sent.push(msg);
          return { messageId: `m${sent.length}` };
        }
      },
      EMAIL_HMAC_SECRET: 'x',
      SUPABASE_AUTH_HOOK_SECRET: SUPABASE_SECRET,
      EMAIL_FROM: 'notifications@dreamstreamstudio.ai',
      EMAIL_FROM_NAME: 'DreamStream Studio',
      EMAIL_REPLY_TO: 'support@dreamstreamstudio.ai',
      SUPABASE_VERIFY_URL: BASE,
      APP_URL: APP,
      ...overrides
    } as Env;
    return { env, sent };
  };
  const call = async (env: Env, body: unknown, signWith: string = RAW_KEY) => {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const h = await signedHeaders(raw, { timestamp: ts, key: signWith });
    const res = await worker.fetch(
      new Request('https://dreamstream-email.example.workers.dev/auth-hook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'webhook-id': h.id, 'webhook-timestamp': h.timestamp, 'webhook-signature': h.signature },
        body: raw
      }),
      env
    );
    expect(res.headers.get('content-type')).toBe('application/json'); // GoTrue rejects anything else
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it('acknowledges an unknown action type with 200 and sends nothing', async () => {
    const { env, sent } = makeEnv();
    const res = await call(env, payload({ email_action_type: 'some_future_notification' }));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, skipped: true });
    expect(res.json).not.toHaveProperty('error'); // a 200 body with `error` would count as failure
    expect(sent).toHaveLength(0);
  });

  it('sends both Secure Email Change mails from no-reply@ with reply-to support@', async () => {
    const { env, sent } = makeEnv();
    const res = await call(
      env,
      payload(
        { email_action_type: 'email_change', token: '111111', token_hash_new: 'hc', token_new: '222222', token_hash: 'hn' },
        { email: 'old@example.com', new_email: 'new@example.com' }
      )
    );
    expect(res).toEqual({ status: 200, json: { ok: true, sent: 2 } });
    expect(sent.map((m) => m.to).sort()).toEqual(['new@example.com', 'old@example.com']);
    expect(sent[0].from).toEqual({ email: 'no-reply@dreamstreamstudio.ai', name: 'DreamStream Studio' });
    expect(sent.find((m) => m.to === 'old@example.com')!.html).toContain('token=hc&amp;type=email_change');
    expect(sent.find((m) => m.to === 'new@example.com')!.html).toContain('token=hn&amp;type=email_change');
  });

  it('brands live-app mail (subject, body and From name) as Stream Studio', async () => {
    const { env, sent } = makeEnv();
    await call(env, payload({ email_action_type: 'signup', token: '1', token_hash: 'h', redirect_to: `${APP}/live` }));
    expect(sent[0].subject).toBe('Confirm your email — Stream Studio');
    expect(sent[0].from).toEqual({ email: 'no-reply@dreamstreamstudio.ai', name: 'Stream Studio' });
  });

  it('rejects bad signatures (401), reports send failures (502) and stays disabled without a secret (503)', async () => {
    const { env, sent } = makeEnv();
    expect((await call(env, payload({ email_action_type: 'signup', token_hash: 'h' }), btoa('not-the-right-secret-at-all-ok!!'))).status).toBe(401);
    expect(sent).toHaveLength(0);

    const failing = makeEnv({}, true);
    expect((await call(failing.env, payload({ email_action_type: 'signup', token_hash: 'h' }))).status).toBe(502);

    const disabled = makeEnv({ SUPABASE_AUTH_HOOK_SECRET: '' });
    expect((await call(disabled.env, payload({ email_action_type: 'signup', token_hash: 'h' }))).status).toBe(503);
  });
});
