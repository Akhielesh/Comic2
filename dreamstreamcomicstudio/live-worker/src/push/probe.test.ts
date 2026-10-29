// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { classifyApnsProbe, handleApnsProbe, opsKeyMatches, PROBE_DEVICE_TOKEN, probeAdrLine, probeApns } from './probe';
import probeWorker from './probeWorker';
import { hexBytes, recordingFetch, type FixtureResponse } from './testKit';
import fixtures from './fixtures/apns/responses.json';

interface Case {
  name: string;
  source: string;
  response: FixtureResponse & { headers: Record<string, string>; body: string };
}
const fx = fixtures as unknown as { cases: Case[]; http1: { rawHex: string } };
const RECORDED_PASS = fx.cases.find((c) => c.source === 'recorded' && c.name.startsWith('sandbox'))!.response;
const KEY = 'k'.repeat(32);

/** What a Worker without HTTP/2 gets back from APNs: HTTP/2 frames it can't parse (recorded). */
const http1Failure = () =>
  recordingFetch(() => {
    const text = new TextDecoder().decode(hexBytes(fx.http1.rawHex));
    throw new TypeError(`Parse Error: Expected HTTP/ (${text.slice(text.indexOf('Unexpected'), text.indexOf('Unexpected') + 27)})`);
  });

describe('classifying the probe', () => {
  it('the recorded APNs answer passes: a JSON reason with an apns-id', async () => {
    const { fetcher, calls } = recordingFetch(() => RECORDED_PASS);
    const r = await probeApns({ fetcher });
    expect(r).toMatchObject({ verdict: 'pass', decision: 'apns-direct', status: 403, apnsId: 'BEB26349-5C0C-CE80-467D-9F2E56DD7880', reason: 'MissingProviderToken', host: 'sandbox' });
    // The probe itself: sandbox, a dummy token, no provider token at all.
    expect(calls[0]).toMatchObject({ method: 'POST', url: `https://api.sandbox.push.apple.com/3/device/${PROBE_DEVICE_TOKEN}` });
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it('APNs refusing an HTTP/1.x request (the recorded GOAWAY) is a fail → FCM for iOS', async () => {
    expect(new TextDecoder().decode(hexBytes(fx.http1.rawHex))).toContain('Unexpected HTTP/1.x request');
    const r = await probeApns({ fetcher: http1Failure().fetcher });
    expect(r).toMatchObject({ verdict: 'fail', decision: 'fcm-for-ios', status: 0, apnsId: null });
    expect(r.detail).toMatch(/No HTTP\/2 answer/);
    expect(r.error).toMatch(/Parse Error/);
  });

  it('a response without apns-id (a proxy error page, say) is a fail', async () => {
    const { fetcher } = recordingFetch(() => ({ status: 502, headers: { 'content-type': 'text/html' }, body: '<html>Bad gateway</html>' }));
    expect(await probeApns({ fetcher })).toMatchObject({ verdict: 'fail', status: 502, apnsId: null });
    expect(classifyApnsProbe({ status: 403, apnsId: 'X', body: 'not json' }).verdict).toBe('fail');
  });

  it('can probe the production host too', async () => {
    const { fetcher, calls } = recordingFetch(() => fx.cases.find((c) => c.name.startsWith('production'))!.response);
    expect((await probeApns({ fetcher, host: 'production' })).verdict).toBe('pass');
    expect(calls[0].url.startsWith('https://api.push.apple.com/3/device/')).toBe(true);
  });

  it('prints the ADR line for either outcome', async () => {
    const pass = await probeApns({ fetcher: recordingFetch(() => RECORDED_PASS).fetcher, now: () => Date.UTC(2026, 9, 28) });
    expect(probeAdrLine({ ...pass, colo: 'SJC' })).toBe(
      '- **APNs probe 2026-10-28 (Cloudflare production, SJC, sandbox): pass** — HTTP 403 `MissingProviderToken` with `apns-id` BEB26349-5C0C-CE80-467D-9F2E56DD7880. Decision: **send to APNs directly**.',
    );
    const fail = await probeApns({ fetcher: http1Failure().fetcher, now: () => Date.UTC(2026, 9, 28) });
    expect(probeAdrLine(fail)).toMatch(/^- \*\*APNs probe 2026-10-28 \(Cloudflare production, sandbox\): fail\*\* — No HTTP\/2 answer .* Decision: \*\*FCM for iOS\*\*/);
  });
});

describe('the probe endpoint', () => {
  const post = (key?: string, q = '') => new Request(`https://probe.example/probe${q}`, { method: 'POST', headers: key ? { 'x-ops-key': key } : {} });

  it('needs POST and the ops key, and fails closed without a configured secret', async () => {
    const { fetcher, calls } = recordingFetch(() => RECORDED_PASS);
    expect((await handleApnsProbe(new Request('https://probe.example/probe'), KEY, { fetcher })).status).toBe(405);
    expect((await handleApnsProbe(post('wrong'), KEY, { fetcher })).status).toBe(403);
    expect((await handleApnsProbe(post(), KEY, { fetcher })).status).toBe(403);
    expect((await handleApnsProbe(post(KEY), undefined, { fetcher })).status).toBe(403);
    expect((await handleApnsProbe(post('short'), 'short', { fetcher })).status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(await opsKeyMatches(KEY, KEY)).toBe(true);
  });

  it('answers the result as JSON, uncached, with the data centre when known', async () => {
    const { fetcher } = recordingFetch(() => RECORDED_PASS);
    const req = post(KEY, '?host=production') as Request & { cf?: unknown };
    Object.defineProperty(req, 'cf', { value: { colo: 'LHR' } });
    const res = await handleApnsProbe(req, KEY, { fetcher });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ verdict: 'pass', host: 'production', colo: 'LHR', status: 403 });
  });

  it('the throwaway Worker serves only /probe (and the ops path)', async () => {
    expect((await probeWorker.fetch(new Request('https://w.example/', { method: 'POST' }), { OPS_KEY: KEY })).status).toBe(404);
    expect((await probeWorker.fetch(new Request('https://w.example/probe', { method: 'POST' }), {})).status).toBe(403);
    expect((await probeWorker.fetch(new Request('https://w.example/probe', { method: 'GET' }), { OPS_KEY: KEY })).status).toBe(405);
  });
});
