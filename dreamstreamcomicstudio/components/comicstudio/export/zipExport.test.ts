import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import type { ComicDoc, Page } from '../../../shared/comic/doc';
import { fakeUrlFor, makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { makeBook } from './__fixtures__/books';
import { ExportError } from './rasterize';
import { blobBytes, exportFileStem, exportLanguagesZip, exportPngZip } from './zipExport';

const png = (label: string) => new Blob([new TextEncoder().encode(`png:${label}`)], { type: 'image/png' });

const withCover = () =>
  makeSampleDoc((d) => {
    d.cover.render = { status: 'ready', history: [], asset: { path: 'u/cover.png', source: 'generated', at: 0 } };
  });

const entries = (zip: JSZip) => Object.keys(zip.files).filter((f) => !zip.files[f].dir).sort();

describe('exportFileStem', () => {
  it('slugs the title (re-exported for older imports)', () => {
    expect(exportFileStem(makeSampleDoc())).toBe('the-saffron-thief');
    expect(exportFileStem(makeSampleDoc((d) => (d.brief.title = 'Café  Noir!!')))).toBe('cafe-noir');
    expect(exportFileStem(makeSampleDoc((d) => (d.brief.title = '???')))).toBe('comic');
  });
});

describe('exportPngZip', () => {
  it('zips the cover and every drawn page in reading order, with progress, and downloads it', async () => {
    const download = vi.fn();
    const onProgress = vi.fn();
    const renderPage = vi.fn(async (_doc: ComicDoc, page: Page) => png(page.id));
    const renderImage = vi.fn(async () => png('cover'));
    const result = await exportPngZip(withCover(), fakeUrlFor, { download, onProgress, renderPage, renderImage, longEdge: 2000 });

    expect(result).toMatchObject({ fileName: 'the-saffron-thief-pages.zip', files: 3, failed: [] });
    expect(result.notice).toBeUndefined();
    expect(result.skipped).toEqual(['Page 2 (not drawn yet)', 'Page 3 (not drawn yet)', 'Page 4 (not drawn yet)', 'Page 6 (not drawn yet)']);
    expect(renderPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'pg_1' }), 'https://cdn.test/u/proj/pages/p1.png', expect.objectContaining({ longEdge: 2000 }));
    expect(renderImage).toHaveBeenCalledWith('https://cdn.test/u/cover.png', expect.anything());
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ done: 0, total: 3, label: 'Rendering cover (1 of 3)…' }));
    expect(onProgress).toHaveBeenLastCalledWith({ done: 3, total: 3, label: 'Done' });

    const [blob, name] = download.mock.calls[0];
    expect(name).toBe('the-saffron-thief-pages.zip');
    expect(blob.type).toBe('application/zip');
    const zip = await JSZip.loadAsync(await blobBytes(blob));
    expect(entries(zip)).toEqual(['the-saffron-thief/00-cover.png', 'the-saffron-thief/01-page-01.png', 'the-saffron-thief/02-page-05.png']);
    expect(await zip.file('the-saffron-thief/02-page-05.png')!.async('string')).toBe('png:pg_5');
  });

  it('includes the book plates as software pages and names files in slot order', async () => {
    const download = vi.fn();
    const renderPlate = vi.fn(async (_d: ComicDoc, kind: string) => png(kind));
    const result = await exportPngZip(makeBook(), fakeUrlFor, { download, renderPage: async (_d, p) => png(p.id), renderImage: async () => png('cover'), renderPlate });
    expect(result.files).toBe(6);
    const zip = await JSZip.loadAsync(await blobBytes(download.mock.calls[0][0]));
    expect(entries(zip)).toEqual([
      'the-saffron-thief/00-cover.png',
      'the-saffron-thief/01-title.png',
      'the-saffron-thief/02-page-01.png',
      'the-saffron-thief/03-page-05.png',
      'the-saffron-thief/04-end.png',
      'the-saffron-thief/05-back-cover.png'
    ]);
    // The back cover's vignette is the cover image.
    expect(renderPlate).toHaveBeenCalledWith(expect.anything(), 'back_cover', expect.objectContaining({ artUrl: 'https://cdn.test/u/proj/cover.png' }));
  });

  it('exports one edition: localized lettering and the edition’s title + “-te” as the file name', async () => {
    const download = vi.fn();
    const seen: string[] = [];
    const renderPage = vi.fn(async (d: ComicDoc, p: Page) => {
      seen.push(p.panels[0].lines[0].text);
      expect(d.format.language).toBe('te');
      return png(p.id);
    });
    const result = await exportPngZip(makeBook(undefined, { plates: false }), fakeUrlFor, { lang: 'te', download, renderPage, renderImage: async () => png('c') });
    expect(result.fileName).toBe('కుంకుమపువ్వు-దొంగ-te-pages.zip'); // the edition's own title
    expect(seen[0]).toBe('పాత దిల్లీ. ఎండకు ముందు.');
    await expect(exportPngZip(makeBook(), fakeUrlFor, { lang: 'hi', download })).rejects.toThrow('There is no Hindi edition of this comic yet.');
  });

  it('reports a page that failed and still exports the rest', async () => {
    const download = vi.fn();
    const renderPage = vi.fn(async (_doc: ComicDoc, page: Page) => {
      if (page.id === 'pg_5') throw new ExportError('The image link expired. Refresh the page and try again.');
      return png(page.id);
    });
    const result = await exportPngZip(makeSampleDoc(), fakeUrlFor, { download, renderPage, renderImage: vi.fn() });
    expect(result.files).toBe(1);
    expect(result.failed).toEqual([{ label: 'Page 5', message: 'The image link expired. Refresh the page and try again.' }]);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('fails honestly when nothing could be exported', async () => {
    const download = vi.fn();
    const renderPage = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(exportPngZip(makeSampleDoc(), fakeUrlFor, { download, renderPage })).rejects.toThrow(/Couldn’t export any pages\. Something went wrong: boom/);
    expect(download).not.toHaveBeenCalled();
  });

  it('refuses when nothing is drawn (plates alone are not a book)', async () => {
    const doc = makeBook((d) => {
      d.cover.render = { status: 'none', history: [] };
      d.pages.forEach((p) => (p.render = { status: 'none', history: [] }));
    });
    await expect(exportPngZip(doc, fakeUrlFor, { download: vi.fn() })).rejects.toThrow(/Nothing to export yet/);
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    const renderPage = vi.fn(async (_doc: ComicDoc, page: Page) => {
      controller.abort();
      return png(page.id);
    });
    await expect(exportPngZip(makeSampleDoc(), fakeUrlFor, { download: vi.fn(), renderPage, signal: controller.signal })).rejects.toThrow('Export cancelled.');
  });
});

describe('exportLanguagesZip (all published languages)', () => {
  it('puts each language in its own folder, re-lettered from the same art', async () => {
    const download = vi.fn();
    const calls: { lang: string; text: string; url: string }[] = [];
    const renderPage = vi.fn(async (d: ComicDoc, p: Page, url: string) => {
      calls.push({ lang: d.format.language, text: p.panels[0].lines[0].text, url });
      return png(`${d.format.language}:${p.id}`);
    });
    const doc = makeBook(undefined, { plates: false });
    doc.publication = { visibility: 'unlisted', status: 'live', publishedRev: 3, publishedAt: 1, languages: ['en', 'te'] };
    const result = await exportLanguagesZip(doc, fakeUrlFor, { download, renderPage, renderImage: async () => png('cover') });
    expect(result.languages).toEqual(['en', 'te']);
    expect(result.fileName).toBe('the-saffron-thief-all-languages.zip');
    expect(result.files).toBe(6);
    const zip = await JSZip.loadAsync(await blobBytes(download.mock.calls[0][0]));
    expect(entries(zip)).toEqual([
      'the-saffron-thief/en-english/00-cover.png',
      'the-saffron-thief/en-english/01-page-01.png',
      'the-saffron-thief/en-english/02-page-05.png',
      'the-saffron-thief/te-telugu/00-cover.png',
      'the-saffron-thief/te-telugu/01-page-01.png',
      'the-saffron-thief/te-telugu/02-page-05.png'
    ]);
    expect(await zip.file('the-saffron-thief/te-telugu/01-page-01.png')!.async('string')).toBe('png:te:pg_1');
    const te = calls.find((c) => c.lang === 'te' && c.url.endsWith('p1.png'))!;
    expect(te.text).toBe('పాత దిల్లీ. ఎండకు ముందు.');
    expect(calls.filter((c) => c.url.endsWith('p1.png')).map((c) => c.url)).toEqual(['https://cdn.test/u/proj/pages/p1.png', 'https://cdn.test/u/proj/pages/p1.png']);
  });

  it('only exports languages that exist; reports a failure per language', async () => {
    const download = vi.fn();
    const renderPage = vi.fn(async (d: ComicDoc, p: Page) => {
      if (d.format.language === 'te' && p.id === 'pg_5') throw new Error('boom');
      return png(p.id);
    });
    const result = await exportLanguagesZip(makeBook(undefined, { plates: false }), fakeUrlFor, { languages: ['te', 'hi', 'en'], download, renderPage, renderImage: async () => png('c') });
    expect(result.languages).toEqual(['en', 'te']);
    expect(result.failed).toEqual([{ label: 'Page 5 · Telugu', message: 'Something went wrong: boom' }]);
    expect(result.files).toBe(5);
  });
});
