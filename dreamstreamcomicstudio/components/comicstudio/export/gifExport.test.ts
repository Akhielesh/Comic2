import { describe, expect, it, vi } from 'vitest';
import type { Page } from '../../../shared/comic/doc';
import { makeBook } from './__fixtures__/books';
import { gifPageUrl } from './gifExport';

describe('GIF frame sources', () => {
  it('requests only the width needed for a small preview, regardless of display pixel density', () => {
    const page = makeBook().pages[0];
    const asset = { ...page.render.asset!, w: 2400, h: 3600 };
    const urlFor = vi.fn(() => 'preview');
    vi.stubGlobal('devicePixelRatio', 2);
    try {
      expect(gifPageUrl(page, asset, urlFor)).toBe('preview');
      expect(urlFor).toHaveBeenCalledWith(asset, { width: 180 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the full source when composing editable panel crops', () => {
    const page = makeBook().pages[0];
    const composed: Page = {
      ...page,
      artMode: 'panels',
      panels: page.panels.map((p) => ({
        ...p,
        frame: { box: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 }, src: { path: page.render.asset!.path } }
      }))
    };
    const asset = page.render.asset!;
    const urlFor = vi.fn(() => 'original');
    expect(gifPageUrl(composed, asset, urlFor)).toBe('original');
    expect(urlFor).toHaveBeenCalledExactlyOnceWith(asset);
  });
});
