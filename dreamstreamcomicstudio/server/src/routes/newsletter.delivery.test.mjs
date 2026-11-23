// @vitest-environment node
// Exercise the HTTP route, production mailer, HMAC verification, and Worker rendering together.
// Only subscriber/log storage and the external provider binding are simulated.
import { once } from 'node:events';
import express from 'express';
import { expect, it, vi } from 'vitest';
import emailWorker from '../../../email-worker/src/index.ts';

const fixture = vi.hoisted(() => ({
  email: 'reader@example.test',
  secret: 'synthetic-worker-shared-secret',
  suppressed: false,
  token: '',
  subscriptions: new Set(),
  jobs: [],
  workerOrigin: 'https://email-worker.invalid',
  appOrigin: 'https://comic.example.test'
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  APP_PUBLIC_URL: fixture.appOrigin,
  EMAIL_PUBLIC_BASE_URL: fixture.appOrigin,
  EMAIL_WORKER_URL: fixture.workerOrigin,
  EMAIL_HMAC_SECRET: fixture.secret,
  TURNSTILE_SECRET_KEY: ''
}));
// Simulated PostgREST operations for the queue and signup table. The route, runner,
 // transport, signature checker and actual Worker renderer all run.
vi.mock('../services/supabase.js', () => ({
  getSupabaseAdmin: () => ({
    rpc: async () => ({ data: fixture.jobs.splice(0, 1), error: null }),
    from: (table) => {
      let rowId;
      const chain = {
        eq: (key, value) => { if (key === 'id') rowId = value; return chain; },
        select: () => chain,
        update: () => chain,
        maybeSingle: async () => ({ data: table === 'waitlist_signups' ? {
          kind: rowId, email: fixture.email, confirmed: !fixture.token, confirm_token: fixture.token,
          confirm_sent_at: new Date().toISOString(), unsubscribed_at: fixture.suppressed ? 'now' : null
        } : null, error: null })
      };
      return chain;
    }
  })
}));
const queue = (template, kind) => fixture.jobs.push({
  id: kind, signup_id: kind, template, lease_id: 'synthetic-lease', attempts: 1, created_at: new Date().toISOString()
});

vi.mock('../services/emailStore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  upsertSubscriber: async (email, kind, token) => {
    if (kind === 'updates') fixture.token = token;
    fixture.subscriptions.add(kind + ':' + email);
    queue(kind === 'updates' ? 'newsletter-confirm' : 'access-requested', kind);
    return { outcome: 'new' };
  },
  confirmSubscriber: async (email, token) => {
    if (email !== fixture.email || !fixture.token || fixture.token !== token) return false;
    fixture.token = '';
    queue('newsletter-welcome', 'updates');
    return true;
  },
  markUnsubscribed: async (email) => {
    expect(email).toBe(fixture.email);
    fixture.suppressed = true;
  },
  isSuppressed: async () => fixture.suppressed,
  getUsage: async () => ({ day: 0, month: 0 }),
  logSend: async () => 'synthetic-log-row',
  patchLog: async () => {}
}));

it('delivers access and update messages through the signed worker, then honors one-click unsubscribe', async () => {
  vi.stubEnv('INTEREST_EMAILS', 'on');
  const { newsletterRouter } = await import('./newsletter.js');
  const { sendNewsletterWelcome } = await import('../services/mailer.js');
  const app = express();
  app.use(express.json());
  app.use('/api/newsletter', newsletterRouter);
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const localOrigin = 'http://127.0.0.1:' + server.address().port;
    const request = globalThis.fetch;
    const inbox = [];
    let releaseProvider;
    const slowDelivery = new Promise(resolve => { releaseProvider = resolve; });
    const env = {
      EMAIL_HMAC_SECRET: fixture.secret,
      EMAIL_FROM: 'notifications@example.test',
      EMAIL: { send: async (message) => {
        await slowDelivery;
        inbox.push(message);
        return { messageId: 'synthetic-' + inbox.length };
      } }
    };
    vi.stubGlobal('fetch', async (input, init) => {
      const req = new Request(input, init);
      expect(req.url).toBe(fixture.workerOrigin + '/send');
      return emailWorker.fetch(req, env);
    });

    const submit = (kind) => request(localOrigin + '/api/newsletter/subscribe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: fixture.email, kind, keepUpdated: true })
    });
    const openAppLink = (url, method = 'GET') => {
      expect(url.origin).toBe(fixture.appOrigin);
      return request(localOrigin + url.pathname + url.search, { method, redirect: 'manual' });
    };

    expect((await submit('access')).status).toBe(200);
    expect(inbox).toHaveLength(0);
    releaseProvider();
    await vi.waitFor(() => expect(inbox).toHaveLength(1));
    expect(inbox[0].to).toBe(fixture.email);
    expect(inbox[0].text).not.toContain('/api/newsletter/confirm');
    expect((await submit('updates')).status).toBe(200);
    expect(fixture.subscriptions.size).toBe(2);
    await vi.waitFor(() => expect(inbox).toHaveLength(2));
    const confirmLink = inbox[1].text?.match(/https:\/\/[^\s]+\/api\/newsletter\/confirm\?[^\s]+/)?.[0];
    expect(confirmLink).toBeTruthy();
    const confirm = new URL(confirmLink);
    expect((await openAppLink(confirm)).headers.get('location')).toBe(fixture.appOrigin + '/?newsletter=confirmed');
    await vi.waitFor(() => expect(inbox).toHaveLength(3));
    expect((await openAppLink(confirm)).headers.get('location')).toBe(fixture.appOrigin + '/?newsletter=invalid');
    expect(inbox).toHaveLength(3);

    expect(inbox[2].headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const unsubscribe = new URL(inbox[2].headers['List-Unsubscribe'].slice(1, -1));
    expect(await (await openAppLink(unsubscribe, 'POST')).json()).toEqual({ ok: true });
    expect(fixture.suppressed).toBe(true);
    expect((await openAppLink(unsubscribe)).headers.get('location')).toBe(fixture.appOrigin + '/?newsletter=unsubscribed');
    expect(await sendNewsletterWelcome(fixture.email)).toMatchObject({ skipped: 'suppressed' });
    expect(inbox).toHaveLength(3);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});
