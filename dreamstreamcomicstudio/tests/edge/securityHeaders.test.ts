// @vitest-environment node
/**
 * ADR 0006 WS-1 — the security headers the Pages middleware puts on every page, for both
 * apps and both hosts, and the things it must leave alone (its own redirects, a route's own
 * CSP). The policy-vs-built-bundle proof is tests/edge/liveCsp.built.test.ts.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
  ENFORCE_LIVE,
  HSTS,
  INDEX_INLINE_SCRIPT_HASHES,
  LIVE_WORKER_DEV_ORIGIN,
  SUPABASE_ORIGIN,
  createOnRequest,
  liveCsp,
  mainCsp,
  onRequest,
  withSecurityHeaders,
} from '../../functions/_middleware';
import { FALLBACK_PAGES_LIVE_WORKER_BASE } from '../../live/config';
import { allowsInlineScript, allowsUrl, parsePolicies, parsePolicy, sha256Source } from './cspEval';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const HUMAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const html = (body = '<!doctype html>') => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

function harness(opts: { streamHostOn?: boolean; enforceLive?: boolean; env?: Record<string, unknown> } = {}) {
  const handler = createOnRequest({ streamHostOn: opts.streamHostOn ?? false, enforceLive: opts.enforceLive });
  const next = vi.fn(async () => html());
  const assets = vi.fn(async (input: Request | string | URL) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    if (u.pathname === '/live.html') return new Response(null, { status: 308, headers: { location: '/live' } });
    return html('<live app>');
  });
  const go = (u: string, init: { ua?: string; method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    handler({
      request: new Request(u, { method: init.method ?? 'GET', body: init.body, headers: { 'user-agent': init.ua ?? HUMAN, ...(init.headers ?? {}) } }),
      next,
      env: { ASSETS: { fetch: assets }, ...(opts.env ?? {}) } as never,
    });
  return { go, next, assets };
}

const SECURITY_HEADERS = [
  'strict-transport-security', 'x-content-type-options', 'referrer-policy', 'permissions-policy',
  'cross-origin-opener-policy', 'x-frame-options', 'content-security-policy', 'content-security-policy-report-only', 'reporting-endpoints',
];

describe('Stream Studio pages (/live and the stream host)', () => {
  it('carry HSTS, nosniff, Referrer-Policy, Permissions-Policy, COOP and no-framing on /live', async () => {
    const { go } = harness();
    for (const u of ['https://dreamstreamstudio.ai/live', 'https://dreamstreamstudio.ai/live/', 'https://dreamstreamstudio.ai/live.html']) {
      const res = await go(u);
      expect(res.headers.get('strict-transport-security'), u).toBe('max-age=63072000; includeSubDomains');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('strict-origin');
      expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      const pp = res.headers.get('permissions-policy')!;
      for (const f of ['camera=(self)', 'microphone=(self)', 'display-capture=(self)', 'screen-wake-lock=(self)', 'geolocation=()', 'payment=()', 'usb=()']) {
        expect(pp).toContain(f);
      }
      // Motion sensors (tamper detection) and autoplay (alarm sounds) are never switched off.
      expect(pp).not.toMatch(/accelerometer|gyroscope|magnetometer|autoplay/);
      expect(res.headers.get('reporting-endpoints')).toBe(`csp="${new URL(u).origin}/csp-report"`);
    }
  });

  it('serves every Stream Studio host page with the same live headers', async () => {
    const { go, assets } = harness();
    for (const p of ['/', '/monitor', '/live-room.html']) {
      const res = await go(`https://stream.dreamstreamstudio.ai${p}`);
      expect(await res.text()).toBe('<live app>');
      expect(res.headers.get('x-frame-options'), p).toBe('DENY');
      expect(res.headers.get('content-security-policy-report-only') ?? res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    }
    expect(assets).toHaveBeenCalled();
  });

  it('ships the live policy Report-Only (plus Trusted Types report-only) while ENFORCE_LIVE is off', async () => {
    const { go } = harness({ enforceLive: false });
    const res = await go('https://stream.dreamstreamstudio.ai/');
    // Enforced while the switch is off: only the sign-in page's frame block (auth hotfix), nothing else.
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    const [policy, tt] = parsePolicies(res.headers.get('content-security-policy-report-only')!);
    expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'none'"]);
    expect(policy.has('upgrade-insecure-requests')).toBe(false); // ignored in report-only; not sent
    expect(policy.get('report-to')).toEqual(['csp']);
    expect(policy.get('report-uri')).toEqual(['/csp-report']);
    expect(tt.get('require-trusted-types-for')).toEqual(["'script'"]);
  });

  it('enforces the live policy once flipped, keeping Trusted Types report-only', async () => {
    const { go } = harness({ enforceLive: true });
    const res = await go('https://dreamstreamstudio.ai/live');
    const policy = parsePolicy(res.headers.get('content-security-policy')!);
    expect(policy.has('upgrade-insecure-requests')).toBe(true);
    expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
    expect(res.headers.get('content-security-policy-report-only')).toMatch(/^require-trusted-types-for 'script'/);
  });

  it('sign-in landing pages are never framed — and the frame block never replaces the live policy', async () => {
    // Regression (merge of the auth hotfix with these headers): the frame block used to be stamped on first,
    // so withSecurityHeaders kept it as the page's own policy and the enforced live CSP never applied.
    for (const enforceLive of [false, true]) {
      const { go } = harness({ enforceLive, streamHostOn: true });
      for (const u of ['https://dreamstreamstudio.ai/auth/callback', 'https://stream.dreamstreamstudio.ai/', 'https://dreamstreamstudio.ai/live.html?legacy=1']) {
        const res = await go(u);
        expect(res.headers.get('x-frame-options'), u).toBe('DENY');
        const policy = parsePolicy(res.headers.get('content-security-policy')!);
        expect(policy.get('frame-ancestors'), u).toEqual(["'none'"]);
        if (enforceLive && !u.includes('/auth/callback')) expect(policy.has('upgrade-insecure-requests'), u).toBe(true);
      }
    }
  });

  it('the shipped switch is honoured by the exported handler', async () => {
    const res = await onRequest({ request: new Request('https://dreamstreamstudio.ai/live', { headers: { 'user-agent': HUMAN } }), next: async () => html() });
    // Off: only the frame block is enforced; on: the whole live policy (which keeps frame-ancestors 'none').
    const enforced = parsePolicy(res.headers.get('content-security-policy')!);
    expect(enforced.has('upgrade-insecure-requests')).toBe(ENFORCE_LIVE);
    expect(enforced.get('frame-ancestors')).toEqual(["'none'"]);
    expect(res.headers.get('content-security-policy-report-only')).toBeTruthy();
  });

  it('allows the live app its real endpoints and nothing script-like from elsewhere', () => {
    for (const self of ['https://stream.dreamstreamstudio.ai/', 'https://dreamstreamstudio.ai/live']) {
      const p = parsePolicy(liveCsp({ origin: new URL(self).origin, enforce: true }));
      const host = new URL(self).host;
      // Worker base: same-origin /live-api over https and wss, and the workers.dev fallback.
      expect(allowsUrl(p, 'connect-src', `https://${host}/live-api/api/monitor/x`, self)).toBe(true);
      expect(allowsUrl(p, 'connect-src', `wss://${host}/live-api/api/monitor/x/ws`, self)).toBe(true);
      expect(allowsUrl(p, 'connect-src', `${LIVE_WORKER_DEV_ORIGIN}/api/x`, self)).toBe(true);
      expect(allowsUrl(p, 'connect-src', `${LIVE_WORKER_DEV_ORIGIN.replace('https:', 'wss:')}/api/x/ws`, self)).toBe(true);
      // The apex's /api (the stream host reaches it), Supabase REST/auth/realtime, Drive uploads.
      expect(allowsUrl(p, 'connect-src', 'https://dreamstreamstudio.ai/api/me', self)).toBe(true);
      expect(allowsUrl(p, 'connect-src', `${SUPABASE_ORIGIN}/auth/v1/token`, self)).toBe(true);
      expect(allowsUrl(p, 'connect-src', `${SUPABASE_ORIGIN.replace('https:', 'wss:')}/realtime/v1/websocket`, self)).toBe(true);
      expect(allowsUrl(p, 'connect-src', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', self)).toBe(true);
      // Turnstile (dormant until a site key is set) in script + frame; Google Fonts.
      expect(allowsUrl(p, 'script-src-elem', 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', self)).toBe(true);
      expect(allowsUrl(p, 'frame-src', 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x', self)).toBe(true);
      expect(allowsUrl(p, 'style-src-elem', 'https://fonts.googleapis.com/css2?family=Newsreader', self)).toBe(true);
      expect(allowsUrl(p, 'font-src', 'https://fonts.gstatic.com/s/x.woff2', self)).toBe(true);
      // Workers (YAMNet, the service worker, blob: recorder/ticker) and blob: AudioWorklets.
      expect(allowsUrl(p, 'worker-src', '/assets/yamnet.worker-abc.js', self)).toBe(true);
      expect(allowsUrl(p, 'worker-src', '/live-sw.js', self)).toBe(true);
      expect(allowsUrl(p, 'worker-src', `blob:${new URL(self).origin}/0b5c`, self)).toBe(true);
      expect(allowsUrl(p, 'script-src-elem', `blob:${new URL(self).origin}/0b5c`, self)).toBe(true);
      expect(p.get('script-src')).toContain("'wasm-unsafe-eval'");
      // The things it must refuse.
      expect(p.get('script-src')).not.toContain("'unsafe-inline'");
      expect(p.get('script-src')).not.toContain("'unsafe-eval'");
      expect(allowsUrl(p, 'script-src-elem', 'https://cdnjs.cloudflare.com/ajax/libs/x.js', self)).toBe(false);
      expect(allowsUrl(p, 'connect-src', 'https://huggingface.co/audiomagic/yamnet-onnx/resolve/main/yamnet.onnx', self)).toBe(false);
      expect(allowsUrl(p, 'connect-src', 'https://odml.pa.googleapis.com/v1/log', self)).toBe(false);
      expect(allowsUrl(p, 'connect-src', 'https://evil.example/exfil', self)).toBe(false);
      expect(allowsUrl(p, 'img-src', 'https://evil.example/pixel.gif', self)).toBe(false);
      expect(allowsUrl(p, 'frame-src', 'https://evil.example/', self)).toBe(false);
      expect(allowsInlineScript(p, 'alert(1)')).toBe(false);
    }
  });

  it('adds the build’s Supabase and live Worker origins from env, and ignores anything malformed', () => {
    const p = parsePolicy(liveCsp({
      origin: 'https://dreamstreamstudio.ai',
      env: { VITE_SUPABASE_URL: 'https://abcd.supabase.co/', VITE_LIVE_WORKER_URL: 'https://live.example.dev/base' },
    }));
    const connect = p.get('connect-src')!;
    for (const o of ['https://abcd.supabase.co', 'wss://abcd.supabase.co', 'https://live.example.dev', 'wss://live.example.dev', SUPABASE_ORIGIN]) {
      expect(connect).toContain(o);
    }
    for (const bad of ["https://x.supabase.co; script-src *", 'http://plain.example', 'javascript:alert(1)', 'https://u:p@x.example', '']) {
      const header = liveCsp({ origin: 'https://dreamstreamstudio.ai', env: { VITE_SUPABASE_URL: bad } });
      expect(header).not.toMatch(/script-src \*|plain\.example|javascript|u:p@/);
      expect(parsePolicy(header).get('connect-src')).toEqual(connect.filter((s) => !/abcd|live\.example/.test(s)));
    }
  });

  it('keeps the workers.dev origin in step with live/config.ts', () => {
    expect(LIVE_WORKER_DEV_ORIGIN).toBe(FALLBACK_PAGES_LIVE_WORKER_BASE);
  });
});

describe('the comic / chat app (everything else)', () => {
  it('gets CSP Report-Only — never enforced — with the splash watchdog hashed', async () => {
    const { go } = harness({ enforceLive: true });
    for (const u of ['https://dreamstreamstudio.ai/', 'https://dreamstreamstudio.ai/share/abc', 'https://dreamstreamstudio.ai/live-guide']) {
      const res = await go(u);
      expect(res.headers.get('content-security-policy'), u).toBeNull();
      const p = parsePolicy(res.headers.get('content-security-policy-report-only')!);
      for (const h of INDEX_INLINE_SCRIPT_HASHES) expect(p.get('script-src')).toContain(h);
      expect(p.get('report-to')).toEqual(['csp']);
      expect(res.headers.get('strict-transport-security')).toBe(HSTS);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      // No COOP / X-Frame-Options on the comic app yet: OAuth popups and embeds are inventoried first.
      expect(res.headers.get('cross-origin-opener-policy')).toBeNull();
      expect(res.headers.get('x-frame-options')).toBeNull();
      expect(res.headers.get('permissions-policy')).not.toMatch(/camera|microphone|geolocation/);
    }
  });

  it('allows the SRI-pinned cdnjs scripts and the embeds in its inventory policy', () => {
    const p = parsePolicy(mainCsp({ origin: 'https://dreamstreamstudio.ai' }));
    const self = 'https://dreamstreamstudio.ai/';
    expect(allowsUrl(p, 'script-src-elem', 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', self)).toBe(true);
    expect(allowsUrl(p, 'frame-src', 'https://www.youtube-nocookie.com/embed/x', self)).toBe(true);
    expect(allowsUrl(p, 'frame-src', 'https://preview.sandpack-static-server.codesandbox.io/', self)).toBe(true);
    expect(allowsUrl(p, 'img-src', 'https://images.example/cover.png', self)).toBe(true);
  });
});

describe('what the middleware leaves alone', () => {
  it('its own redirects and the agent check-in stay byte-for-byte', async () => {
    const { go } = harness({ streamHostOn: true });
    const responses = [
      await go('https://www.dreamstreamstudio.ai/x?y=1'),
      await go('https://comic2.pages.dev/live'),
      await go('https://www.stream.dreamstreamstudio.ai/'),
      await go('https://stream.dreamstreamstudio.ai/live.html?e=1'),
      await go('https://dreamstreamstudio.ai/live'),
      await go('https://dreamstreamstudio.ai/models', { ua: 'PerplexityBot/1.0' }),
      await go('https://dreamstreamstudio.ai/agents'),
    ];
    for (const res of responses) {
      expect([301, 302]).toContain(res.status);
      for (const h of SECURITY_HEADERS) expect(res.headers.has(h), `${res.headers.get('location')} ${h}`).toBe(false);
    }
  });

  it('keeps a CSP a route set for itself', () => {
    const own = new Response('<p>', { headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'" } });
    const res = withSecurityHeaders(own, new URL('https://dreamstreamstudio.ai/live'), { enforceLive: true });
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('gives non-HTML files only the baseline (no CSP on robots.txt, security.txt, JSON)', async () => {
    const { go, next } = harness();
    next.mockImplementation(async () => new Response('User-agent: *', { headers: { 'content-type': 'text/plain' } }));
    for (const u of ['https://dreamstreamstudio.ai/robots.txt', 'https://stream.dreamstreamstudio.ai/.well-known/security.txt']) {
      const res = await go(u);
      expect(res.headers.get('strict-transport-security')).toBe(HSTS);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.has('content-security-policy')).toBe(false);
      expect(res.headers.has('content-security-policy-report-only')).toBe(false);
    }
  });

  it('still sends the policy on a 304 for a page (no content type), so cached pages pick it up', () => {
    const res = withSecurityHeaders(new Response(null, { status: 304 }), new URL('https://dreamstreamstudio.ai/live'), { enforceLive: true });
    expect(res.status).toBe(304);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('sends POST /csp-report to the report Function even from an automated browser', async () => {
    const { go, next } = harness();
    next.mockImplementation(async () => new Response(null, { status: 204 }));
    const res = await go('https://dreamstreamstudio.ai/csp-report', {
      method: 'POST',
      ua: 'Mozilla/5.0 HeadlessChrome/140.0.0.0',
      headers: { 'content-type': 'application/csp-report' },
      body: '{}',
    });
    expect(res.status).toBe(204);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('no header value is long enough to trouble a proxy, and none contains a line break', async () => {
    const { go } = harness({ enforceLive: true, env: { VITE_SUPABASE_URL: 'https://abcd.supabase.co' } });
    for (const u of ['https://stream.dreamstreamstudio.ai/', 'https://dreamstreamstudio.ai/']) {
      const res = await go(u);
      res.headers.forEach((value) => {
        expect(value.length).toBeLessThan(2000);
        expect(value).not.toMatch(/[\r\n]/);
      });
    }
  });
});

describe('inline scripts and handlers (index.html, live.html)', () => {
  // Parsed as a browser would (comments, CDATA and all), so the hash is over the same text.
  const dom = (doc: string) => new JSDOM(doc).window.document;
  const inlineScripts = (doc: string) =>
    [...dom(doc).querySelectorAll('script:not([src])')]
      .filter((s) => (s.getAttribute('type') ?? '') !== 'importmap')
      .map((s) => s.textContent ?? '');
  const handlerAttributes = (doc: string) =>
    [...dom(doc).querySelectorAll('*')].flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `${el.tagName}[${a.name}]`));

  it('every inline script in index.html (source and build) is hashed in the policy', () => {
    const docs = [read('index.html')];
    // The build too, when it is a build of this source (CI builds before it tests).
    const built = path.join(ROOT, 'dist/index.html');
    if (existsSync(built) && statSync(built).mtimeMs >= statSync(path.join(ROOT, 'index.html')).mtimeMs) docs.push(read('dist/index.html'));
    const p = parsePolicy(mainCsp({ origin: 'https://dreamstreamstudio.ai' }));
    for (const doc of docs) {
      const scripts = inlineScripts(doc);
      expect(scripts.length).toBeGreaterThan(0);
      for (const body of scripts) {
        // On failure, the hash to put in INDEX_INLINE_SCRIPT_HASHES is in the message.
        expect(allowsInlineScript(p, body), `add ${sha256Source(body)} to INDEX_INLINE_SCRIPT_HASHES`).toBe(true);
      }
    }
  });

  it('there is no importmap and no inline event handler on either page', () => {
    for (const file of ['index.html', 'live.html']) {
      const doc = read(file);
      expect(dom(doc).querySelectorAll('script[type="importmap"]').length, file).toBe(0);
      expect(doc, file).not.toMatch(/aistudiocdn/i);
      expect(handlerAttributes(doc), file).toEqual([]);
    }
    expect(inlineScripts(read('live.html'))).toEqual([]);
  });
});
