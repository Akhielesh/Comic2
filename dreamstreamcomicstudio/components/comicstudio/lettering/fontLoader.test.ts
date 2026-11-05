import { afterEach, describe, expect, it, vi } from 'vitest';
import { FONT_REGISTRY } from '../../../shared/comic/lettering/fonts';
import { estimateMeasure } from '../../../shared/comic/lettering/layout';
import { FONT_FILES } from './fontFiles';
import { ensureFonts, filesFor, fontFaceCss, fontLoadGeneration, isFontReady, resetFontLoaderForTests, subscribeFontLoads } from './fontLoader';
import { createMeasure, parseFont } from './measure';

afterEach(() => {
  resetFontLoaderForTests();
  vi.unstubAllGlobals();
});

describe('self-hosted lettering faces', () => {
  it('ship every Latin registry face (latin subset at least) with only woff2 files', () => {
    for (const [id, files] of Object.entries(FONT_FILES)) {
      const meta = FONT_REGISTRY[id as keyof typeof FONT_REGISTRY];
      expect(meta.source).toBe('fontsource');
      expect(['OFL-1.1', 'Apache-2.0']).toContain(meta.license);
      expect(files.some((f) => f.subset === 'latin')).toBe(true);
      for (const f of files) {
        expect(f.url).toMatch(/\.woff2/);
        expect(meta.weights).toContain(f.weight);
        expect(f.unicodeRange).toMatch(/^U\+/);
      }
    }
  });

  it('pick the nearest shipped weight and italics only where the face has them', () => {
    expect(filesFor('bangers', 900).every((f) => f.weight === 400 && f.style === 'normal')).toBe(true);
    expect(filesFor('comic-neue', 700, true).every((f) => f.weight === 700 && f.style === 'italic')).toBe(true);
    expect(filesFor('bangers', 400, true).every((f) => f.style === 'normal')).toBe(true);
  });

  it('print CSS: @font-face for the used faces only, private DSL families, absolute URLs, no Google CSS for Latin', () => {
    const css = fontFaceCss(['bangers', 'noto-sans-telugu'], 'https://comics.example');
    expect(css).toContain('font-family:"DSL Bangers"');
    expect(css).not.toContain('Comic Neue');
    expect(css).not.toContain('fonts.googleapis.com');
    expect(css).not.toContain('Noto Sans Telugu');
    expect(css).toMatch(/src:url\("https:\/\/comics\.example\//);
    expect(css.match(/@font-face/g)!.length).toBe(FONT_FILES.bangers.length);
  });
});

describe('ensureFonts', () => {
  it('without a FontFace API it resolves at once and reports every face as not loaded (never rejects)', async () => {
    const r = await ensureFonts(['comic-neue', 'noto-sans-telugu']);
    expect(r.loaded).toEqual([]);
    expect(r.failed.sort()).toEqual(['comic-neue', 'noto-sans-telugu']);
    expect(isFontReady('comic-neue', 700)).toBe(false);
  });

  it('registers DSL faces with the FontFace API, loads them once and bumps the generation', async () => {
    const added: { family: string; weight?: string; style?: string }[] = [];
    class FakeFace {
      family: string;
      descriptors: FontFaceDescriptors;
      constructor(family: string, _src: string, descriptors: FontFaceDescriptors) {
        this.family = family;
        this.descriptors = descriptors;
      }
      load() {
        return Promise.resolve(this);
      }
    }
    vi.stubGlobal('FontFace', FakeFace);
    const fonts = { add: (f: FakeFace) => added.push({ family: f.family, weight: f.descriptors.weight, style: f.descriptors.style }), addEventListener: vi.fn(), check: () => true, load: vi.fn(async () => []) };
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
    try {
      const seen = vi.fn();
      const off = subscribeFontLoads(seen);
      const before = fontLoadGeneration();
      const r = await ensureFonts(['comic-neue'], { weights: [700] });
      expect(r.loaded).toEqual(['comic-neue']);
      expect(added.every((f) => f.family === 'DSL Comic Neue' && f.weight === '700')).toBe(true);
      expect(isFontReady('comic-neue', 700)).toBe(true);
      expect(fontLoadGeneration()).toBeGreaterThan(before);
      expect(seen).toHaveBeenCalled();
      const count = added.length;
      await ensureFonts(['comic-neue'], { weights: [700] });
      expect(added.length).toBe(count); // memoized per file
      off();
    } finally {
      delete (document as unknown as { fonts?: unknown }).fonts;
    }
  });
});

describe('script faces (Google CSS2)', () => {
  it('are measurable only once a face of the family has really loaded (check() alone is true for unknown families)', () => {
    const faces: { family: string; status: string }[] = [];
    const fonts = { check: () => true, forEach: (cb: (f: { family: string; status: string }) => void) => faces.forEach(cb), addEventListener: vi.fn() };
    vi.stubGlobal('FontFace', class {});
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
    try {
      expect(isFontReady('noto-sans-telugu', 400)).toBe(false);
      faces.push({ family: '"Noto Sans Telugu"', status: 'loading' });
      expect(isFontReady('noto-sans-telugu', 400)).toBe(false);
      faces.push({ family: 'Noto Sans Telugu', status: 'loaded' });
      expect(isFontReady('noto-sans-telugu', 400)).toBe(true);
    } finally {
      delete (document as unknown as { fonts?: unknown }).fonts;
    }
  });

  it('wait for the stylesheet before loading, and report a face that never arrives as failed (never rejects)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('FontFace', class {});
    const load = vi.fn(async () => [] as FontFace[]);
    Object.defineProperty(document, 'fonts', { value: { load, check: () => true, forEach: () => undefined, addEventListener: vi.fn() }, configurable: true });
    try {
      const pending = ensureFonts(['noto-sans-telugu'], { weights: [400], sample: 'నమస్తే', timeoutMs: 1000 });
      const link = document.head.querySelector<HTMLLinkElement>('link[data-ds-lettering-fonts]')!;
      expect(link.href).toContain('fonts.googleapis.com/css2?family=Noto+Sans+Telugu');
      await vi.advanceTimersByTimeAsync(10);
      expect(load).not.toHaveBeenCalled(); // the @font-face rules are not there yet
      link.dispatchEvent(new Event('load'));
      await vi.advanceTimersByTimeAsync(10);
      expect(load).toHaveBeenCalledWith(expect.stringContaining('Noto Sans Telugu'), 'నమస్తే');
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toEqual({ loaded: [], failed: ['noto-sans-telugu'] });
    } finally {
      vi.useRealTimers();
      document.head.querySelectorAll('link[data-ds-lettering-fonts]').forEach((l) => l.remove());
      delete (document as unknown as { fonts?: unknown }).fonts;
    }
  });
});

describe('measure', () => {
  it('parses lettering font shorthands', () => {
    expect(parseFont('italic 700 17px "DSL Comic Neue", "Comic Sans MS", cursive')).toEqual({ italic: true, weight: 700, px: 17, family: 'DSL Comic Neue' });
    expect(parseFont('400 40.8px "DSL Bangers", Impact')).toEqual({ italic: false, weight: 400, px: 40.8, family: 'DSL Bangers' });
    expect(parseFont('nonsense')).toBeNull();
  });

  it('uses registry estimates until the face is really loaded, then the canvas', () => {
    const ctx = { font: '', measureText: vi.fn((s: string) => ({ width: s.length * 7 })) } as unknown as CanvasRenderingContext2D;
    const font = '700 17px "DSL Comic Neue", "Comic Sans MS"';
    const notReady = createMeasure({ ctx, ready: () => false });
    expect(notReady('HELLO', font)).toBe(estimateMeasure('HELLO', font));
    const ready = createMeasure({ ctx, ready: () => true });
    expect(ready('HELLO', font)).toBe(35);
    expect(ctx.font).toBe(font);
    expect(ready('', font)).toBe(0);
  });
});
