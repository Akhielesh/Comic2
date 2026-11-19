// A look's static art has one plug-in point (stylepick SC-1): lookSources.ts. LibraryImage's fallback for a look's
// library preview (style.<id>, when the index has no published preview or it fails) reads the same lookSourcesOf as
// LookArt, so when the look-samples work gives a look a picture there, every surface paints it, and no surface keeps
// its own list of files. Here lookSourcesOf gives cartoon-strip (a look with no bundled art) a picture.
import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STYLE_PRESETS } from '../../../shared/comic/stylePresets';
import { stylePreviewId } from '../../../shared/comic/library';
import { LibraryImage } from './LibraryImage';
import { LookArt } from './LookArt';
import { __resetComicLibraryForTests, loadComicLibrary } from './useComicLibrary';

/** Let the index request fail, so LibraryImage is past loading and on its fallback. */
const indexFailed = () => act(async () => {
  await loadComicLibrary();
});

const { EXTRA } = vi.hoisted(() => ({
  EXTRA: { w320: '/assets/looks/cartoon-strip-320.webp', w640: '/assets/looks/cartoon-strip-640.webp', size: { width: 640, height: 512 } }
}));

vi.mock('./lookSources', async (importOriginal) => {
  const real = await importOriginal<typeof import('./lookSources')>();
  return {
    ...real,
    lookSourcesOf: (id: string) => (id === 'cartoon-strip' ? { scene: EXTRA, pages: [] } : real.lookSourcesOf(id))
  };
});

beforeEach(() => {
  __resetComicLibraryForTests();
  // The index is not there: every LibraryImage below falls back.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 503 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  __resetComicLibraryForTests();
});

describe('LibraryImage falls back to the look\'s picture from lookSources', () => {
  it('a look lookSources gives a picture paints it in LibraryImage too, with its own size', async () => {
    const { container } = render(<LibraryImage id={stylePreviewId('cartoon-strip')} fallback={<span>procedural</span>} />);
    await indexFailed();
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', EXTRA.w320);
    expect([img!.getAttribute('width'), img!.getAttribute('height')]).toEqual(['640', '512']);
    const look = render(<LookArt presetId="cartoon-strip" size="tile" />);
    expect(look.container.querySelector('img')).toHaveAttribute('src', EXTRA.w320);
  });

  it('every look shows the same file in LibraryImage\'s fallback as in LookArt (or the fallback when it has none)', async () => {
    let pictured = 0;
    for (const preset of STYLE_PRESETS) {
      const art = render(<LookArt presetId={preset.id} size="tile" />);
      const want = art.container.querySelector('img')?.getAttribute('src') ?? null;
      art.unmount();
      const lib = render(<LibraryImage id={stylePreviewId(preset.id)} fallback={<span data-testid="fb">procedural</span>} />);
      await indexFailed();
      expect(lib.container.querySelector('img')?.getAttribute('src') ?? null, preset.id).toBe(want);
      if (!want) expect(lib.queryByTestId('fb'), preset.id).not.toBeNull();
      if (want) pictured += 1;
      lib.unmount();
    }
    // The six Paper Boat looks and the one lookSourcesOf gives here.
    expect(pictured).toBe(7);
  });

  it('a cast bust id never borrows the look\'s scene', async () => {
    const { container, getByText } = render(<LibraryImage id={`${stylePreviewId('cartoon-strip')}.cast`} fallback={<span>procedural</span>} />);
    await indexFailed();
    expect(getByText('procedural')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});
