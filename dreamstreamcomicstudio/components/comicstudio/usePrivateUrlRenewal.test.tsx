import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePrivateUrlRenewal } from './usePrivateUrlRenewal';
import { legacyPagePath, signedLegacyPreview } from './legacyPreview.testkit';
import { directDisplayUrl, mergeUrls, refreshSignedUrls, studioBitmapKey, urlIsFresh } from './signedAssets';

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

describe('owner receipts for original Director artwork', () => {
  it('caps long historical signatures from issue, preserves exact private variants and rejects stale downgrades', () => {
    const path = legacyPagePath.replace('.webp', '_w480.webp');
    const now = Math.floor(Date.now() / 1000) * 1000;
    const old = signedLegacyPreview(path, 'custom-public', now - 60_000, 3600);
    const first = mergeUrls({}, { [path]: old }, now);
    expect(first[path].expiresAt).toBe(now + 240_000);
    const moved = signedLegacyPreview(path, 'custom.private-v2', now + 230_000, 300, true);
    const next = refreshSignedUrls(first, [path], { [path]: moved }, now + 230_000);
    expect(next[path].url).toBe(moved);
    expect(studioBitmapKey(path, moved)).not.toBe(studioBitmapKey(path, old));
    expect(refreshSignedUrls(next, [path], { [path]: old }, now + 235_000)[path]).toEqual(next[path]);
    expect(refreshSignedUrls(next, [path], {}, now + 235_000)).not.toHaveProperty(path);
    expect(directDisplayUrl(old)).toBeUndefined();
    expect(directDisplayUrl(moved)).toBeUndefined();
    expect(directDisplayUrl(moved.replace('/sign/custom.private-v2/', '/public/u/'))).toBeUndefined();
    expect(directDisplayUrl('https://example.test/storage/v1/object/public/comic-assets/pub/p/cover.webp')).toBeTruthy();
  });

  it('rejects mismatched key or claim, lookalike storage routes and document/blob fallbacks for the migrated key', () => {
    const now = Date.now();
    const path = legacyPagePath;
    const valid = signedLegacyPreview(path, 'comic-private', now);
    const other = signedLegacyPreview(path + '.other', 'comic-private', now).replace('page.webp.other?', 'page.webp?');
    const refused = [valid.replace('/object/sign/', '/object/public/'), valid.replace('/sign/comic-private/', '/sign/comic-assets/'),
      other, valid.replace('/storage/v1/', '/untrusted/storage/v1/'), 'blob:cached-public', 'data:image/png;base64,YQ=='];
    if (import.meta.env.VITE_SUPABASE_URL) refused.push(valid.replace(new URL(valid).origin, 'https://lookalike.invalid'));
    for (const url of refused) {
      expect(mergeUrls({}, { [path]: url }, now)[path]).toBeUndefined();
      expect(studioBitmapKey(path, url)).toBeUndefined();
    }
  });
});
