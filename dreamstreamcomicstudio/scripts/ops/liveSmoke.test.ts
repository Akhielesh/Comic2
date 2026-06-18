import { describe, expect, it } from 'vitest';
import {
  classifySmokeResponse,
  detectCloudflareChallenge,
  formatSmokeReport,
  runLiveSmoke,
  type SmokeTarget
} from './liveSmoke';

const htmlResponse = (body: string, init: ResponseInit = {}) =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...(init.headers ?? {}) },
    ...init
  });

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init
  });

describe('live smoke classification', () => {
  it('flags Cloudflare challenge interstitials even when they are HTML', () => {
    const body = '<title>Just a moment...</title><script>window._cf_chl_opt={}</script>';
    const response = htmlResponse(body, {
      status: 403,
      headers: { 'server': 'cloudflare', 'cf-mitigated': 'challenge' }
    });

    expect(detectCloudflareChallenge(response, body)).toBe(true);

    const result = classifySmokeResponse(
      { name: 'primary app', url: 'https://dreamstreamstudio.ai/', kind: 'frontend' },
      response,
      body,
      120
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Cloudflare challenge');
  });

  it('accepts the deployed app shell when it returns normal HTML', () => {
    const body = '<!doctype html><html><head><title>DreamStream</title></head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>';
    const result = classifySmokeResponse(
      { name: 'fallback app', url: 'https://comic2.pages.dev/', kind: 'frontend' },
      htmlResponse(body),
      body,
      80
    );

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('app shell');
  });

  it('requires the backend health endpoint to return status ok JSON', () => {
    const okBody = { status: 'ok', email: 'dormant' };
    const ok = classifySmokeResponse(
      { name: 'railway api', url: 'https://comic2-production.up.railway.app/api/health', kind: 'api' },
      jsonResponse(okBody),
      JSON.stringify(okBody),
      55
    );

    expect(ok.status).toBe('pass');
    expect(ok.detail).toContain('health ok');

    const badBody = { status: 'degraded' };
    const bad = classifySmokeResponse(
      { name: 'railway api', url: 'https://comic2-production.up.railway.app/api/health', kind: 'api' },
      jsonResponse(badBody),
      JSON.stringify(badBody),
      55
    );

    expect(bad.status).toBe('fail');
    expect(bad.detail).toContain('unexpected health payload');
  });

  it('accepts the live-worker route when a no-write missing-event probe returns JSON 404', () => {
    const body = JSON.stringify({ error: 'not found' });
    const result = classifySmokeResponse(
      { name: 'stream worker route', url: 'https://comic2.pages.dev/live-api/api/events/smokeprobe', kind: 'live-api' },
      jsonResponse({ error: 'not found' }, { status: 404 }),
      body,
      70
    );

    expect(result.status).toBe('pass');
    expect(result.detail).toContain('live worker route reachable');
  });

  it('rejects live-worker probes that are routed to the static website shell', () => {
    const body = '<!doctype html><div id="root"></div><script type="module" src="/assets/index.js"></script>';
    const result = classifySmokeResponse(
      { name: 'stream worker route', url: 'https://comic2.pages.dev/live-api/api/events/smokeprobe', kind: 'live-api' },
      htmlResponse(body),
      body,
      70
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('website HTML');
  });

  it('runs all targets through an injected fetcher and reports failures clearly', async () => {
    const targets: SmokeTarget[] = [
      { name: 'fallback app', url: 'https://comic2.pages.dev/', kind: 'frontend' },
      { name: 'primary app', url: 'https://dreamstreamstudio.ai/', kind: 'frontend' }
    ];

    const results = await runLiveSmoke({
      targets,
      timeoutMs: 100,
      fetcher: async (url) => {
        if (String(url).includes('dreamstreamstudio.ai')) {
          return htmlResponse('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>', {
            status: 403,
            headers: { server: 'cloudflare' }
          });
        }
        return htmlResponse('<div id="root"></div><script type="module" src="/assets/index.js"></script>');
      }
    });

    expect(results.map((result) => result.status)).toEqual(['pass', 'fail']);
    const report = formatSmokeReport(results);
    expect(report).toContain('PASS fallback app');
    expect(report).toContain('FAIL primary app');
    expect(report).toContain('Cloudflare challenge');
  });
});
