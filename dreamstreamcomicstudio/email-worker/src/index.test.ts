// @vitest-environment node
import { describe, expect, it } from 'vitest';
import worker, { type Env } from './index';
import { brandForSend } from './authHook';

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
