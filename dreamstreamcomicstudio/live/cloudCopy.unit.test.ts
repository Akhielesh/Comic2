// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ token: 'member-token' as string | null }));
vi.mock('./account', () => ({ accessToken: vi.fn(async () => h.token) }));

import { uploadRecording } from './api';
import {
  CloudCopyError,
  cloudCopyErrorFrom,
  fetchCloudCopyQuota,
  fitsQuota,
  parseQuota,
  quotaLine,
  quotaPct,
} from './cloudCopy';

const GB = 1024 ** 3;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  h.token = 'member-token';
});
afterEach(() => vi.unstubAllGlobals());

describe('cloud copy allowance — copy and maths', () => {
  it('reads as “kept 7 days · X of 10 GB used”', () => {
    expect(quotaLine({ usedBytes: 3.1 * GB, limitBytes: 10 * GB, copies: 2, nextFreeAt: null })).toBe('kept 7 days · 3.1 of 10 GB used');
    expect(quotaLine(null)).toBe('kept 7 days · up to 10 GB per account');
  });

  it('fits only what is left; unknown usage leaves it to the server', () => {
    const q = { usedBytes: 9 * GB, limitBytes: 10 * GB, copies: 3, nextFreeAt: null };
    expect(fitsQuota(q, GB)).toBe(true);
    expect(fitsQuota(q, GB + 1)).toBe(false);
    expect(fitsQuota(null, 50 * GB)).toBe(true);
    expect(quotaPct(q)).toBe(90);
  });

  it('an unfinished earlier try of this recording isn’t counted twice (a retry replaces it)', () => {
    // 6 GB of other copies + this recording's 3 GB unfinished try: the retry fits, as on the server.
    const q = { usedBytes: 9 * GB, limitBytes: 10 * GB, copies: 2, nextFreeAt: null, retryBytes: 3 * GB };
    expect(fitsQuota(q, 3 * GB)).toBe(true);
    expect(fitsQuota(q, 4 * GB + 1)).toBe(false);
    expect(fitsQuota({ ...q, retryBytes: undefined }, 3 * GB)).toBe(false);
  });

  it('reads the retry share only when there is one, and never more than what is used', () => {
    expect(parseQuota({ usedBytes: GB, limitBytes: 10 * GB, copies: 1, nextFreeAt: null, retryBytes: 0 })).toEqual({ usedBytes: GB, limitBytes: 10 * GB, copies: 1, nextFreeAt: null });
    expect(parseQuota({ usedBytes: GB, limitBytes: 10 * GB, copies: 1, nextFreeAt: null, retryBytes: 5 * GB })?.retryBytes).toBe(GB);
  });

  it('keeps the server’s honest reason, numbers and free-up day', async () => {
    const e = await cloudCopyErrorFrom(json({ error: 'cloud_copy_full', message: 'Your 10 GB of 7-day copies is full.', usedBytes: 9 * GB, limitBytes: 10 * GB, freesAt: 123 }, 413));
    expect(e).toBeInstanceOf(CloudCopyError);
    expect(e).toMatchObject({ code: 'cloud_copy_full', message: 'Your 10 GB of 7-day copies is full.', freesAt: 123, usedBytes: 9 * GB, limitBytes: 10 * GB });
    expect(e.isLimit).toBe(true);
    const other = await cloudCopyErrorFrom(new Response('oops', { status: 500 }));
    expect(other.code).toBe('failed');
    expect(other.isLimit).toBe(false);
    expect(other.message).toMatch(/still on this device/);
  });
});

describe('fetchCloudCopyQuota', () => {
  it('asks with the account’s own token, once', async () => {
    const f = vi.fn(async () => json({ usedBytes: GB, limitBytes: 10 * GB, copies: 1, nextFreeAt: 99 }));
    const q = await fetchCloudCopyQuota('ev1', 'hk 1', undefined, f as unknown as typeof fetch);
    expect(q).toEqual({ usedBytes: GB, limitBytes: 10 * GB, copies: 1, nextFreeAt: 99 });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/events\/ev1\/recordings\?op=quota&k=hk%201$/);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer member-token');
  });

  it('with the recording’s size, so the server can say what a retry replaces', async () => {
    const f = vi.fn(async () => json({ usedBytes: 9 * GB, limitBytes: 10 * GB, copies: 2, nextFreeAt: null, retryBytes: 3 * GB }));
    const q = await fetchCloudCopyQuota('ev1', 'hk', 3 * GB, f as unknown as typeof fetch);
    expect(q?.retryBytes).toBe(3 * GB);
    expect((f.mock.calls[0] as unknown as [string])[0]).toMatch(new RegExp(`op=quota&k=hk&bytes=${3 * GB}$`));
  });

  it('is null (never throws) when signed out, offline or refused', async () => {
    h.token = null;
    const f = vi.fn();
    expect(await fetchCloudCopyQuota('ev1', 'hk', 1, f as unknown as typeof fetch)).toBeNull();
    expect(f).not.toHaveBeenCalled();
    h.token = 'member-token';
    expect(await fetchCloudCopyQuota('ev1', 'hk', 1, (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch)).toBeNull();
    expect(await fetchCloudCopyQuota('ev1', 'hk', 1, (async () => json({ error: 'x' }, 503)) as unknown as typeof fetch)).toBeNull();
  });
});

describe('uploadRecording — the allowance is checked before anything is stored', () => {
  it('sends the size and the account token at init, and returns the updated allowance', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('op=init')) return json({ key: 'events/ev1/rec/1-a.webm', uploadId: 'u1', quota: { usedBytes: 2 * GB, limitBytes: 10 * GB, copies: 1, nextFreeAt: 5 } });
      if (url.includes('op=part')) return json({ partNumber: 1, etag: 'e1' });
      return json({ ok: true });
    }));
    const blob = new Blob([new Uint8Array(2048)], { type: 'video/webm' });
    const res = await uploadRecording('ev1', 'hk', blob, { file: 'a.webm', durMs: 1000 });
    expect(res.quota).toEqual({ usedBytes: 2 * GB, limitBytes: 10 * GB, copies: 1, nextFreeAt: 5 });
    const init = calls[0];
    expect(JSON.parse(String(init.init.body))).toMatchObject({ file: 'a.webm', bytes: 2048 });
    expect((init.init.headers as Record<string, string>).authorization).toBe('Bearer member-token');
    expect((init.init.headers as Record<string, string>)['x-host-key']).toBe('hk');
  });

  it('cuts parts at the size the server holds them to', async () => {
    const MiB = 1024 ** 2;
    const sizes: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('op=init')) return json({ key: 'k', uploadId: 'u1', partBytes: 5 * MiB, quota: null });
      if (url.includes('op=part')) {
        sizes.push((init.body as Blob).size);
        return json({ partNumber: sizes.length, etag: `e${sizes.length}` });
      }
      return json({ ok: true });
    }));
    await uploadRecording('ev1', 'hk', new Blob([new Uint8Array(11 * MiB)]), { file: 'a.webm', durMs: 1 });
    expect(sizes).toEqual([5 * MiB, 5 * MiB, MiB]);
  });

  it('a full allowance stops it at init with the server’s reason — no parts sent', async () => {
    const f = vi.fn(async () => json({ error: 'cloud_copy_full', message: 'Your 10 GB of 7-day copies is full.', freesAt: 7 }, 413));
    vi.stubGlobal('fetch', f);
    const err = await uploadRecording('ev1', 'hk', new Blob([new Uint8Array(10)]), { file: 'a.webm', durMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(CloudCopyError);
    expect(err).toMatchObject({ code: 'cloud_copy_full', freesAt: 7 });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
