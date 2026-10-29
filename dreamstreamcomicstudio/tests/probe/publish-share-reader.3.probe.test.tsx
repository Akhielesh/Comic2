// Probe (publish-share-reader, analytics): every share action tags the link with ?via=<channel>
// (shareModel.shareLinkFor / ShareLinkCard withVia / QrCode via:'qr'), and the owner's Share sheet shows
// "Top channels" from stats.byChannel7d. But the public reader never reads ?via= — SlugReader.track
// (PublicComicReader.tsx:643) sends view events with no channel, so the edge records every view as
// "direct" and the channel breakdown the owner sees is meaningless.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { ComicDoc } from '../../shared/comic/doc';
import type { PublicComicPayload } from '../../shared/comic/publication';
import { makeSampleDoc } from '../../components/comicstudio/board/__fixtures__/sampleDoc';
import { pageImageCache } from '../../components/comicstudio/immersive/pageImageCache';

const api = vi.hoisted(() => ({
  loadPublicComic: vi.fn(),
  loadPublicComicBySlug: vi.fn(),
  trackPublicEvent: vi.fn(async () => undefined),
  reportPublicComic: vi.fn(async () => undefined)
}));
vi.mock('../../components/comicstudio/studioApi', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../components/comicstudio/studioApi')>()), ...api }));

const { PublicComicReader } = await import('../../components/comicstudio/PublicComicReader');

const SLUG = 'AbCdEfGhIjKlMnOpQ';
const KEY = 'AbCdEfGhIjKlMnOpQrStUv';

const snapshotDoc = (): ComicDoc =>
  makeSampleDoc((d) => {
    d.cover.render = { status: 'ready', history: [], asset: { path: `pub/${KEY}/cover.webp`, source: 'generated', at: 0, w: 1000, h: 1500 } };
    d.pages.forEach((p, i) => {
      p.render = { status: 'ready', history: [], asset: { path: `pub/${KEY}/p${i + 1}.webp`, source: 'generated', at: 0, w: 1000, h: 1500 } };
    });
  });

const payload = (): PublicComicPayload => {
  const doc = snapshotDoc();
  return {
    publication: {
      slug: SLUG,
      visibility: 'unlisted',
      languages: ['en'],
      allowDownload: true,
      allowEmbed: true,
      publishedAt: 1,
      updatedAt: 1,
      card: { v: 1, title: 'The Saffron Thief', description: 'x', kindLabel: 'Comic', pageCount: 6, aspect: '2:3', og: {}, i18n: {} }
    },
    doc,
    urls: Object.fromEntries([doc.cover.render.asset, ...doc.pages.map((p) => p.render.asset)].filter(Boolean).map((a) => [a!.path, `https://public.test/${a!.path}`]))
  };
};

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.trackPublicEvent.mockResolvedValue(undefined);
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['img'], { type: 'image/png' }), { status: 200 })));
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => 'blob:test/1';
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
  (HTMLImageElement.prototype as unknown as { decode: () => Promise<void> }).decode = () => Promise.resolve();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  pageImageCache.clear();
  window.history.replaceState(null, '', '/');
});

describe('share-link channel attribution', () => {
  it('opening a link copied from the Share sheet (?via=whatsapp) records the view under that channel', async () => {
    window.history.replaceState(null, '', `/c/${SLUG}?via=whatsapp`);
    api.loadPublicComicBySlug.mockResolvedValue(payload());
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    await waitFor(() => expect(api.trackPublicEvent).toHaveBeenCalled());
    const [slug, event] = api.trackPublicEvent.mock.calls[0] as unknown as [string, { type: string; channel?: string }];
    expect(slug).toBe(SLUG);
    expect(event.type).toBe('view');
    // The edge (api-proxy/src/publicComic.ts:210) stores body.channel, else 'direct'.
    expect(event.channel).toBe('whatsapp');
  });
});
