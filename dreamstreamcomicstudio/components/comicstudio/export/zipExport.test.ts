import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { fakeUrlFor, makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { ExportError } from './rasterize';
import { blobBytes, exportFileStem, exportPngZip } from './zipExport';

const png = (label: string) => new Blob([new TextEncoder().encode(`png:${label}`)], { type: 'image/png' });

const withCover = () =>
  makeSampleDoc((d) => {
    d.cover.render = { status: 'ready', history: [], asset: { path: 'u/cover.png', source: 'generated', at: 0 } };
  });


describe('exportFileStem', () => {
  it('slugs the title', () => {
    expect(exportFileStem(makeSampleDoc())).toBe('the-saffron-thief');
    expect(exportFileStem(makeSampleDoc((d) => (d.brief.title = 'Café  Noir!!')))).toBe('cafe-noir');
    expect(exportFileStem(makeSampleDoc((d) => (d.brief.title = '???')))).toBe('comic');
  });
});

describe('exportPngZip', () => {
  it('zips the cover and every drawn page, with progress, and downloads it', async () => {
    const download = vi.fn();
    const onProgress = vi.fn();
    const renderPage = vi.fn(async (_doc, page) => png(page.id));
    const renderImage = vi.fn(async () => png('cover'));
    const result = await exportPngZip(withCover(), fakeUrlFor, { download, onProgress, renderPage, renderImage, longEdge: 2000 });

    expect(result).toMatchObject({ fileName: 'the-saffron-thief-pages.zip', files: 3, failed: [] });
    expect(result.skipped).toEqual(['Page 2 (not drawn yet)', 'Page 3 (not drawn yet)', 'Page 4 (not drawn yet)', 'Page 6 (not drawn yet)']);
    expect(renderPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'pg_1' }), 'https://cdn.test/u/proj/pages/p1.png', expect.objectContaining({ longEdge: 2000 }));
    expect(renderImage).toHaveBeenCalledWith('https://cdn.test/u/cover.png', expect.anything());
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ done: 0, total: 3 }));
    expect(onProgress).toHaveBeenLastCalledWith({ done: 3, total: 3, label: 'Done' });

    const [blob, name] = download.mock.calls[0];
    expect(name).toBe('the-saffron-thief-pages.zip');
    expect(blob.type).toBe('application/zip');
    const zip = await JSZip.loadAsync(await blobBytes(blob));
    expect(Object.keys(zip.files).filter((f) => !zip.files[f].dir).sort()).toEqual([
      'the-saffron-thief/00-cover.png',
      'the-saffron-thief/page-01.png',
      'the-saffron-thief/page-05.png'
    ]);
    expect(await zip.file('the-saffron-thief/page-05.png')!.async('string')).toBe('png:pg_5');
  });

  it('reports a page that failed and still exports the rest', async () => {
    const download = vi.fn();
    const renderPage = vi.fn(async (_doc, page) => {
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

  it('refuses when nothing is drawn', async () => {
    const doc = makeSampleDoc((d) => d.pages.forEach((p) => (p.render = { status: 'none', history: [] })));
    await expect(exportPngZip(doc, fakeUrlFor, { download: vi.fn() })).rejects.toThrow(/Nothing to export yet/);
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    const renderPage = vi.fn(async (_doc, page) => {
      controller.abort();
      return png(page.id);
    });
    await expect(exportPngZip(makeSampleDoc(), fakeUrlFor, { download: vi.fn(), renderPage, signal: controller.signal })).rejects.toThrow('Export cancelled.');
  });
});
