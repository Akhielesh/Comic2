// LookArt (stylepick SC-1): one picture for a look on every style surface. It paints static files at once (the
// bundled sample art for the six Paper Boat looks), never reads the library index, never fetches, and never shows
// a placeholder first. Looks without a picture yet keep the interim drawn thumbnail (removed with SC-5); a picture
// that fails to load becomes the look's swatch. lookSourcesOf is the one place a look's files are named.
import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStylePreset, type StylePreset } from '../../../shared/comic/stylePresets';
import { LookArt } from './LookArt';
import { lookPictureOf, lookSourcesOf } from './lookSources';
import { SAMPLE_LOOKS } from './sampleArt';

const presetOf = (id: string): StylePreset => {
  const p = getStylePreset(id);
  if (!p) throw new Error(`no preset ${id}`);
  return p;
};

/** The swatch as the browser keeps it (jsdom rewrites the gradient's colours). */
const swatchCss = (preset: StylePreset) => {
  const probe = document.createElement('span');
  probe.style.background = preset.swatch;
  return probe.style.background;
};

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lookSourcesOf', () => {
  it('names the bundled thumb as the scene and the two sample pages for each Paper Boat look', () => {
    for (const look of SAMPLE_LOOKS) {
      const s = lookSourcesOf(look);
      expect(s.scene, look).toEqual({ w320: `/assets/comic-sample/${look}-thumb.webp`, w640: `/assets/comic-sample/${look}-thumb.webp` });
      expect(s.pages, look).toEqual([`/assets/comic-sample/${look}-1.webp`, `/assets/comic-sample/${look}-2.webp`]);
      expect(s.cast, look).toBeUndefined();
    }
  });

  it('a look without art (or an unknown id) has no scene and no pages', () => {
    expect(lookSourcesOf('cartoon-strip')).toEqual({ pages: [] });
    expect(lookSourcesOf('nope')).toEqual({ pages: [] });
    expect(lookSourcesOf('__proto__')).toEqual({ pages: [] });
  });

  it('tile reads w320; large reads w640, or the first sample page when the scene has no larger file', () => {
    const bundled = lookSourcesOf('noir-ink');
    expect(lookPictureOf(bundled, 'tile')).toBe('/assets/comic-sample/noir-ink-thumb.webp');
    expect(lookPictureOf(bundled, 'large')).toBe('/assets/comic-sample/noir-ink-1.webp');
    const sized = { scene: { w320: '/a@320.webp', w640: '/a@640.webp' }, pages: ['/p1.webp'] };
    expect(lookPictureOf(sized, 'tile')).toBe('/a@320.webp');
    expect(lookPictureOf(sized, 'large')).toBe('/a@640.webp');
    expect(lookPictureOf({ pages: ['/p1.webp'] }, 'large')).toBe('/p1.webp');
    expect(lookPictureOf({ pages: ['/p1.webp'] }, 'tile')).toBeUndefined();
    expect(lookPictureOf({ pages: [] }, 'large')).toBeUndefined();
  });
});

describe('LookArt', () => {
  it('noir-ink paints its bundled thumb on the first render, and nothing is fetched', () => {
    const { container } = render(<LookArt presetId="noir-ink" size="tile" />);
    const img = container.querySelector('img[src$="/noir-ink-thumb.webp"]');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    expect(img).toHaveAttribute('width');
    expect(img).toHaveAttribute('height');
    expect(img!.className).toMatch(/\bobject-cover\b/);
    expect(container.querySelector('[data-preset-thumb]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('every Paper Boat look paints its own file at once, tile and large', () => {
    for (const look of SAMPLE_LOOKS) {
      const tile = render(<LookArt presetId={look} size="tile" />);
      expect(tile.container.querySelector('img')?.getAttribute('src'), look).toBe(`/assets/comic-sample/${look}-thumb.webp`);
      tile.unmount();
      const large = render(<LookArt presetId={look} size="large" />);
      expect(large.container.querySelector('img')?.getAttribute('src'), look).toBe(`/assets/comic-sample/${look}-1.webp`);
      large.unmount();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a look without art yet renders the interim drawn thumbnail', () => {
    const { container } = render(<LookArt presetId="cartoon-strip" size="tile" />);
    expect(container.querySelector('[data-preset-thumb="cartoon-strip"]')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an image error swaps to the swatch tile with the preset gradient (a hairline, no figure, no text)', () => {
    const preset = presetOf('noir-ink');
    const { container } = render(<LookArt presetId="noir-ink" size="tile" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-preset-thumb]')).toBeNull();
    const swatch = container.querySelector<HTMLElement>('[data-look-art="swatch"]')!;
    expect(swatch).not.toBeNull();
    expect(swatch.style.background).toBe(swatchCss(preset));
    expect(swatch.className).toMatch(/border-\[var\(--ds-hairline\)\]/);
    expect(swatch.textContent).toBe('');
    expect(swatch.querySelector('svg')).toBeNull();
  });

  it('alt is "<name> sample" by default, and the caller can pass its own (or none)', () => {
    const preset = presetOf('noir-ink');
    const first = render(<LookArt presetId="noir-ink" size="tile" />);
    expect(first.container.querySelector('img')).toHaveAttribute('alt', `${preset.name} sample`);
    first.unmount();
    const own = render(<LookArt presetId="noir-ink" size="tile" alt="" />);
    expect(own.container.querySelector('img')).toHaveAttribute('alt', '');
    own.unmount();
    // The swatch keeps the name for a screen reader; decorative when the caller passes "".
    const named = render(<LookArt presetId="noir-ink" size="tile" />);
    fireEvent.error(named.container.querySelector('img')!);
    expect(named.container.querySelector('[data-look-art="swatch"]')).toHaveAttribute('aria-label', `${preset.name} sample`);
  });

  it('renders phrasing content only: no div for bundled art or the swatch', () => {
    const art = render(<LookArt presetId="retro-pop" size="tile" className="absolute inset-0" />);
    expect(art.container.querySelector('div')).toBeNull();
    expect(art.container.firstElementChild?.tagName).toBe('IMG');
    expect(art.container.firstElementChild!.className).toContain('absolute inset-0');
    fireEvent.error(art.container.querySelector('img')!);
    expect(art.container.querySelector('div')).toBeNull();
    expect(art.container.firstElementChild?.tagName).toBe('SPAN');
  });

  it('an object-fit from the caller wins over the default cover', () => {
    const { container } = render(<LookArt presetId="noir-ink" size="large" className="object-contain" />);
    const img = container.querySelector('img')!;
    expect(img.className).toMatch(/\bobject-contain\b/);
    expect(img.className).not.toMatch(/\bobject-cover\b/);
  });

  it('an unknown look draws a neutral tile, never a crash', () => {
    const { container } = render(<LookArt presetId="gone" size="tile" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-look-art="swatch"]')).not.toBeNull();
  });
});
