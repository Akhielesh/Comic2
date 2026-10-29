// Probe (publish-share-reader, embed route when the author turned embedding OFF):
// functions/c/[[path]].ts answers /c/<slug>/embed with the 404 shell and boot {"notFound":true}
// ("Link not active"). But readShareBoot (usePublicComic.ts:81) drops that boot (no slug), the SPA fetches
// /api/comic/public/s/<slug> (which knows nothing about embed) and renders the comic in embed chrome on a
// page the server called "not active" — the author's "Allow embedding: off" is only enforced for framed
// loads (frame-ancestors), not for the /embed address itself.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
      allowEmbed: false,
      publishedAt: 1,
      updatedAt: 1,
      card: { v: 1, title: 'The Saffron Thief', description: 'x', kindLabel: 'Comic', pageCount: 6, aspect: '2:3', og: {}, i18n: {} }
    },
    doc,
    urls: Object.fromEntries([doc.cover.render.asset, ...doc.pages.map((p) => p.render.asset)].filter(Boolean).map((a) => [a!.path, `https://public.test/${a!.path}`]))
  };
};

const setBoot = (boot: Record<string, unknown>) => {
  const el = document.createElement('script');
  el.type = 'application/json';
  el.id = 'ds-share-boot';
  el.textContent = JSON.stringify(boot);
  document.body.appendChild(el);
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
  window.history.replaceState(null, '', `/c/${SLUG}/embed`);
});
afterEach(() => {
  document.getElementById('ds-share-boot')?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  pageImageCache.clear();
  window.history.replaceState(null, '', '/');
});

describe('/c/<slug>/embed with embedding turned off', () => {
  it('shows the same "This link isn’t active" the server answered, not the comic', async () => {
    setBoot({ notFound: true }); // what functions/c/[[path]].ts injects for /embed when allowEmbed is false
    api.loadPublicComicBySlug.mockResolvedValue(payload());
    render(<PublicComicReader source={{ kind: 'slug', slug: SLUG, embed: true }} />);
    expect(await screen.findByText('This link isn’t active')).toBeInTheDocument();
    expect(screen.queryByTestId('comic-reader')).toBeNull();
  });
});
