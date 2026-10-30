import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { languageSpec } from '../../../shared/comic/languages';
import { makeBook } from './__fixtures__/books';
import { localizedFor } from './sequence';

const ensureFonts = vi.fn(async (ids: string[]) => ({ loaded: ids, failed: [] as string[] }));
const ensureFontsFor = vi.fn(async () => ({ degraded: false }));
vi.mock('../lettering/fontLoader', async (orig) => ({ ...(await orig<typeof import('../lettering/fontLoader')>()), ensureFonts: (...a: unknown[]) => ensureFonts(...(a as [string[]])) }));
vi.mock('../i18n/scriptFonts', async (orig) => ({ ...(await orig<typeof import('../i18n/scriptFonts')>()), ensureFontsFor: (...a: unknown[]) => ensureFontsFor(...(a as [])) }));

const { exportFaces, prepareExportFonts, FONT_NOTICE, titleFaceFor } = await import('./fonts');

describe('exportFaces', () => {
  it('collects the faces, weights and text the lettering draws', () => {
    const { faces, langs, sample } = exportFaces([makeBook()]);
    const ids = faces.map((f) => f.id);
    expect(ids).toContain('comic-neue');
    expect(ids).toContain('bangers');
    expect(faces.find((f) => f.id === 'comic-neue')!.weights).toContain(700);
    expect(faces.find((f) => f.id === 'comic-neue')!.sample).toContain('D');
    expect(langs).toEqual(['en']);
    expect(sample.length).toBeGreaterThan(5);
  });

  it('switches to the script faces of an edition and samples its real characters', () => {
    const te = localizedFor(makeBook(), 'te');
    const { faces, langs } = exportFaces([te]);
    const dialogue = languageSpec('te')!.fonts.dialogue;
    const face = faces.find((f) => f.id === dialogue);
    expect(face).toBeTruthy();
    expect(face!.sample).toMatch(/\p{Script=Telugu}/u);
    expect(langs).toContain('te');
  });

  it('includes the overlay cover title face, and nothing for in-art lettering', () => {
    const cover = exportFaces([makeBook(undefined, { overlayCover: true })]).faces.find((f) => f.id === 'bangers')!;
    expect(cover.sample).toContain('S'); // "THE SAFFRON THIEF"
    const inArt = exportFaces([makeBook((d) => (d.format.lettering = 'in_art'))]);
    expect(inArt.faces).toEqual([]);
  });

  it('gives the motion title card the language’s display face', () => {
    expect(titleFaceFor('en').id).toBe('bangers');
    expect(titleFaceFor('te').id).toBe(languageSpec('te')!.fonts.sfx);
    expect(titleFaceFor('en').font(40)).toMatch(/^400 40px "DSL Bangers"/);
  });
});

describe('prepareExportFonts', () => {
  const doc = makeBook();
  beforeEach(() => {
    ensureFonts.mockClear();
    ensureFontsFor.mockClear();
    vi.stubGlobal('FontFace', class {});
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load: vi.fn(async () => []), ready: Promise.resolve() } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (document as unknown as { fonts?: unknown }).fonts;
  });

  it('loads every face with its weights and sample text, then hands back a fresh measure', async () => {
    const r = await prepareExportFonts([doc]);
    expect(r.degraded).toBe(false);
    expect(r.notice).toBeUndefined();
    expect(typeof r.measure).toBe('function');
    const called = ensureFonts.mock.calls.map((c) => (c as unknown[])[0]) as string[][];
    expect(called.flat()).toEqual(expect.arrayContaining(['comic-neue', 'bangers']));
    const opts = (ensureFonts.mock.calls[0] as unknown[])[1] as { sample: string; timeoutMs: number };
    expect(opts.sample.length).toBeGreaterThan(0);
    expect(opts.timeoutMs).toBe(5000);
    expect(ensureFontsFor).not.toHaveBeenCalled(); // Latin only
  });

  it('waits for the script stylesheet faces of an edition with its text', async () => {
    await prepareExportFonts([localizedFor(doc, 'te')]);
    expect(ensureFontsFor).toHaveBeenCalledTimes(1);
    const [langs, roles, sample] = ensureFontsFor.mock.calls[0] as unknown as [string[], string[], string];
    expect(langs).toContain('te');
    expect(roles).toEqual(['dialogue', 'sfx', 'legible']);
    expect(sample).toMatch(/\p{Script=Telugu}/u);
  });

  it('says so honestly when a face did not load', async () => {
    ensureFonts.mockImplementationOnce(async (ids: string[]) => ({ loaded: [], failed: ids }));
    const r = await prepareExportFonts([doc]);
    expect(r.degraded).toBe(true);
    expect(r.failed.length).toBeGreaterThan(0);
    expect(r.notice).toBe(FONT_NOTICE);
    expect(FONT_NOTICE).toMatch(/^Some lettering fonts didn’t load/);
  });

  it('a degraded script stylesheet is reported too', async () => {
    ensureFontsFor.mockImplementationOnce(async () => ({ degraded: true }));
    const r = await prepareExportFonts([localizedFor(doc, 'te')]);
    expect(r.degraded).toBe(true);
  });

  it('without a font API it never claims a failure (and loads nothing)', async () => {
    delete (document as unknown as { fonts?: unknown }).fonts;
    const r = await prepareExportFonts([doc]);
    expect(r.degraded).toBe(false);
    expect(ensureFonts).not.toHaveBeenCalled();
  });
});
