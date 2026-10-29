// Probe (publish-share-reader, download permission in the full-screen reader opened from the inline view):
// On a share link the header's Download menu is gated by publication.allowDownload (PublicComicReader.tsx:188,
// :310). The cover card's "Read" opens ImmersiveReader with allowDownload/onDownload (:616-618), but the
// inline reader (a ?p= deep link, or "Read on this page") is mounted WITHOUT allowDownload/onDownload
// (:522-561, only the embed gets onDownload) and forwards those props to the ImmersiveReader its own
// "Full screen" button opens (ComicReaderView.tsx:985-986). So the full-screen reader reached that way has
// no Download in its HUD or End card while the header's Download menu sits hidden under the portal.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const realMatchMedia = window.matchMedia;

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.trackPublicEvent.mockResolvedValue(undefined);
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? true : query.includes('hover: hover') || query.includes('any-pointer: fine'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['img'], { type: 'image/png' }), { status: 200 })));
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => 'blob:test/1';
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
  (HTMLImageElement.prototype as unknown as { decode: () => Promise<void> }).decode = () => Promise.resolve();
  vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
  window.history.replaceState(null, '', `/c/${SLUG}?p=1`);
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  pageImageCache.clear();
  window.history.replaceState(null, '', '/');
});

describe('downloads allowed by the author, full-screen reader opened from the inline view', () => {
  it('the immersive HUD offers Download like the one opened from the cover card does', async () => {
    api.loadPublicComicBySlug.mockResolvedValue(payload());
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG }} />);
    // The deep link opens the inline reader; the header's Download menu proves downloads are allowed.
    await screen.findByTestId('comic-reader');
    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Full screen/ }));
    const dialog = await screen.findByTestId('immersive-reader');
    await waitFor(() => expect(dialog.querySelector('[data-testid="reader-hud"]')).not.toBeNull());
    const hud = dialog.querySelector('[data-testid="reader-hud"]') as HTMLElement;
    expect(Array.from(hud.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') || b.textContent?.trim())).toContain('Download');
  });
});
