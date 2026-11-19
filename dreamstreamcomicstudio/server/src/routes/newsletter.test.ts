// @vitest-environment node
// POST /api/newsletter/subscribe and GET /api/newsletter/confirm: registering interest sends
// no email unless INTEREST_EMAILS is exactly "on", every valid address gets the same answer
// (no account or invite lookup a caller could observe), and the optional answers are
// validated and capped on the server. The "keep me updated" box is stored as an explicit consent flag with
// its time and starts no email of its own.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const mailer = vi.hoisted(() => ({
  sendAccessRequested: vi.fn(async (..._args: unknown[]) => undefined),
  sendNewsletterConfirm: vi.fn(async (..._args: unknown[]) => undefined),
  sendNewsletterWelcome: vi.fn(async (..._args: unknown[]) => undefined),
  verifyUnsubscribeToken: vi.fn(() => true)
}));
vi.mock('../services/mailer.js', () => mailer);

const store = vi.hoisted(() => ({
  upsertSubscriber: vi.fn(),
  confirmSubscriber: vi.fn(async () => true),
  markUnsubscribed: vi.fn(async () => undefined),
  newConfirmToken: vi.fn(() => 'token-1')
}));
vi.mock('../services/emailStore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/emailStore.js')>()),
  ...store
}));

// The route must never ask about accounts or invites. These mocks answer as if the address
// had both, so any lookup that crept back in would change the response and fail the tests.
const invites = vi.hoisted(() => ({
  resendPendingInvite: vi.fn(async () => ({ status: 'invited', resent: true }))
}));
vi.mock('../services/invites.js', () => invites);
const profilesQuery = vi.hoisted(() => vi.fn());
vi.mock('../services/supabase.js', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      profilesQuery(table);
      const chain: Record<string, unknown> = {};
      for (const k of ['select', 'ilike', 'eq', 'limit']) chain[k] = () => chain;
      chain.maybeSingle = async () => ({ data: { id: 'someone' }, error: null });
      return chain;
    }
  })
}));
const turnstile = vi.hoisted(() => ({ verifyTurnstile: vi.fn(async () => true) }));
vi.mock('../services/turnstile.js', () => turnstile);

const { newsletterRouter, NEUTRAL_REPLY } = await import('./newsletter.js');
const { INTEREST_LIMITS, INTEREST_THANKS, INTEREST_UPDATES } = await import('../../../shared/interest.js');

const app = express();
app.use(express.json());
app.use('/api/newsletter', newsletterRouter);

let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const ORIGINAL = process.env.INTEREST_EMAILS;
beforeEach(() => {
  delete process.env.INTEREST_EMAILS;
  for (const fn of Object.values(mailer)) fn.mockClear();
  store.upsertSubscriber.mockReset();
  store.upsertSubscriber.mockResolvedValue({ outcome: 'new' });
  invites.resendPendingInvite.mockClear();
  profilesQuery.mockClear();
  turnstile.verifyTurnstile.mockClear();
  turnstile.verifyTurnstile.mockResolvedValue(true);
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.INTEREST_EMAILS;
  else process.env.INTEREST_EMAILS = ORIGINAL;
});

const post = async (body: unknown) => {
  const res = await fetch(`${base}/api/newsletter/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
};

const sendCount = () =>
  mailer.sendAccessRequested.mock.calls.length +
  mailer.sendNewsletterConfirm.mock.calls.length +
  mailer.sendNewsletterWelcome.mock.calls.length;

/** The address cases a caller might try to tell apart, each as the store would see it. */
const CASES = [
  { name: 'a new address', email: 'new@example.com', outcome: 'new' },
  { name: 'an address that has an account', email: 'member@example.com', outcome: 'new' },
  { name: 'an already invited address', email: 'invited@example.com', outcome: 'new' },
  { name: 'an address already on the list', email: 'repeat@example.com', outcome: 'already_registered' }
] as const;

describe('no email while INTEREST_EMAILS is not "on"', () => {
  for (const kind of ['access', 'updates'] as const) {
    it(`kind ${kind}: every address case sends nothing and re-sends no invite`, async () => {
      for (const c of CASES) {
        store.upsertSubscriber.mockResolvedValueOnce({ outcome: c.outcome });
        const res = await post({ email: c.email, kind });
        expect(res.status).toBe(200);
      }
      expect(sendCount()).toBe(0);
      expect(invites.resendPendingInvite).not.toHaveBeenCalled();
    });
  }

  it('any value other than exactly "on" keeps emails off', async () => {
    for (const value of ['', 'ON', 'true', '1', 'on ']) {
      process.env.INTEREST_EMAILS = value;
      await post({ email: 'new@example.com', kind: 'access' });
      await post({ email: 'new@example.com', kind: 'updates' });
    }
    expect(sendCount()).toBe(0);
  });

  it('ticking "keep me updated" sends nothing either', async () => {
    for (const c of CASES) {
      store.upsertSubscriber.mockResolvedValueOnce({ outcome: c.outcome });
      expect((await post({ email: c.email, kind: 'access', keepUpdated: true })).status).toBe(200);
    }
    expect(sendCount()).toBe(0);
  });

  it('the confirm link still confirms, without the welcome email', async () => {
    const res = await fetch(`${base}/api/newsletter/confirm?e=a%40example.com&t=abc`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('newsletter=confirmed');
    expect(store.confirmSubscriber).toHaveBeenCalled();
    expect(mailer.sendNewsletterWelcome).not.toHaveBeenCalled();
  });
});

describe('INTEREST_EMAILS=on', () => {
  beforeEach(() => {
    process.env.INTEREST_EMAILS = 'on';
  });

  it('a new access row gets the access email once; a repeat gets none; never an invite re-send', async () => {
    await post({ email: 'new@example.com', kind: 'access', firstName: 'Asha' });
    expect(mailer.sendAccessRequested).toHaveBeenCalledTimes(1);
    expect(mailer.sendAccessRequested.mock.calls[0]?.[0]).toBe('new@example.com');
    store.upsertSubscriber.mockResolvedValueOnce({ outcome: 'already_registered' });
    await post({ email: 'repeat@example.com', kind: 'access' });
    expect(mailer.sendAccessRequested).toHaveBeenCalledTimes(1);
    expect(invites.resendPendingInvite).not.toHaveBeenCalled();
  });

  it('the "keep me updated" box starts no email path of its own (the same mail as an unticked form)', async () => {
    await post({ email: 'new@example.com', kind: 'access', keepUpdated: false });
    const unticked = mailer.sendAccessRequested.mock.calls.length + mailer.sendNewsletterConfirm.mock.calls.length + mailer.sendNewsletterWelcome.mock.calls.length;
    for (const fn of Object.values(mailer)) fn.mockClear();
    await post({ email: 'new@example.com', kind: 'access', keepUpdated: true });
    expect(mailer.sendNewsletterConfirm).not.toHaveBeenCalled();
    expect(mailer.sendNewsletterWelcome).not.toHaveBeenCalled();
    expect(sendCount()).toBe(unticked);
  });

  it('an updates row gets the confirm email; the confirm link sends the welcome', async () => {
    await post({ email: 'new@example.com', kind: 'updates' });
    expect(mailer.sendNewsletterConfirm).toHaveBeenCalledTimes(1);
    await fetch(`${base}/api/newsletter/confirm?e=a%40example.com&t=abc`, { redirect: 'manual' });
    expect(mailer.sendNewsletterWelcome).toHaveBeenCalledTimes(1);
  });

  it('asks the store to renew a confirm token, and mails one only when the store wrote it', async () => {
    store.upsertSubscriber.mockResolvedValueOnce({ outcome: 'pending' });
    await post({ email: 'repeat@example.com', kind: 'updates' });
    expect((store.upsertSubscriber.mock.calls[0] as unknown[])[5]).toEqual({ reissueToken: true });
    expect(mailer.sendNewsletterConfirm).toHaveBeenCalledTimes(1);
    // Already on the list and nothing renewed (or already confirmed): a link would not match the row, so none goes.
    for (const outcome of ['already_registered', 'already_confirmed']) {
      store.upsertSubscriber.mockResolvedValueOnce({ outcome });
      await post({ email: 'repeat@example.com', kind: 'updates' });
    }
    expect(mailer.sendNewsletterConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('emails off: an address already on the list is left as it is', () => {
  it('asks the store not to renew any confirm token (an earlier confirm link keeps working)', async () => {
    await post({ email: 'repeat@example.com', kind: 'updates' });
    await post({ email: 'repeat@example.com', kind: 'access', comment: 'hello' });
    for (const call of store.upsertSubscriber.mock.calls as unknown[][]) expect(call[5]).toEqual({ reissueToken: false });
  });
});

describe('one neutral answer for every address', () => {
  for (const emails of ['off', 'on'] as const) {
    for (const kind of ['access', 'updates'] as const) {
      it(`emails ${emails}, kind ${kind}: same status and body for all address cases; no account lookup`, async () => {
        if (emails === 'on') process.env.INTEREST_EMAILS = 'on';
        const answers = [];
        for (const c of CASES) {
          store.upsertSubscriber.mockResolvedValueOnce({ outcome: c.outcome });
          answers.push(await post({ email: c.email, kind }));
        }
        for (const a of answers) expect(a).toEqual({ status: 200, body: NEUTRAL_REPLY[kind] });
        expect(profilesQuery).not.toHaveBeenCalled();
        expect(invites.resendPendingInvite).not.toHaveBeenCalled();
      });
    }
  }

  it('the answer promises no email and says nothing about accounts or invites', () => {
    for (const reply of Object.values(NEUTRAL_REPLY)) {
      expect(reply.message).not.toMatch(/email|inbox|account|invite|access|already/i);
    }
  });

  it('thanks for the answers only when some were sent; the address never changes the body', async () => {
    const plain = await post({ email: 'new@example.com', kind: 'access' });
    const answered = await post({ email: 'repeat@example.com', kind: 'access', comment: 'Hello' });
    expect(plain.body).toEqual(NEUTRAL_REPLY.access);
    expect(plain.body.message).not.toMatch(/answers/);
    expect(answered.body).toMatchObject({ ok: true, status: 'registered' });
    expect(answered.body.message).toMatch(/Your answers help shape what we build next\.$/);
  });

  it('a ticked box adds the truthful updates line, the same for every address', async () => {
    const answers = [];
    for (const c of CASES) {
      store.upsertSubscriber.mockResolvedValueOnce({ outcome: c.outcome });
      answers.push(await post({ email: c.email, kind: 'access', keepUpdated: true }));
    }
    for (const a of answers) {
      expect(a).toEqual({ status: 200, body: { ok: true, status: 'registered', message: `${INTEREST_THANKS.access} ${INTEREST_THANKS.keptUpdated}` } });
      expect(a.body.message).not.toMatch(/email|inbox|account|invite|already/i);
    }
  });

  it('a store failure answers 503, never a success', async () => {
    store.upsertSubscriber.mockRejectedValueOnce(new Error('db down'));
    const res = await post({ email: 'new@example.com', kind: 'access' });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, status: 'unavailable' });
  });

  it('keeps the bot check: a failed check answers 400 verify and stores nothing', async () => {
    turnstile.verifyTurnstile.mockResolvedValueOnce(false);
    const res = await post({ email: 'new@example.com', kind: 'access' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, status: 'verify' });
    expect(store.upsertSubscriber).not.toHaveBeenCalled();
  });
});

describe('optional answers: validated and capped on the server', () => {
  const AT = '2026-11-19T10:00:00.000Z';
  beforeEach(() => {
    // Only the clock is fixed (the server stamps the consent time); timers stay real for the HTTP round trip.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(AT));
  });
  afterEach(() => vi.useRealTimers());

  const stored = () => {
    const call = store.upsertSubscriber.mock.calls[0] as unknown[];
    return { metadata: call[3] as Record<string, unknown>, intent: call[4] as Record<string, unknown> };
  };
  const consent = (updates: boolean) => ({ updates, at: AT, wording: INTEREST_UPDATES.label });

  it('email alone stores no answers, and an explicit "no" to updates', async () => {
    await post({ email: 'new@example.com', kind: 'access', source: 'auth-request-access' });
    expect(stored()).toEqual({ metadata: { source: 'auth-request-access', consent: consent(false) }, intent: {} });
  });

  it('the list card (kind updates) carries no consent flag', async () => {
    await post({ email: 'new@example.com', kind: 'updates', source: 'home-stay-updated', keepUpdated: true });
    expect(stored().metadata).toEqual({ source: 'home-stay-updated' });
  });

  it('stores the new questions: first name, what they would like to make, how they heard, anything else, the box', async () => {
    await post({
      email: 'new@example.com',
      kind: 'access',
      source: 'landing',
      firstName: ' Asha\u0007 ',
      makes: ['kids', 'pitch', 'kids', 'teleport', 42, 'work'],
      heardFrom: 'linkedin',
      comment: 'Line one\r\nLine two\u001b\n\n\n\nLast\tline',
      keepUpdated: true
    });
    expect(stored().metadata).toEqual({
      source: 'landing',
      answers: {
        v: 2,
        makes: ['kids', 'pitch', 'work'],
        heardFrom: 'linkedin',
        comment: 'Line one\nLine two\n\nLast line',
        firstName: 'Asha'
      },
      consent: consent(true)
    });
    // The note also lands in the existing feedback column; nothing goes to product_interests any more.
    expect(stored().intent).toEqual({ feedback: 'Line one\nLine two\n\nLast line' });
  });

  it('the consent flag is false unless the box was ticked (only a real true counts)', async () => {
    for (const keepUpdated of [undefined, false, 'true', 'on', 1, null, ['yes']]) {
      store.upsertSubscriber.mockClear();
      expect((await post({ email: 'new@example.com', kind: 'access', keepUpdated })).status).toBe(200);
      expect(stored().metadata.consent, String(keepUpdated)).toEqual(consent(false));
    }
    store.upsertSubscriber.mockClear();
    await post({ email: 'new@example.com', kind: 'access', keepUpdated: true });
    expect(stored().metadata.consent).toEqual(consent(true));
  });

  it('an unknown "how did you hear" is dropped, not stored', async () => {
    await post({ email: 'new@example.com', kind: 'access', heardFrom: 'billboard' });
    expect(stored().metadata).toEqual({ consent: consent(false) });
  });

  it("stores exactly the shape the form's direct save writes (shared interestMetadata)", async () => {
    const answers = { makes: ['webcomic'], heardFrom: 'search', comment: 'Note', firstName: 'Ravi', keepUpdated: true };
    await post({ email: 'new@example.com', kind: 'access', source: 'auth-request-access', ...answers });
    const { interestMetadata } = await import('../../../shared/interest.js');
    expect(stored().metadata).toEqual(interestMetadata('auth-request-access', answers as never, AT));
  });

  it("still accepts an old open tab's payload: its studio, feature and something-else picks are not stored", async () => {
    const res = await post({
      email: 'new@example.com',
      kind: 'access',
      firstName: 'Old',
      features: ['chat', 'translations'],
      featureOther: 'x'.repeat(500),
      studios: Array.from({ length: 40 }, () => 'dashboards'),
      productInterests: ['comic_studio'],
      feedback: 'Hi'
    });
    expect(res).toEqual({ status: 200, body: { ok: true, status: 'registered', message: INTEREST_THANKS.accessWithAnswers } });
    expect(stored().intent).toEqual({ feedback: 'Hi' });
    expect(stored().metadata).toEqual({ answers: { v: 2, comment: 'Hi', firstName: 'Old' }, consent: consent(false) });
  });

  it('the surface tag is cut, never a reason to refuse', async () => {
    const res = await post({ email: 'new@example.com', kind: 'access', source: '/c/' + 'x'.repeat(400) });
    expect(res.status).toBe(200);
    expect((stored().metadata.source as string).length).toBe(INTEREST_LIMITS.sourceMax);
  });

  const oversize: Array<[string, Record<string, unknown>]> = [
    ['a comment over the limit', { comment: 'x'.repeat(INTEREST_LIMITS.commentMax + 1) }],
    ['a first name over the limit', { firstName: 'x'.repeat(INTEREST_LIMITS.firstNameMax + 1) }],
    ['too many picks', { makes: Array.from({ length: INTEREST_LIMITS.listMax + 1 }, () => 'kids') }],
    ['picks that are not a list', { makes: 'kids' }],
    ['a "how did you hear" that is not text', { heardFrom: ['friend'] }],
    ['a first name that is not text', { firstName: 42 }],
    ['a comment that is not text', { comment: { html: '<b>' } }],
    ['an email that is not an email', { email: 'not-an-email' }]
  ];
  for (const [name, extra] of oversize) {
    it(`refuses ${name} with 400 and stores nothing`, async () => {
      const res = await post({ email: 'new@example.com', kind: 'access', ...extra });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, status: 'invalid' });
      expect(store.upsertSubscriber).not.toHaveBeenCalled();
    });
  }

  it('a comment exactly at the limit is accepted', async () => {
    const res = await post({ email: 'new@example.com', kind: 'access', comment: 'y'.repeat(INTEREST_LIMITS.commentMax) });
    expect(res.status).toBe(200);
  });
});
