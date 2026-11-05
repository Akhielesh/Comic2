// @vitest-environment node
// L13: the hand-merged Pages middleware (production merge f56518c9: Stream Studio host routing +
// the Comic Studio front-door exemption + the legacy reader head) — every branch that merge touched,
// on both sides of the STREAM_HOST_ON switch.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOnRequest } from './_middleware';

const HUMAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const SLUG = 'Ab3dEf6hIj9kLm2nP';
const KEY = 'K1234567890abcdefghijk';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const SUPA = 'https://bdjfmxfmhqhzvgrhbbzm.supabase.co';
const SHELL = '<!DOCTYPE html><html><head><title>DreamStream Studio — Comics, AI Chat &amp; Code</title><!--ds:head--></head><body><div id="root"></div></body></html>';

const publicCard = {
  slug: SLUG,
  visibility: 'public',
  languages: ['en'],
  defaultLang: 'en',
  allowDownload: true,
  allowEmbed: true,
  assetKey: KEY,
  card: { v: 1, title: 'Spice Run', description: 'A courier races.', kindLabel: 'Comic', pageCount: 2, aspect: '2:3', og: { en: { path: `pub/${KEY}/og-en-0123456789ab.jpg`, alt: 'Cover' } }, i18n: {} }
};

/** The anon share-card RPC (only the legacy reader head calls it). */
const stubRpc = (answer: unknown) => {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (!url.startsWith(`${SUPA}/rest/v1/rpc/`)) throw new Error(`unexpected fetch ${url}`);
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    })
  );
  return calls;
};

/** The Pages asset server with its pretty URLs (/live.html → 308 /live). */
const assetServer = () =>
  vi.fn(async (input: Request | string | URL) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    if (u.pathname === '/live.html') return new Response(null, { status: 308, headers: { location: '/live' } });
    if (u.pathname === '/live') return new Response('<live app>', { headers: { 'content-type': 'text/html' } });
    return new Response('index', { headers: { 'content-type': 'text/html' } });
  });

const setup = (streamHostOn: boolean) => {
  const handler = createOnRequest({ streamHostOn });
  const next = vi.fn(async () => new Response(SHELL, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
  const assets = assetServer();
  const go = (url: string, init: { ua?: string; headers?: Record<string, string>; method?: string } = {}) =>
    handler({
      request: new Request(url, { method: init.method ?? 'GET', headers: { 'user-agent': init.ua ?? HUMAN, ...(init.headers || {}) } }),
      next,
      env: { ASSETS: { fetch: assets } }
    });
  return { go, next, assets };
};

const meta = (html: string, key: string) => new RegExp(`<meta (?:name|property)="${key.replace(/[:.]/g, '\\$&')}" content="([^"]*)">`).exec(html)?.[1];

afterEach(() => vi.unstubAllGlobals());

for (const streamHostOn of [false, true]) {
  describe(`Pages middleware after the production merge (STREAM_HOST_ON=${streamHostOn})`, () => {
    it('serves (never 301s) a request the comics front door proxies to comic2.pages.dev', async () => {
      const { go, next } = setup(streamHostOn);
      const paths = ['/', '/?view=studio&id=p1', '/auth/callback?code=abc', `/c/${SLUG}`, '/robots.txt', '/settings'];
      for (const forwarded of ['comics.dreamstreamstudio.ai', 'comic.dreamstreamstudio.ai', '  Comics.DreamStreamStudio.AI ']) {
        for (const path of paths) {
          const res = await go(`https://comic2.pages.dev${path}`, { headers: { 'x-forwarded-host': forwarded } });
          expect(res.status, `${forwarded} ${path}`).toBe(200);
          expect(res.headers.get('location')).toBeNull();
        }
      }
      expect(next).toHaveBeenCalledTimes(paths.length * 3);
    });

    it('still 301s the Pages alias to the apex without the header, or with any other forwarded host', async () => {
      const { go, next } = setup(streamHostOn);
      for (const forwarded of [undefined, 'evil.example', 'dreamstreamstudio.ai', 'stream.dreamstreamstudio.ai', 'comics.dreamstreamstudio.ai.evil.example']) {
        const res = await go('https://comic2.pages.dev/?view=studio&id=p1', forwarded ? { headers: { 'x-forwarded-host': forwarded } } : {});
        expect(res.status, String(forwarded)).toBe(301);
        expect(res.headers.get('location')).toBe('https://dreamstreamstudio.ai/?view=studio&id=p1');
      }
      expect(next).not.toHaveBeenCalled();
    });

    it('still gates AI agents on a comics-proxied page (the edge maps the Location back to its host)', async () => {
      const { go, next } = setup(streamHostOn);
      const res = await go(`https://comic2.pages.dev/c/${SLUG}`, { ua: 'Mozilla/5.0 (compatible; GPTBot/1.2)', headers: { 'x-forwarded-host': 'comics.dreamstreamstudio.ai' } });
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get('location') || '').pathname).toBe('/api/agent-gate');
      expect(next).not.toHaveBeenCalled();
    });

    it('the Stream Studio host still serves live.html on every page (a forwarded host changes nothing there)', async () => {
      const { go, next, assets } = setup(streamHostOn);
      for (const path of ['/', '/?e=evt_1', '/anything/deep']) {
        for (const headers of [{}, { 'x-forwarded-host': 'comics.dreamstreamstudio.ai' }]) {
          const res = await go(`https://stream.dreamstreamstudio.ai${path}`, { headers });
          expect(res.status).toBe(200);
          expect(await res.text()).toBe('<live app>');
        }
      }
      expect(next).not.toHaveBeenCalled();
      expect(assets).toHaveBeenCalled();
      // /live.html there lands on / (one address).
      const old = await go('https://stream.dreamstreamstudio.ai/live.html?e=evt_1');
      expect(old.status).toBe(301);
      expect(old.headers.get('location')).toBe('https://stream.dreamstreamstudio.ai/?e=evt_1');
    });

    it('/?view=read&id=<uuid> on the apex still gets the public comic preview head', async () => {
      const { go } = setup(streamHostOn);
      const calls = stubRpc(publicCard);
      const res = await go(`https://dreamstreamstudio.ai/?view=read&id=${PROJECT}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const html = await res.text();
      expect(html).toContain(`<link rel="canonical" href="https://comics.dreamstreamstudio.ai/c/${SLUG}">`);
      expect(meta(html, 'og:title')).toBe('Spice Run');
      expect(meta(html, 'og:image')).toBe(`https://dreamstreamstudio.ai/og/${KEY}/og-en-0123456789ab.jpg`);
      expect(calls).toEqual([`${SUPA}/rest/v1/rpc/comic_share_card_by_project`]);
      // HEAD: the same headers, no body.
      stubRpc(publicCard);
      const head = await go(`https://dreamstreamstudio.ai/?view=read&id=${PROJECT}`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
    });

    it('…and through the comics front door, with images on the comics host', async () => {
      const { go } = setup(streamHostOn);
      stubRpc(publicCard);
      const res = await go(`https://comic2.pages.dev/?view=read&id=${PROJECT}`, { headers: { 'x-forwarded-host': 'comics.dreamstreamstudio.ai' } });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(meta(html, 'og:image')).toBe(`https://comics.dreamstreamstudio.ai/og/${KEY}/og-en-0123456789ab.jpg`);
      expect(html).not.toContain('comic2.pages.dev');
    });

    it('an unlisted, unknown or malformed legacy id gets the plain app (no slug, no lookup for a bad id)', async () => {
      const { go } = setup(streamHostOn);
      stubRpc({ ...publicCard, visibility: 'unlisted' });
      const unlisted = await (await go(`https://dreamstreamstudio.ai/?view=read&id=${PROJECT}`)).text();
      expect(unlisted).toBe(SHELL);
      stubRpc(null);
      expect(await (await go(`https://dreamstreamstudio.ai/?view=read&id=${PROJECT}`)).text()).toBe(SHELL);
      const calls = stubRpc(publicCard);
      expect(await (await go('https://dreamstreamstudio.ai/?view=read&id=not-a-uuid')).text()).toBe(SHELL);
      expect(calls).toHaveLength(0);
    });
  });
}
