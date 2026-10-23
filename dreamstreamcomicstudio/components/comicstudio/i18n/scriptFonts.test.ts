import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FONT_REGISTRY } from '../../../shared/comic/lettering/fonts';
import { cssFontFamily, ensureFontsFor, googleFacesFor, googleFontsHref, resetScriptFonts, SAMPLE_TEXT, weightsFor } from './scriptFonts';
import { LANGUAGES } from '../../../shared/comic/languages';

const links = () => Array.from(document.head.querySelectorAll('link[rel="stylesheet"]')).map((l) => l.getAttribute('href'));
/** jsdom never fetches stylesheets: settle the injected <link>s the way a browser would. */
const settleSheets = (event: 'load' | 'error' = 'load') => document.head.querySelectorAll('link[rel="stylesheet"]').forEach((l) => l.dispatchEvent(new Event(event)));

beforeEach(() => {
  resetScriptFonts();
  document.head.querySelectorAll('link').forEach((l) => l.remove());
});
afterEach(() => {
  vi.useRealTimers();
  delete (document as unknown as { fonts?: unknown }).fonts;
});

const fakeFonts = (load: (font: string, text?: string) => Promise<FontFace[]>) => {
  const fonts = { load: vi.fn(load), check: vi.fn(() => true) };
  Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
  return fonts;
};

describe('per-script Noto faces from Google Fonts CSS2', () => {
  it('families come from the registry; Latin faces are self-hosted (never requested from Google)', () => {
    expect(cssFontFamily('te', 'dialogue')).toMatch(/^"Noto Sans Telugu", /);
    expect(cssFontFamily('ur', 'dialogue')).toMatch(/^"Noto Nastaliq Urdu"/);
    expect(googleFacesFor(['en', 'es'], ['dialogue', 'sfx'])).toEqual([]);
    expect(googleFacesFor(['te', 'hi', 'mr'], ['dialogue', 'sfx', 'legible']).map((f) => f.family)).toEqual(['Noto Sans Devanagari', 'Noto Sans Telugu']);
    for (const l of LANGUAGES) expect(SAMPLE_TEXT[l.code], l.code).toBeTruthy();
  });

  it('builds one CSS2 URL with only weights the face ships (no faux bold) and display=swap', () => {
    const href = googleFontsHref(googleFacesFor(['te', 'ar'], ['dialogue']))!;
    expect(href).toBe('https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;700&family=Noto+Sans+Telugu:wght@400;700;800&display=swap');
    expect(weightsFor(FONT_REGISTRY['noto-naskh-arabic'])).toEqual([400, 700]);
    expect(googleFontsHref([])).toBeNull();
  });

  it('injects the stylesheet once and awaits document.fonts.load WITH the sample text', async () => {
    const fonts = fakeFonts(async () => [{} as FontFace]);
    const first = ensureFontsFor(['te'], ['dialogue', 'sfx'], 'నమస్కారం నేస్తం');
    settleSheets();
    await expect(first).resolves.toEqual({ degraded: false });
    // The second call reuses the loaded sheet (no new <link>, no wait).
    await expect(ensureFontsFor(['te'], ['dialogue'], 'మళ్ళీ')).resolves.toEqual({ degraded: false });
    expect(links()).toHaveLength(1);
    expect(links()[0]).toContain('family=Noto+Sans+Telugu');
    expect(document.head.querySelector('link[rel="preconnect"]')?.getAttribute('href')).toBe('https://fonts.gstatic.com');
    expect(fonts.load).toHaveBeenCalledWith('700 16px "Noto Sans Telugu"', 'నమస్కారం నేస్తం');
  });

  it('is degraded (never rejects) when a face times out or does not match', async () => {
    vi.useFakeTimers();
    fakeFonts(() => new Promise(() => undefined));
    const slow = ensureFontsFor(['hi'], ['dialogue'], 'नमस्ते', 100);
    await vi.advanceTimersByTimeAsync(150);
    await expect(slow).resolves.toEqual({ degraded: true });
    vi.useRealTimers();
    fakeFonts(async () => []);
    const ja = ensureFontsFor(['ja'], ['dialogue'], 'こんにちは');
    settleSheets();
    await expect(ja).resolves.toEqual({ degraded: true });
    fakeFonts(async () => {
      throw new Error('network');
    });
    const ko = ensureFontsFor(['ko'], ['dialogue'], '안녕');
    settleSheets();
    await expect(ko).resolves.toEqual({ degraded: true });
  });

  it('waits for the injected stylesheet before loading faces: a first visit is not reported as degraded', async () => {
    let sheetLoaded = false;
    // A real browser: fonts.load() before the @font-face rules exist resolves EMPTY.
    const fonts = fakeFonts(async () => (sheetLoaded ? [{} as FontFace] : []));
    const p = ensureFontsFor(['ta'], ['dialogue'], 'வணக்கம்');
    await Promise.resolve();
    expect(fonts.load).not.toHaveBeenCalled();
    sheetLoaded = true;
    settleSheets();
    await expect(p).resolves.toEqual({ degraded: false });
    expect(fonts.load).toHaveBeenCalledWith(expect.stringContaining('"Noto Sans Tamil"'), 'வணக்கம்');
  });

  it('a stylesheet that fails to load is reported as degraded (the export says so instead of a silent fallback)', async () => {
    fakeFonts(async () => [{} as FontFace]);
    const p = ensureFontsFor(['bn'], ['dialogue'], 'নমস্কার');
    settleSheets('error');
    await expect(p).resolves.toEqual({ degraded: true });
  });

  it('Latin-only requests load nothing', async () => {
    const fonts = fakeFonts(async () => [{} as FontFace]);
    await expect(ensureFontsFor(['en', 'fr'], ['dialogue'], 'Hello')).resolves.toEqual({ degraded: false });
    expect(fonts.load).not.toHaveBeenCalled();
    expect(links()).toHaveLength(0);
  });
});
