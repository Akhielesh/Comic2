// Fonts budget (master plan §2.8): each face loads on demand, once. The face tables of the Pro and script faces are
// separate chunks (fontFiles.ts LAZY_FONT_FILES); this suite counts which tables and files a call really pulls in.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRO_FONT_IDS } from '../../../shared/comic/lettering/proFonts';

const tableLoads = vi.hoisted(() => [] as string[]);
vi.mock('./fontFiles', async (orig) => {
  const actual = await orig<typeof import('./fontFiles')>();
  const lazy = Object.fromEntries(
    Object.entries(actual.LAZY_FONT_FILES).map(([id, load]) => [
      id,
      () => {
        tableLoads.push(id);
        return load();
      }
    ])
  );
  return { ...actual, LAZY_FONT_FILES: lazy };
});

import { ensureFonts, isFontReady, resetFontLoaderForTests } from './fontLoader';

interface Made {
  family: string;
  src: string;
  loads: number;
}
const installFontApi = () => {
  const made: Made[] = [];
  class FakeFace {
    rec: Made;
    constructor(family: string, src: string) {
      this.rec = { family, src, loads: 0 };
      made.push(this.rec);
    }
    load() {
      this.rec.loads += 1;
      return Promise.resolve(this);
    }
  }
  vi.stubGlobal('FontFace', FakeFace);
  Object.defineProperty(document, 'fonts', {
    value: { add: vi.fn(), load: vi.fn(async () => [{}]), check: () => true, forEach: () => undefined, addEventListener: vi.fn() },
    configurable: true
  });
  return made;
};

afterEach(() => {
  resetFontLoaderForTests();
  tableLoads.length = 0;
  vi.unstubAllGlobals();
  delete (document as unknown as { fonts?: unknown }).fonts;
});

describe('fontLoader loads a face only on demand, once', () => {
  it('importing the loader fetches no table and no face', () => {
    expect(tableLoads).toEqual([]);
  });

  it('a Pro face: its table and the files of the asked weight only, the first time it is asked for', async () => {
    const made = installFontApi();
    const r = await ensureFonts(['bungee'], { weights: [400] });
    expect(r).toEqual({ loaded: ['bungee'], failed: [] });
    expect(tableLoads).toEqual(['bungee']);
    expect(made.map((f) => f.family)).toEqual(['DSL Bungee', 'DSL Bungee']);
    expect(made.map((f) => f.src).every((s) => /bungee-latin(-ext)?-400-normal.*\.woff2/.test(s))).toBe(true);
    expect(made.every((f) => f.loads === 1)).toBe(true);
    expect(isFontReady('bungee', 400)).toBe(true);
    // Asked again (any weight snaps to the one Bungee ships): nothing new is fetched.
    await ensureFonts(['bungee'], { weights: [400, 700] });
    expect(tableLoads).toEqual(['bungee']);
    expect(made).toHaveLength(2);
    expect(made.every((f) => f.loads === 1)).toBe(true);
    // No other Pro face was touched.
    expect(PRO_FONT_IDS.filter((id) => id !== 'bungee' && isFontReady(id))).toEqual([]);
  });

  it('a multi-weight Pro face loads just the weights asked (and italics only when asked)', async () => {
    const made = installFontApi();
    await ensureFonts(['grandstander'], { weights: [700] });
    expect(made.map((f) => f.src).every((s) => /grandstander-latin(-ext)?-700-normal/.test(s))).toBe(true);
    expect(made).toHaveLength(2);
    await ensureFonts(['grandstander'], { weights: [700], italic: true });
    expect(made).toHaveLength(4);
    expect(made.slice(2).every((f) => /-700-italic/.test(f.src))).toBe(true);
  });

  it('the base Latin faces never pull a Pro or script table; unknown ids are ignored', async () => {
    installFontApi();
    const r = await ensureFonts(['comic-neue', 'bangers', 'nope' as never], { weights: [400] });
    expect(r).toEqual({ loaded: ['comic-neue', 'bangers'], failed: [] });
    expect(tableLoads).toEqual([]);
  });

  it('without a FontFace API nothing is fetched and every face reports not loaded (never rejects)', async () => {
    const r = await ensureFonts(['bungee', 'noto-sans-jp']);
    expect(r).toEqual({ loaded: [], failed: ['bungee', 'noto-sans-jp'] });
    expect(tableLoads).toEqual([]);
  });
});
