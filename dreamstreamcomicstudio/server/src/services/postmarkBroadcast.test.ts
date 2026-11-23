// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('EMAIL_HMAC_SECRET', 'signed-test-links');
  vi.stubEnv('EMAIL_PUBLIC_BASE_URL', 'https://studio.example');
  vi.stubEnv('EMAIL_WORKER_URL', 'https://worker.example');
});
vi.mock('./emailStore.js', async (original) => ({
  ...(await original<typeof import('./emailStore.js')>()),
  hasConfirmedUpdates: vi.fn(), isSuppressed: vi.fn(), getUsage: vi.fn(async () => ({ day: 0, month: 0 })),
  logSend: vi.fn(async () => 'log-id'), patchLog: vi.fn()
}));
import { sendEmail } from './mailer.js';
import { hasConfirmedUpdates, isSuppressed } from './emailStore.js';
import { broadcastReadiness } from './postmarkBroadcast.js';

const to = 'reader@example.com';
const update = () => sendEmail({ to, template: 'product-update', params: {
  title: 'New edition', body: 'Read the new pages.', unsubscribeUrl: 'https://wrong.example', pixelUrl: 'https://wrong.example/p.gif'
} });
const stream = { ID: 'studio-updates', MessageStreamType: 'Broadcasts', ArchivedAt: null,
  SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Postmark' } };
const request = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubEnv('PRODUCT_UPDATE_TRANSPORT', 'postmark');
  vi.stubEnv('POSTMARK_BROADCAST_SERVER_TOKEN', 'test-postmark-token');
  vi.stubEnv('POSTMARK_BROADCAST_STREAM', stream.ID);
  vi.stubEnv('POSTMARK_BROADCAST_FROM', 'news@studio.example');
  vi.mocked(hasConfirmedUpdates).mockResolvedValue(true);
  vi.mocked(isSuppressed).mockResolvedValue(false);
  request.mockReset();
  vi.stubGlobal('fetch', request);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('product-update campaign delivery', () => {
  it('stays dormant without explicit transport selection and never falls back to the Worker', async () => {
    vi.stubEnv('PRODUCT_UPDATE_TRANSPORT', '');
    expect(broadcastReadiness().configured).toBe(false);
    expect(await update()).toMatchObject({ skipped: 'not_configured' });
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['POSTMARK_BROADCAST_SERVER_TOKEN', 'POSTMARK_BROADCAST_STREAM', 'POSTMARK_BROADCAST_FROM'])('rejects missing %s', async (name) => {
    vi.stubEnv(name, '');
    expect(broadcastReadiness().missing).toContain(name);
    expect(await update()).toMatchObject({ skipped: 'not_configured' });
    expect(request).not.toHaveBeenCalled();
  });
  it('skips suppressed or unconfirmed recipients before contacting the provider', async () => {
    vi.mocked(isSuppressed).mockResolvedValue(true);
    expect(await update()).toMatchObject({ skipped: 'suppressed' });
    vi.mocked(isSuppressed).mockResolvedValue(false);
    vi.mocked(hasConfirmedUpdates).mockResolvedValue(false);
    expect(await update()).toMatchObject({ skipped: 'no_confirmed_subscription' });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([{ MessageStreamType: 'Transactional' }, { ArchivedAt: 'now' }, { ID: 'unexpected' },
    { SubscriptionManagementConfiguration: { UnsubscribeHandlingType: 'Custom' } }])('refuses incompatible streams', async (variation) => {
    request.mockResolvedValue(Response.json({ ...stream, ...variation }));
    expect(await update()).toMatchObject({ ok: false, error: expect.stringContaining('active Broadcast') });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('sends only to the confirmed address, in its verified stream, using the shared template and signed local opt-out', async () => {
    request.mockResolvedValueOnce(Response.json(stream)).mockResolvedValueOnce(Response.json({ MessageID: 'postmark-id', ErrorCode: 0 }));
    expect(await update()).toEqual({ ok: true, messageId: 'postmark-id' });
    expect(request.mock.calls[0][0]).toBe('https://api.postmarkapp.com/message-streams/studio-updates');
    const [url, init] = request.mock.calls[1];
    expect(url).toBe('https://api.postmarkapp.com/email');
    expect(init?.headers).toMatchObject({ 'X-Postmark-Server-Token': 'test-postmark-token' });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ From: 'news@studio.example', To: to, Subject: 'New edition', MessageStream: stream.ID, TrackOpens: false });
    for (const content of [body.HtmlBody, body.TextBody]) {
      expect(content).toContain('Read the new pages.');
      expect(content).toContain('https://studio.example/api/newsletter/unsubscribe?');
      expect(content).not.toContain('wrong.example');
    }
  });
  it('treats provider rejection as a failure without switching transports', async () => {
    request.mockResolvedValueOnce(Response.json(stream)).mockResolvedValueOnce(Response.json({ ErrorCode: 406 }, { status: 422 }));
    expect(await update()).toMatchObject({ ok: false, error: expect.stringContaining('406') });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
