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

const { sendEmail } = await import('./mailer.js');
const { logSend, patchLog } = await import('./emailStore.js');

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
  it('signs the exact body and adds the read-receipt pixel by default', async () => {
    expect(await sendEmail({ to: 'Ada@Example.com', template: 'welcome' })).toEqual({ ok: true, messageId: 'm1' });
    const req = lastRequest();
    expect(req.url).toBe('https://email-worker.test/send');
    expect(req.signature).toBe('sha256=' + crypto.createHmac('sha256', 'test-secret').update(req.raw).digest('hex'));
    expect(req.body).toMatchObject({ template: 'welcome', to: 'ada@example.com', params: { pixelUrl: 'https://api.test/api/email/o/log-1.gif' } });
    expect(req.body).not.toHaveProperty('brand');
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

  it('public-form mail (the confirmation, the early-access receipt) whose send can\'t be logged is not sent: every limit on it counts logged sends only; other mail still goes', async () => {
    for (const template of ['newsletter-confirm', 'access-requested'] as const) {
      vi.mocked(logSend).mockResolvedValueOnce(null);
      expect(await sendEmail({ to: 'victim+1@gmail.com', template, params: { confirmUrl: 'https://api.test/c' } })).toEqual({ ok: false, error: 'not_logged' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    vi.mocked(logSend).mockResolvedValueOnce(null);
    expect(await sendEmail({ to: 'ada@example.com', template: 'auth-confirm-signup', params: { actionUrl: 'https://dreamstreamstudio.ai/x' }, track: false })).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('a public-form send whose log INSERT committed but whose reply was lost (logSend null) closes that row as failed, so it never counts against the inbox', async () => {
    const rows = new Map<string, { status: string; error?: string }>();
    vi.mocked(logSend).mockImplementationOnce(async (entry) => {
      rows.set(entry.id!, { status: entry.status });
      return null;
    });
    vi.mocked(patchLog).mockImplementation(async (id, fields) => {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, ...fields } as { status: string; error?: string });
    });
    expect(await sendEmail({ to: 'victim@gmail.com', template: 'newsletter-confirm', params: { confirmUrl: 'https://api.test/c' } })).toEqual({ ok: false, error: 'not_logged' });
    expect([...rows.values()]).toEqual([{ status: 'failed', error: 'not_logged' }]);
    expect([...rows.keys()][0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(fetchMock).not.toHaveBeenCalled();
    // Other mail whose reply was lost still goes, and its row is still closed as sent.
    vi.mocked(logSend).mockImplementationOnce(async (entry) => {
      rows.set(entry.id!, { status: entry.status });
      return null;
    });
    expect(await sendEmail({ to: 'ada@example.com', template: 'welcome' })).toMatchObject({ ok: true });
    expect([...rows.values()].at(-1)).toMatchObject({ status: 'sent' });
    vi.mocked(patchLog).mockReset();
  });
});
