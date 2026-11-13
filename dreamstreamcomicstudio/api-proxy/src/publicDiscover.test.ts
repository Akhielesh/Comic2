// @vitest-environment node
// Discover at the edge (redesign DS-R2): built against a fake RPC until comic_discovery.sql is applied.
// 400 on bad params (before any database call), 429 from the public comic limiter, the cache header and the edge
// cache, 503 + no-store on a database timeout, HEAD, only allow-listed fields, and the dispatch in proxy.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './proxy';
import { DISCOVER_BACKOFF_MS, handlePublicDiscover, resetDiscoverBackoffForTests, type EdgeCache } from './publicDiscover';
import { rpc as realRpc, type RpcResult } from '../../functions/_shared/supabaseRpc';
import { decodeDiscoverPage, encodeDiscoverCursor, type DiscoverPage } from '../../shared/comic/discovery';

const SUPA = 'https://bdjfmxfmhqhzvgrhbbzm.supabase.co';
const SLUG = 'Ab3dEf6hIj9kLm2nP';
const SLUG2 = 'Zz3dEf6hIj9kLm2nP';
const KEY = 'K1234567890abcdefghijk';
const SITE = 'https://dreamstreamstudio.ai';
const ALLOWED = ['slug', 'title', 'description', 'kind', 'pageCount', 'aspect', 'cover', 'rating', 'languages', 'publishedAt', 'firstPublishedAt', 'likes', 'themeColor', 'creator'];

const rpcItem = (over: Record<string, unknown> = {}) => ({
  slug: SLUG,
  title: 'Spice Run',
  description: 'A courier races the monsoon.',
  kind: 'comic',
  pageCount: 12,
  aspect: '2:3',
  cover: { w480: `pub/${KEY}/cover-0123456789ab-w480.webp`, w1080: `pub/${KEY}/cover-0123456789ab-w1080.webp` },
  rating: 'G',
  languages: ['en'],
  publishedAt: 1_762_000_000_000,
  firstPublishedAt: 1_762_000_000_000,
  likes: 3,
  creator: { username: 'alice', avatarUrl: `${SUPA}/storage/v1/object/public/comic-assets/avatars/alice.webp` },
  // Everything a careless RPC could add: none of it may reach a reader.
  userId: '00000000-0000-4000-8000-00000000000a',
  snapshot: { pages: [{ render: { asset: { path: 'u/x/draft.webp' } } }] },
  safety: { rating: 'G', status: 'cleared', reasons: [] },
  assetKey: KEY,
  ...over
});

type Call = { name: string; args: Record<string, unknown>; timeoutMs?: number };
const fakeRpc = (answer: (name: string, args: Record<string, unknown>) => RpcResult<unknown>) => {
  const calls: Call[] = [];
  const fn = (async (_env: unknown, name: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
    calls.push({ name, args, timeoutMs: opts?.timeoutMs });
    return answer(name, args);
  }) as unknown as typeof realRpc;
  return { fn, calls };
};

/** The Cache API, in memory (keyed by URL; GET only). */
const memoryCache = () => {
  const store = new Map<string, { body: string; headers: [string, string][] }>();
  const cache: EdgeCache = {
    match: async (req) => {
      const hit = store.get(req.url);
      return hit ? new Response(hit.body, { headers: hit.headers }) : undefined;
    },
    put: async (req, res) => {
      store.set(req.url, { body: await res.text(), headers: [...res.headers] });
    }
  };
  return { cache, store };
};

const limiter = (success: boolean) => ({ limit: vi.fn(async (_: { key: string }) => ({ success })) });
const env = (extra: Record<string, unknown> = {}) => ({ VITE_SUPABASE_URL: SUPA, CORS_ORIGIN: `${SITE},https://www.dreamstreamstudio.ai`, ...extra });
const ctx = () => {
  const waits: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => void waits.push(p), waits };
};

async function call(path: string, opts: { method?: string; origin?: string; env?: Record<string, unknown>; rpc?: typeof realRpc; cache?: EdgeCache | null; ctx?: ReturnType<typeof ctx> } = {}) {
  const url = new URL(`https://dreamstreamstudio.ai${path}`);
  const headers: Record<string, string> = { 'cf-connecting-ip': '203.0.113.7' };
  if (opts.origin) headers.origin = opts.origin;
  const req = new Request(url, { method: opts.method || 'GET', headers });
  const c = opts.ctx || ctx();
  const res = await handlePublicDiscover(req, (opts.env || env()) as never, c, url, { rpc: opts.rpc, cache: opts.cache === undefined ? null : opts.cache });
  await Promise.all(c.waits);
  return res;
}

const listOk = (items: unknown[] = [rpcItem()], next: unknown = null) => ({ ok: true as const, data: { items, next } });

afterEach(() => {
  resetDiscoverBackoffForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('400 on bad parameters, before the database is asked', () => {
  it.each([
    ['an unknown parameter', '?page=2'],
    ['a repeated parameter', '?kind=manga&kind=comic'],
    ['an unknown sort', '?sort=random'],
    ['an unknown rating', '?rating=all'],
    ['a limit over 24', '?limit=25'],
    ['a 61-character search', `?q=${'x'.repeat(61)}`],
    ['a cursor from another sort', `?sort=new&cursor=${encodeDiscoverCursor('trending', { slug: SLUG })}`],
    ['a cursor carrying a number', `?cursor=t4.${SLUG}`],
    ['an unknown shelves parameter', '/shelves?sort=new']
  ])('%s', async (_label, query) => {
    const rpc = fakeRpc(() => listOk());
    const path = query.startsWith('/') ? `/api/comic/public/discover${query}` : `/api/comic/public/discover${query}`;
    const res = (await call(path, { rpc: rpc.fn }))!;
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).error.code).toBe('BAD_REQUEST');
    expect(rpc.calls).toHaveLength(0);
  });
});

describe('429 from the shared public comic limiter', () => {
  it('answers 429 with retry-after and never calls the database', async () => {
    const rpc = fakeRpc(() => listOk());
    const rl = limiter(false);
    const res = (await call('/api/comic/public/discover', { rpc: rpc.fn, env: env({ PUBLIC_COMIC_RL: rl }) }))!;
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(rl.limit).toHaveBeenCalledWith({ key: 'discover:203.0.113.7' });
    expect(rpc.calls).toHaveLength(0);
  });

  it('counts malformed requests too, and a limiter outage never takes Discover down', async () => {
    const rl = limiter(false);
    expect((await call('/api/comic/public/discover?page=2', { env: env({ PUBLIC_COMIC_RL: rl }) }))!.status).toBe(429);
    const broken = { limit: vi.fn(async () => { throw new Error('down'); }) };
    const rpc = fakeRpc(() => listOk());
    expect((await call('/api/comic/public/discover', { rpc: rpc.fn, env: env({ PUBLIC_COMIC_RL: broken }) }))!.status).toBe(200);
  });
});

describe('200: the listing', () => {
  it('sends the canonical arguments and answers only allow-listed fields', async () => {
    const rpc = fakeRpc(() => listOk([rpcItem(), rpcItem({ slug: SLUG2, creator: undefined, rating: 'PG-13' })], { slug: SLUG2 }));
    const res = (await call(`/api/comic/public/discover?kind=manga&q=${encodeURIComponent(' spice  run ')}&rating=kids&lang=EN&limit=2&week=1`, { rpc: rpc.fn }))!;
    expect(res.status).toBe(200);
    expect(rpc.calls).toEqual([
      {
        name: 'comic_discover_list',
        args: { p_sort: 'trending', p_q: 'spice run', p_rating: 'kids', p_lang: 'en', p_kind: 'manga', p_length: null, p_week: true, p_limit: 2, p_after_slug: null },
        timeoutMs: 4000
      }
    ]);
    const body = (await res.json()) as DiscoverPage;
    expect(body.items.map((i) => i.slug)).toEqual([SLUG, SLUG2]);
    for (const item of body.items) expect(Object.keys(item).every((k) => ALLOWED.includes(k))).toBe(true);
    expect(body.items[0].cover).toEqual({
      w480: `${SUPA}/storage/v1/object/public/comic-assets/pub/${KEY}/cover-0123456789ab-w480.webp`,
      w1080: `${SUPA}/storage/v1/object/public/comic-assets/pub/${KEY}/cover-0123456789ab-w1080.webp`
    });
    expect(body.items[0].creator).toEqual({ username: 'alice', avatarUrl: `${SUPA}/storage/v1/object/public/comic-assets/avatars/alice.webp` });
    expect(body.items[1].creator).toBeUndefined();
    const text = JSON.stringify(body);
    for (const leak of ['00000000-0000-4000-8000-00000000000a', 'snapshot', 'safety', 'assetKey', 'draft.webp', 'cleared']) expect(text).not.toContain(leak);
    // The UI decode accepts exactly what the edge sends.
    expect(decodeDiscoverPage(body)).toEqual(body);
  });

  it('pages with the opaque cursor: next goes back as cursor and becomes the keyset (the slug only)', async () => {
    const rpc = fakeRpc(() => listOk([rpcItem()], { slug: SLUG }));
    const first = (await (await call('/api/comic/public/discover?sort=new', { rpc: rpc.fn }))!.json()) as DiscoverPage;
    expect(first.next).toBe(encodeDiscoverCursor('new', { slug: SLUG }));
    await call(`/api/comic/public/discover?sort=new&cursor=${first.next}`, { rpc: rpc.fn });
    expect(rpc.calls[1].args).toMatchObject({ p_sort: 'new', p_after_slug: SLUG });
    expect(rpc.calls[1].args).not.toHaveProperty('p_after_n');
  });

  it('the cursor never carries a reader count: a score in the RPC\'s next stays at the edge', async () => {
    // Trending (the default sort) ranks by 7-day reads, which are owner-only: anyone may page with limit=1.
    const rpc = fakeRpc(() => listOk([rpcItem()], { n: 777, slug: SLUG }));
    const res = (await call('/api/comic/public/discover?limit=1', { rpc: rpc.fn }))!;
    const text = await res.text();
    const body = JSON.parse(text) as DiscoverPage;
    expect(body.next).toBe(`t.${SLUG}`);
    expect(text).not.toContain('777');
  });

  it('an avatar from another Supabase project is dropped (only our own storage origin is trusted)', async () => {
    const rpc = fakeRpc(() =>
      listOk([rpcItem({ creator: { username: 'erin', avatarUrl: 'https://abcdefghijkl.supabase.co/storage/v1/object/public/comic-assets/avatars/a.webp' } })])
    );
    const body = (await (await call('/api/comic/public/discover', { rpc: rpc.fn }))!.json()) as DiscoverPage;
    expect(body.items[0].creator).toEqual({ username: 'erin' });
  });

  it('drops a cover outside pub/ and an avatar outside our storage', async () => {
    const rpc = fakeRpc(() =>
      listOk([rpcItem({ cover: { w480: 'u/1/p/2/img/draft.webp', w1080: `pub/${KEY}/c.webp` }, creator: { username: 'dave', avatarUrl: 'https://tracker.example/p.png' } })])
    );
    const body = (await (await call('/api/comic/public/discover', { rpc: rpc.fn }))!.json()) as DiscoverPage;
    expect(body.items[0].cover).toBeUndefined();
    expect(body.items[0].creator).toEqual({ username: 'dave' });
  });

  it('no rows is an empty page; a malformed answer is 503, never "nothing here"', async () => {
    const empty = fakeRpc(() => ({ ok: true, data: null }));
    const res = (await call('/api/comic/public/discover', { rpc: empty.fn }))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const odd = fakeRpc(() => ({ ok: true, data: [{ slug: SLUG }] }));
    const bad = (await call('/api/comic/public/discover', { rpc: odd.fn }))!;
    expect(bad.status).toBe(503);
    expect(bad.headers.get('cache-control')).toBe('no-store');
  });

  it('carries the cache header, security headers and CORS only for our sites', async () => {
    const rpc = fakeRpc(() => listOk());
    const ours = (await call('/api/comic/public/discover', { rpc: rpc.fn, origin: 'https://comics.dreamstreamstudio.ai' }))!;
    expect(ours.headers.get('cache-control')).toBe('public, max-age=30, s-maxage=30');
    expect(ours.headers.get('vary')).toBe('Origin');
    expect(ours.headers.get('access-control-allow-origin')).toBe('https://comics.dreamstreamstudio.ai');
    expect(ours.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ours.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const foreign = (await call('/api/comic/public/discover', { rpc: rpc.fn, origin: 'https://evil.example' }))!;
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers HEAD with the same status and headers and no body', async () => {
    const rpc = fakeRpc(() => listOk());
    const res = (await call('/api/comic/public/discover?sort=most_read', { method: 'HEAD', rpc: rpc.fn }))!;
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=30, s-maxage=30');
    expect(await res.text()).toBe('');
  });

  it('405 for other methods; any other path under /discover is answered at the edge (404), others are not ours', async () => {
    const post = (await call('/api/comic/public/discover', { method: 'POST' }))!;
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    expect((await call('/api/comic/public/discover/xyz'))!.status).toBe(404);
    expect(await call('/api/comic/public/discovery')).toBeNull();
    expect(await call('/api/comic/public/s/Ab3dEf6hIj9kLm2nP')).toBeNull();
  });
});

describe('503 + no-store when the database does not answer', () => {
  it('a timeout from the RPC client', async () => {
    const rpc = fakeRpc(() => ({ ok: false, reason: 'timeout' }));
    const res = (await call('/api/comic/public/discover', { rpc: rpc.fn }))!;
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('retry-after')).toBe('5');
    expect((await res.json()).error.code).toBe('UNAVAILABLE');
  });

  it('a real 4 s timeout through supabaseRpc (a hung database), never cached', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }))
    );
    const { cache, store } = memoryCache();
    const pending = call('/api/comic/public/discover', { rpc: realRpc, cache });
    await vi.advanceTimersByTimeAsync(4000);
    const res = (await pending)!;
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(store.size).toBe(0);
  });

  it('the SQL not applied yet (PostgREST 404) reads as unavailable, not as an empty Discover', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"code":"PGRST202"}', { status: 404 })));
    const res = (await call('/api/comic/public/discover', { rpc: realRpc }))!;
    expect(res.status).toBe(503);
  });
});

describe('back-off while the database is down or the SQL is not applied', () => {
  it('two requests after a failed answer make ONE database call; the second is the same 503, at once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rpc = fakeRpc(() => ({ ok: false, reason: 'unavailable' } as RpcResult<unknown>));
    const first = (await call('/api/comic/public/discover', { rpc: rpc.fn }))!;
    const second = (await call('/api/comic/public/discover/shelves', { rpc: rpc.fn }))!;
    expect(rpc.calls).toHaveLength(1);
    for (const res of [first, second]) {
      expect(res.status).toBe(503);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect((await res.json()).error.code).toBe('UNAVAILABLE');
    }
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it(`asks again once ${DISCOVER_BACKOFF_MS / 1000} s have passed, and a good answer serves as usual`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let down = true;
    const rpc = fakeRpc(() => (down ? ({ ok: false, reason: 'timeout' } as RpcResult<unknown>) : listOk()));
    expect((await call('/api/comic/public/discover', { rpc: rpc.fn }))!.status).toBe(503);
    vi.setSystemTime(Date.now() + DISCOVER_BACKOFF_MS - 1000);
    expect((await call('/api/comic/public/discover', { rpc: rpc.fn }))!.status).toBe(503);
    expect(rpc.calls).toHaveLength(1);
    down = false;
    vi.setSystemTime(Date.now() + 2000);
    expect((await call('/api/comic/public/discover', { rpc: rpc.fn }))!.status).toBe(200);
    expect(rpc.calls).toHaveLength(2);
  });
});

describe('the edge cache', () => {
  it('serves the same canonical query from the cache, with CORS for each caller and never a cached CORS header', async () => {
    const rpc = fakeRpc(() => listOk());
    const { cache, store } = memoryCache();
    const first = (await call('/api/comic/public/discover?lang=EN&kind=manga', { rpc: rpc.fn, cache, origin: SITE }))!;
    expect(first.headers.get('x-discover-cache')).toBe('miss');
    expect(store.size).toBe(1);
    const [stored] = [...store.values()];
    expect(new Headers(stored.headers).get('access-control-allow-origin')).toBeNull();
    expect(new Headers(stored.headers).get('cache-control')).toBe('public, max-age=30, s-maxage=30');

    const again = (await call('/api/comic/public/discover?kind=manga&lang=en&limit=24', { rpc: rpc.fn, cache, origin: 'https://comics.dreamstreamstudio.ai' }))!;
    expect(again.headers.get('x-discover-cache')).toBe('hit');
    expect(again.headers.get('access-control-allow-origin')).toBe('https://comics.dreamstreamstudio.ai');
    // A hit is public and cacheable with a per-request ACAO: without Vary a cache could replay one site's ACAO to another.
    expect(again.headers.get('vary')).toBe('Origin');
    expect(again.headers.get('cache-control')).toBe('public, max-age=30, s-maxage=30');
    expect(await again.json()).toEqual(await first.json());
    const head = (await call('/api/comic/public/discover?kind=manga&lang=en', { method: 'HEAD', rpc: rpc.fn, cache }))!;
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(rpc.calls).toHaveLength(1);
  });

  it('a different query is a different entry; errors are never stored', async () => {
    const rpc = fakeRpc((_n, args) => (args.p_kind === 'manga' ? { ok: false, reason: 'unavailable' } : listOk()));
    const { cache, store } = memoryCache();
    await call('/api/comic/public/discover?kind=comic', { rpc: rpc.fn, cache });
    await call('/api/comic/public/discover?kind=manga', { rpc: rpc.fn, cache });
    await call('/api/comic/public/discover?page=1', { rpc: rpc.fn, cache });
    expect([...store.keys()]).toEqual(['https://dreamstreamstudio.ai/api/comic/public/discover?kind=comic']);
  });
});

describe('shelves', () => {
  const items = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => rpcItem({ slug: `${prefix}${String(i).padStart(3, '0')}` }));

  it('calls comic_discover_shelves and keeps only the shelves worth showing', async () => {
    const rpc = fakeRpc(() => ({ ok: true, data: { featured: items(1, 'Fe3dEf6hIj9kLm'), trending: [], kids: items(3, 'Ki3dEf6hIj9kLm'), lang: items(2, 'La3dEf6hIj9kLm'), manga: items(5, 'Ma3dEf6hIj9kLm') } }));
    const res = (await call('/api/comic/public/discover/shelves?your_lang=hi&rating=kids', { rpc: rpc.fn }))!;
    expect(res.status).toBe(200);
    expect(rpc.calls[0]).toMatchObject({ name: 'comic_discover_shelves', args: { p_rating: 'kids', p_lang: null, p_kind: null, p_your_lang: 'hi' } });
    const body = (await res.json()) as { shelves: Record<string, unknown[]> };
    expect(Object.keys(body.shelves)).toEqual(['featured', 'kids', 'manga']);
    expect(res.headers.get('cache-control')).toBe('public, max-age=30, s-maxage=30');
    for (const shelf of Object.values(body.shelves)) for (const item of shelf as Record<string, unknown>[]) expect(Object.keys(item).every((k) => ALLOWED.includes(k))).toBe(true);
  });

  it('503 + no-store when the shelves do not answer', async () => {
    const rpc = fakeRpc(() => ({ ok: false, reason: 'timeout' }));
    const res = (await call('/api/comic/public/discover/shelves', { rpc: rpc.fn }))!;
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('proxy.ts dispatch', () => {
  it('answers Discover at the edge: the anon RPC is called, the backend is never reached', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url === `${SUPA}/rest/v1/rpc/comic_discover_list`) {
          expect(JSON.parse(String(init?.body))).toMatchObject({ p_sort: 'new', p_limit: 24 });
          return new Response(JSON.stringify({ items: [rpcItem()], next: null }), { headers: { 'content-type': 'application/json' } });
        }
        return new Response('{"from":"backend"}');
      })
    );
    const req = new Request('https://dreamstreamstudio.ai/api/comic/public/discover?sort=new', {
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }
    });
    const c = ctx();
    const res = await worker.fetch(req, { BACKEND_TARGET: 'origin', BACKEND_ORIGIN: 'https://backend.example', VITE_SUPABASE_URL: SUPA } as never, c);
    expect(res.status).toBe(200);
    expect(((await res.json()) as DiscoverPage).items[0].slug).toBe(SLUG);
    expect(calls).toEqual([`${SUPA}/rest/v1/rpc/comic_discover_list`]);
  });

  it('every other /api/comic route still reaches the share handler or the backend', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (calls.push(String(input)), new Response('{"from":"backend"}'))));
    const req = new Request('https://dreamstreamstudio.ai/api/comic/projects/1', { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' } });
    const res = await worker.fetch(req, { BACKEND_TARGET: 'origin', BACKEND_ORIGIN: 'https://backend.example', VITE_SUPABASE_URL: SUPA } as never, ctx());
    expect(await res.text()).toBe('{"from":"backend"}');
    expect(calls).toEqual(['https://backend.example/api/comic/projects/1']);
  });
});

describe('the RPC allow-list', () => {
  it('lets the two listing RPCs through and still refuses any other name', async () => {
    const fetchImpl = vi.fn(async () => new Response('null')) as unknown as typeof fetch;
    await expect(realRpc({ VITE_SUPABASE_URL: SUPA }, 'comic_discover_list', {}, { fetchImpl })).resolves.toEqual({ ok: true, data: null });
    await expect(realRpc({ VITE_SUPABASE_URL: SUPA }, 'comic_discover_shelves', {}, { fetchImpl })).resolves.toEqual({ ok: true, data: null });
    await expect(realRpc({ VITE_SUPABASE_URL: SUPA }, 'comic_featured_admin', {}, { fetchImpl })).rejects.toThrow(/not allow-listed/);
  });
});
