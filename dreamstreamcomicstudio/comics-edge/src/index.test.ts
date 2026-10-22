// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { COMICS_ALIAS_HOSTS, COMICS_HOST, MAIN_ORIGIN } from '../../services/productHost';
import { BRAND } from './brand';
import { createEdge, type Env } from './index';
import { ALIAS_HOSTS, DEFAULT_CONFIG, HSTS_VALUE, resolveConfig, rewriteLocation } from './policy';
import { FakeHtmlRewriter } from './testing/fakeHtmlRewriter';

const PUBLIC = 'https://comics.dreamstreamstudio.ai';
const PAGES = 'https://comic2.pages.dev';

const INDEX_HTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8" />
<meta name="description" content="Suite description" />
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#111111" media="(prefers-color-scheme: dark)" />
<link rel="manifest" href="/app.webmanifest" />
<link rel="apple-touch-icon" href="/icons/apple-touch-180.png" />
<meta property="og:title" content="Old suite title" />
<title>DreamStream Studio — Comics, AI Chat &amp; Code</title>
</head><body><div id="root"></div></body></html>`;

type PagesCall = { url: string; init: RequestInit };

function setup(pagesResponse: (url: string) => Response | Promise<Response> = () => html(INDEX_HTML), envOverrides: Partial<Env> = {}) {
  const pagesCalls: PagesCall[] = [];
  const apiCalls: Request[] = [];
  const pagesFetch = vi.fn(async (url: string, init: RequestInit) => {
    pagesCalls.push({ url, init });
    return pagesResponse(url);
  });
  const api = {
    fetch: vi.fn(async (req: Request) => {
      apiCalls.push(req);
      return new Response(JSON.stringify({ status: 'ok', echo: await req.clone().text() }), {
        status: 201,
        headers: { 'content-type': 'application/json', 'x-api': 'yes' }
      });
    })
  };
  const env: Env = {
    API: api,
    PUBLIC_HOST: 'comics.dreamstreamstudio.ai',
    PAGES_ORIGIN: PAGES,
    MAIN_ORIGIN: 'https://dreamstreamstudio.ai',
    ...envOverrides
  };
  const edge = createEdge({ fetch: pagesFetch, HTMLRewriter: FakeHtmlRewriter });
  const call = (url: string, init?: RequestInit) => edge.fetch(new Request(url, init), env);
  return { call, pagesCalls, apiCalls, pagesFetch, api, env };
}

function html(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/html; charset=utf-8', etag: '"abc"', ...(init.headers || {}) }
  });
}

function expectSecurityHeaders(res: Response) {
  expect(res.headers.get('strict-transport-security')).toBe(HSTS_VALUE);
  expect(res.headers.get('strict-transport-security')).not.toMatch(/includesubdomains/i);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  expect(res.headers.get('permissions-policy')).toMatch(/camera=\(\)/);
}

describe('health', () => {
  it('answers on the public host, the workers.dev host and over http, without touching Pages or the API', async () => {
    const { call, pagesFetch, api } = setup();
    for (const url of [`${PUBLIC}/__edge/health`, 'https://dreamstream-comics.example.workers.dev/__edge/health', 'http://comic.dreamstreamstudio.ai/__edge/health']) {
      const res = await call(url);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      expect(body).toMatchObject({ status: 'ok', service: 'dreamstream-comics', host: 'comics.dreamstreamstudio.ai', api: true });
      expectSecurityHeaders(res);
    }
    expect(pagesFetch).not.toHaveBeenCalled();
    expect(api.fetch).not.toHaveBeenCalled();
  });
});

describe('redirects', () => {
  it('sends http to https with a 301, keeping path and query', async () => {
    const { call } = setup();
    const res = await call('http://comics.dreamstreamstudio.ai/?view=studio&id=p1');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`${PUBLIC}/?view=studio&id=p1`);
    expectSecurityHeaders(res);
    const alias = await call('http://comic.dreamstreamstudio.ai/c/abc?lang=te');
    expect(alias.headers.get('location')).toBe(`${PUBLIC}/c/abc?lang=te`);
  });

  it('sends the comic. alias to comics. with a 301 (same path + query)', async () => {
    const { call, pagesFetch } = setup();
    const res = await call('https://comic.dreamstreamstudio.ai/c/Ab3dEf6hIj9kLm2nP/embed?page=3');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`${PUBLIC}/c/Ab3dEf6hIj9kLm2nP/embed?page=3`);
    expect(pagesFetch).not.toHaveBeenCalled();
  });

  it('sends any other host (workers.dev) to the public host with a 302, API paths included', async () => {
    const { call, api } = setup();
    const res = await call('https://dreamstream-comics.example.workers.dev/api/health');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${PUBLIC}/api/health`);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('sends other DreamStream products to the main site', async () => {
    const { call, pagesFetch } = setup();
    for (const path of ['/live.html?room=1', '/live', '/models', '/share/tok_1', '/studio.html']) {
      const res = await call(`${PUBLIC}${path}`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`https://dreamstreamstudio.ai${path}`);
    }
    expect(pagesFetch).not.toHaveBeenCalled();
  });
});

describe('/api passthrough', () => {
  it('hands the original request to the API binding unchanged (method, body, headers)', async () => {
    const { call, apiCalls, pagesFetch } = setup();
    const res = await call(`${PUBLIC}/api/comic/projects/p1?x=1`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer user-jwt', 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9', cookie: 'a=b' },
      body: JSON.stringify({ title: 'Spice Run' })
    });
    expect(apiCalls).toHaveLength(1);
    const forwarded = apiCalls[0];
    expect(forwarded.method).toBe('PATCH');
    expect(forwarded.url).toBe(`${PUBLIC}/api/comic/projects/p1?x=1`);
    expect(forwarded.headers.get('authorization')).toBe('Bearer user-jwt');
    expect(forwarded.headers.get('cf-connecting-ip')).toBe('203.0.113.9');
    expect(forwarded.headers.get('cookie')).toBe('a=b');
    expect(res.status).toBe(201);
    expect(res.headers.get('x-api')).toBe('yes');
    expect((await res.json()).echo).toBe('{"title":"Spice Run"}');
    expectSecurityHeaders(res);
    expect(pagesFetch).not.toHaveBeenCalled();
  });

  it('answers an honest 502 when the API binding is missing or throws', async () => {
    const missing = setup(undefined, { API: undefined });
    const res = await missing.call(`${PUBLIC}/api/health`);
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toMatch(/unreachable/i);
    const throwing = setup(undefined, { API: { fetch: async () => { throw new Error('boom'); } } });
    expect((await throwing.call(`${PUBLIC}/api`)).status).toBe(502);
  });
});

describe('Pages proxy', () => {
  it('fetches the same path + query from the Pages origin with safe forwarding headers', async () => {
    const { call, pagesCalls } = setup();
    await call(`${PUBLIC}/?view=studio&id=p1`, {
      headers: {
        'user-agent': 'Mozilla/5.0 Test',
        'accept-language': 'te',
        cookie: 'session=secret',
        authorization: 'Bearer x',
        'cf-connecting-ip': '198.51.100.7',
        'cf-container-target-port': '8080',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-for': '1.2.3.4'
      }
    });
    expect(pagesCalls).toHaveLength(1);
    const { url, init } = pagesCalls[0];
    expect(url).toBe(`${PAGES}/?view=studio&id=p1`);
    expect(init.redirect).toBe('manual');
    const headers = new Headers(init.headers);
    expect(headers.get('x-forwarded-host')).toBe('comics.dreamstreamstudio.ai');
    expect(headers.get('x-forwarded-proto')).toBe('https');
    expect(headers.get('x-forwarded-for')).toBe('198.51.100.7');
    expect(headers.get('user-agent')).toBe('Mozilla/5.0 Test');
    expect(headers.get('accept-language')).toBe('te');
    for (const dropped of ['cookie', 'authorization', 'cf-connecting-ip', 'cf-container-target-port', 'host']) expect(headers.has(dropped)).toBe(false);
  });

  it('brands the SPA HTML as Comic Studio on /', async () => {
    const { call } = setup();
    const res = await call(`${PUBLIC}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<title>Comic Studio — DreamStream</title>');
    expect(body).not.toContain('Comics, AI Chat');
    expect(body).toContain(`<meta name="description" content="${BRAND.description}">`);
    expect(body).toContain('<link rel="manifest" href="/comics.webmanifest">');
    expect(body).toContain('<link rel="apple-touch-icon" href="/icons/comics-apple-touch-180.png">');
    expect(body).toContain('<meta name="theme-color" content="#FAF9F5" media="(prefers-color-scheme: light)">');
    expect(body).toContain('<meta name="theme-color" content="#262624" media="(prefers-color-scheme: dark)">');
    expect(body).toContain('<meta name="ds-product" content="comics">');
    expect(body).toContain('<meta property="og:site_name" content="DreamStream Comic Studio">');
    expect(body).toContain(`<meta property="og:url" content="${PUBLIC}/">`);
    expect(body).toContain(`<meta property="og:image" content="${PUBLIC}/icons/comics-og.png">`);
    expect(body).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(body).not.toContain('Old suite title');
    expect(body.match(/property="og:title"/g)).toHaveLength(1);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.has('etag')).toBe(false);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expectSecurityHeaders(res);
  });

  it('brands SPA deep links too, but never reflects the request path or query into the HTML', async () => {
    const { call } = setup();
    const body = await (await call(`${PUBLIC}/auth/callback?x="><script>alert(1)</script>`)).text();
    expect(body).toContain('<title>Comic Studio — DreamStream</title>');
    expect(body).not.toContain('alert(1)');
  });

  it('leaves share pages (/c/*) to their Pages Function: no rebrand, no reframing, own caching', async () => {
    const shareHtml = '<!DOCTYPE html><html><head><title>Spice Run — a comic</title><meta property="og:title" content="Spice Run"></head><body></body></html>';
    const { call } = setup(() =>
      html(shareHtml, { headers: { 'content-type': 'text/html', 'x-frame-options': 'SAMEORIGIN', 'cache-control': 'public, max-age=60', 'content-security-policy': "default-src 'self'" } })
    );
    const res = await call(`${PUBLIC}/c/Ab3dEf6hIj9kLm2nP`);
    const body = await res.text();
    expect(body).toBe(shareHtml);
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expectSecurityHeaders(res);
  });

  it('lets embeds be framed', async () => {
    const { call } = setup(() => html('<html><head></head><body></body></html>', { headers: { 'content-type': 'text/html', 'x-frame-options': 'DENY' } }));
    for (const path of ['/embed/Ab3dEf6hIj9kLm2nP', '/c/Ab3dEf6hIj9kLm2nP/embed']) {
      const res = await call(`${PUBLIC}${path}`);
      if (path.startsWith('/embed')) expect(res.headers.has('x-frame-options')).toBe(false);
      expect(res.headers.get('content-security-policy') || '').not.toContain("frame-ancestors 'none'");
    }
  });

  it('does not overwrite the preview head of a legacy reader link', async () => {
    const readerHtml = '<html><head><title>Spice Run</title><meta property="og:title" content="Spice Run"></head><body></body></html>';
    const { call } = setup(() => html(readerHtml));
    const body = await (await call(`${PUBLIC}/?view=read&id=11111111-2222-3333-4444-555555555555`)).text();
    expect(body).toBe(readerHtml);
  });

  it('adds frame-ancestors to an existing CSP instead of replacing it', async () => {
    const { call } = setup(() => html('<html><head></head></html>', { headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'self';" } }));
    const res = await call(`${PUBLIC}/`);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'; frame-ancestors 'none'");
  });

  it('caches hashed assets for a year and turns an SPA fallback for a missing chunk into a 404', async () => {
    const { call } = setup((url) =>
      url.endsWith('/assets/app-1a2b.js')
        ? new Response('console.log(1)', { status: 200, headers: { 'content-type': 'application/javascript' } })
        : html(INDEX_HTML)
    );
    const asset = await call(`${PUBLIC}/assets/app-1a2b.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await asset.text()).toBe('console.log(1)');
    expectSecurityHeaders(asset);
    const missing = await call(`${PUBLIC}/assets/gone-9z.js`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
  });

  it('maps Location headers from the Pages origin and the apex back to the public host', async () => {
    const { call } = setup(() => new Response(null, { status: 302, headers: { location: `${PAGES}/api/agent-gate?from=%2F` } }));
    const res = await call(`${PUBLIC}/`, { headers: { 'user-agent': 'GPTBot/1.0' } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${PUBLIC}/api/agent-gate?from=%2F`);
    expectSecurityHeaders(res);
  });

  it('answers a calm 502 page when the Pages origin is unreachable', async () => {
    const { call } = setup(() => {
      throw new Error('network down');
    });
    const res = await call(`${PUBLIC}/`);
    expect(res.status).toBe(502);
    expect(res.headers.get('retry-after')).toBe('10');
    const body = await res.text();
    expect(body).toContain('Comic Studio can’t load right now');
    expect(body).toContain('Your comics are safe');
    expectSecurityHeaders(res);
  });

  it('passes HEAD through without a body and without branding errors', async () => {
    const { call } = setup(() => new Response(null, { status: 200, headers: { 'content-type': 'text/html' } }));
    const res = await call(`${PUBLIC}/`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });
});

describe('rewriteLocation', () => {
  const cfg = DEFAULT_CONFIG;
  it.each([
    [`${PAGES}/?view=dashboard`, `${PUBLIC}/?view=dashboard`],
    ['//comic2.pages.dev/x#frag', `${PUBLIC}/x#frag`],
    ['https://dreamstreamstudio.ai/auth/callback?code=1', `${PUBLIC}/auth/callback?code=1`],
    ['https://www.dreamstreamstudio.ai/', `${PUBLIC}/`],
    ['https://dreamstreamstudio.ai/live.html', 'https://dreamstreamstudio.ai/live.html'],
    ['/relative/path', '/relative/path'],
    ['https://accounts.google.com/o/oauth2', 'https://accounts.google.com/o/oauth2'],
    ['https://preview.comic2.pages.dev/x', 'https://preview.comic2.pages.dev/x'],
    ['javascript:alert(1)', 'javascript:alert(1)']
  ])('%s → %s', (input, expected) => {
    expect(rewriteLocation(input, cfg)).toBe(expected);
  });
});

describe('configuration', () => {
  it('falls back to production values for missing or unsafe vars', () => {
    expect(resolveConfig({})).toEqual(DEFAULT_CONFIG);
    expect(resolveConfig({ PAGES_ORIGIN: 'http://comic2.pages.dev', PUBLIC_HOST: 'bad host!', MAIN_ORIGIN: 'https://u:p@x.example' })).toEqual(DEFAULT_CONFIG);
    expect(resolveConfig({ PUBLIC_HOST: 'Comics.DreamStreamStudio.ai.' }).publicHost).toBe('comics.dreamstreamstudio.ai');
  });

  it('agrees with the client host helpers (no drift between edge and app)', () => {
    expect(DEFAULT_CONFIG.publicHost).toBe(COMICS_HOST);
    expect(DEFAULT_CONFIG.mainOrigin).toBe(MAIN_ORIGIN);
    expect([...ALIAS_HOSTS]).toEqual([...COMICS_ALIAS_HOSTS]);
  });

  it('wrangler.jsonc declares the routes, the API binding and vars, and holds no secrets', () => {
    const raw = readFileSync(fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), 'utf8');
    const config = JSON.parse(stripJsonComments(raw));
    expect(config.name).toBe('dreamstream-comics');
    expect(config.main).toBe('src/index.ts');
    expect(config.workers_dev).toBe(true);
    expect(config.routes).toEqual([
      { pattern: 'comics.dreamstreamstudio.ai/*', zone_name: 'dreamstreamstudio.ai' },
      { pattern: 'comic.dreamstreamstudio.ai/*', zone_name: 'dreamstreamstudio.ai' }
    ]);
    expect(config.services).toEqual([{ binding: 'API', service: 'dreamstream-api' }]);
    expect(config.vars).toEqual({ PUBLIC_HOST: 'comics.dreamstreamstudio.ai', PAGES_ORIGIN: PAGES, MAIN_ORIGIN: 'https://dreamstreamstudio.ai' });
    for (const [key, value] of Object.entries(config.vars as Record<string, string>)) {
      expect(key).not.toMatch(/secret|token|key|password/i);
      expect(value).not.toMatch(/^eyJ|[A-Za-z0-9_-]{32,}/);
    }
  });
});

/** Removes // and /* *\/ comments outside strings (enough for wrangler.jsonc). */
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += ch;
  }
  return out;
}
