// @vitest-environment node
// abuse-ops-4: the auth reserve (other mail stops at the cap minus the reserve; auth mail may use
// the whole cap), the per-sender allowance for mail a signed-out request triggers, the 50% / 80%
// warnings, the cap gate (auth mail never waits behind other mail; a closed lane refuses without
// reading usage), and abuse-ops-15: no log line carries a full recipient address.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('EMAIL_WORKER_URL', 'https://email-worker.test');
  vi.stubEnv('EMAIL_HMAC_SECRET', 'test-secret');
  vi.stubEnv('EMAIL_PUBLIC_BASE_URL', 'https://api.test');
  vi.stubEnv('EMAIL_MAX_PER_DAY', '10');
  vi.stubEnv('EMAIL_MAX_PER_MONTH', '100');
  // Larger than half the day cap: clamped to 5 so other mail keeps half.
  vi.stubEnv('EMAIL_AUTH_RESERVE_PER_DAY', '8');
  vi.stubEnv('EMAIL_AUTH_RESERVE_PER_MONTH', '20');
  vi.stubEnv('EMAIL_ANON_MAX_PER_CLIENT_PER_DAY', '2');
});

const store = vi.hoisted(() => ({
  usage: { day: 0, month: 0, authDay: 0, authMonth: 0 },
  /** When set, usage is derived from the logged rows (queued / sent count), answered after a DB-like delay. */
  live: false,
  /** Milliseconds each usage read and log insert takes (0: answered at once). */
  delayMs: 0,
  logs: [] as Record<string, unknown>[]
}));
const dbDelay = () => (store.delayMs ? new Promise((r) => setTimeout(r, store.delayMs)) : Promise.resolve());
vi.mock('./emailStore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./emailStore.js')>()),
  getUsage: vi.fn(async () => {
    if (!store.live) {
      await dbDelay();
      return { ...store.usage };
    }
    // Like the database: the count is taken when the query runs, the answer arrives later.
    const counted = store.logs.filter((l) => l.status === 'queued' || l.status === 'sent');
    const auth = counted.filter((l) => String(l.template).startsWith('auth-')).length;
    await new Promise((r) => setTimeout(r, 5));
    return { day: store.usage.day + counted.length, month: store.usage.month + counted.length, authDay: store.usage.authDay + auth, authMonth: store.usage.authMonth + auth };
  }),
  isSuppressed: vi.fn(async () => false),
  logSend: vi.fn(async (entry: Record<string, unknown>) => {
    await dbDelay();
    store.logs.push(entry);
    return 'log-1';
  }),
  patchLog: vi.fn(async () => undefined)
}));

const { getEmailUsageStatus, resetMailerWarnings, sendEmail, sendNewsletterConfirm } = await import('./mailer.js');
const { getUsage } = await import('./emailStore.js');

const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ ok: true, messageId: 'm1' })));
vi.stubGlobal('fetch', fetchMock);
const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  warn.mockRestore();
  error.mockRestore();
});
beforeEach(() => {
  fetchMock.mockClear();
  warn.mockClear();
  error.mockClear();
  store.logs.length = 0;
  store.live = false;
  store.delayMs = 0;
  store.usage = { day: 0, month: 0, authDay: 0, authMonth: 0 };
  resetMailerWarnings();
});
/** Move the clock (Date only: timers stay real, so the DB-like delays still run). */
const setClock = (iso: string | number) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(typeof iso === 'number' ? iso : Date.parse(iso));
};
const usageReads = () => vi.mocked(getUsage).mock.calls.length;

const logged = () => [...warn.mock.calls, ...error.mock.calls].map((c) => c.join(' ')).join('\n');

describe('the auth reserve (abuse-ops-4)', () => {
  it('newsletter mail cannot use up the reserve; sign-in mail still goes out', async () => {
    // 5 non-auth sent today: other mail's share (10 − 5 reserved) is used up.
    store.usage = { day: 5, month: 5, authDay: 0, authMonth: 0 };
    expect(await sendNewsletterConfirm('ada@example.com', 'https://api.test/c')).toEqual({ ok: false, skipped: 'rate_limited' });
    expect(store.logs.at(-1)).toMatchObject({ template: 'newsletter-confirm', status: 'rate_limited', error: 'auth_reserve' });
    for (const template of ['access-requested', 'beta-invite', 'announcement'] as const) {
      expect((await sendEmail({ to: 'ada@example.com', template })).skipped).toBe('rate_limited');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    // Auth mail uses the reserve.
    expect(await sendEmail({ to: 'ada@example.com', template: 'auth-recovery', params: { actionUrl: 'https://x.test/r' }, track: false })).toEqual({ ok: true, messageId: 'm1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('auth mail sent earlier does not shrink other mail’s share, and the hard cap still binds everything', async () => {
    store.usage = { day: 4, month: 4, authDay: 4, authMonth: 4 };
    expect((await sendNewsletterConfirm('ada@example.com', 'https://api.test/c')).ok).toBe(true);
    store.usage = { day: 10, month: 10, authDay: 6, authMonth: 6 };
    expect((await sendEmail({ to: 'ada@example.com', template: 'auth-magic-link' })).skipped).toBe('rate_limited');
    expect(store.logs.at(-1)).toMatchObject({ status: 'rate_limited' });
    expect(store.logs.at(-1)).not.toHaveProperty('error', 'auth_reserve');
  });

  it('the monthly share binds too', async () => {
    store.usage = { day: 0, month: 80, authDay: 0, authMonth: 0 }; // 100 − 20 reserved
    expect((await sendNewsletterConfirm('ada@example.com', 'https://api.test/c')).skipped).toBe('rate_limited');
    expect((await sendEmail({ to: 'ada@example.com', template: 'auth-confirm-signup' })).ok).toBe(true);
  });

  it('reports each bucket for the admin console; day/maxPerDay stays the auth rule', async () => {
    store.usage = { day: 7, month: 30, authDay: 3, authMonth: 10 };
    expect(await getEmailUsageStatus()).toMatchObject({
      day: 7,
      maxPerDay: 10,
      authDay: 3,
      otherDay: 4,
      otherMaxPerDay: 5,
      authReservePerDay: 5, // 8 asked, clamped to half the cap
      authMonth: 10,
      otherMonth: 20,
      otherMaxPerMonth: 80,
      authReservePerMonth: 20
    });
  });

  it('parallel sends at the edge of the share: one goes out, the rest are refused (in-flight sends count)', async () => {
    // 4 of other mail's 5 already sent; five requests arrive at once.
    store.usage = { day: 4, month: 4, authDay: 0, authMonth: 0 };
    store.live = true;
    const results = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((n) => sendNewsletterConfirm(`${n}@example.com`, 'https://api.test/c'))
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.skipped === 'rate_limited')).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The auth reserve is intact: sign-in mail still goes out, in parallel too, up to the hard cap.
    const auth = await Promise.all(
      Array.from({ length: 7 }, (_, i) => sendEmail({ to: `u${i}@example.com`, template: 'auth-recovery', track: false }))
    );
    expect(auth.filter((r) => r.ok)).toHaveLength(5); // 10 − 4 − 1
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('warns once at 50% and once at 80%, not on every send', async () => {
    store.usage = { day: 1, month: 50, authDay: 0, authMonth: 0 };
    for (let i = 0; i < 3; i++) await sendEmail({ to: 'ada@example.com', template: 'auth-recovery' });
    expect(warn.mock.calls.filter((c) => /all mail: 50\/100 this month \(≥50%\)/.test(String(c[0])))).toHaveLength(1);
    store.usage = { day: 1, month: 81, authDay: 0, authMonth: 0 };
    for (let i = 0; i < 3; i++) await sendEmail({ to: 'ada@example.com', template: 'auth-recovery' });
    expect(warn.mock.calls.filter((c) => /all mail: 81\/100 this month \(≥80%\)/.test(String(c[0])))).toHaveLength(1);
    store.usage = { day: 3, month: 1, authDay: 0, authMonth: 0 };
    await sendNewsletterConfirm('ada@example.com', 'https://api.test/c');
    expect(warn.mock.calls.filter((c) => /non-auth mail: 3\/5 this day \(≥50%\)/.test(String(c[0])))).toHaveLength(1);
  });
});

describe('the cap gate: auth mail has its own lane; a closed lane refuses without reading usage', () => {
  it('a sign-in email does not wait behind queued other mail', async () => {
    store.delayMs = 10; // each usage read and log insert: 10 ms
    const N = 40; // ≈ 40 × 2 × 10 ms = 800 ms of other mail in the gate, all of it admitted
    let othersDone = 0;
    const flood = Array.from({ length: N }, (_, i) =>
      sendEmail({ to: `n${i}@example.com`, template: 'access-requested' }).then((r) => (othersDone++, r))
    );
    await new Promise((r) => setTimeout(r, 5)); // the flood is in the gate first
    const t0 = performance.now();
    const auth = await sendEmail({ to: 'real@example.com', template: 'auth-recovery', params: { actionUrl: 'https://x.test/r' }, track: false });
    const waited = performance.now() - t0;
    const othersWhenAuthDone = othersDone;
    const results = await Promise.all(flood);
    expect(auth).toEqual({ ok: true, messageId: 'm1' });
    expect(waited).toBeLessThan(200); // its own read + insert, not the queue's
    expect(othersWhenAuthDone).toBeLessThan(N / 2);
    expect(results.every((r) => r.ok)).toBe(true); // other mail still goes out, one check at a time
  });

  it('once other mail’s share is used up, the rest is refused without a usage read or a wait — and still logged', async () => {
    store.delayMs = 10;
    store.usage = { day: 5, month: 5, authDay: 0, authMonth: 0 }; // other mail's 5 used
    setClock('2026-11-05T12:00:00Z');
    const reads = usageReads();
    const t0 = performance.now(); // real time (only Date is faked)
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => sendNewsletterConfirm(`n${i}@example.com`, 'https://api.test/c'))
    );
    // One usage read, then the log inserts side by side: ~20 ms, not 30 × (read + insert) ≈ 600 ms.
    expect(performance.now() - t0).toBeLessThan(200);
    expect(results.every((r) => r.skipped === 'rate_limited')).toBe(true);
    expect(usageReads() - reads).toBe(1); // the first one read the counts and closed the lane
    expect(store.logs.filter((l) => l.status === 'rate_limited' && l.error === 'auth_reserve')).toHaveLength(30);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('[email][RESERVE]'))).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    // Later arrivals do not enter the gate either.
    expect((await sendEmail({ to: 'late@example.com', template: 'beta-invite' })).skipped).toBe('rate_limited');
    expect(usageReads() - reads).toBe(1);
    // The auth lane is open: sign-in mail still reads the counts and goes out.
    expect((await sendEmail({ to: 'real@example.com', template: 'auth-recovery', track: false })).ok).toBe(true);
    // A minute later the lane reads the counts again: a queued send that failed freed a place.
    setClock('2026-11-05T12:01:01Z');
    store.usage = { day: 4, month: 4, authDay: 0, authMonth: 0 };
    expect((await sendNewsletterConfirm('ada@example.com', 'https://api.test/c')).ok).toBe(true);
  });

  it('the hard cap closes both lanes, until UTC midnight at the latest', async () => {
    setClock('2026-11-05T23:59:50Z');
    store.usage = { day: 10, month: 10, authDay: 6, authMonth: 6 };
    expect((await sendEmail({ to: 'a@example.com', template: 'auth-magic-link' })).skipped).toBe('rate_limited');
    const reads = usageReads();
    expect((await sendEmail({ to: 'b@example.com', template: 'auth-recovery' })).skipped).toBe('rate_limited');
    expect((await sendNewsletterConfirm('c@example.com', 'https://api.test/c')).skipped).toBe('rate_limited');
    expect(usageReads()).toBe(reads);
    expect(store.logs.at(-1)).toMatchObject({ status: 'rate_limited' });
    expect(store.logs.at(-1)?.error).toBeUndefined(); // the hard cap, not the reserve
    // 11 seconds later it is a new UTC day: the day count starts over and both lanes read it.
    setClock('2026-11-06T00:00:01Z');
    store.usage = { day: 0, month: 10, authDay: 0, authMonth: 6 };
    expect((await sendEmail({ to: 'b@example.com', template: 'auth-recovery', track: false })).ok).toBe(true);
    expect((await sendNewsletterConfirm('c@example.com', 'https://api.test/c')).ok).toBe(true);
  });
});

describe('mail a signed-out request triggers: per IPv4 address / IPv6 /64 a day', () => {
  it('2 a day per /64, rotating addresses does not help; another network and signed-in sends are unaffected', async () => {
    const send = (ip?: string) => sendNewsletterConfirm('ada@example.com', 'https://api.test/c', undefined, ip === undefined ? {} : { anonymousClientIp: ip });
    expect((await send('2001:db8:9:9::1')).ok).toBe(true);
    expect((await send('2001:db8:9:9::2')).ok).toBe(true);
    expect(await send('2001:db8:9:9:abcd::3')).toEqual({ ok: false, skipped: 'rate_limited' });
    expect(store.logs.at(-1)).toMatchObject({ status: 'rate_limited', error: 'anon_sender_cap' });
    expect((await send('2001:db8:9:a::1')).ok).toBe(true);
    expect((await send('::ffff:198.51.100.4')).ok).toBe(true);
    expect((await send()).ok).toBe(true); // signed-in / admin: no per-sender allowance
    expect((await send()).ok).toBe(true);
  });
});

describe('mailer logs never carry a full recipient address (abuse-ops-15)', () => {
  it('masks the address on the cost cap, the reserve, a failed send and a network error', async () => {
    // A minute between the steps: a refused lane reads the counts again only after one.
    setClock('2026-11-05T12:00:00Z');
    store.usage = { day: 10, month: 10, authDay: 0, authMonth: 0 };
    await sendEmail({ to: 'Grace.Hopper@Example.com', template: 'auth-recovery' });
    setClock('2026-11-05T12:01:01Z');
    store.usage = { day: 5, month: 5, authDay: 0, authMonth: 0 };
    await sendNewsletterConfirm('grace.hopper@example.com', 'https://api.test/c');
    setClock('2026-11-05T12:02:02Z');
    store.usage = { day: 0, month: 0, authDay: 0, authMonth: 0 };
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ ok: false, error: 'bounced' }), { status: 502 }));
    await sendEmail({ to: 'grace.hopper@example.com', template: 'welcome' });
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('socket hang up');
    });
    await sendEmail({ to: 'grace.hopper@example.com', template: 'welcome' });
    for (let i = 0; i < 3; i++) await sendNewsletterConfirm('grace.hopper@example.com', 'https://api.test/c', undefined, { anonymousClientIp: '203.0.113.200' });

    const text = logged();
    expect(text).toContain('[email][COST-CAP]');
    expect(text).toContain('[email][RESERVE]');
    expect(text).toContain('send failed (welcome → g***@example.com): bounced');
    expect(text).toContain('send error (welcome → g***@example.com): socket hang up');
    expect(text).toContain('[email][ANON-CAP]');
    expect(text.toLowerCase()).not.toContain('grace.hopper');
    expect(text).toMatch(/g\*\*\*@example\.com/);
  });
});
