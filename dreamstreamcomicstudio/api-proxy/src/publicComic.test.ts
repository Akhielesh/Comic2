// @vitest-environment node
// Edge read path for shared comics (sharing.md §11 #12–17) + the edge CSP report route.
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './proxy';
import { maskedPath, summarize } from './cspReport';
import { oembedFor, slugFromShareUrl, trackProof, viewerHash } from './publicComic';
import { validateShareCardRpc } from '../../functions/_shared/shareHead';

const SLUG = 'Ab3dEf6hIj9kLm2nP';
const KEY = 'K1234567890abcdefghijk';
const SUPA = 'https://bdjfmxfmhqhzvgrhbbzm.supabase.co';
const HUMAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const SALT = 's'.repeat(40);

const publication = (over: Record<string, unknown> = {}) => ({
  slug: SLUG,
  visibility: 'unlisted',
  languages: ['en'],
  defaultLang: 'en',
  startPage: null,
  allowDownload: true,
  allowEmbed: true,
  assetKey: KEY,
  publishedAt: 10,
  updatedAt: 11,
  card: { v: 1, title: 'Spice Run', description: 'A courier races.', kindLabel: 'Comic', pageCount: 2, aspect: '2:3', og: { en: { path: `pub/${KEY}/og-en-0123456789ab.jpg`, alt: 'Cover' } }, i18n: {} },
  ...over
});
const asset = (name: string) => ({
  path: `pub/${KEY}/${name}-0123456789ab.webp`,
  source: 'generated',
  at: 0,
  w: 1024,
  h: 1536,
  variants: [{ path: `pub/${KEY}/${name}-0123456789ab-w480.webp`, w: 480, h: 720 }]
});
const snapshot = (pagePath?: string) => ({
  id: 'pub-1',
  cover: { render: { status: 'ready', asset: asset('cover'), history: [] } },
  pages: [
    { id: 'pg_1', n: 1, render: { status: 'ready', asset: pagePath ? { ...asset('page'), path: pagePath } : asset('page'), history: [] } },
    { id: 'pg_2', n: 2, render: { status: 'none', history: [] } }
  ]
});

interface Backend {
  calls: { url: string; body?: unknown }[];
}

const stubFetch = (answer: (name: string, body: Record<string, unknown>) => unknown): Backend => {
  const calls: Backend['calls'] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, body });
      if (!url.startsWith(`${SUPA}/rest/v1/rpc/`)) return new Response('{"from":"backend"}', { headers: { 'content-type': 'application/json' } });
      const out = answer(url.split('/rpc/')[1], body);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
    })
  );
  return { calls };
};

const limiter = (success: boolean) => ({ limit: vi.fn(async () => ({ success })) });
const baseEnv = (extra: Record<string, unknown> = {}) => ({
  BACKEND_TARGET: 'origin',
  BACKEND_ORIGIN: 'https://backend.example',
  VITE_SUPABASE_URL: SUPA,
  CORS_ORIGIN: 'https://dreamstreamstudio.ai,https://www.dreamstreamstudio.ai',
  ...extra
});

const call = async (path: string, init: RequestInit & { ua?: string } = {}, env: Record<string, unknown> = baseEnv()) => {
  const headers = new Headers(init.headers);
  headers.set('user-agent', init.ua ?? HUMAN);
  headers.set('cf-connecting-ip', '203.0.113.9');
  const waits: Promise<unknown>[] = [];
  const res = await worker.fetch(new Request(`https://dreamstreamstudio.ai${path}`, { ...init, headers }), env as never, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return res;
};

afterEach(() => vi.unstubAllGlobals());

describe('GET /api/comic/public/s/:slug (edge, never the container)', () => {
  it('#12 payload: urls keys are exactly the snapshot image paths, all under pub/<key>/, no-store, no container call', async () => {
    const b = stubFetch((name) => (name === 'comic_public_payload' ? { publication: publication(), doc: snapshot() } : null));
    const res = await call(`/api/comic/public/s/${SLUG}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await res.json();
    expect(Object.keys(body.urls).sort()).toEqual(
      [`pub/${KEY}/cover-0123456789ab.webp`, `pub/${KEY}/cover-0123456789ab-w480.webp`, `pub/${KEY}/page-0123456789ab.webp`, `pub/${KEY}/page-0123456789ab-w480.webp`].sort()
    );
    for (const [p, u] of Object.entries(body.urls)) expect(u).toBe(`${SUPA}/storage/v1/object/public/comic-assets/${p}`);
    expect(body.publication.slug).toBe(SLUG);
    expect(body.publication.assetKey).toBeUndefined();
    expect(b.calls.every((c) => c.url.startsWith(`${SUPA}/rest/v1/rpc/`))).toBe(true);
  });

  it('#13 missing, revoked and malformed slugs share ONE canonical 404 body; malformed skips the RPC', async () => {
    const b = stubFetch(() => null);
    const missing = await call(`/api/comic/public/s/${SLUG}`);
    const malformed = await call('/api/comic/public/s/short');
    const bodies = [await missing.text(), await malformed.text()];
    expect([missing.status, malformed.status]).toEqual([404, 404]);
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[0]).toBe('{"error":{"message":"This comic isn\'t available.","code":"NOT_FOUND"}}');
    expect(b.calls).toHaveLength(1);
  });

  it('fails closed when a snapshot path leaves the publication prefix (a u/ path, another key, traversal)', async () => {
    for (const bad of [`u/user-1/p/proj/img/x.webp`, `pub/${'Z'.repeat(22)}/page-0123456789ab.webp`, `pub/${KEY}/../x.webp`]) {
      stubFetch(() => ({ publication: publication(), doc: snapshot(bad) }));
      expect((await call(`/api/comic/public/s/${SLUG}`)).status).toBe(404);
      vi.unstubAllGlobals();
    }
  });

  it('#14 rate limit: the binding says no → 429 with retry-after, no RPC', async () => {
    const b = stubFetch(() => null);
    const res = await call(`/api/comic/public/s/${SLUG}`, {}, baseEnv({ PUBLIC_COMIC_RL: limiter(false) }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(b.calls).toHaveLength(0);
  });

  it('read-only: no write method is accepted on the payload path; CORS only for site origins', async () => {
    stubFetch(() => ({ publication: publication(), doc: snapshot() }));
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect((await call(`/api/comic/public/s/${SLUG}`, { method })).status).toBe(405);
    const foreign = await call(`/api/comic/public/s/${SLUG}`, { headers: { origin: 'https://evil.example' } });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    const own = await call(`/api/comic/public/s/${SLUG}`, { headers: { origin: 'https://comics.dreamstreamstudio.ai' } });
    expect(own.headers.get('access-control-allow-origin')).toBe('https://comics.dreamstreamstudio.ai');
  });

  it('#17 AI agents get the existing 403 and nothing reaches Supabase or the container', async () => {
    const b = stubFetch(() => null);
    const res = await call(`/api/comic/public/s/${SLUG}`, { ua: 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)' });
    expect(res.status).toBe(403);
    expect(b.calls).toHaveLength(0);
  });

  it('the report route is still proxied to the container (Turnstile + safety store)', async () => {
    const b = stubFetch(() => null);
    await call(`/api/comic/public/s/${SLUG}/report`, { method: 'POST', body: '{}' });
    expect(b.calls.map((c) => c.url)).toEqual([`https://backend.example/api/comic/public/s/${SLUG}/report`]);
  });
});

describe('POST /api/comic/public/s/:slug/event', () => {
  it('#15 calls the track RPC with a 32-hex viewer hash + HMAC proof (never the raw IP) and answers 204', async () => {
    const b = stubFetch(() => null);
    const res = await call(`/api/comic/public/s/${SLUG}/event`, { method: 'POST', body: JSON.stringify({ type: 'view', channel: 'whatsapp', lang: 'hi' }) }, baseEnv({ SHARE_VIEW_SALT: SALT }));
    expect(res.status).toBe(204);
    expect(b.calls).toHaveLength(1);
    const args = b.calls[0].body as Record<string, string>;
    expect(b.calls[0].url).toBe(`${SUPA}/rest/v1/rpc/comic_publication_track`);
    expect(args.p_viewer).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(args)).not.toContain('203.0.113.9');
    const day = new Date().toISOString().slice(0, 10);
    expect(args.p_proof).toBe(createHmac('sha256', SALT).update(`${SLUG}:${args.p_viewer}:${day}`).digest('hex'));
    expect(args).toMatchObject({ p_slug: SLUG, p_event: 'view', p_channel: 'whatsapp', p_lang: 'hi' });
  });

  it('invalid type, oversize body, no salt, malformed slug or rate-limited → still 204 and no RPC (no oracle)', async () => {
    const b = stubFetch(() => null);
    const env = baseEnv({ SHARE_VIEW_SALT: SALT });
    expect((await call(`/api/comic/public/s/${SLUG}/event`, { method: 'POST', body: '{"type":"delete"}' }, env)).status).toBe(204);
    expect((await call(`/api/comic/public/s/${SLUG}/event`, { method: 'POST', body: JSON.stringify({ type: 'view', pad: 'x'.repeat(2000) }) }, env)).status).toBe(204);
    expect((await call(`/api/comic/public/s/${SLUG}/event`, { method: 'POST', body: '{"type":"view"}' })).status).toBe(204);
    expect((await call('/api/comic/public/s/short/event', { method: 'POST', body: '{"type":"view"}' }, env)).status).toBe(204);
    expect((await call(`/api/comic/public/s/${SLUG}/event`, { method: 'POST', body: '{"type":"view"}' }, { ...env, PUBLIC_EVENT_RL: limiter(false) })).status).toBe(204);
    expect(b.calls).toHaveLength(0);
    expect((await call(`/api/comic/public/s/${SLUG}/event`, { method: 'GET' }, env)).status).toBe(405);
  });

  it('viewer hash and proof are deterministic per day', async () => {
    expect(await viewerHash(SALT, '2026-10-22', '1.2.3.4', 'ua')).toBe(await viewerHash(SALT, '2026-10-22', '1.2.3.4', 'ua'));
    expect(await viewerHash(SALT, '2026-10-23', '1.2.3.4', 'ua')).not.toBe(await viewerHash(SALT, '2026-10-22', '1.2.3.4', 'ua'));
    expect(await trackProof(SALT, SLUG, 'a'.repeat(32), '2026-10-22')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('GET /api/comic/oembed', () => {
  it('#16 rejects foreign URLs (400), escapes the title, drops html when embedding is off', async () => {
    const b = stubFetch(() => publication({ card: { ...publication().card, title: '"><script>alert(1)</script>' } }));
    expect((await call(`/api/comic/oembed?url=${encodeURIComponent(`https://evil.example/c/${SLUG}`)}`)).status).toBe(400);
    expect((await call(`/api/comic/oembed?url=${encodeURIComponent(`http://dreamstreamstudio.ai/c/${SLUG}`)}`)).status).toBe(400);
    expect((await call(`/api/comic/oembed?url=${encodeURIComponent(`https://user:pw@dreamstreamstudio.ai/c/${SLUG}`)}`)).status).toBe(400);
    expect((await call(`/api/comic/oembed?url=${encodeURIComponent(`https://comics.dreamstreamstudio.ai/c/${SLUG}`)}&format=xml`)).status).toBe(501);
    expect(b.calls).toHaveLength(0);
    const res = await call(`/api/comic/oembed?url=${encodeURIComponent(`https://comics.dreamstreamstudio.ai/c/${SLUG}/spice-run`)}&maxwidth=400`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe('rich');
    expect(body.title).toBe('"><script>alert(1)</script>');
    expect(body.html).toContain(`src="https://comics.dreamstreamstudio.ai/c/${SLUG}/embed"`);
    expect(body.html).toContain('title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(body.html).not.toContain('<script>');
    expect(body.width).toBe(400);
    expect(body.thumbnail_url).toBe(`https://dreamstreamstudio.ai/og/${KEY}/og-en-0123456789ab.jpg`);
    const off = oembedFor(validateShareCardRpc(publication({ allowEmbed: false }))!, 'https://dreamstreamstudio.ai');
    expect(off.html).toBeUndefined();
    expect(off.type).toBe('link');
    expect(slugFromShareUrl(`https://dreamstreamstudio.ai/c/${SLUG}`)).toBe(SLUG);
    expect(slugFromShareUrl(`https://dreamstreamstudio.ai:8443/c/${SLUG}`)).toBeNull();
  });

  it('unknown slugs → the canonical 404', async () => {
    stubFetch(() => null);
    const res = await call(`/api/comic/oembed?url=${encodeURIComponent(`https://comics.dreamstreamstudio.ai/c/${SLUG}`)}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/csp-report (edge only)', () => {
  it('never reaches the container; 204; sampled, sanitized log with masked share slugs', async () => {
    const b = stubFetch(() => null);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const report = { 'csp-report': { 'document-uri': `https://dreamstreamstudio.ai/c/${SLUG}?lang=hi`, 'violated-directive': 'script-src-elem', 'blocked-uri': 'https://evil.example/x.js?token=secret' } };
    const res = await call('/api/csp-report', { method: 'POST', headers: { 'content-type': 'application/csp-report' }, body: JSON.stringify(report) }, baseEnv({ CSP_REPORT_SAMPLE: '1' }));
    expect(res.status).toBe(204);
    expect(b.calls).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('csp_violation', { directive: 'script-src-elem', blocked: 'https://evil.example', page: '/c/:slug', disposition: '' });
    expect(JSON.stringify(log.mock.calls)).not.toContain(SLUG);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
    log.mockRestore();
    expect((await call('/api/csp-report', { method: 'GET' })).status).toBe(405);
    expect((await call('/api/csp-report', { method: 'POST', body: 'x'.repeat(20_000) })).status).toBe(204);
    expect(b.calls).toHaveLength(0);
  });

  it('parses the Reporting API format too', () => {
    expect(summarize([{ type: 'csp-violation', body: { effectiveDirective: 'img-src', blockedURL: 'https://x.test/a.png', documentURL: 'https://dreamstreamstudio.ai/?view=studio', disposition: 'report' } }])).toEqual([
      { directive: 'img-src', blocked: 'https://x.test', page: '/', disposition: 'report' }
    ]);
    expect(maskedPath('https://comics.dreamstreamstudio.ai/c/Ab3dEf6hIj9kLm2nP/embed')).toBe('/c/:slug/embed');
  });
});
