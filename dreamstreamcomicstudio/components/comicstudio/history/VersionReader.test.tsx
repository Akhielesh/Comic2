// The read-only reader re-signs expired images (package H5, review round). The book (…/history/:vid/book) may come
// from the browser cache while its signed URLs are short-lived: when an image fails, the reader asks the uncached
// POST …/urls for the book's display images again — once each, so a truly broken image never loops.
//
// ComicReaderView is stubbed here (its own tests own its image error wiring): the stub exposes onImageError and the
// urlFor it was given.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { displayAssetPaths } from '../../../shared/comic/doc';
import { resetBackStack } from '../mobile/backStack';
import { legacyPagePath, signedLegacyPreview } from '../legacyPreview.testkit';
import { VersionReader } from './VersionReader';
import { historySetup, HISTORY_NOW, HISTORY_TZ, mountWith, settle } from './history.testkit';

const seen: { urlFor?: (p: string) => string | undefined; firstPath?: string } = {};

vi.mock('../reader/ComicReaderView', () => ({
  ComicReaderView: (props: { doc: { pages: { render: { asset?: { path: string } } }[] }; urlFor(p: string): string | undefined; onImageError?: () => void }) => {
    seen.urlFor = props.urlFor;
    seen.firstPath = props.doc.pages.find((p) => p.render.asset)?.render.asset?.path;
    return (
      <button type="button" onClick={() => props.onImageError?.()}>
        An image failed
      </button>
    );
  }
}));

beforeEach(() => resetBackStack());
afterEach(() => resetBackStack());

describe('the read-only reader re-signs expired images', () => {
  it('keeps history open as migrated artwork renews, and masks it as soon as the version signer refuses access', async () => {
    const path = legacyPagePath;
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const first = signedLegacyPreview(path, 'comic-assets', now);
      const second = signedLegacyPreview(path, 'comic-private', now + 271_000);
      const m = historySetup({ studio: { urlFor: () => first } });
      const book = await m.api.book(m.fixture.live.id, 'ver_before');
      book.doc.pages[0].render.asset = { ...book.doc.pages[0].render.asset!, path };
      m.api.book = vi.fn().mockResolvedValue({ ...book, urls: { [path]: first } });
      m.api.urls = vi.fn().mockResolvedValueOnce({ [path]: second }).mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
      mountWith(m, <VersionReader studio={m.studio} versionId="ver_before" now={HISTORY_NOW} tz={HISTORY_TZ} onCompare={vi.fn()} onRestore={vi.fn()} onBack={vi.fn()} />);
      await settle();
      expect(seen.urlFor!(path)).toBe(first);
      now += 271_000;
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      await act(async () => settle());
      expect(seen.urlFor!(path)).toBe(second);
      now += 271_000;
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      await act(async () => settle());
      expect(seen.urlFor!(path)).toBeUndefined();
      expect(m.api.urls).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
  });

  it('an image that fails asks for fresh URLs of the book’s images once, and uses them', async () => {
    const m = historySetup();
    mountWith(m, <VersionReader studio={m.studio} versionId="ver_before" now={HISTORY_NOW} tz={HISTORY_TZ} onCompare={vi.fn()} onRestore={vi.fn()} onBack={vi.fn()} />);
    await settle();
    const doc = m.fixture.versions.find((v) => v.row.id === 'ver_before')!.doc;
    const path = seen.firstPath!;
    const cached = seen.urlFor!(path);
    expect(cached).toBeTruthy();
    expect(m.api.calls.filter((c) => c.method === 'urls')).toHaveLength(0);

    // Make the fresh signature distinguishable from the cached one.
    const urls = m.api.urls.bind(m.api);
    m.api.urls = async (projectId, versionId, paths) => {
      const got = await urls(projectId, versionId, paths);
      return Object.fromEntries(Object.entries(got).map(([k, v]) => [k, `${v}#fresh`]));
    };
    fireEvent.click(screen.getByRole('button', { name: 'An image failed' }));
    await act(async () => settle());
    const asked = m.api.calls.filter((c) => c.method === 'urls');
    expect(asked).toHaveLength(1);
    expect([...(asked[0].args[2] as string[])].sort()).toEqual([...new Set(displayAssetPaths(doc))].sort());
    expect(seen.urlFor!(path)).toMatch(/#fresh$/);
    expect(seen.urlFor!(path)).not.toBe(cached);

    // Again: nothing more is asked (each path is re-signed once per moment).
    fireEvent.click(screen.getByRole('button', { name: 'An image failed' }));
    await act(async () => settle());
    expect(m.api.calls.filter((c) => c.method === 'urls')).toHaveLength(1);
  });
});
