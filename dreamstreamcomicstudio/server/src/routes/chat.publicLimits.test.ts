// @vitest-environment node
// abuse-ops-1 (f) and abuse-ops-6, route side: the public data routes (mounted before requireAuth) are
// limited per caller after optionalAuth — a signed-in caller per account, everyone else per IPv4
// address or IPv6 /64 — and the widget refresh of the two tools that spend a paid platform key
// (find_places, video_search) needs a signed-in caller. The fetchers themselves are faked: no network.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { PublicDataWindow } from '../middleware/publicDataLimits.js';

vi.mock('../services/supabase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/supabase.js')>()),
  getSupabaseAdmin: () => {
    throw new Error('no database in tests');
  }
}));
vi.mock('../ai/clientGeo.js', () => ({ resolveClientGeo: async () => null, clientIpFromReq: () => undefined }));
const fetched = vi.hoisted(() => ({ unfurl: 0, read: 0, readAllowJina: [] as (boolean | undefined)[], tools: [] as string[] }));
// The real in-memory counter store, on a clock a test can move forward (days of dashboard use in ms).
const clock = vi.hoisted(() => ({ offsetMs: 0 }));
vi.mock('../middleware/rateLimitStore.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../middleware/rateLimitStore.js')>();
  const store = new mod.InMemoryRateLimitStore(() => Date.now() + clock.offsetMs);
  return { ...mod, getRateLimitStore: () => store };
});
vi.mock('../ai/tools/unfurl.js', () => ({
  unfurlUrl: async (url: string) => {
    fetched.unfurl += 1;
    return { url, title: 'A page' };
  }
}));
vi.mock('../ai/tools/readArticle.js', () => ({
  readArticle: async (url: string, _signal?: AbortSignal, opts?: { allowJina?: boolean }) => {
    fetched.read += 1;
    fetched.readAllowJina.push(opts?.allowJina);
    return { url, host: 'example.com', blocks: [], ok: true };
  }
}));
vi.mock('../ai/tools/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/tools/registry.js')>()),
  resolveTools: (toolNames: string[]) =>
    toolNames.map((name) => ({
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        fetched.tools.push(name);
        return { content: 'ok', artifacts: [{ type: 'weather', data: {} }] };
      }
    }))
}));

const { chatPublicRouter } = await import('./chat.js');
const { PUBLIC_DATA_WINDOWS, publicRequesterKey, toolRefreshLimit } = await import('../middleware/publicDataLimits.js');

const app = express();
app.set('trust proxy', true); // the client address comes from X-Forwarded-For below
app.use(express.json());
// optionalAuth stand-in: `x-test-user` signs the caller in.
app.use((req, _res, next) => {
  const id = req.header('x-test-user');
  if (id) (req as unknown as { user: { id: string } }).user = { id };
  next();
});
app.use('/api/chat', chatPublicRouter);

let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let seq = 0;
const v4 = () => `198.51.100.${(seq++ % 250) + 1}`;
const as = (who: { user?: string; ip?: string }) => ({
  ...(who.user ? { 'x-test-user': who.user } : {}),
  'x-forwarded-for': who.ip ?? v4()
});
const unfurl = (who: { user?: string; ip?: string }) =>
  fetch(`${base}/api/chat/unfurl?url=${encodeURIComponent('https://example.com/a')}`, { headers: as(who) });
const readUrl = (who: { user?: string; ip?: string }) =>
  fetch(`${base}/api/chat/read-url?url=${encodeURIComponent('https://example.com/a')}`, { headers: as(who) });
const refresh = (who: { user?: string; ip?: string }, tool = 'get_weather') =>
  fetch(`${base}/api/chat/tool-refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...as(who) },
    body: JSON.stringify({ tool, args: { location: 'Paris' } })
  });
const statuses = async (n: number, call: () => Promise<Response>) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await call()).status);
  return out;
};

describe('limits on the public data routes', () => {
  it('unfurl: 60 a minute per anonymous address, then 429 with the usual body', async () => {
    const ip = v4();
    const before = fetched.unfurl;
    expect(await statuses(60, () => unfurl({ ip }))).toEqual(Array(60).fill(200));
    const res = await unfurl({ ip });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = await res.json();
    expect(body.error).toMatchObject({ code: 'RATE_LIMITED', details: { scope: 'chat_unfurl', limit: 60, keyType: 'ip' } });
    // The refused call never reached the fetcher.
    expect(fetched.unfurl - before).toBe(60);
    // Another address is unaffected.
    expect((await unfurl({})).status).toBe(200);
  });

  it('read-url: 20 a minute anonymous, 60 signed in (the signed-in news list prefetches on hover)', async () => {
    const windows: readonly PublicDataWindow[] = PUBLIC_DATA_WINDOWS.readUrl;
    expect(windows.map((w) => [w.windowMs, w.maxRequests, w.appliesTo ?? 'all'])).toEqual([
      [60_000, 20, 'anonymous'],
      [60_000, 60, 'signedIn']
    ]);
    const ip = v4();
    expect(await statuses(20, () => readUrl({ ip }))).toEqual(Array(20).fill(200));
    const res = await readUrl({ ip });
    expect(res.status).toBe(429);
    expect((await res.json()).error.details).toMatchObject({ scope: 'chat_read_url', limit: 20, keyType: 'ip' });
    // A signed-in caller on that same address has its own, larger allowance.
    expect((await readUrl({ ip, user: `u-${seq++}` })).status).toBe(200);
  });

  it('read-url: only a signed-in caller may fall back to the Jina reader (allowJina passed explicitly)', async () => {
    const before = fetched.readAllowJina.length;
    expect((await readUrl({})).status).toBe(200);
    expect((await readUrl({ user: `u-${seq++}` })).status).toBe(200);
    expect(fetched.readAllowJina.slice(before)).toEqual([false, true]);
  });

  it('a signed-in caller is counted per account, wherever they connect from', async () => {
    const user = `u-${seq++}`;
    // 60 reads from 60 different addresses use up the account's allowance…
    expect(await statuses(60, () => readUrl({ user }))).toEqual(Array(60).fill(200));
    const res = await readUrl({ user });
    expect(res.status).toBe(429);
    expect((await res.json()).error.details.keyType).toBe('user');
    // …and another account (or an anonymous caller) on the same address is not affected.
    expect((await readUrl({ user: `u-${seq++}` })).status).toBe(200);
  });

  it('anonymous IPv6 callers share one allowance per /64 (rotating the interface id does not help)', async () => {
    const prefix = `2001:db8:${(seq++).toString(16)}:1`;
    expect(await statuses(20, () => readUrl({ ip: `${prefix}::${(seq++).toString(16)}` }))).toEqual(Array(20).fill(200));
    expect((await readUrl({ ip: `${prefix}:dead:beef:1:2` })).status).toBe(429);
    // The next /64 is someone else.
    expect((await readUrl({ ip: `2001:db8:${(seq++).toString(16)}:2::1` })).status).toBe(200);
  });

  it('tool-refresh: a minute is 30 anonymous, 120 signed in; a day is 300 anonymous, 10,000 signed in', async () => {
    const windows: readonly PublicDataWindow[] = PUBLIC_DATA_WINDOWS.toolRefresh;
    expect(windows.map((w) => [w.windowMs, w.maxRequests, w.appliesTo ?? 'all'])).toEqual([
      [60_000, 30, 'anonymous'],
      [60_000, 120, 'signedIn'],
      [24 * 60 * 60_000, 300, 'anonymous'],
      [24 * 60 * 60_000, 10_000, 'signedIn']
    ]);
    const ip = v4();
    expect(await statuses(30, () => refresh({ ip }))).toEqual(Array(30).fill(200));
    const res = await refresh({ ip });
    expect(res.status).toBe(429);
    expect((await res.json()).error.details.scope).toBe('chat_tool_refresh');
  });

  it('keys a request without an address as unknown rather than skipping the limit', () => {
    expect(publicRequesterKey({ ip: undefined } as never)).toBe('ip:unknown');
    expect(publicRequesterKey({ ip: '::ffff:203.0.113.9' } as never)).toBe('ip:4:203.0.113.9');
    expect(publicRequesterKey({ ip: '203.0.113.9', user: { id: 'u1' } } as never)).toBe('user:u1');
  });
});

describe('tool-refresh windows against real client cadence', () => {
  const MIN = 60_000;
  // Drive the limiter as Express would, on the store's movable clock; returns the refusal scope or null.
  const hit = async (who: { user?: string; ip: string }): Promise<string | null> => {
    let refused: string | null = null;
    const res = {
      setHeader: () => undefined,
      status: () => res,
      json: (body: { error: { details: { scope: string } } }) => {
        refused = body.error.details.scope;
      }
    };
    let passed = false;
    await toolRefreshLimit({ ip: who.ip, user: who.user ? { id: who.user } : undefined } as never, res as never, () => {
      passed = true;
    });
    expect(passed).toBe(refused === null);
    return refused;
  };
  const start = clock.offsetMs;
  afterAll(() => {
    clock.offsetMs = start;
  });

  it('a signed-in 10-tile board (every 5 min) plus a 30 s live monitor, open for 8 hours, is never refused', async () => {
    const who = { user: `u-board-${seq++}`, ip: v4() };
    const t0 = (clock.offsetMs += 2 * 24 * 60 * MIN); // a fresh day for every window
    const refusals: string[] = [];
    let calls = 0;
    for (let t = 0; t <= 8 * 60 * MIN; t += 30_000) {
      clock.offsetMs = t0 + t;
      const due = 1 + (t % (5 * MIN) === 0 ? 10 : 0); // the monitor every tick, the 10 tiles every 5 min
      for (let i = 0; i < due; i++) {
        calls += 1;
        const r = await hit(who);
        if (r) refusals.push(r);
      }
    }
    expect(calls).toBe(961 + 970); // 961 monitor ticks + 97 board refreshes × 10 tiles
    expect(refusals).toEqual([]);
  });

  it('a signed-in 40-tile board refreshed all at once, plus a 30 s live monitor, is never refused (8 hours)', async () => {
    // Dashboards fires every data tile of the open board in the same moment, on open and on every
    // 5-minute tick, and boards have no tile cap: 41 calls land in one minute, over the anonymous 30.
    const who = { user: `u-board40-${seq++}`, ip: v4() };
    const t0 = (clock.offsetMs += 2 * 24 * 60 * MIN);
    const refusals: string[] = [];
    let calls = 0;
    for (let t = 0; t <= 8 * 60 * MIN; t += 30_000) {
      clock.offsetMs = t0 + t;
      const due = 1 + (t % (5 * MIN) === 0 ? 40 : 0);
      for (let i = 0; i < due; i++) {
        calls += 1;
        const r = await hit(who);
        if (r) refusals.push(r);
      }
    }
    expect(calls).toBe(961 + 97 * 40);
    expect(refusals).toEqual([]);
  });

  it('the same 40-tile burst from an anonymous caller stops at 30 in the minute', async () => {
    const who = { ip: v4() };
    clock.offsetMs += 2 * 24 * 60 * MIN;
    const scopes: (string | null)[] = [];
    for (let i = 0; i < 41; i++) scopes.push(await hit(who));
    expect(scopes.slice(0, 30).every((s) => s === null)).toBe(true);
    expect(new Set(scopes.slice(30))).toEqual(new Set(['chat_tool_refresh']));
  });

  it('a signed-in account still stops at 120 in a minute', async () => {
    const who = { user: `u-burst-${seq++}`, ip: v4() };
    clock.offsetMs += 2 * 24 * 60 * MIN;
    const scopes: (string | null)[] = [];
    for (let i = 0; i < 121; i++) scopes.push(await hit(who));
    expect(scopes.slice(0, 120).every((s) => s === null)).toBe(true);
    expect(scopes[120]).toBe('chat_tool_refresh');
  });

  it('an anonymous caller still stops at 300 a day, even when spread under the minute limit', async () => {
    const who = { ip: v4() };
    const t0 = (clock.offsetMs += 2 * 24 * 60 * MIN);
    const scopes: (string | null)[] = [];
    for (let i = 0; i < 301; i++) {
      clock.offsetMs = t0 + Math.floor(i / 20) * MIN; // 20 a minute
      scopes.push(await hit(who));
    }
    expect(scopes.slice(0, 300).every((s) => s === null)).toBe(true);
    expect(scopes[300]).toBe('chat_tool_refresh_day');
  });

  it('a signed-in account stops at 10,000 a day', async () => {
    const who = { user: `u-script-${seq++}`, ip: v4() };
    const t0 = (clock.offsetMs += 2 * 24 * 60 * MIN);
    let last: string | null = null;
    for (let i = 0; i < 10_001; i++) {
      clock.offsetMs = t0 + Math.floor(i / 120) * MIN; // the most the signed-in minute window allows
      last = await hit(who);
      if (i < 10_000) expect(last).toBeNull();
    }
    expect(last).toBe('chat_tool_refresh_day');
  });
});

describe('tool-refresh of paid-key tools needs a signed-in caller', () => {
  it.each(['find_places', 'video_search'])('%s: anonymous → 401 and the tool never runs; signed in → refreshed', async (tool) => {
    const ran = fetched.tools.length;
    const anon = await refresh({}, tool);
    expect(anon.status).toBe(401);
    expect((await anon.json()).error).toMatchObject({ code: 'SIGN_IN_REQUIRED' });
    expect(fetched.tools.length).toBe(ran);
    const signedIn = await refresh({ user: `u-${seq++}` }, tool);
    expect(signedIn.status).toBe(200);
    expect(fetched.tools.slice(ran)).toEqual([tool]);
  });

  it('keyless tools still refresh anonymously', async () => {
    expect((await refresh({}, 'get_weather')).status).toBe(200);
  });
});
