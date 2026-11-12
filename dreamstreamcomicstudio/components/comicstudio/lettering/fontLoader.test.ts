import { afterEach, describe, expect, it, vi } from 'vitest';
import { FONT_REGISTRY } from '../../../shared/comic/lettering/fonts';
import { estimateMeasure } from '../../../shared/comic/lettering/layout';
import { FONT_FILES } from './fontFiles';
import { ensureFonts, filesFor, fontFaceCss, fontLoadGeneration, isFontReady, preloadFontFiles, resetFontLoaderForTests, subscribeFontLoads } from './fontLoader';
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

  it('print CSS: @font-face for the used faces only, private DSL families, absolute URLs, never a Google stylesheet', async () => {
    const css = fontFaceCss(['bangers', 'noto-sans-telugu'], 'https://comics.example');
    expect(css).toContain('font-family:"DSL Bangers"');
    expect(css).not.toContain('Comic Neue');
    expect(css).not.toMatch(/googleapis|gstatic/);
    expect(css).toMatch(/src:url\("https:\/\/comics\.example\//);
    // A script face's table loads on first use; once it has, the print CSS declares its self-hosted slices too.
    expect(css).not.toContain('Noto Sans Telugu');
    await preloadFontFiles(['noto-sans-telugu', 'bungee']);
    const full = fontFaceCss(['bangers', 'noto-sans-telugu', 'bungee'], 'https://comics.example', [700]);
    expect(full.match(/font-family:"DSL Bangers"/g)!.length).toBe(FONT_FILES.bangers.length);
    expect(full.match(/font-family:"Noto Sans Telugu";font-style:normal;font-weight:700;/g)!.length).toBe(3); // telugu, latin, latin-ext
    expect(full).not.toMatch(/font-family:"Noto Sans Telugu";font-style:normal;font-weight:400;/);
    expect(full).toContain('font-family:"DSL Bungee"');
    expect(full).not.toMatch(/googleapis|gstatic/);
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

describe('script faces (self-hosted Noto slices)', () => {
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

  it('never request fonts.googleapis.com: the slices of the asked weight are registered from our origin and the sample loads them', async () => {
    const made: { family: string; src: string; weight?: string; range?: string; display?: string; loads: number }[] = [];
    class FakeFace {
      rec: (typeof made)[number];
      constructor(family: string, src: string, d: FontFaceDescriptors) {
        this.rec = { family, src, weight: d.weight, range: d.unicodeRange, display: d.display, loads: 0 };
        made.push(this.rec);
      }
      load() {
        this.rec.loads += 1;
        return Promise.resolve(this);
      }
    }
    vi.stubGlobal('FontFace', FakeFace);
    const load = vi.fn(async () => [{}] as unknown as FontFace[]);
    const added: unknown[] = [];
    Object.defineProperty(document, 'fonts', { value: { load, add: (f: unknown) => added.push(f), check: () => true, forEach: () => undefined, addEventListener: vi.fn() }, configurable: true });
    const appended = vi.spyOn(document.head, 'appendChild');
    try {
      const r = await ensureFonts(['noto-sans-telugu'], { weights: [700], sample: 'నమస్తే' });
      expect(r).toEqual({ loaded: ['noto-sans-telugu'], failed: [] });
      expect(appended).not.toHaveBeenCalled(); // no <link rel="stylesheet"> of any kind
      expect(document.head.querySelector('link[href*="googleapis"], link[href*="gstatic"]')).toBeNull();
      expect(made.map((f) => f.family)).toEqual(['Noto Sans Telugu', 'Noto Sans Telugu', 'Noto Sans Telugu']);
      for (const f of made) {
        expect(f.src).toMatch(/noto-sans-telugu-(telugu|latin|latin-ext)-700-normal.*\.woff2/);
        expect(f.src).not.toMatch(/googleapis|gstatic|https?:/);
        expect(f.weight).toBe('700');
        expect(f.range).toMatch(/^U\+/);
        expect(f.display).toBe('swap');
        expect(f.loads).toBe(0); // registered, not fetched: the browser fetches only the slices the text needs
      }
      expect(added).toHaveLength(3);
      expect(load).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledWith(expect.stringMatching(/^700 16px "Noto Sans Telugu", /), 'నమస్తే');
    } finally {
      appended.mockRestore();
      delete (document as unknown as { fonts?: unknown }).fonts;
    }
  });

  // ensureFonts imports a face's table lazily, inside its 5 s per-face deadline. Here vitest transforms
  // fontTables/noto-sans-jp.ts (744 `?url` slice imports) on that first import: about 4 s alone on a busy 4-core
  // machine and past 5 s in the full suite, so the face timed out as failed and no slice was registered. The table is
  // imported once up front (the module cache then answers ensureFonts at once), and the test's budget covers that.
  it('a CJK face registers only the asked weight (124 slices, not 744) and loads by sample, once', { timeout: 30_000 }, async () => {
    await import('./fontTables/noto-sans-jp');
    const made: string[] = [];
    let loads = 0;
    vi.stubGlobal(
      'FontFace',
      class {
        constructor(_family: string, src: string) {
          made.push(src);
        }
        load() {
          loads += 1;
          return Promise.resolve(this);
        }
      }
    );
    const load = vi.fn(async () => [{}] as unknown as FontFace[]);
    Object.defineProperty(document, 'fonts', { value: { load, add: vi.fn(), check: () => true, forEach: () => undefined, addEventListener: vi.fn() }, configurable: true });
    try {
      await ensureFonts(['noto-sans-jp'], { weights: [400], sample: '月まで' });
      expect(made.length).toBe(124);
      expect(made.every((u) => /noto-sans-jp-[a-z0-9-]+-400-normal/.test(u))).toBe(true);
      expect(loads).toBe(0);
      await ensureFonts(['noto-sans-jp'], { weights: [400], sample: '月まで' });
      expect(made.length).toBe(124);
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      delete (document as unknown as { fonts?: unknown }).fonts;
    }
  });

  it('report a face that never arrives as failed (never rejects)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('FontFace', class { load() { return new Promise(() => undefined); } });
    const load = vi.fn(() => new Promise<FontFace[]>(() => undefined));
    Object.defineProperty(document, 'fonts', { value: { load, add: vi.fn(), check: () => true, forEach: () => undefined, addEventListener: vi.fn() }, configurable: true });
    try {
      const pending = ensureFonts(['noto-sans-telugu'], { weights: [400], sample: 'నమస్తే', timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(10);
      expect(load).toHaveBeenCalledWith(expect.stringContaining('Noto Sans Telugu'), 'నమస్తే');
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toEqual({ loaded: [], failed: ['noto-sans-telugu'] });
    } finally {
      vi.useRealTimers();
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
