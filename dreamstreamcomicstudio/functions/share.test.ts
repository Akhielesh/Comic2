// @vitest-environment node
// Edge HTML for shared comics (sharing.md §11 #1–11): previews, escaping, CSP, no-oracle 404s.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequest as middleware } from './_middleware';
import { handleShare, parseSharePath, type ShareEnv } from './c/[[path]]';
import { handleOg } from './og/[[path]]';
import { buildCsp, inlineHashes } from './_shared/csp';
import { escAttr, injectHead, jsonForScript, renderShareHead, validateShareCardRpc } from './_shared/shareHead';

const SLUG = 'Ab3dEf6hIj9kLm2nP';
const KEY = 'K1234567890abcdefghijk';
const SHELL = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="description" content="Make comics with an AI director." />
    <meta name="theme-color" content="#FAF9F5" media="(prefers-color-scheme: light)" />
    <title>DreamStream Studio — Comics, AI Chat &amp; Code</title>
    <script defer src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
  <script type="importmap">
{
  "imports": { "react": "https://aistudiocdn.com/react@^19.2.0" }
}
</script>
    <script type="module" crossorigin src="/assets/main-abc.js"></script>
<!--ds:head-->
</head>
  <body>
    <div id="root"><div id="app-splash"><button type="button" onclick="window.location.reload()">Reload</button></div></div>
    <script>
      setTimeout(function () { var s = document.querySelector('#app-splash .slow'); if (s) s.style.display = 'block'; }, 12000);
    </script>
  </body>
</html>`;

const card = (over: Record<string, unknown> = {}, cardOver: Record<string, unknown> = {}) => ({
  slug: SLUG,
  visibility: 'unlisted',
  languages: ['en', 'hi'],
  defaultLang: 'en',
  startPage: null,
  allowDownload: true,
  allowEmbed: true,
  assetKey: KEY,
  publishedAt: 1,
  updatedAt: 2,
  card: {
    v: 1,
    title: 'Playtime at the Lake',
    description: 'A baby plays by a lake with three ducklings.',
    kindLabel: 'Storybook',
    pageCount: 4,
    aspect: '4:5',
    coverUrl: `https://bdjfmxfmhqhzvgrhbbzm.supabase.co/storage/v1/object/public/comic-assets/pub/${KEY}/cover-0123456789ab-w1080.webp`,
    og: { en: { path: `pub/${KEY}/og-en-0123456789ab.jpg`, w: 1200, h: 630, alt: 'Cover of Playtime' }, hi: { path: `pub/${KEY}/og-hi-ba9876543210.jpg`, w: 1200, h: 630, alt: 'आवरण' } },
    i18n: { en: { title: 'Playtime at the Lake', description: 'A baby plays.' }, hi: { title: 'झील के किनारे', description: 'एक बच्चा खेलता है।' } },
    themeColor: '#336699',
    ...cardOver
  },
  ...over
});

const env = (rpcAnswer: unknown | ((name: string, body: unknown) => Response | Promise<Response>)): ShareEnv & { calls: string[] } => {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (!url.startsWith('https://bdjfmxfmhqhzvgrhbbzm.supabase.co/rest/v1/rpc/')) throw new Error(`unexpected fetch ${url}`);
      const name = url.split('/rpc/')[1];
      if (typeof rpcAnswer === 'function') return (rpcAnswer as (n: string, b: unknown) => Response)(name, JSON.parse(String(init?.body || '{}')));
      return new Response(JSON.stringify(rpcAnswer), { status: 200, headers: { 'content-type': 'application/json' } });
    })
  );
  return {
    calls,
    ASSETS: { fetch: async () => new Response(SHELL, { headers: { 'content-type': 'text/html' } }) }
  };
};

const get = (path: string, ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', method = 'GET') =>
  new Request(`https://dreamstreamstudio.ai${path}`, { method, headers: { 'user-agent': ua } });

const meta = (html: string, key: string) => new RegExp(`<meta (?:name|property)="${key.replace(/[:.]/g, '\\$&')}" content="([^"]*)">`).exec(html)?.[1];

afterEach(() => vi.unstubAllGlobals());

describe('/c/<slug> share HTML', () => {
  const PREVIEW_UAS = [
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Twitterbot/1.0',
    'WhatsApp/2.23.20.0',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'TelegramBot (like TwitterBot)',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0',
    'Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5',
    'Mastodon/4.2.0 (http.rb/5.1.1; +https://mastodon.social/)',
    'Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)'
  ];

  it('#1 every preview bot passes the gate and gets OG/Twitter tags with the same-origin 1200×630 image', async () => {
    for (const ua of PREVIEW_UAS) {
      const e = env(card());
      const gated = await middleware({ request: get(`/c/${SLUG}`, ua), next: async () => new Response('next') });
      expect(await gated.text(), ua).toBe('next');
      const res = await handleShare(get(`/c/${SLUG}`, ua), e);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(meta(html, 'og:title')).toBe('Playtime at the Lake');
      expect(meta(html, 'og:image')).toBe(`https://dreamstreamstudio.ai/og/${KEY}/og-en-0123456789ab.jpg`);
      expect(meta(html, 'og:image:width')).toBe('1200');
      expect(meta(html, 'twitter:card')).toBe('summary_large_image');
      expect(meta(html, 'og:url')).toBe(`https://comics.dreamstreamstudio.ai/c/${SLUG}`);
    }
  });

  it('#2 people get the SAME document: SPA root, module script and a valid boot card', async () => {
    const res = await handleShare(get(`/c/${SLUG}`), env(card()));
    const html = await res.text();
    expect(html).toContain('<div id="root">');
    expect(html).toContain('<script type="module" crossorigin src="/assets/main-abc.js">');
    const boot = JSON.parse(/<script type="application\/json" id="ds-share-boot">([^<]*)<\/script>/.exec(html)![1]);
    expect(boot).toMatchObject({ slug: SLUG, lang: 'en', card: { title: 'Playtime at the Lake', aspect: '4:5', pageCount: 4 } });
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).not.toContain('Make comics with an AI director'); // static description replaced
  });

  it('#3 unlisted → noindex meta + header, no JSON-LD, no hreflang; public → JSON-LD ComicStory, indexable', async () => {
    const res = await handleShare(get(`/c/${SLUG}`), env(card()));
    const html = await res.text();
    expect(meta(html, 'robots')).toBe('noindex, nofollow');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(html).not.toContain('application/ld+json');
    expect(html).not.toContain('hreflang');
    const pub = await handleShare(get(`/c/${SLUG}`), env(card({ visibility: 'public' })));
    const pubHtml = await pub.text();
    expect(pubHtml).toContain('"@type":"ComicStory"');
    expect(pubHtml).toContain('hreflang="hi"');
    expect(meta(pubHtml, 'robots')).toBeUndefined();
    expect(pub.headers.get('x-robots-tag')).toBe('noai, noimageai');
    expect(pub.headers.get('content-signal')).toContain('ai-train=no');
  });

  it('#4 unknown / revoked / unpublished / suspended / malformed → byte-identical 404s; malformed never calls the RPC', async () => {
    const bodies: string[] = [];
    const headers: string[] = [];
    for (const path of [`/c/${SLUG}`, `/c/${SLUG}/embed`, '/c/short', '/c/Ab3dEf6hIj9kLm2nP/<script>', '/c/Ab3dEf6hIj9kLm2nP/x/y']) {
      const e = env(null);
      const res = await handleShare(get(path), e);
      expect(res.status).toBe(404);
      bodies.push(await res.text());
      headers.push(JSON.stringify([...res.headers.entries()].sort()));
      if (!path.startsWith(`/c/${SLUG}`) || path.includes('<') || path.endsWith('/y')) expect(e.calls).toHaveLength(0);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(new Set(headers).size).toBe(1);
    expect(bodies[0]).toContain('noindex');
    expect(bodies[0]).not.toContain('Playtime');
  });

  it('#5 a malicious title/description never escapes its context (HTML, attributes, JSON boot, JSON-LD)', async () => {
    const evil = '"><script>alert(1)</script></script><!--';
    const res = await handleShare(get(`/c/${SLUG}`), env(card({ visibility: 'public' }, { title: evil, description: `line\u2028sep ${evil}`, i18n: {}, creator: evil })));
    const html = await res.text();
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('"><script');
    expect(meta(html, 'og:title')).toBe('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;/script&gt;&lt;!--');
    const boot = /<script type="application\/json" id="ds-share-boot">([^<]*)<\/script>/.exec(html)![1];
    expect(boot).toContain('\\u003c/script\\u003e');
    expect(boot).not.toContain('\u2028');
    expect(JSON.parse(boot).card.title).toBe(evil);
    const ld = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html)![1];
    expect(JSON.parse(ld).name).toBe(evil);
    // `$&`-style patterns in a title can't splice the page into itself.
    const dollar = await (await handleShare(get(`/c/${SLUG}`), env(card({}, { title: "$` $& $'" , i18n: {} })))).text();
    expect(meta(dollar, 'og:title')).toBe('$` $&amp; $&#39;');
  });

  it('#6 ?lang=hi serves the Hindi card and image; an unpublished language falls back to the default', async () => {
    const hi = await (await handleShare(get(`/c/${SLUG}?lang=hi`), env(card()))).text();
    expect(meta(hi, 'og:title')).toBe('झील के किनारे');
    expect(meta(hi, 'og:locale')).toBe('hi_IN');
    expect(meta(hi, 'og:image')).toContain('/og-hi-');
    expect(hi).toContain(`<link rel="canonical" href="https://comics.dreamstreamstudio.ai/c/${SLUG}?lang=hi">`);
    const xx = await (await handleShare(get(`/c/${SLUG}?lang=xx`), env(card()))).text();
    expect(meta(xx, 'og:title')).toBe('Playtime at the Lake');
    expect(meta(xx, 'og:locale')).toBe('en_US');
  });

  it('#7 AI agents are sent to the gate before the share function runs', async () => {
    const next = vi.fn(async () => new Response('share'));
    const res = await middleware({ request: get(`/c/${SLUG}`, 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)'), next });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/api/agent-gate');
    expect(next).not.toHaveBeenCalled();
    const headless = await middleware({ request: get(`/c/${SLUG}`, 'Mozilla/5.0 HeadlessChrome/120.0'), next });
    expect(headless.status).toBe(302);
  });

  it('#8 embed: 404 when the author turned it off; frame-ancestors * without XFO when on; main route self-only', async () => {
    expect((await handleShare(get(`/c/${SLUG}/embed`), env(card({ allowEmbed: false })))).status).toBe(404);
    const embed = await handleShare(get(`/c/${SLUG}/embed`), env(card()));
    expect(embed.status).toBe(200);
    expect(embed.headers.get('content-security-policy')).toContain('frame-ancestors *');
    expect(embed.headers.get('x-frame-options')).toBeNull();
    expect(embed.headers.get('x-robots-tag')).toContain('noindex');
    const main = await handleShare(get(`/c/${SLUG}/playtime-at-the-lake`), env(card()));
    expect(main.status).toBe(200);
    expect(main.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    expect(main.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('#9 a slow/down database serves the plain SPA (200, generic head, no-store)', async () => {
    const res = await handleShare(get(`/c/${SLUG}`), env(() => new Response('oops', { status: 503 })));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('DreamStream Studio — Comics, AI Chat &amp; Code');
    expect(html).not.toContain('og:title');
    // A misconfigured database (wrong key, migration not applied) is "unavailable", never a dead link.
    for (const status of [401, 404]) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const r = await handleShare(get(`/c/${SLUG}`), env(() => new Response('{"code":"PGRST202"}', { status })));
      expect(r.status).toBe(200);
      expect(await r.text()).not.toContain('"notFound":true');
      warn.mockRestore();
    }
  });

  it('previews proxied by the comics front door point at the comics host, never the Pages origin; other forwarded hosts are ignored', async () => {
    const via = (host: string) => new Request(`https://comic2.pages.dev/c/${SLUG}`, { headers: { 'user-agent': 'Twitterbot/1.0', 'x-forwarded-host': host } });
    const html = await (await handleShare(via('comics.dreamstreamstudio.ai'), env(card()))).text();
    expect(meta(html, 'og:image')).toBe(`https://comics.dreamstreamstudio.ai/og/${KEY}/og-en-0123456789ab.jpg`);
    expect(meta(html, 'og:url')).toBe(`https://comics.dreamstreamstudio.ai/c/${SLUG}`);
    const forged = await (await handleShare(via('evil.example'), env(card()))).text();
    expect(meta(forged, 'og:image')).toBe(`https://comic2.pages.dev/og/${KEY}/og-en-0123456789ab.jpg`);
    expect(forged).not.toContain('evil.example');
  });

  it('strict, hashed CSP: every inline script and handler hashed, no unsafe-inline/eval in script-src, reports at the edge', async () => {
    const res = await handleShare(get(`/c/${SLUG}`), env(card()));
    const csp = res.headers.get('content-security-policy')!;
    const html = await res.text();
    const script = /script-src ([^;]+)/.exec(csp)![1];
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    const sha = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
    const importmap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)![1];
    const watchdog = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    expect(script).toContain(sha(importmap));
    expect(script).toContain(sha(watchdog));
    expect(script).toContain("'unsafe-hashes'");
    expect(script).toContain(sha('window.location.reload()'));
    // JSON data blocks are never hashed (never executed).
    const boot = /<script type="application\/json" id="ds-share-boot">([^<]*)<\/script>/.exec(html)![1];
    expect(script).not.toContain(sha(boot));
    for (const directive of ["object-src 'none'", "base-uri 'none'", 'report-uri /api/csp-report', "default-src 'self'", 'upgrade-insecure-requests']) expect(csp).toContain(directive);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await inlineHashes(html)).toEqual(await inlineHashes(html)); // cached per deploy
    expect(buildCsp({ hashes: { scripts: [], handlers: [] }, supabaseOrigin: 'https://x.supabase.co', embed: false })).not.toContain('unsafe-hashes');
  });

  it('only GET/HEAD; HEAD has headers and no body', async () => {
    expect((await handleShare(get(`/c/${SLUG}`, undefined, 'POST'), env(card()))).status).toBe(405);
    const head = await handleShare(get(`/c/${SLUG}`, undefined, 'HEAD'), env(card()));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('#10 legacy /?view=read&id=<uuid>: a PUBLIC publication gets the /c/ head; otherwise no slug anywhere', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const next = async () => new Response(SHELL, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    vi.unstubAllGlobals();
    env(card({ visibility: 'public' }));
    const pub = await (await middleware({ request: get(`/?view=read&id=${id}`), next })).text();
    expect(pub).toContain(`<link rel="canonical" href="https://comics.dreamstreamstudio.ai/c/${SLUG}">`);
    vi.unstubAllGlobals();
    env(card({ visibility: 'unlisted' }));
    const unlisted = await (await middleware({ request: get(`/?view=read&id=${id}`), next })).text();
    expect(unlisted).not.toContain(SLUG);
    vi.unstubAllGlobals();
    const e = env(card());
    const bad = await (await middleware({ request: get('/?view=read&id=not-a-uuid'), next })).text();
    expect(bad).not.toContain(SLUG);
    expect(e.calls).toHaveLength(0);
  });

  it('www / Pages alias still redirect, except requests the comics front door proxies', async () => {
    const www = await middleware({ request: new Request(`https://www.dreamstreamstudio.ai/c/${SLUG}`), next: async () => new Response('x') });
    expect(www.status).toBe(301);
    const proxied = await middleware({ request: new Request(`https://comic2.pages.dev/c/${SLUG}`, { headers: { 'x-forwarded-host': 'comics.dreamstreamstudio.ai' } }), next: async () => new Response('served') });
    expect(await proxied.text()).toBe('served');
  });
});

describe('/og/<key>/<file>.jpg', () => {
  it('#11 streams a validated path from the fixed Supabase host; anything else 404s with no fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { 'content-length': '3' } }));
    const ok = await handleOg(get(`/og/${KEY}/og-en-0123456789ab.jpg`), {}, fetchImpl as unknown as typeof fetch);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/jpeg');
    expect(ok.headers.get('cache-control')).toContain('max-age=86400');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe(`https://bdjfmxfmhqhzvgrhbbzm.supabase.co/storage/v1/object/public/comic-assets/pub/${KEY}/og-en-0123456789ab.jpg`);
    fetchImpl.mockClear();
    for (const bad of ['/og/../x', `/og/${KEY}/a.png`, `/og/${KEY}/og-en-0123456789ab.jpg/..`, '/og/short/og-en-0123456789ab.jpg', `/og/${KEY}/og-EN-0123456789ab.jpg`]) {
      expect((await handleOg(get(bad), {}, fetchImpl as unknown as typeof fetch)).status).toBe(404);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    // An env pointing at another host is ignored (fixed *.supabase.co only).
    await handleOg(get(`/og/${KEY}/og-en-0123456789ab.jpg`), { VITE_SUPABASE_URL: 'https://evil.example.com' }, fetchImpl as unknown as typeof fetch);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain('https://bdjfmxfmhqhzvgrhbbzm.supabase.co/');
    const missing = vi.fn(async () => new Response('no', { status: 400 }));
    expect((await handleOg(get(`/og/${KEY}/og-en-0123456789ab.jpg`), {}, missing as unknown as typeof fetch)).status).toBe(404);
  });
});

describe('shareHead units', () => {
  it('escapes, validates and injects safely', () => {
    expect(escAttr(`a"<b>&'\u202E`)).toBe('a&quot;&lt;b&gt;&amp;&#39;');
    expect(jsonForScript({ t: '</script><!--\u2028' })).toBe('{"t":"\\u003c/script\\u003e\\u003c!--\\u2028"}');
    expect(validateShareCardRpc({ ...card(), slug: 'bad' })).toBeNull();
    expect(validateShareCardRpc({ ...card(), assetKey: '../../x' })).toBeNull();
    // An OG path under ANOTHER publication's key is dropped (never served for this card).
    const foreign = validateShareCardRpc(card({}, { og: { en: { path: `pub/${'Z'.repeat(22)}/og-en-0123456789ab.jpg`, alt: 'x' } } }))!;
    expect(foreign.card.og).toEqual({});
    // The cover URL must be this publication's own pub/<key>/ copy on Supabase storage.
    expect(validateShareCardRpc(card())!.card.coverUrl).toContain(`/pub/${KEY}/`);
    for (const coverUrl of ['https://evil.example/pub/x.webp', `https://bdjfmxfmhqhzvgrhbbzm.supabase.co/storage/v1/object/public/comic-assets/u/user/p/proj/img/a.webp`, `https://bdjfmxfmhqhzvgrhbbzm.supabase.co/storage/v1/object/public/comic-assets/pub/${'Z'.repeat(22)}/a.webp`]) {
      expect(validateShareCardRpc(card({}, { coverUrl }))!.card.coverUrl).toBeUndefined();
    }
    const injected = injectHead('<head><title>x</title><!--ds:head--></head>', renderShareHead(validateShareCardRpc(card())!, { origin: 'https://dreamstreamstudio.ai' }));
    expect(injected.match(/<title>/g)).toHaveLength(1);
    expect(parseSharePath(`/c/${SLUG}/`)).toEqual({ slug: SLUG, embed: false });
    expect(parseSharePath(`/c/${SLUG}/embed`)).toEqual({ slug: SLUG, embed: true });
    expect(parseSharePath(`/c/${SLUG}/Title-Caps`)).toBeNull();
  });
});
