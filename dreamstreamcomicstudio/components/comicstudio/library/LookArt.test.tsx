// LookArt (stylepick SC-1): one picture for a look on every style surface. It paints static files at once (the
// bundled sample art for the six Paper Boat looks), never reads the library index, never fetches, and never shows
// a placeholder first. Looks without a picture yet keep the interim drawn thumbnail (removed with SC-5); a picture
// that fails to load becomes the look's swatch. lookSourcesOf is the one place a look's files are named.
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStylePreset, type StylePreset } from '../../../shared/comic/stylePresets';
import { LookArt } from './LookArt';
import { lookFileOf, lookIdOfPreview, lookPictureOf, lookSourcesOf } from './lookSources';
import { SAMPLE_LOOKS } from './sampleArt';

/** A file's pixel size, read from its webp header in public/ (VP8X, VP8 and VP8L). */
const webpSize = (src: string): { width: number; height: number } => {
  const b = readFileSync(path.join(__dirname, '../../../public', src));
  expect(b.toString('ascii', 0, 4) + b.toString('ascii', 8, 12), src).toBe('RIFFWEBP');
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  throw new Error(`${src}: unknown webp chunk ${chunk}`);
};

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
      expect(s.scene, look).toEqual({ w320: `/assets/comic-sample/${look}-thumb.webp`, w640: `/assets/comic-sample/${look}-thumb.webp`, size: { width: 480, height: 240 } });
      expect(s.pages, look).toEqual([`/assets/comic-sample/${look}-1.webp`, `/assets/comic-sample/${look}-2.webp`]);
      expect(s.cast, look).toBeUndefined();
    }
  });

  it('every file carries its own pixel size, as its webp header says (the img reserves the real aspect)', () => {
    for (const look of SAMPLE_LOOKS) {
      for (const size of ['tile', 'large'] as const) {
        const file = lookFileOf(lookSourcesOf(look), size)!;
        expect(file.size, `${look} ${size}`).toEqual(webpSize(file.src));
      }
      const s = lookSourcesOf(look);
      for (const page of s.pages) expect(s.pageSize, page).toEqual(webpSize(page));
    }
  });

  it('a source that names no size gives the file alone (no made-up box)', () => {
    expect(lookFileOf({ scene: { w320: '/a.webp', w640: '/a.webp' }, pages: [] }, 'tile')).toEqual({ src: '/a.webp' });
    expect(lookFileOf({ pages: ['/p1.webp'] }, 'large')).toEqual({ src: '/p1.webp' });
    expect(lookFileOf({ pages: ['/p1.webp'], pageSize: { width: 10, height: 8 } }, 'large')).toEqual({ src: '/p1.webp', size: { width: 10, height: 8 } });
  });

  it('a look preview id names its look; a cast bust, an anchor or a malformed id names none', () => {
    expect(lookIdOfPreview('style.noir-ink')).toBe('noir-ink');
    expect(lookIdOfPreview('style.cartoon-strip')).toBe('cartoon-strip');
    for (const id of ['style.noir-ink.cast', 'anchor.noir-ink', 'empty.studio-hero', 'style.', 'style.__proto__', 'style.Noir', 'noir-ink', '']) {
      expect(lookIdOfPreview(id), id).toBeUndefined();
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
    // The file's own size (480x240), not a made-up 4:5 box.
    expect(img).toHaveAttribute('width', '480');
    expect(img).toHaveAttribute('height', '240');
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

  it('the img states its file\'s real size at tile and large, so an auto-height caller never jumps', () => {
    for (const look of SAMPLE_LOOKS) {
      for (const size of ['tile', 'large'] as const) {
        const { container, unmount } = render(<LookArt presetId={look} size={size} />);
        const img = container.querySelector('img')!;
        const real = webpSize(img.getAttribute('src')!);
        expect([img.getAttribute('width'), img.getAttribute('height')], `${look} ${size}`).toEqual([String(real.width), String(real.height)]);
        unmount();
      }
    }
  });

  it('the picture sits on the look\'s swatch until the file decodes (the look\'s colours, never a grey box)', () => {
    for (const look of SAMPLE_LOOKS) {
      const { container, unmount } = render(<LookArt presetId={look} size="tile" />);
      expect(container.querySelector<HTMLImageElement>('img')!.style.background, look).toBe(swatchCss(presetOf(look)));
      unmount();
    }
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
