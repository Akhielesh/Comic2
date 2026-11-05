// @vitest-environment node
// abuse-ops-11: re-subscribing a pending address no longer mails a fresh confirm link on every
// submit. Under 10 minutes since the last one, or 3 in a day, the address keeps the link already
// in its inbox (no new token, no new email). abuse-ops-4: the confirm a signed-out request
// triggers carries the sender's address to the mailer's per-sender allowance.
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  throttled: false,
  upserts: [] as string[],
  sends: [] as { email: string; meta: Record<string, unknown> | undefined }[],
  db: {
    row: null as null | { confirmed: boolean; confirm_sent_at: string | null },
    logCount: 0 as number,
    logError: null as null | { message: string },
    calls: [] as [string, string, unknown[]][]
  }
}));

vi.mock('../services/mailer.js', () => ({
  sendAccessRequested: vi.fn(async () => ({ ok: true })),
  sendNewsletterWelcome: vi.fn(async () => ({ ok: true })),
  verifyUnsubscribeToken: () => false,
  sendNewsletterConfirm: vi.fn(async (email: string, _url: string, _first?: string, meta?: Record<string, unknown>) => {
    h.sends.push({ email, meta });
    return { ok: true };
  })
}));
vi.mock('../services/invites.js', () => ({ resendPendingInvite: vi.fn(async () => ({ status: 'none' })) }));
vi.mock('../services/turnstile.js', () => ({ verifyTurnstile: vi.fn(async () => true) }));
// A minimal PostgREST stand-in for newsletterConfirmThrottled: one waitlist row, one email_log count.
vi.mock('../services/supabase.js', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'gte', 'limit']) {
        q[m] = (...args: unknown[]) => (h.db.calls.push([table, m, args]), q);
      }
      q.maybeSingle = async () => ({ data: h.db.row, error: null });
      q.then = (resolve: (v: unknown) => void) => resolve({ count: h.db.logCount, error: h.db.logError });
      return q;
    }
  })
}));
vi.mock('../services/emailStore.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/emailStore.js')>();
  return {
    ...real,
    newsletterConfirmThrottled: vi.fn(async (email: string, now?: number) => (h.throttled ? true : real.newsletterConfirmThrottled(email, now))),
    upsertSubscriber: vi.fn(async (email: string) => (h.upserts.push(email), { outcome: 'pending' as const }))
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
  h.sends.length = 0;
  h.db = { row: null, logCount: 0, logError: null, calls: [] };
});

const subscribe = (headers: Record<string, string> = {}) =>
  fetch(`${base}/api/newsletter/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '2001:db8:1:2::3', ...headers },
    body: JSON.stringify({ email: 'Ada@Example.com' })
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as { ok: boolean; message: string } }));

describe('POST /api/newsletter/subscribe — re-send throttle', () => {
  it('a throttled pending address keeps its current link: no new token, no new email, the same answer', async () => {
    h.throttled = true;
    const res = await subscribe();
    expect(res).toEqual({ status: 200, body: { ok: true, message: 'Almost there! Check your inbox to confirm your subscription.' } });
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

describe('newsletterConfirmThrottled', () => {
  const NOW = Date.parse('2026-11-05T12:00:00Z');
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it('throttles a pending address mailed under 10 minutes ago, without counting the log', async () => {
    h.db.row = { confirmed: false, confirm_sent_at: ago(9 * 60_000) };
    expect(await newsletterConfirmThrottled('ada@example.com', NOW)).toBe(true);
    expect(h.db.calls.some(([t]) => t === 'email_log')).toBe(false);
  });

  it('throttles after 3 confirms in 24 hours, counted from email_log for this address and template', async () => {
    h.db.row = { confirmed: false, confirm_sent_at: ago(11 * 60_000) };
    h.db.logCount = 2;
    expect(await newsletterConfirmThrottled('Ada@Example.com', NOW)).toBe(false);
    h.db.logCount = 3;
    expect(await newsletterConfirmThrottled('Ada@Example.com', NOW)).toBe(true);
    const log = h.db.calls.filter(([t]) => t === 'email_log').map(([, m, a]) => [m, ...a]);
    expect(log).toEqual(
      expect.arrayContaining([
        ['eq', 'to_email', 'ada@example.com'],
        ['eq', 'template', 'newsletter-confirm'],
        ['in', 'status', ['queued', 'sent']],
        ['gte', 'created_at', ago(24 * 3_600_000)]
      ])
    );
  });

  it('never throttles a new or confirmed address, and fails open on a log error', async () => {
    h.db.row = null;
    h.db.logCount = 99;
    expect(await newsletterConfirmThrottled('ada@example.com', NOW)).toBe(false);
    h.db.row = { confirmed: true, confirm_sent_at: ago(1_000) };
    expect(await newsletterConfirmThrottled('ada@example.com', NOW)).toBe(false);
    h.db.row = { confirmed: false, confirm_sent_at: ago(60 * 60_000) };
    h.db.logError = { message: 'boom' };
    expect(await newsletterConfirmThrottled('ada@example.com', NOW)).toBe(false);
  });
});
