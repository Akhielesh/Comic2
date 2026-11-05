// @vitest-environment node
// /og/<key>/og-<lang>-<hash>.jpg — P2-GATE L11: a moderation hold deletes pub/<key>/ (the takedown), so
// the served OG image must not be cacheable for long anywhere between here and the viewer.
import { describe, expect, it, vi } from 'vitest';
import { OG_MAX_AGE_SEC, handleOg } from './og/[[path]]';

const KEY = 'K1234567890abcdefghijk';
const get = (path: string, method = 'GET') => new Request(`https://comics.dreamstreamstudio.ai${path}`, { method });
const jpeg = () => vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { 'content-length': '3' } }));

describe('OG image caching after a takedown', () => {
  it('is cached for minutes, not a day, by browsers and shared caches alike', async () => {
    const res = await handleOg(get(`/og/${KEY}/og-en-0123456789ab.jpg`), {}, jpeg() as unknown as typeof fetch);
    expect(res.status).toBe(200);
    const cc = res.headers.get('cache-control') || '';
    const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1]);
    const sMaxAge = Number(/s-maxage=(\d+)/.exec(cc)?.[1]);
    expect(cc).toContain('public');
    expect(OG_MAX_AGE_SEC).toBeLessThanOrEqual(300);
    expect(maxAge).toBe(OG_MAX_AGE_SEC);
    expect(sMaxAge).toBe(OG_MAX_AGE_SEC);
    expect(cc).not.toMatch(/immutable|stale-while-revalidate|stale-if-error/);
    // HEAD gets the same policy with no body.
    const head = await handleOg(get(`/og/${KEY}/og-en-0123456789ab.jpg`, 'HEAD'), {}, jpeg() as unknown as typeof fetch);
    expect(head.headers.get('cache-control')).toBe(cc);
    expect(head.body).toBeNull();
  });

  it('a taken-down object (upstream 404/400) answers 404 no-store, so nothing caches the miss as a hit', async () => {
    for (const status of [404, 400]) {
      const gone = vi.fn(async () => new Response('', { status }));
      const res = await handleOg(get(`/og/${KEY}/og-en-0123456789ab.jpg`), {}, gone as unknown as typeof fetch);
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });
});
