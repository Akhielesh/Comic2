// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type BackendNamespace } from './proxy';
import { buildBackendEnv, loadBackendEnv, type EnvDb } from './backendEnv';
import { detectAgent } from './agent-gate';
import { resetShareViewSaltCache } from './shareViewSalt';
import { createOnRequest, onRequest } from '../../functions/_middleware';
import { STREAM_HOST_ON } from '../../shared/streamHost';

const HUMAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const env: Record<string, unknown> = { BACKEND_TARGET: 'origin', BACKEND_ORIGIN: 'https://backend.example' };

function call(path: string, init: RequestInit & { ua?: string } = {}, workerEnv: Record<string, unknown> = env) {
  const headers = new Headers(init.headers);
  if (init.ua !== undefined) headers.set('user-agent', init.ua);
  const waits: Promise<unknown>[] = [];
  const res = worker.fetch(new Request(`https://dreamstreamstudio.ai${path}`, { ...init, headers }), workerEnv, { waitUntil: (p) => waits.push(p) });
  return { res, waits };
}

afterEach(() => vi.unstubAllGlobals());

describe('dreamstream-api agent gate', () => {
  it('turns AI agents away from the API without touching the backend', async () => {
    const backend = vi.fn();
    vi.stubGlobal('fetch', backend);
    const res = await call('/api/projects', { ua: 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)' }).res;
    expect(res.status).toBe(403);
    expect((await res.json()).checkin).toBe('https://dreamstreamstudio.ai/api/agent-gate');
    expect(backend).not.toHaveBeenCalled();
  });

  it('still proxies people, scripts and the product’s own /api/agents routes', async () => {
    const backend = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"status":"ok"}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', backend);
    expect((await call('/api/agents/custom-1', { method: 'DELETE', ua: HUMAN }).res).status).toBe(200);
    expect((await call('/api/health', { ua: 'curl/8.5.0' }).res).status).toBe(200);
    expect((await call('/api/health', { ua: 'node' }).res).status).toBe(200);
    expect(backend.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://backend.example/api/agents/custom-1',
      'https://backend.example/api/health',
      'https://backend.example/api/health',
    ]);
  });

  it('serves the check-in page with a canary and escapes request-supplied names', async () => {
    const res = await call('/api/agent-gate?from=/models', { ua: 'Mozilla/5.0', headers: { 'signature-agent': '"<script>x</script>"' } }).res;
    const html = await res.text();
    expect(res.headers.get('x-robots-tag')).toContain('noai');
    expect(html).toContain('dss-canary-');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('returns 50 questions as JSON and keeps only q1–q50 answers', async () => {
    const questions = await (await call('/api/agent-gate/checkin', { ua: 'ClaudeBot/1.0' }).res).json();
    expect(questions.questions).toHaveLength(50);
    expect(questions.sample.notice).toMatch(/SYNTHETIC/);
    const post = await call('/api/agent-gate/checkin', {
      method: 'POST',
      ua: 'ClaudeBot/1.0',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: { q1: 'ClaudeBot', q50: 'done', q51: 'ignored', toString: 'x' } }),
    }).res;
    expect((await post.json()).answered).toBe(2);
  });

  it('only flags automated browsers on pages, never on the API', () => {
    const headless = new Request('https://dreamstreamstudio.ai/', { headers: { 'user-agent': 'Mozilla/5.0 HeadlessChrome/140.0' } });
    expect(detectAgent(headless, 'page')?.kind).toBe('automation');
    expect(detectAgent(headless, 'api')).toBeNull();
    const google = new Request('https://dreamstreamstudio.ai/', { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } });
    expect(detectAgent(google, 'page')).toBeNull();
  });
});

describe('Pages middleware', () => {
  const next = vi.fn(async () => new Response('app'));
  const run = (path: string, ua: string) => onRequest({ request: new Request(`https://dreamstreamstudio.ai${path}`, { headers: { 'user-agent': ua } }), next });

  it('redirects AI agents to the check-in and leaves everyone else alone', async () => {
    const agent = await run('/models', 'PerplexityBot/1.0');
    expect(agent.status).toBe(302);
    expect(agent.headers.get('location')).toBe('https://dreamstreamstudio.ai/api/agent-gate?from=%2Fmodels');
    expect(await (await run('/models', HUMAN)).text()).toBe('app');
    expect(await (await run('/share/abc', 'Twitterbot/1.0')).text()).toBe('app');
    expect(await (await run('/robots.txt', 'GPTBot/1.2')).text()).toBe('app');
    expect((await run('/agents', HUMAN)).headers.get('location')).toBe('https://dreamstreamstudio.ai/api/agent-gate');
  });

  it('sends www to the bare domain so there is one sign-in (sessions are per host)', async () => {
    const res = await onRequest({ request: new Request('https://www.dreamstreamstudio.ai/live?x=1', { headers: { 'user-agent': HUMAN } }), next });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://dreamstreamstudio.ai/live?x=1');
  });

  it('sends the Pages production host to the custom domain, keeping path + query', async () => {
    const go = (u: string, ua = HUMAN) => onRequest({ request: new Request(u, { headers: { 'user-agent': ua } }), next });
    const served = next.mock.calls.length;
    const res = await go('https://comic2.pages.dev/live.html?e=evt_1');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://dreamstreamstudio.ai/live.html?e=evt_1');
    expect((await go('https://comic2.pages.dev/')).headers.get('location')).toBe('https://dreamstreamstudio.ai/');
    // Host redirect wins over the agent gate (the gate runs on the custom domain).
    expect((await go('https://comic2.pages.dev/models', 'GPTBot/1.2')).headers.get('location')).toBe('https://dreamstreamstudio.ai/models');
    // Crawl files and /.well-known redirect too: the host serves nothing of its own.
    expect((await go('https://comic2.pages.dev/robots.txt')).status).toBe(301);
    expect(next.mock.calls.length).toBe(served);
  });

  it('leaves Pages preview and branch deploys alone', async () => {
    for (const host of ['a1b2c3d4.comic2.pages.dev', 'dreamstrream-v1.comic2.pages.dev']) {
      const res = await onRequest({ request: new Request(`https://${host}/live`, { headers: { 'user-agent': HUMAN } }), next });
      expect(await res.text()).toBe('app');
    }
  });

  it('never serves the apex pages sign-in links land on to a frame — the Function sets the headers itself (_headers may not reach a response that passed through it)', async () => {
    const page = async () => new Response('app', { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    const go = (path: string, streamHostOn = false, ua = HUMAN) =>
      createOnRequest({ streamHostOn })({ request: new Request(`https://dreamstreamstudio.ai${path}`, { headers: { 'user-agent': ua } }), next: page });
    for (const path of ['/auth/callback', '/auth/callback/', '/auth/callback?token_hash=h&type=magiclink', '/auth/callback#access_token=x', '/live', '/live/', '/live.html?e=evt_1', '/live?after=monitor&token_hash=h&type=signup']) {
      const res = await go(path);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toBe('app'); // served as before…
      expect(res.headers.get('x-frame-options'), path).toBe('DENY'); // …never to a frame
      expect(res.headers.get('content-security-policy'), path).toBe("frame-ancestors 'none'");
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8'); // the page's own headers stay
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    // Switch on: /auth/callback stays on the apex and keeps them (the live app moved to its host, which sets its own).
    const cb = await go('/auth/callback?code=c', true);
    expect(cb.status).toBe(200);
    expect(cb.headers.get('x-frame-options')).toBe('DENY');
    expect((await go('/live?after=monitor', true)).status).toBe(301);
    // Other pages and files are untouched; AI agents still go to the check-in first.
    for (const path of ['/', '/models', '/auth/callbacks', '/auth/callback.txt', '/assets/index.js', '/api/health']) {
      expect((await go(path)).headers.get('x-frame-options'), path).toBeNull();
    }
    expect((await go('/auth/callback', false, 'GPTBot/1.2')).status).toBe(302);
  });
});

describe('Stream Studio host (stream.dreamstreamstudio.ai)', () => {
  const STREAM = 'https://stream.dreamstreamstudio.ai';
  // The Pages asset server, with its pretty URLs: /live.html answers 308 → /live.
  const assetServer = () =>
    vi.fn(async (input: Request | string | URL) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      if (u.pathname === '/live.html') return new Response(null, { status: 308, headers: { location: '/live' } });
      if (u.pathname === '/live') return new Response('<live app>', { headers: { 'content-type': 'text/html' } });
      return new Response('index', { headers: { 'content-type': 'text/html' } });
    });
  const setup = (streamHostOn: boolean) => {
    const handler = createOnRequest({ streamHostOn });
    const next = vi.fn(async () => new Response('app'));
    const assets = assetServer();
    const go = (u: string, ua = HUMAN, method = 'GET') =>
      handler({ request: new Request(u, { method, headers: { 'user-agent': ua } }), next, env: { ASSETS: { fetch: assets } } });
    /** Follow redirects through the middleware the way a browser would; fails on a loop. */
    const land = async (u: string): Promise<{ url: string; res: Response; hops: number }> => {
      let url = u;
      for (let hops = 0; hops < 5; hops++) {
        const res = await go(url);
        const loc = res.headers.get('location');
        if (res.status < 300 || res.status >= 400 || !loc) return { url, res, hops };
        url = new URL(loc, url).toString();
      }
      throw new Error(`redirect loop from ${u}`);
    };
    return { go, land, next, assets };
  };

  it('serves the live app at / and on every page, without redirecting', async () => {
    for (const on of [false, true]) {
      const { go, next, assets } = setup(on);
      for (const path of ['/', '/?e=evt_1', '/anything/deep', '/index.html', '/auth/callback?token_hash=h&type=magiclink']) {
        const res = await go(`${STREAM}${path}`);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('<live app>');
      }
      expect(next).not.toHaveBeenCalled();
      // Asked for /live first (pretty URL), never the redirecting /live.html.
      expect(assets.mock.calls.every((c) => new URL((c[0] as Request).url).pathname === '/live')).toBe(true);
    }
  });

  it('refuses to be framed: the live app (where sign-in links land) is served with frame-blocking headers', async () => {
    for (const on of [false, true]) {
      const { go } = setup(on);
      for (const path of ['/', '/?token_hash=h&type=signup&after=monitor', '/auth/callback?token_hash=h&type=magiclink']) {
        const res = await go(`${STREAM}${path}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('x-frame-options'), path).toBe('DENY');
        expect(res.headers.get('content-security-policy'), path).toBe("frame-ancestors 'none'");
        expect(res.headers.get('content-type')).toBe('text/html'); // the asset's own headers stay
      }
    }
  });

  it('keeps old viewer, guest and studio links working there: /live… → / with the query', async () => {
    const { go, land } = setup(false);
    const viewer = await go(`${STREAM}/live.html?e=evt_1`);
    expect(viewer.status).toBe(301);
    expect(viewer.headers.get('location')).toBe(`${STREAM}/?e=evt_1`);
    expect((await go(`${STREAM}/live`)).headers.get('location')).toBe(`${STREAM}/`);
    expect((await go(`${STREAM}/live/?after=monitor`)).headers.get('location')).toBe(`${STREAM}/?after=monitor`);
    const landed = await land(`${STREAM}/live.html?e=evt_1`);
    expect(landed).toMatchObject({ url: `${STREAM}/?e=evt_1`, hops: 1 });
    expect(await landed.res.text()).toBe('<live app>');
  });

  it('leaves files, the APIs and crawl files to Pages and the Worker routes', async () => {
    const { go, next, assets } = setup(true);
    for (const path of ['/assets/index-abc.js', '/live-sw.js', '/live.webmanifest', '/stream.webmanifest', '/stream-studio.svg', '/api/health', '/live-api/api/events/x', '/robots.txt', '/.well-known/security.txt']) {
      expect(await (await go(`${STREAM}${path}`)).text()).toBe('app');
    }
    expect(assets).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(9);
    // Not a page load: Pages answers it as before.
    expect(await (await go(`${STREAM}/`, HUMAN, 'POST')).text()).toBe('app');
  });

  it('sends AI agents to the check-in on the same host (the gate is unchanged)', async () => {
    const { go, assets } = setup(true);
    const res = await go(`${STREAM}/`, 'GPTBot/1.2');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${STREAM}/api/agent-gate?from=%2F`);
    expect((await go(`${STREAM}/agents`)).headers.get('location')).toBe(`${STREAM}/api/agent-gate`);
    expect(await (await go(`${STREAM}/robots.txt`, 'GPTBot/1.2')).text()).toBe('app');
    expect(assets).not.toHaveBeenCalled();
  });

  it('redirects www.stream to the Stream Studio host', async () => {
    const { go } = setup(false);
    const res = await go('https://www.stream.dreamstreamstudio.ai/?e=evt_1');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`${STREAM}/?e=evt_1`);
  });

  it('never passes on a redirect from the asset server (no rewrite loops)', async () => {
    const handler = createOnRequest({ streamHostOn: true });
    const fetch = vi.fn(async () => new Response(null, { status: 308, headers: { location: '/live' } }));
    const res = await handler({ request: new Request(`${STREAM}/`, { headers: { 'user-agent': HUMAN } }), next: async () => new Response('app'), env: { ASSETS: { fetch } } });
    expect(res.status).toBe(503);
    expect(res.headers.get('location')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('switch off: the apex serves /live, /live.html and viewer links exactly as before', async () => {
    const { go, next } = setup(false);
    for (const path of ['/live', '/live/', '/live.html', '/live.html?e=evt_1']) {
      expect(await (await go(`https://dreamstreamstudio.ai${path}`)).text()).toBe('app');
    }
    expect(next).toHaveBeenCalledTimes(4);
    expect((await go('https://comic2.pages.dev/live.html?e=evt_1')).headers.get('location')).toBe('https://dreamstreamstudio.ai/live.html?e=evt_1');
    // The production export is the switch as committed.
    const res = await onRequest({ request: new Request('https://dreamstreamstudio.ai/live.html?e=evt_1', { headers: { 'user-agent': HUMAN } }), next });
    expect(res.status).toBe(STREAM_HOST_ON ? 301 : 200);
  });

  it('switch on: the apex app addresses move to the Stream Studio host, everything else stays', async () => {
    const { go, land, next } = setup(true);
    const cases: [string, string][] = [
      ['/live', `${STREAM}/`],
      ['/live/', `${STREAM}/`],
      ['/live.html', `${STREAM}/`],
      ['/live.html?e=evt_1', `${STREAM}/?e=evt_1`],
      ['/live?after=monitor&token_hash=h&type=signup', `${STREAM}/?after=monitor&token_hash=h&type=signup`],
    ];
    for (const [path, to] of cases) {
      const res = await go(`https://dreamstreamstudio.ai${path}`);
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe(to);
      expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
    }
    // Old installed apps, service workers and open tabs keep their APIs and files on the apex.
    for (const path of ['/', '/models', '/live-api/api/events/x', '/api/health', '/assets/live-abc.js', '/live-sw.js', '/live.webmanifest', '/livestream', '/live.html?legacy=1']) {
      expect(await (await go(`https://dreamstreamstudio.ai${path}`)).text()).toBe('app');
    }
    // The Pages alias goes straight to the new host (one hop) for app links, to the apex otherwise.
    expect((await go('https://comic2.pages.dev/live.html?e=evt_1')).headers.get('location')).toBe(`${STREAM}/?e=evt_1`);
    expect((await go('https://www.dreamstreamstudio.ai/live')).headers.get('location')).toBe(`${STREAM}/`);
    expect((await go('https://comic2.pages.dev/models')).headers.get('location')).toBe('https://dreamstreamstudio.ai/models');
    // No loops: every old address lands on the app in one hop.
    for (const start of ['https://dreamstreamstudio.ai/live.html?e=evt_1', 'https://comic2.pages.dev/live', 'https://www.stream.dreamstreamstudio.ai/live.html']) {
      const landed = await land(start);
      expect(landed.res.status).toBe(200);
      expect(landed.hops).toBeLessThanOrEqual(2);
    }
    expect(next.mock.calls.length).toBeGreaterThan(0);
  });

  it('switch on: AI agents asking for /live follow the move and are gated on the new host', async () => {
    const { go } = setup(true);
    const res = await go('https://dreamstreamstudio.ai/live', 'ClaudeBot/1.0');
    expect(res.headers.get('location')).toBe(`${STREAM}/`);
    expect((await go(`${STREAM}/`, 'ClaudeBot/1.0')).headers.get('location')).toBe(`${STREAM}/api/agent-gate?from=%2F`);
  });
});

function fakeContainer(handler: (req: Request) => Promise<Response>) {
  const seen: { name: unknown; req: Request }[] = [];
  const ns: BackendNamespace = {
    idFromName: (name) => ({ name }),
    get: (id) => ({
      fetch: async (req) => {
        seen.push({ name: (id as { name: unknown }).name, req });
        return handler(req);
      },
    }),
  };
  return { ns, seen };
}

describe('backend routing', () => {
  it('sends API traffic to the single Backend container with the real client IP', async () => {
    const railway = vi.fn();
    vi.stubGlobal('fetch', railway);
    const { ns, seen } = fakeContainer(async (req) => new Response(await req.text(), { status: 201 }));
    const res = await call(
      '/api/projects?x=1',
      { method: 'POST', ua: HUMAN, body: '{"a":1}', headers: { 'cf-connecting-ip': '203.0.113.9', 'content-type': 'application/json' } },
      { BACKEND: ns, BACKEND_ORIGIN: 'https://railway.example' },
    ).res;
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('{"a":1}');
    expect(railway).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe('primary');
    expect(seen[0].req.url).toBe('https://dreamstreamstudio.ai/api/projects?x=1');
    expect(seen[0].req.headers.get('x-forwarded-for')).toBe('203.0.113.9');
    expect(seen[0].req.headers.get('x-forwarded-proto')).toBe('https');
  });

  it('falls back to the external origin only when told to (or when no container is bound)', async () => {
    const railway = vi.fn(async () => new Response('{"status":"ok"}'));
    vi.stubGlobal('fetch', railway);
    const { ns, seen } = fakeContainer(async () => new Response('container'));
    await call('/api/health', { ua: HUMAN }, { BACKEND: ns, BACKEND_TARGET: ' Origin ', BACKEND_ORIGIN: 'https://railway.example/' }).res;
    await call('/api/health', { ua: HUMAN }, { BACKEND_ORIGIN: 'https://railway.example' }).res;
    expect(seen).toHaveLength(0);
    expect(railway.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual(['https://railway.example/api/health', 'https://railway.example/api/health']);
  });

  it('answers with retryable JSON when no backend is reachable', async () => {
    const { ns } = fakeContainer(async () => {
      throw new Error('boom');
    });
    const broken = await call('/api/health', { ua: HUMAN }, { BACKEND: ns }).res;
    expect(broken.status).toBe(502);
    expect(broken.headers.get('retry-after')).toBe('5');
    const none = await call('/api/health', { ua: HUMAN }, {}).res;
    expect(none.status).toBe(503);
    expect((await none.json()).error.message).toMatch(/No backend/);
  });

  it('still keeps AI agents away from the container', async () => {
    const { ns, seen } = fakeContainer(async () => new Response('x'));
    expect((await call('/api/projects', { ua: 'GPTBot/1.2' }, { BACKEND: ns }).res).status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe('share routes: SHARE_VIEW_SALT fallback', () => {
  const SLUG = 'Ab3dEf6hIj9kLm2nP';
  const SUPA = 'https://bdjfmxfmhqhzvgrhbbzm.supabase.co';
  const SALT = 'd'.repeat(40);
  const shareEnv = (extra: Record<string, unknown>) => ({
    VITE_SUPABASE_URL: SUPA,
    VITE_SUPABASE_ANON_KEY: 'anon',
    PUBLIC_EVENT_RL: { limit: vi.fn(async () => ({ success: true })) },
    ...extra,
  });
  const d1 = (rows: { value: string }[]) => {
    const all = vi.fn(async () => ({ results: rows }));
    return { db: { prepare: vi.fn(() => ({ all })) }, all };
  };
  const view = (workerEnv: Record<string, unknown>) =>
    call(`/api/comic/public/s/${SLUG}/event`, { method: 'POST', ua: HUMAN, body: '{"type":"view"}', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' } }, workerEnv);

  it('tracks a view with the salt from the D1 backend_env row when no Worker secret is set, and only share paths read D1', async () => {
    resetShareViewSaltCache();
    const supa = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', supa);
    const { db, all } = d1([{ value: SALT }]);
    const { ns } = fakeContainer(async () => new Response('container'));
    const { res, waits } = view(shareEnv({ BACKEND_ENV: db, BACKEND: ns }));
    expect((await res).status).toBe(204);
    await Promise.all(waits);
    expect(all).toHaveBeenCalledTimes(1);
    expect(supa).toHaveBeenCalledTimes(1);
    expect(String((supa.mock.calls[0] as unknown[])[0])).toBe(`${SUPA}/rest/v1/rpc/comic_publication_track`);
    await call('/api/health', { ua: HUMAN }, shareEnv({ BACKEND_ENV: db, BACKEND: ns })).res;
    expect(all).toHaveBeenCalledTimes(1); // cached, and never consulted for non-share paths
  });

  it('a Worker secret wins over D1, and without either the view is accepted but not tracked', async () => {
    resetShareViewSaltCache();
    const supa = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', supa);
    const { db, all } = d1([{ value: 'e'.repeat(40) }]);
    const { res, waits } = view(shareEnv({ BACKEND_ENV: db, SHARE_VIEW_SALT: SALT }));
    expect((await res).status).toBe(204);
    await Promise.all(waits);
    expect(all).not.toHaveBeenCalled();
    expect(supa).toHaveBeenCalledTimes(1);
    resetShareViewSaltCache();
    const none = view(shareEnv({ BACKEND_ENV: d1([]).db }));
    expect((await none.res).status).toBe(204);
    await Promise.all(none.waits);
    expect(supa).toHaveBeenCalledTimes(1);
  });
});

describe('backend env', () => {
  it('merges D1 secrets under Worker vars/secrets and drops proxy-only settings and bindings', () => {
    const merged = buildBackendEnv(
      { BACKEND_TARGET: 'container', BACKEND_ORIGIN: 'https://x', CORS_ORIGIN: 'https://a', OPENROUTER_API_KEY: 'worker-secret', BACKEND: {}, AGENT_DB: {} },
      [
        { name: 'OPENROUTER_API_KEY', value: 'd1-value' },
        { name: 'SUPABASE_SERVICE_ROLE_KEY', value: 'svc' },
        { name: 'bad name', value: 'x' },
        { name: 'BACKEND_TARGET', value: 'origin' },
        { name: 'NUMERIC', value: 5 },
      ],
    );
    expect(merged).toEqual({ CORS_ORIGIN: 'https://a', OPENROUTER_API_KEY: 'worker-secret', SUPABASE_SERVICE_ROLE_KEY: 'svc' });
  });

  it('retries a failed D1 read once, then refuses to start half-configured', async () => {
    let calls = 0;
    const flaky: EnvDb = {
      prepare: () => ({
        all: async <T>() => {
          calls++;
          if (calls === 1) throw new Error('transient');
          return { results: [{ name: 'A_KEY', value: '1' }] as T[] };
        },
      }),
    };
    expect(await loadBackendEnv({ PORT: '8080' }, flaky)).toEqual({ A_KEY: '1', PORT: '8080' });
    const down: EnvDb = { prepare: () => ({ all: async () => { throw new Error('down'); } }) };
    await expect(loadBackendEnv({}, down)).rejects.toThrow(/unreadable/);
    expect(await loadBackendEnv({ X: 'y' }, undefined)).toEqual({ X: 'y' });
  });
});
