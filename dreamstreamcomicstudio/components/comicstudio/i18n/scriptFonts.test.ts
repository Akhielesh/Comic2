import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FONT_REGISTRY } from '../../../shared/comic/lettering/fonts';
import { LANGUAGES } from '../../../shared/comic/languages';

const ensureFonts = vi.hoisted(() => vi.fn(async (ids: readonly string[]) => ({ loaded: [...ids], failed: [] as string[] })));
vi.mock('../lettering/fontLoader', () => ({ ensureFonts }));

import { cssFontFamily, ensureFontsFor, googleFacesFor, googleFontsHref, resetScriptFonts, SAMPLE_TEXT, scriptFacesFor, weightsFor } from './scriptFonts';

const links = () => Array.from(document.head.querySelectorAll('link')).map((l) => l.getAttribute('href'));
const fakeFonts = () => {
  vi.stubGlobal('FontFace', class {});
  Object.defineProperty(document, 'fonts', { value: { load: vi.fn(async () => []), check: vi.fn(() => true) }, configurable: true });
};

beforeEach(() => {
  resetScriptFonts();
  ensureFonts.mockClear();
  document.head.querySelectorAll('link').forEach((l) => l.remove());
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (document as unknown as { fonts?: unknown }).fonts;
});

describe('per-script Noto faces (self-hosted, PE-FONTS)', () => {
  it('families come from the registry; Latin faces are never script faces; nothing is Google-hosted any more', () => {
    expect(cssFontFamily('te', 'dialogue')).toMatch(/^"Noto Sans Telugu", /);
    expect(cssFontFamily('ur', 'dialogue')).toMatch(/^"Noto Nastaliq Urdu"/);
    expect(scriptFacesFor(['en', 'es'], ['dialogue', 'sfx'])).toEqual([]);
    expect(scriptFacesFor(['te', 'hi', 'mr'], ['dialogue', 'sfx', 'legible']).map((f) => f.family)).toEqual(['Noto Sans Devanagari', 'Noto Sans Telugu']);
    expect(googleFacesFor(['te', 'ar'], ['dialogue'])).toEqual([]);
    expect(googleFontsHref([])).toBeNull();
    for (const l of LANGUAGES) expect(SAMPLE_TEXT[l.code], l.code).toBeTruthy();
  });

  it('asks only for weights the face ships (no faux bold)', () => {
    expect(weightsFor(FONT_REGISTRY['noto-naskh-arabic'])).toEqual([400, 700]);
    expect(weightsFor(FONT_REGISTRY['noto-sans-telugu'])).toEqual([400, 700, 800]);
  });

  it('loads through the self-hosted loader WITH the sample text and never adds a stylesheet', async () => {
    fakeFonts();
    await expect(ensureFontsFor(['te'], ['dialogue', 'sfx'], 'నమస్కారం నేస్తం')).resolves.toEqual({ degraded: false });
    expect(ensureFonts).toHaveBeenCalledWith(['noto-sans-telugu'], { weights: [400, 700, 800], sample: 'నమస్కారం నేస్తం', timeoutMs: 3500 });
    expect(links()).toEqual([]);
  });

  it('is degraded (never rejects) when a face does not arrive in time', async () => {
    fakeFonts();
    ensureFonts.mockResolvedValueOnce({ loaded: [], failed: ['noto-sans-devanagari'] });
    await expect(ensureFontsFor(['hi'], ['dialogue'], 'नमस्ते', 100)).resolves.toEqual({ degraded: true });
    expect(ensureFonts).toHaveBeenLastCalledWith(['noto-sans-devanagari'], expect.objectContaining({ timeoutMs: 100 }));
  });

  it('Latin-only requests, and a page without a font API, load nothing', async () => {
    fakeFonts();
    await expect(ensureFontsFor(['en', 'fr'], ['dialogue'], 'Hello')).resolves.toEqual({ degraded: false });
    vi.unstubAllGlobals();
    await expect(ensureFontsFor(['ja'], ['dialogue'], 'こんにちは')).resolves.toEqual({ degraded: false });
    expect(ensureFonts).not.toHaveBeenCalled();
  });
});
