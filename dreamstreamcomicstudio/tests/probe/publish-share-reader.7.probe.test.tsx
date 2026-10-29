// Probe (publish-share-reader, reader deep links): the inline reader writes ?lang= only for a
// non-source edition (ComicReaderView.tsx:512) and the language picker removes it for the source
// (readerLanguage.syncLangToUrl), but the immersive reader schedules `lang: language?.current`
// unconditionally (ImmersiveReader.tsx:580) — so after one page turn in the full-screen reader the
// address bar (and anything copied from it) carries ?lang=en for the original language, contradicting
// the canonical links buildShareUrl makes (lang dropped when it equals the default).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComicDoc } from '../../shared/comic/doc';
import { fakeUrlFor, makeSampleDoc } from '../../components/comicstudio/board/__fixtures__/sampleDoc';
import { ImmersiveReader } from '../../components/comicstudio/immersive/ImmersiveReader';
import { pageImageCache } from '../../components/comicstudio/immersive/pageImageCache';

const SLUG = 'AbCdEfGhIjKlMnOpQ';

const drawnDoc = (): ComicDoc =>
  makeSampleDoc((d) => {
    d.format = { ...d.format, language: 'en' };
    d.cover.render = { status: 'ready', history: [], asset: { path: 'u/cover.png', source: 'generated', at: 0, w: 1000, h: 1500 } };
    d.pages.forEach((p, i) => {
      p.render = { status: 'ready', history: [], asset: { path: `u/p${i + 1}.png`, source: 'generated', at: 0, w: 1000, h: 1500 } };
    });
  });

const realMatchMedia = window.matchMedia;

beforeEach(() => {
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
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['img'], { type: 'image/png' }), { status: 200 })));
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => 'blob:test/1';
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
  (HTMLImageElement.prototype as unknown as { decode: () => Promise<void> }).decode = () => Promise.resolve();
  vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
  window.history.replaceState(null, '', `/c/${SLUG}`);
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

describe('immersive reader URL sync', () => {
  it('never writes ?lang= for the comic’s own language (the inline reader and the canonical link builder drop it)', async () => {
    const language = {
      current: 'en',
      options: [
        { code: 'en', label: 'English', native: 'English', status: 'ready' as const },
        { code: 'hi', label: 'Hindi', native: 'हिन्दी', status: 'ready' as const }
      ],
      onChange: vi.fn()
    };
    render(<ImmersiveReader doc={drawnDoc()} urlFor={fakeUrlFor} intro={false} syncUrl language={language} onExit={() => undefined} />);
    const root = screen.getByTestId('immersive-reader');
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    await waitFor(() => expect(window.location.search).toContain('p=1'), { timeout: 2000 });
    expect(window.location.search).not.toMatch(/lang=/);
  });
});
