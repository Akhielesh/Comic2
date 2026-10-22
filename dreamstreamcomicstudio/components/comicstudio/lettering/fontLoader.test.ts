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
