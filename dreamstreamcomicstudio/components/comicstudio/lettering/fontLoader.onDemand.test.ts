// Fonts budget (master plan §2.8): each face loads on demand, once. The face tables of the Pro and script faces are
// separate chunks (fontFiles.ts LAZY_FONT_FILES); this suite counts which tables and files a call really pulls in.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRO_FONT_IDS } from '../../../shared/comic/lettering/proFonts';

const tableLoads = vi.hoisted(() => [] as string[]);
/** Tables whose chunk request never answers (a stalled dynamic import on a weak connection). */
const stalled = vi.hoisted(() => new Set<string>());
vi.mock('./fontFiles', async (orig) => {
  const actual = await orig<typeof import('./fontFiles')>();
  const lazy = Object.fromEntries(
    Object.entries(actual.LAZY_FONT_FILES).map(([id, load]) => [
      id,
      () => {
        tableLoads.push(id);
        return stalled.has(id) ? new Promise<never>(() => undefined) : load();
      }
    ])
  );
  return { ...actual, LAZY_FONT_FILES: lazy };
});

import { ensureFonts, fontFaceCss, isFontReady, preloadFontFiles, resetFontLoaderForTests } from './fontLoader';

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
  vi.useRealTimers();
  resetFontLoaderForTests();
  tableLoads.length = 0;
  stalled.clear();
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

describe('a face table that never arrives is bounded by the timeout', () => {
  const settle = <T,>(p: Promise<T>) => {
    const state: { done: boolean; value?: T } = { done: false };
    void p.then((value) => Object.assign(state, { done: true, value }));
    return state;
  };

  it('ensureFonts reports the stalled faces as failed within timeoutMs; the ready faces still load', async () => {
    vi.useFakeTimers();
    installFontApi();
    stalled.add('bungee').add('noto-sans-telugu');
    const r = settle(ensureFonts(['bungee', 'noto-sans-telugu', 'comic-neue'], { weights: [400], sample: 'నమస్తే', timeoutMs: 1000 }));
    await vi.advanceTimersByTimeAsync(999);
    expect(r.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(r).toEqual({ done: true, value: { loaded: ['comic-neue'], failed: ['noto-sans-telugu', 'bungee'] } });
    expect(tableLoads).toEqual(['bungee', 'noto-sans-telugu']);
  });

  it('the default 5 s budget applies when no timeout is given (the export path waits on this call)', async () => {
    vi.useFakeTimers();
    installFontApi();
    stalled.add('noto-sans-jp');
    const r = settle(ensureFonts(['noto-sans-jp'], { sample: '月まで' }));
    await vi.advanceTimersByTimeAsync(4999);
    expect(r.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(r).toEqual({ done: true, value: { loaded: [], failed: ['noto-sans-jp'] } });
  });

  it('preloadFontFiles (the print view waits on it) resolves by its timeout and leaves the stalled face out of the CSS', async () => {
    vi.useFakeTimers();
    stalled.add('noto-sans-telugu');
    const r = settle(preloadFontFiles(['noto-sans-telugu', 'bungee'], 1000));
    await vi.advanceTimersByTimeAsync(999);
    expect(r.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.done).toBe(true);
    const css = fontFaceCss(['noto-sans-telugu', 'bungee'], 'https://comics.example');
    expect(css).toContain('font-family:"DSL Bungee"');
    expect(css).not.toContain('Noto Sans Telugu');
  });
});
