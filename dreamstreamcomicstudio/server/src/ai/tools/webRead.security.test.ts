// @vitest-environment node
// web-surface-2 / abuse-ops-10 and abuse-ops-1 (a)-(e): the anonymous read-url / unfurl paths and
// the deep-research reader. Redirects to internal hosts are refused (not followed), one deadline
// covers the body, downloads stop at their cap, the Jina fallback is for signed-in callers only,
// and the unfurl cache is bounded.
//
// Every network edge is fake. `globalFetch` behaves like the real fetch (it FOLLOWS redirects
// unless told `redirect: 'manual'`), so code that hands a user URL to plain fetch is caught
// following a 302 into 127.0.0.1; `transport` is the pinned path (never follows).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readArticle, READ_MAX_BYTES } from './readArticle.js';
import { fetchReadable } from '../research/readable.js';
import { fetchTextCapped } from './http.js';
import { unfurlUrl, __clearUnfurlCache, __unfurlCacheSize, UNFURL_CACHE_MAX } from './unfurl.js';
import { __setNetForTests } from './safeNet.js';
import { runWithAccount } from '../../lib/accountContext.js';
import { __resetProviderUsage } from '../../lib/providerUsage.js';

const para = (text: string) => `<p>${text} ${'This sentence pads the paragraph past the reader threshold. '.repeat(3)}</p>`;
const ARTICLE_HTML = `<html><head><title>Internal</title></head><body><article>${para('INTERNAL SECRET one')}${para('INTERNAL SECRET two')}${para('INTERNAL SECRET three')}</article></body></html>`;

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

const fakeWeb = (route: Route) => {
  const calls: string[] = [];
  const serve = async (url: string, init?: RequestInit) => {
    calls.push(url);
    return route(url, init);
  };
  const globalFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    for (let hop = 0; hop < 5; hop += 1) {
      const res = await serve(url, init);
      if (init?.redirect === 'manual' || res.status < 300 || res.status >= 400) return res;
      url = new URL(res.headers.get('location') || '/', url).href;
    }
    throw new TypeError('redirect loop');
  });
  const transport = vi.fn(async (url: string, init?: RequestInit) => serve(url, init));
  return { calls, globalFetch, transport };
};

const resolver = async (host: string) =>
  host === 'rebind.test' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }];

let restoreNet: (() => void) | null = null;
const install = (web: ReturnType<typeof fakeWeb>) => {
  vi.stubGlobal('fetch', web.globalFetch);
  restoreNet = __setNetForTests({ transport: web.transport, resolve: resolver });
};

/** A body that is generated on demand, counting how much of it was ever pulled. */
const lazyBody = (total: number, chunkAt: (offset: number, size: number) => string, chunk = 64 * 1024) => {
  const stats = { pulledBytes: 0, cancelled: false };
  const enc = new TextEncoder();
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= total) {
        controller.close();
        return;
      }
      const size = Math.min(chunk, total - offset);
      const bytes = enc.encode(chunkAt(offset, size));
      stats.pulledBytes += bytes.length;
      offset += size;
      controller.enqueue(bytes);
    },
    cancel() {
      stats.cancelled = true;
    }
  });
  return { stream, stats };
};

beforeEach(() => {
  __resetProviderUsage();
  __clearUnfurlCache();
});

afterEach(() => {
  restoreNet?.();
  restoreNet = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a redirect into the private network is refused, not followed', () => {
  const redirectTo = (location: string) =>
    fakeWeb((url) =>
      url.startsWith('https://news.test/')
        ? new Response(null, { status: 302, headers: { location } })
        : new Response(ARTICLE_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
    );

  it.each(['http://127.0.0.1/', 'https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data/', 'https://rebind.test/'])(
    'read-url: a 302 to %s gives fetch_failed after exactly one request',
    async (location) => {
      const web = redirectTo(location);
      install(web);
      const out = await readArticle('https://news.test/story');
      expect(out.ok).toBe(false);
      expect(out.reason).toBe('fetch_failed');
      expect(web.calls).toEqual(['https://news.test/story']);
      expect(JSON.stringify(out)).not.toContain('INTERNAL SECRET');
    }
  );

  it('deep research: fetchReadable returns null for it, after one request', async () => {
    const web = redirectTo('http://127.0.0.1/');
    install(web);
    expect(await fetchReadable('https://news.test/story')).toBeNull();
    expect(web.calls).toEqual(['https://news.test/story']);
  });

  it('unfurl: refused, after one request', async () => {
    const web = redirectTo('https://169.254.169.254/latest/meta-data/');
    install(web);
    await expect(unfurlUrl('https://news.test/story')).rejects.toThrow();
    expect(web.calls).toEqual(['https://news.test/story']);
  });

  it('a public redirect is still followed (re-checked) and read', async () => {
    const web = fakeWeb((url) =>
      url === 'https://news.test/old'
        ? new Response(null, { status: 301, headers: { location: 'https://news.test/new' } })
        : new Response(ARTICLE_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
    );
    install(web);
    const out = await readArticle('https://news.test/old');
    expect(out.ok).toBe(true);
    expect(web.calls).toEqual(['https://news.test/old', 'https://news.test/new']);
  });
});

describe('fetchTextCapped: one deadline through the body, a streamed byte cap', () => {
  it('a body that never finishes is cut off by the same deadline as the headers', async () => {
    const web = fakeWeb((_url, init) => {
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode('<html><body>first bytes'));
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        }
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    install(web);
    const started = Date.now();
    await expect(fetchTextCapped('https://slow.test/', { publicOnly: true, timeoutMs: 120, maxBytes: 10_000 })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(2500);
  }, 4000);

  it('stops downloading at maxBytes and cancels the rest', async () => {
    const body = lazyBody(5 * 1024 * 1024, (_o, size) => 'a'.repeat(size));
    const web = fakeWeb(() => new Response(body.stream, { status: 200, headers: { 'content-type': 'text/plain' } }));
    install(web);
    const out = await fetchTextCapped('https://big.test/', { publicOnly: true, timeoutMs: 5000, maxBytes: 1_000_000 });
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(1_000_000);
    expect(body.stats.pulledBytes).toBeLessThanOrEqual(1_000_000 + 2 * 64 * 1024);
    expect(body.stats.cancelled).toBe(true);
  });

  it('refuses a non-page content type before reading its body', async () => {
    const body = lazyBody(1024 * 1024, (_o, size) => 'x'.repeat(size));
    const web = fakeWeb(() => new Response(body.stream, { status: 200, headers: { 'content-type': 'application/pdf' } }));
    install(web);
    expect(await fetchReadable('https://pdf.test/file')).toBeNull();
    expect(body.stats.pulledBytes).toBeLessThanOrEqual(64 * 1024);
  });
});

describe('read-url caps', () => {
  it('downloads at most 1 MB and parses only the first 256 KB', async () => {
    const head = `<html><body><article>${para('Opening paragraph')}${para('Second paragraph')}${para('Third paragraph')}`;
    const far = para('FAR PARAGRAPH beyond the parse window');
    const body = lazyBody(4 * 1024 * 1024, (offset, size) => {
      // The article opens the page; a paragraph sits at ~300 KB (outside the parse window).
      if (offset === 0) return (head + ' '.repeat(size)).slice(0, size);
      if (offset === 4 * 64 * 1024) return (far + ' '.repeat(size)).slice(0, size);
      return ' '.repeat(size);
    });
    const web = fakeWeb(() => new Response(body.stream, { status: 200, headers: { 'content-type': 'text/html' } }));
    install(web);
    const out = await readArticle('https://huge.test/story');
    expect(out.ok).toBe(true);
    expect(out.blocks.some((b) => b.text.includes('Opening paragraph'))).toBe(true);
    expect(out.blocks.some((b) => b.text.includes('FAR PARAGRAPH'))).toBe(false);
    expect(body.stats.pulledBytes).toBeLessThanOrEqual(READ_MAX_BYTES + 2 * 64 * 1024);
    expect(body.stats.cancelled).toBe(true);
  });
});

describe('the Jina fallback is for signed-in callers only', () => {
  const thinPlusJina = () =>
    fakeWeb((url) =>
      url.startsWith('https://r.jina.ai/')
        ? new Response(
            `Title: From Jina\n\nMarkdown Content:\n${'A long enough paragraph of extracted article text for the reader to keep it. '.repeat(4)}\n\n${'Another long paragraph so the extracted text clears the reader threshold comfortably. '.repeat(3)}`,
            { status: 200, headers: { 'content-type': 'text/plain' } }
          )
        : new Response('<html><body><p>Too short.</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    );

  it('an anonymous web caller never reaches Jina', async () => {
    const web = thinPlusJina();
    install(web);
    const out = await runWithAccount(null, () => readArticle('https://thin.test/a'));
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('empty');
    expect(web.calls.some((u) => u.startsWith('https://r.jina.ai/'))).toBe(false);
  });

  it('a signed-in caller still gets the Jina second pass', async () => {
    const web = thinPlusJina();
    install(web);
    const out = await runWithAccount('user-1', () => readArticle('https://thin.test/a'));
    expect(out.ok).toBe(true);
    expect(web.calls.some((u) => u.startsWith('https://r.jina.ai/'))).toBe(true);
  });
});

describe('unfurl cache: bounded, short owned copies, expired entries swept on access', () => {
  const page = (title: string) =>
    `<html><head><meta property="og:title" content="${title}"><meta name="description" content="d"></head><body></body></html>`;

  it(`never holds more than ${UNFURL_CACHE_MAX} entries`, async () => {
    const web = fakeWeb((url) => new Response(page(url), { status: 200, headers: { 'content-type': 'text/html' } }));
    install(web);
    for (let i = 0; i < UNFURL_CACHE_MAX + 100; i += 1) await unfurlUrl(`https://site${i}.test/`);
    expect(__unfurlCacheSize()).toBe(UNFURL_CACHE_MAX);
    // The most recent entries are the ones kept (LRU): no new request for the last URL.
    const before = web.calls.length;
    await unfurlUrl(`https://site${UNFURL_CACHE_MAX + 99}.test/`);
    expect(web.calls.length).toBe(before);
  });

  it('stores clipped fields, and sweeps expired entries on the next access (no timer)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T00:00:00Z'));
    const web = fakeWeb(() => new Response(page('T'.repeat(10_000)), { status: 200, headers: { 'content-type': 'text/html' } }));
    install(web);
    const first = await unfurlUrl('https://a.test/');
    expect(first.title?.length).toBe(300);
    await unfurlUrl('https://b.test/');
    expect(__unfurlCacheSize()).toBe(2);
    vi.setSystemTime(new Date('2026-11-05T00:31:00Z'));
    await unfurlUrl('https://c.test/');
    expect(__unfurlCacheSize()).toBe(1);
  });
});
