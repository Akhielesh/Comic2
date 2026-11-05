// @vitest-environment node
// abuse-ops-11: re-subscribing a pending address no longer mails a fresh confirm link on every
// submit. Under 10 minutes since the last one, or 3 in a day (both from email_log, so a refused or
// failed confirm never blocks a retry), the address keeps the link already in its inbox (no new
// token, no new email) — new picks are still recorded. abuse-ops-4: the confirm a signed-out
// request triggers carries the sender's address to the mailer's per-sender allowance; the welcome
// after a confirm click does not.
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  throttled: false,
  upserts: [] as string[],
  merges: [] as [string, string, unknown][],
  sends: [] as { email: string; meta: Record<string, unknown> | undefined }[],
  welcomes: [] as { email: string; meta: Record<string, unknown> | undefined }[],
  db: {
    row: null as null | { confirmed: boolean },
    /** email_log rows for the address, newest first (what the query returns). */
    logRows: [] as { created_at: string }[],
    logError: null as null | { message: string },
    calls: [] as [string, string, unknown[]][]
  }
}));

vi.mock('../services/mailer.js', () => ({
  sendAccessRequested: vi.fn(async () => ({ ok: true })),
  sendNewsletterWelcome: vi.fn(async (email: string, _first?: string, meta?: Record<string, unknown>) => {
    h.welcomes.push({ email, meta });
    return { ok: true };
  }),
  verifyUnsubscribeToken: () => false,
  sendNewsletterConfirm: vi.fn(async (email: string, _url: string, _first?: string, meta?: Record<string, unknown>) => {
    h.sends.push({ email, meta });
    return { ok: true };
  })
}));
vi.mock('../services/invites.js', () => ({ resendPendingInvite: vi.fn(async () => ({ status: 'none' })) }));
vi.mock('../services/turnstile.js', () => ({ verifyTurnstile: vi.fn(async () => true) }));
// A minimal PostgREST stand-in: one waitlist row, the address's email_log rows.
vi.mock('../services/supabase.js', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'gte', 'order', 'limit', 'update']) {
        q[m] = (...args: unknown[]) => (h.db.calls.push([table, m, args]), q);
      }
      q.maybeSingle = async () => ({ data: h.db.row, error: null });
      q.then = (resolve: (v: unknown) => void) => resolve({ data: h.db.logError ? null : h.db.logRows, error: h.db.logError });
      return q;
    }
  })
}));
vi.mock('../services/emailStore.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/emailStore.js')>();
  return {
    ...real,
    newsletterConfirmThrottled: vi.fn(async (email: string, now?: number) => (h.throttled ? true : real.newsletterConfirmThrottled(email, now))),
    mergeSubscriberIntent: vi.fn(async (email: string, kind: string, intent: unknown) => {
      h.merges.push([email, kind, intent]);
      return real.mergeSubscriberIntent(email, kind as 'updates', intent as never);
    }),
    upsertSubscriber: vi.fn(async (email: string) => (h.upserts.push(email), { outcome: 'pending' as const })),
    confirmSubscriber: vi.fn(async () => true)
  };
});

import { newsletterRouter } from './newsletter.js';
import { newsletterConfirmThrottled } from '../services/emailStore.js';

let base = '';
let close: () => void = () => undefined;
beforeAll(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.header('authorization') === 'Bearer u1') (req as unknown as { user: { id: string } }).user = { id: 'u1' };
    next();
  });
  app.use('/api/newsletter', newsletterRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());
beforeEach(() => {
  h.throttled = false;
  h.upserts.length = 0;
  h.merges.length = 0;
  h.sends.length = 0;
  h.welcomes.length = 0;
  h.db = { row: null, logRows: [], logError: null, calls: [] };
});

const subscribe = (headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  fetch(`${base}/api/newsletter/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '2001:db8:1:2::3', ...headers },
    body: JSON.stringify({ email: 'Ada@Example.com', ...extra })
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as { ok: boolean; message: string } }));

describe('POST /api/newsletter/subscribe — re-send throttle', () => {
  it('a throttled pending address keeps its current link: no new token, no new email, the same answer', async () => {
    h.throttled = true;
    const res = await subscribe();
    expect(res).toEqual({ status: 200, body: { ok: true, message: 'Almost there! Check your inbox to confirm your subscription.' } });
    expect(h.upserts).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  it('a throttled re-submit still records new product picks and feedback (and nothing else)', async () => {
    h.throttled = true;
    await subscribe({}, { productInterests: ['comic_studio', 'not_a_product'], feedback: ' More panels ' });
    expect(h.merges).toEqual([['ada@example.com', 'updates', { productInterests: ['comic_studio', 'not_a_product'], feedback: ' More panels ' }]]);
    const update = h.db.calls.filter(([t, m]) => t === 'waitlist_signups' && m === 'update').map(([, , a]) => a[0]);
    expect(update).toEqual([{ product_interests: ['comic_studio'], feedback: 'More panels' }]);
    expect(h.upserts).toEqual([]);
    expect(h.sends).toEqual([]);
  });

  it('otherwise issues the link; a signed-out sender’s address goes to the mailer, a signed-in one’s does not', async () => {
    await subscribe();
    await subscribe({ authorization: 'Bearer u1' });
    expect(h.upserts).toEqual(['ada@example.com', 'ada@example.com']);
    expect(h.sends.map((s) => s.meta?.anonymousClientIp)).toEqual(['2001:db8:1:2::3', undefined]);
    expect(h.sends[1].meta).toMatchObject({ userId: 'u1' });
  });
});

describe('GET /api/newsletter/confirm — the welcome is not charged to the clicker’s network', () => {
  it('sends the welcome without the anonymous sender address', async () => {
    const r = await fetch(`${base}/api/newsletter/confirm?e=ada%40example.com&t=tok`, { redirect: 'manual', headers: { 'x-forwarded-for': '2001:db8:1:2::3' } });
    expect(r.status).toBe(302);
    expect(h.welcomes).toHaveLength(1);
    expect(h.welcomes[0].meta).not.toHaveProperty('anonymousClientIp');
  });
});

describe('newsletterConfirmThrottled', () => {
  const NOW = Date.parse('2026-11-05T12:00:00Z');
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it('throttles a pending address whose last confirm went out (or is going out) under 10 minutes ago', async () => {
    h.db.row = { confirmed: false };
    h.db.logRows = [{ created_at: ago(9 * 60_000) }];
    expect(await newsletterConfirmThrottled('ada@example.com', NOW)).toBe(true);
    h.db.logRows = [{ created_at: ago(11 * 60_000) }];
    expect(await newsletterConfirmThrottled('ada@example.com', NOW)).toBe(false);
  });

  it('a first confirm the mailer refused or that failed leaves no queued/sent row, so the retry goes out', async () => {
    // upsertSubscriber stamped confirm_sent_at a minute ago, but nothing went out.
    h.db.row = { confirmed: false };
    h.db.logRows = [];
    expect(await newsletterConfirmThrottled('ada@example.com', NOW)).toBe(false);
  });

  it('throttles after 3 confirms in 24 hours, read from email_log for this address and template', async () => {
    h.db.row = { confirmed: false };
    h.db.logRows = [{ created_at: ago(60 * 60_000) }, { created_at: ago(2 * 3_600_000) }];
    expect(await newsletterConfirmThrottled('Ada@Example.com', NOW)).toBe(false);
    h.db.logRows = [{ created_at: ago(60 * 60_000) }, { created_at: ago(2 * 3_600_000) }, { created_at: ago(3 * 3_600_000) }];
    expect(await newsletterConfirmThrottled('Ada@Example.com', NOW)).toBe(true);
    const log = h.db.calls.filter(([t]) => t === 'email_log').map(([, m, a]) => [m, ...a]);
    expect(log).toEqual(
      expect.arrayContaining([
        ['eq', 'to_email', 'ada@example.com'],
        ['eq', 'template', 'newsletter-confirm'],
        ['in', 'status', ['queued', 'sent']],
        ['gte', 'created_at', ago(24 * 3_600_000)],
        ['order', 'created_at', { ascending: false }],
        ['limit', 3]
      ])
    );
  });

  it('never throttles a new or confirmed address, and fails open on a log error', async () => {
    h.db.row = null;
    h.db.logRows = Array.from({ length: 3 }, () => ({ created_at: ago(1_000) }));
    expect(await newsletterConfirmThrottled('ada@example.com', NOW)).toBe(false);
    h.db.row = { confirmed: true };
    expect(await newsletterConfirmThrottled('ada@example.com', NOW)).toBe(false);
    h.db.row = { confirmed: false };
    h.db.logError = { message: 'boom' };
    expect(await newsletterConfirmThrottled('ada@example.com', NOW)).toBe(false);
  });
});
