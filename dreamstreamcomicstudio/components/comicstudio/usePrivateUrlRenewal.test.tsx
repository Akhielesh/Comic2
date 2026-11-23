import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePrivateUrlRenewal } from './usePrivateUrlRenewal';
import { mergeUrls, urlIsFresh } from './signedAssets';

const path = 'u/member/p/project/img/draft-v1-12345678-1234-4000-8000-123456789abc.webp';

describe('private preview lifetime', () => {
  it('batches the signed original and thumbnail 30 seconds before their actual expiration, then hides them at expiry', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const jwt = 'x.' + btoa(JSON.stringify({ exp: Math.floor(now / 1000) + 300 })) + '.x';
      const url = 'https://storage.example/storage/v1/object/sign/comic-private/' + path + '?token=' + jwt;
      const thumbnail = path.replace('.webp', '_w480.webp');
      const entries = mergeUrls({}, { [path]: url, [thumbnail]: url, 'pub/cover.webp': 'https://cdn.test/cover' }, now);
      expect(urlIsFresh(entries[path], now, path)).toBe(true);
      const renew = vi.fn();
      const expire = vi.fn();
      const { unmount } = renderHook(() => usePrivateUrlRenewal(entries, renew, expire));
      const until = entries[path].expiresAt - now;
      await act(async () => { await vi.advanceTimersByTimeAsync(until - 30_001); });
      expect(renew).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(renew).toHaveBeenCalledExactlyOnceWith([path, thumbnail]);
      expect(expire).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(expire).toHaveBeenCalledTimes(1);
      unmount();
    } finally { vi.useRealTimers(); }
  });

  it('never extends a repeated opaque private signature or accepts a constructed public URL for a draft', () => {
    const signed = { [path]: 'https://signed.test/opaque' };
    const entries = mergeUrls({}, signed, 0);
    expect(mergeUrls(entries, signed, 120_000)[path].expiresAt).toBe(300_000);
    const raw = 'https://db.test/storage/v1/object/public/comic-assets/' + path;
    expect(mergeUrls(entries, { [path]: raw }, 20_000)).not.toHaveProperty(path);
  });
});
