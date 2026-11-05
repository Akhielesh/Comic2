// @vitest-environment node
// abuse-ops-1 (f) and abuse-ops-6, route side: the public data routes (mounted before requireAuth) are
// limited per caller after optionalAuth — a signed-in caller per account, everyone else per IPv4
// address or IPv6 /64 — and the widget refresh of the two tools that spend a paid platform key
// (find_places, video_search) needs a signed-in caller. The fetchers themselves are faked: no network.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

vi.mock('../services/supabase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/supabase.js')>()),
  getSupabaseAdmin: () => {
    throw new Error('no database in tests');
  }
}));
vi.mock('../ai/clientGeo.js', () => ({ resolveClientGeo: async () => null, clientIpFromReq: () => undefined }));
const fetched = vi.hoisted(() => ({ unfurl: 0, read: 0, tools: [] as string[] }));
vi.mock('../ai/tools/unfurl.js', () => ({
  unfurlUrl: async (url: string) => {
    fetched.unfurl += 1;
    return { url, title: 'A page' };
  }
}));
vi.mock('../ai/tools/readArticle.js', () => ({
  readArticle: async (url: string) => {
    fetched.read += 1;
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
const { PUBLIC_DATA_WINDOWS, publicRequesterKey } = await import('../middleware/publicDataLimits.js');

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

  it('read-url: 20 a minute', async () => {
    const ip = v4();
    expect(await statuses(20, () => readUrl({ ip }))).toEqual(Array(20).fill(200));
    expect((await readUrl({ ip })).status).toBe(429);
  });

  it('a signed-in caller is counted per account, wherever they connect from', async () => {
    const user = `u-${seq++}`;
    // 20 reads from 20 different addresses use up the account's allowance…
    expect(await statuses(20, () => readUrl({ user }))).toEqual(Array(20).fill(200));
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

  it('tool-refresh: 30 a minute and 300 a day', async () => {
    expect(PUBLIC_DATA_WINDOWS.toolRefresh.map((w) => [w.windowMs, w.maxRequests])).toEqual([
      [60_000, 30],
      [24 * 60 * 60_000, 300]
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
