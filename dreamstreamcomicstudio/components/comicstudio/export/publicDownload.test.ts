import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { makeBook } from './__fixtures__/books';

const pdf = vi.fn(async (..._a: unknown[]) => ({ fileName: 'x.pdf', pages: 1, failed: [], skipped: [] }));
const zip = vi.fn(async (..._a: unknown[]) => ({ fileName: 'x.zip', files: 1, failed: [], skipped: [] }));
const zipAll = vi.fn(async (..._a: unknown[]) => ({ fileName: 'x.zip', files: 2, failed: [], skipped: [], languages: ['en', 'te'] }));
vi.mock('./pdfExport', () => ({ exportComicPdf: (...a: unknown[]) => pdf(...a) }));
vi.mock('./zipExport', () => ({ exportPngZip: (...a: unknown[]) => zip(...a), exportLanguagesZip: (...a: unknown[]) => zipAll(...a) }));

const { DOWNLOADS_OFF, PUBLIC_ASSET_PATH_RE, downloadPublicComic, publicDownloadsAllowed, publicExportLanguage, publicExportUrlFor } = await import('./publicDownload');

const KEY = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 chars
const P = (file: string) => `pub/${KEY}/${file}`;
const urls: Record<string, string> = {
  [P('cover-0123456789ab.webp')]: `https://cdn.test/${P('cover-0123456789ab.webp')}`,
  [P('page-1-0123456789ab.webp')]: `https://cdn.test/${P('page-1-0123456789ab.webp')}`,
  [P('page-2-0123456789ab.webp')]: `http://cdn.test/${P('page-2-0123456789ab.webp')}`,
  [P('page-3-0123456789ab.webp')]: `javascript:alert(1)`,
  'u/user-1/p/proj/pages/p1.png': 'https://cdn.test/private-signed-url'
};

describe('publicExportUrlFor (read-only share links fetch only published objects)', () => {
  const urlFor = publicExportUrlFor(urls);

  it('resolves published pub/ objects over https', () => {
    expect(urlFor(P('cover-0123456789ab.webp'))).toBe(`https://cdn.test/${P('cover-0123456789ab.webp')}`);
    expect(urlFor({ path: P('page-1-0123456789ab.webp'), source: 'generated', at: 0 })).toBeTruthy();
  });

  it('never resolves a private path, a traversal, a foreign key or a non-https URL', () => {
    expect(urlFor('u/user-1/p/proj/pages/p1.png')).toBeUndefined();
    expect(urlFor(`pub/${KEY}/../../u/user-1/p/proj/pages/p1.png`)).toBeUndefined();
    expect(urlFor('pub/short/page.webp')).toBeUndefined();
    expect(urlFor(P('page-2-0123456789ab.webp'))).toBeUndefined(); // plain http
    expect(urlFor(P('page-3-0123456789ab.webp'))).toBeUndefined(); // javascript:
    expect(urlFor(P('missing.webp'))).toBeUndefined(); // not in the payload
    expect(urlFor('https://evil.test/x.png')).toBeUndefined(); // a URL is never trusted as a path
    expect(publicExportUrlFor(null)(P('cover-0123456789ab.webp'))).toBeUndefined();
  });

  it('never resolves a withheld asset', () => {
    expect(urlFor({ path: P('page-1-0123456789ab.webp'), source: 'generated', at: 0, safety: { assessed: 'X', at: 1 } })).toBeUndefined();
  });

  it('matches the contract’s public asset shape', () => {
    expect(PUBLIC_ASSET_PATH_RE.test(P('page-1-0123456789ab-w1080.webp'))).toBe(true);
    expect(PUBLIC_ASSET_PATH_RE.test(`pub/${KEY}/sub/dir.webp`)).toBe(false);
  });

  it('allows plain http only for a local dev server', () => {
    const local = publicExportUrlFor({ [P('a.webp')]: `http://localhost:5173/${P('a.webp')}` });
    expect(local(P('a.webp'))).toBe(`http://localhost:5173/${P('a.webp')}`);
  });
});

describe('downloadPublicComic', () => {
  const doc = (): ComicDoc => makeBook();
  beforeEach(() => {
    pdf.mockClear();
    zip.mockClear();
    zipAll.mockClear();
  });

  it('honours the author’s “no downloads” switch (enforced, not just a hidden button)', async () => {
    const src = { publication: { allowDownload: false, languages: ['en'] }, doc: doc(), urls };
    await expect(downloadPublicComic(src, 'pdf')).rejects.toThrow(DOWNLOADS_OFF);
    await expect(downloadPublicComic(src, 'zip_all')).rejects.toThrow(DOWNLOADS_OFF);
    expect(pdf).not.toHaveBeenCalled();
    expect(publicDownloadsAllowed(undefined)).toBe(true); // the addendum's default
    expect(publicDownloadsAllowed({ allowDownload: true })).toBe(true);
  });

  it('exports the reader’s published language with the pub/-only resolver', async () => {
    const src = { publication: { allowDownload: true, languages: ['en', 'te'], defaultLang: 'en' }, doc: doc(), urls };
    await downloadPublicComic(src, 'pdf', { lang: 'te' });
    const [d, urlFor, opts] = pdf.mock.calls[0] as [ComicDoc, (a: unknown) => string | undefined, { lang: string }];
    expect(d).toBe(src.doc);
    expect(opts.lang).toBe('te');
    expect(urlFor('u/user-1/p/proj/pages/p1.png')).toBeUndefined();
    expect(urlFor(P('cover-0123456789ab.webp'))).toBeTruthy();
  });

  it('never exports an unpublished language (falls back to the publication default)', async () => {
    const src = { publication: { allowDownload: true, languages: ['en'], defaultLang: 'en' }, doc: doc(), urls };
    expect(publicExportLanguage(src, 'te')).toBe('en');
    await downloadPublicComic(src, 'zip', { lang: 'te' });
    expect((zip.mock.calls[0] as unknown[])[2]).toMatchObject({ lang: 'en' });
  });

  it('“all languages” contains exactly the published editions', async () => {
    const src = { publication: { allowDownload: true, languages: ['en', 'te', 'hi'] }, doc: doc(), urls };
    await downloadPublicComic(src, 'zip_all');
    expect((zipAll.mock.calls[0] as unknown[])[2]).toMatchObject({ languages: ['en', 'te'] });
  });
});
