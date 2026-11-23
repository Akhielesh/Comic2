// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';

// The mailer's request to the email Worker: HMAC over the exact body, the optional sub-brand,
// and the read-receipt pixel (on by default, off with track:false — auth mail).
vi.hoisted(() => {
  vi.stubEnv('EMAIL_WORKER_URL', 'https://email-worker.test');
  vi.stubEnv('EMAIL_HMAC_SECRET', 'test-secret');
  vi.stubEnv('EMAIL_PUBLIC_BASE_URL', 'https://api.test');
});

vi.mock('./emailStore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./emailStore.js')>()),
  getUsage: vi.fn(async () => ({ day: 0, month: 0 })),
  isSuppressed: vi.fn(async () => false),
  logSend: vi.fn(async () => 'log-1'),
  patchLog: vi.fn(async () => undefined)
}));

const { logSend } = await import('./emailStore.js');
const { sendEmail } = await import('./mailer.js');

const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ ok: true, messageId: 'm1' })));
vi.stubGlobal('fetch', fetchMock);
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
beforeEach(() => fetchMock.mockClear());

const lastRequest = () => {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  const raw = String(init.body);
  return { url, raw, body: JSON.parse(raw), signature: (init.headers as Record<string, string>)['x-email-signature'] };
};

describe('sendEmail → email Worker', () => {
  it('signs the exact body with an optional acknowledgement and no default image tracking', async () => {
    expect(await sendEmail({ to: 'Ada@Example.com', template: 'welcome' })).toEqual({ ok: true, messageId: 'm1' });
    const req = lastRequest();
    expect(req.url).toBe('https://email-worker.test/send');
    expect(req.signature).toBe('sha256=' + crypto.createHmac('sha256', 'test-secret').update(req.raw).digest('hex'));
    expect(req.body).toMatchObject({ template: 'welcome', to: 'ada@example.com' });
    expect(req.body.params.ackUrl).toMatch(/^https:\/\/api\.test\/api\/email\/ack\/[A-Za-z0-9_-]{43}$/);
    expect(req.body.params).not.toHaveProperty('pixelUrl');
    expect(vi.mocked(logSend).mock.lastCall?.[0].ackReceiptHash).toBe(crypto.createHash('sha256').update(req.body.params.ackUrl.split('/').pop()).digest('hex'));
    expect(req.body).not.toHaveProperty('brand');
  });

  it('mints separate random tokens per purpose and message and discards supplied trackers', async () => {
    vi.stubEnv('EMAIL_OPEN_SIGNALS', 'on');
    try {
      const tokens = new Set();
      for (let i = 0; i < 2; i++) {
        await sendEmail({ to: 'reader@example.test', template: 'announcement', params: { ackUrl: 'https://foreign.test/ack', pixelUrl: 'https://foreign.test/p' } });
        const { params } = lastRequest().body;
        const open = new URL(params.pixelUrl), ack = new URL(params.ackUrl);
        expect(open.origin).toBe('https://api.test');
        expect(ack.origin).toBe(open.origin);
        for (const url of [open, ack]) tokens.add(url.pathname.split('/').pop()!.replace(/\.gif$/, ''));
      }
      expect(tokens.size).toBe(4);
      for (const template of ['auth-recovery','signin-alert','newsletter-confirm'] as const) {
        await sendEmail({ to: 'reader@example.test', template, params: { ackUrl: 'https://foreign.test/ack', pixelUrl: 'https://foreign.test/p' } });
        expect(lastRequest().body.params).toEqual({});
      }
    } finally { delete process.env.EMAIL_OPEN_SIGNALS; }
  });

  it('forwards the sub-brand and drops tracking when track is false', async () => {
    await sendEmail({
      to: 'ada@example.com',
      template: 'auth-confirm-signup',
      params: { actionUrl: 'https://dreamstreamstudio.ai/live?token_hash=h&type=signup', pixelUrl: 'https://x.test/p.gif' },
      brand: 'stream-studio',
      track: false
    });
    const { body } = lastRequest();
    expect(body.brand).toBe('stream-studio');
    expect(body.params).toEqual({ actionUrl: 'https://dreamstreamstudio.ai/live?token_hash=h&type=signup' });
  });
});
