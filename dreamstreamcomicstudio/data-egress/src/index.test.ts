// @vitest-environment node
// abuse-ops-12: the data-egress relay fails CLOSED. Without EGRESS_SHARED_SECRET it answers 503 (and
// logs why) instead of relaying for anyone; with it, a missing or wrong x-egress-key is a 403, and only
// the matching key reaches the allowlisted upstream.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { sameSecret } from './index';

const upstream = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => {
  upstream.mockClear();
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TARGET = 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d';
const call = (env: { EGRESS_SHARED_SECRET?: string }, key?: string, target = TARGET) =>
  worker.fetch(
    new Request(`https://dreamstreamstudio.ai/egress/fetch?url=${encodeURIComponent(target)}`, {
      headers: key === undefined ? {} : { 'x-egress-key': key }
    }),
    env
  );

describe('data-egress relay', () => {
  it('with no secret configured: 503 for everyone, logged, and nothing is fetched', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const env of [{}, { EGRESS_SHARED_SECRET: '' }, { EGRESS_SHARED_SECRET: '   ' }]) {
      const res = await call(env, 'anything');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: { message: 'Relay not configured' } });
    }
    expect(upstream).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1); // once per isolate, not per request
    expect(String(log.mock.calls[0][0])).toMatch(/EGRESS_SHARED_SECRET is not set/);
  });

  it('a missing or wrong key: 403, nothing fetched', async () => {
    const env = { EGRESS_SHARED_SECRET: 's3cret-value' };
    for (const key of [undefined, '', 's3cret', 's3cret-value-x', 'S3CRET-VALUE']) {
      const res = await call(env, key);
      expect([key, res.status]).toEqual([key, 403]);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('the matching key relays to an allowlisted host (the secret is trimmed like the backend’s)', async () => {
    const res = await call({ EGRESS_SHARED_SECRET: ' s3cret-value\n' }, 's3cret-value');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-egress-host')).toBe('query1.finance.yahoo.com');
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(String((upstream.mock.calls[0] as unknown[])[0])).toBe(TARGET);
  });

  it('the allowlist still holds with a good key', async () => {
    const res = await call({ EGRESS_SHARED_SECRET: 'k' }, 'k', 'https://169.254.169.254/latest/meta-data/');
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('sameSecret compares exactly (no prefix or empty match)', async () => {
    expect(await sameSecret('abc', 'abc')).toBe(true);
    expect(await sameSecret('ab', 'abc')).toBe(false);
    expect(await sameSecret('abcd', 'abc')).toBe(false);
    expect(await sameSecret('', '')).toBe(false);
  });
});
