// The three Comic Studio roots carry the Atlas skin attribute wherever they mount (docs/design/
// atlas-skin.md "Scope"): on the apex, where <html> has no skin, each root is the boundary the
// `[data-ds-skin="atlas"]` token overrides apply from. The immersive reader is portaled to <body>,
// so it must carry its own. jsdom: no skin on <html> (localhost), exactly like the apex.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ComicStudioController } from './useStudio';
import { makeFakeStudio } from './conversation/testing/fixtures';
import { fakeUrlFor, makeSampleDoc } from './board/__fixtures__/sampleDoc';
import { pageImageCache } from './immersive/pageImageCache';
import { FormFactorProvider, formFactorFor } from './mobile/useFormFactor';
import { COMIC_STUDIO_SKIN, DS_SKIN_ATTR } from '../../services/productHost';

vi.mock('./board/BoardPane', () => ({
  BoardPane: ({ studio }: { studio: ComicStudioController }) => <div data-testid="board">Board · {studio.tab}</div>
}));
vi.mock('../studio/kit/useMediaQuery', () => ({ useIsWide: () => true, useMediaQuery: () => true }));
vi.mock('./features', async (importOriginal) => ({ ...(await importOriginal<typeof import('./features')>()), registeredCard: () => undefined }));
const api = vi.hoisted(() => ({ loadPublicComic: vi.fn(), loadPublicComicBySlug: vi.fn(), trackPublicEvent: vi.fn(async () => undefined) }));
vi.mock('./studioApi', async (importOriginal) => ({ ...(await importOriginal<typeof import('./studioApi')>()), ...api }));
vi.mock('./export/pdfExport', () => ({ exportComicPdf: vi.fn() }));

const { ComicStudioShell } = await import('./ComicStudio');
const { PublicComicReader } = await import('./PublicComicReader');
const { ImmersiveReader } = await import('./immersive/ImmersiveReader');

const DESKTOP = formFactorFor({ w: 1440, h: 900, coarse: false });

beforeEach(() => {
  api.loadPublicComic.mockReset();
  api.loadPublicComic.mockReturnValue(new Promise(() => undefined)); // the shell renders while loading
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['img'], { type: 'image/png' }), { status: 200 })));
  let n = 0;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:test/${(n += 1)}`;
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
  (HTMLImageElement.prototype as unknown as { decode: () => Promise<void> }).decode = () => Promise.resolve();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
  pageImageCache.clear();
});

describe('Comic Studio roots carry data-ds-skin="atlas" on the apex', () => {
  it('<html> has no skin here (the apex case the roots must cover)', () => {
    expect(document.documentElement.hasAttribute(DS_SKIN_ATTR)).toBe(false);
    expect(COMIC_STUDIO_SKIN).toBe('atlas');
  });

  it('the Comic Studio shell root', () => {
    render(
      <FormFactorProvider value={DESKTOP}>
        <ComicStudioShell studio={makeFakeStudio()} onBack={() => undefined} />
      </FormFactorProvider>
    );
    const root = document.querySelector('.gesture-root[data-layout]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute(DS_SKIN_ATTR)).toBe(COMIC_STUDIO_SKIN);
    // The attribute is on the outermost studio element: nothing above it inside #root carries chrome.
    expect(root?.parentElement?.closest(`[${DS_SKIN_ATTR}]`)).toBeNull();
  });

  it('the public reader root (slug and project modes, including while loading)', () => {
    const { unmount } = render(<PublicComicReader projectId="proj_1" onClose={() => undefined} />);
    expect(screen.getByTestId('public-comic-reader').getAttribute(DS_SKIN_ATTR)).toBe(COMIC_STUDIO_SKIN);
    unmount();
    api.loadPublicComicBySlug.mockReturnValue(new Promise(() => undefined));
    render(<PublicComicReader source={{ kind: 'slug', slug: 'AbCdEfGhIjKlMnOpQ' }} />);
    expect(screen.getByTestId('public-comic-reader').getAttribute(DS_SKIN_ATTR)).toBe(COMIC_STUDIO_SKIN);
  });

  it('the immersive reader root (portaled to <body>, so it carries its own)', () => {
    const doc = makeSampleDoc((d) => {
      d.cover.render = { status: 'ready', history: [], asset: { path: 'u/cover.png', source: 'generated', at: 0, w: 1000, h: 1500 } };
    });
    render(<ImmersiveReader doc={doc} urlFor={fakeUrlFor} intro={false} onExit={() => undefined} />);
    const root = screen.getByTestId('immersive-reader');
    expect(root.getAttribute(DS_SKIN_ATTR)).toBe(COMIC_STUDIO_SKIN);
    expect(root.parentElement).toBe(document.body);
    // The room is content: it keeps the reader tokens, not the skin's canvas.
    expect(root.style.background).toContain('--ds-reader-room');
  });
});
