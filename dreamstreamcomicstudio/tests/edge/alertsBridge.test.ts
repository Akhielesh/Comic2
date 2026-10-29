// @vitest-environment node
/**
 * ADR 0006 WS-5, docs/infrastructure/INFRA_MAP.md §2a — the Stream Studio alerts bridge.
 * Stream Studio's own host loads https://dreamstreamstudio.ai/stream-alerts-bridge in a hidden
 * frame to end this browser's old /live alert subscription (live/monitor/push.ts). The headers
 * must let exactly that happen — the host may frame that one page, nothing else may frame it,
 * nothing else on the apex becomes frameable — and keep holding once the policies are enforced.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ALERTS_BRIDGE_CSP, ALERTS_BRIDGE_PATH, createOnRequest, isAlertsBridgePath, liveCsp } from '../../functions/_middleware';
import { BRIDGE_PATH } from '../../live/monitor/push';
import { MAIN_ORIGIN, STREAM_ORIGIN } from '../../shared/streamHost';
import { allowsUrl, parsePolicy } from './cspEval';

const HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const html = (body = '<!doctype html>') => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

function harness(streamHostOn: boolean) {
  const handler = createOnRequest({ streamHostOn });
  const next = vi.fn(async () => html('<bridge>'));
  const assets = vi.fn(async () => html('<live app>'));
  const go = (u: string) =>
    handler({ request: new Request(u, { headers: { 'user-agent': HUMAN } }), next, env: { ASSETS: { fetch: assets } } as never });
  return { go, next, assets };
}

describe('the bridge page on the apex', () => {
  it('the app and the middleware agree on where it is', () => {
    expect(BRIDGE_PATH).toBe(ALERTS_BRIDGE_PATH);
    expect(isAlertsBridgePath('/stream-alerts-bridge')).toBe(true);
    expect(isAlertsBridgePath('/stream-alerts-bridge.html')).toBe(true);
    expect(isAlertsBridgePath('/stream-alerts-bridge/')).toBe(true);
    expect(isAlertsBridgePath('/stream-alerts-bridge.js')).toBe(false);
    expect(isAlertsBridgePath('/live')).toBe(false);
  });

  for (const streamHostOn of [false, true]) {
    it(`may be framed by Stream Studio's host only, under its own enforced policy (switch ${streamHostOn ? 'on' : 'off'})`, async () => {
      const { go, next } = harness(streamHostOn);
      const res = await go(`${MAIN_ORIGIN}${ALERTS_BRIDGE_PATH}`);
      expect(res.status).toBe(200); // served, never redirected with /live
      expect(next).toHaveBeenCalled();
      expect(res.headers.get('x-frame-options')).toBeNull();
      expect(res.headers.get('content-security-policy')).toBe(ALERTS_BRIDGE_CSP);
      // No main-app inventory policy reporting every load as a frame-ancestors violation.
      expect(res.headers.get('content-security-policy-report-only')).toBeNull();
      const p = parsePolicy(ALERTS_BRIDGE_CSP);
      expect(p.get('frame-ancestors')).toEqual([STREAM_ORIGIN]);
      expect(p.get('default-src')).toEqual(["'none'"]);
      expect(p.get('script-src')).toEqual(["'self'"]);
      // The rest of the baseline still applies.
      expect(res.headers.get('strict-transport-security')).toMatch(/max-age=/);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-robots-tag')).toContain('noindex');
    });
  }

  it('allows its one script and nothing else', () => {
    const p = parsePolicy(ALERTS_BRIDGE_CSP);
    const self = `${MAIN_ORIGIN}${ALERTS_BRIDGE_PATH}`;
    expect(allowsUrl(p, 'script-src', `${MAIN_ORIGIN}/stream-alerts-bridge.js`, self)).toBe(true);
    expect(allowsUrl(p, 'script-src', 'https://evil.example/x.js', self)).toBe(false);
    expect(allowsUrl(p, 'connect-src', 'https://evil.example/collect', self)).toBe(false);
    expect(allowsUrl(p, 'img-src', 'https://evil.example/pixel.gif', self)).toBe(false);
    // The page matches: one same-origin script, no inline code.
    const page = readFileSync(new URL('../../public/stream-alerts-bridge.html', import.meta.url), 'utf8');
    expect(page).toMatch(/<script src="\/stream-alerts-bridge\.js" defer><\/script>/);
    expect(page).not.toMatch(/<script>(?!\s*<\/script>)/);
    expect(page).not.toMatch(/\son[a-z]+=/i);
  });

  it('on Stream Studio’s own host the same path is just the app, never framed', async () => {
    const { go, assets } = harness(true);
    const res = await go(`${STREAM_ORIGIN}${ALERTS_BRIDGE_PATH}`);
    expect(assets).toHaveBeenCalled();
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('nothing else on the apex becomes frameable by the host', async () => {
    const { go } = harness(false);
    const live = await go(`${MAIN_ORIGIN}/live`);
    expect(live.headers.get('x-frame-options')).toBe('DENY');
    const home = await go(`${MAIN_ORIGIN}/`);
    const policy = parsePolicy(home.headers.get('content-security-policy-report-only')!);
    expect(policy.get('frame-ancestors')).toEqual(["'self'"]);
  });
});

describe('Stream Studio pages may load the bridge — and only it', () => {
  for (const enforce of [false, true]) {
    it(`frame-src (${enforce ? 'enforced' : 'report-only'})`, () => {
      const self = `${STREAM_ORIGIN}/`;
      const p = parsePolicy(liveCsp({ origin: STREAM_ORIGIN, enforce }));
      expect(allowsUrl(p, 'frame-src', `${MAIN_ORIGIN}${ALERTS_BRIDGE_PATH}`, self)).toBe(true);
      expect(allowsUrl(p, 'frame-src', `${MAIN_ORIGIN}/`, self)).toBe(false);
      expect(allowsUrl(p, 'frame-src', `${MAIN_ORIGIN}/live`, self)).toBe(false);
      expect(allowsUrl(p, 'frame-src', `${MAIN_ORIGIN}${ALERTS_BRIDGE_PATH}/x`, self)).toBe(false);
      expect(allowsUrl(p, 'frame-src', 'https://evil.example/stream-alerts-bridge', self)).toBe(false);
      // Stream Studio itself is still never framed.
      expect(p.get('frame-ancestors')).toEqual(["'none'"]);
    });
  }

  it('the bridge script is a static file: Pages Functions are not run for it', () => {
    const routes = JSON.parse(readFileSync(new URL('../../public/_routes.json', import.meta.url), 'utf8')) as { exclude: string[] };
    expect(routes.exclude).toContain('/stream-alerts-bridge.js');
  });
});
