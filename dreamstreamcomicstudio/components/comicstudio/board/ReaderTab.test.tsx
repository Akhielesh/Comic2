// Read tab exports (P2-WIRING-CLIENT): the SOURCE doc goes to every exporter with the edition's
// `lang` (so files are named "…-te" and that script's faces load), every result's `notice` is shown,
// and "All languages (ZIP)" exports the published editions — sized to the device first.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { FONT_NOTICE } from '../export/fonts';
import { plateWidthFor } from '../export/batch';
import { collectExportSlots } from '../export/sequence';

const ex = vi.hoisted(() => ({
  pdf: vi.fn(),
  zip: vi.fn(),
  zipAll: vi.fn(),
  print: vi.fn(),
  motion: vi.fn(),
  plan: null as null | { fits: boolean; maxEdge?: number },
  oneFits: null as null | boolean,
  planCalls: [] as unknown[][]
}));
vi.mock('../export/pdfExport', () => ({ exportComicPdf: ex.pdf }));
vi.mock('../export/zipExport', () => ({ exportPngZip: ex.zip, exportLanguagesZip: ex.zipAll }));
vi.mock('../export/printView', () => ({ openPrintView: ex.print }));
vi.mock('../export/motionComic', async (importOriginal) => ({ ...(await importOriginal<typeof import('../export/motionComic')>()), exportMotionComic: ex.motion }));
vi.mock('../export/zipMemory', async (importOriginal) => {
  const real = await importOriginal<typeof import('../export/zipMemory')>();
  return {
    ...real,
    planZipMemory: (...args: Parameters<typeof real.planZipMemory>) => {
      ex.planCalls.push(args);
      return ex.plan ? { fullBytes: 0, bytes: 0, budget: 1, fullEdge: 2048, ...ex.plan } : real.planZipMemory(...args);
    },
    oneLanguageZipFits: (...args: Parameters<typeof real.oneLanguageZipFits>) => (ex.oneFits ?? real.oneLanguageZipFits(...args))
  };
});

import { ReaderTab } from './ReaderTab';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';
import { teluguEdition } from '../export/__fixtures__/books';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('offline');
    })
  );
  ex.plan = null;
  ex.oneFits = null;
  ex.planCalls = [];
  for (const f of [ex.pdf, ex.zip, ex.zipAll, ex.print, ex.motion]) f.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const withTelugu = (published?: string[]) =>
  makeSampleDoc((d) => {
    d.i18n = { editions: { te: teluguEdition() }, glossary: [] };
    if (published) d.publication = { visibility: 'unlisted', status: 'live', slug: 'Ab3dEf6hIj9kLm2nOp5q', publishedRev: 3, publishedAt: SAMPLE_NOW, languages: published };
  });

const openSheet = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Share & export' }));
  return screen.getByTestId('share-export-sheet');
};

const pickTelugu = () => fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Reading language' })).getByRole('radio', { name: /తెలుగు/ }));

describe('ReaderTab exports', () => {
  it('PDF: the source doc + the picked edition’s lang, and the font notice is shown (never swallowed)', async () => {
    ex.pdf.mockResolvedValue({ fileName: 'kunkuma-te.pdf', pages: 3, failed: [], skipped: [], notice: FONT_NOTICE });
    const doc = withTelugu();
    const studio = makeStudio(doc);
    render(<ReaderTab studio={studio} doc={doc} />);
    pickTelugu();
    fireEvent.click(within(openSheet()).getByRole('button', { name: /^PDF/ }));
    const status = await screen.findByText(/Downloaded kunkuma-te\.pdf \(3 pages\)\./);
    expect(status).toHaveTextContent(FONT_NOTICE);
    const [passedDoc, urlFor, opts] = ex.pdf.mock.calls[0] as [ComicDoc, unknown, { lang?: string }];
    expect(passedDoc).toBe(doc); // the SOURCE doc, not a localized copy
    expect(urlFor).toBe(studio.urlFor);
    expect(opts.lang).toBe('te');
    // A font fallback is a warning, not a plain success.
    expect(status.closest('[role="status"]')!.className).toContain('amber');
  });

  it('a draft edition’s download says how many lines are still in the original language', async () => {
    ex.zip.mockResolvedValue({ fileName: 'x-te-pages.zip', files: 2, failed: [], skipped: [] });
    const doc = makeSampleDoc((d) => {
      d.i18n = { editions: { te: { lang: 'te', lines: {}, balloons: {}, register: 'everyday' } }, glossary: [] };
    });
    render(<ReaderTab studio={makeStudio(doc)} doc={doc} />);
    pickTelugu();
    fireEvent.click(within(openSheet()).getByRole('button', { name: /^PNG pages/ }));
    expect(await screen.findByText(/Downloaded x-te-pages\.zip \(2 images\)\. .*lines? (is|are) still in English in this edition\./)).toBeInTheDocument();
    expect((ex.zip.mock.calls[0][2] as { lang?: string }).lang).toBe('te');
  });

  it('PNG ZIP in the source language: lang is the source (no suffix), notice and left-out pages shown', async () => {
    ex.zip.mockResolvedValue({ fileName: 'the-saffron-thief-pages.zip', files: 2, failed: [{ label: 'Page 5', message: 'didn’t load' }], skipped: ['Page 2 (not drawn yet)'], notice: 'To fit in this device’s memory, the images were saved at up to 1,472 px (full size is 2,048 px).' });
    const doc = makeSampleDoc();
    render(<ReaderTab studio={makeStudio(doc)} doc={doc} />);
    fireEvent.click(within(openSheet()).getByRole('button', { name: /^PNG pages/ }));
    const status = await screen.findByText(/Downloaded the-saffron-thief-pages\.zip/);
    expect(status).toHaveTextContent('Left out — Page 5: didn’t load; Page 2 (not drawn yet).');
    expect(status).toHaveTextContent('saved at up to 1,472 px');
    expect((ex.zip.mock.calls[0][2] as { lang?: string }).lang).toBe('en');
    expect(ex.zip.mock.calls[0][0]).toBe(doc);
  });

  it('print and motion get the edition too, and show their notice', async () => {
    ex.print.mockResolvedValue({ pages: 4, skipped: [], failedImages: [], notice: FONT_NOTICE });
    ex.motion.mockResolvedValue({ fileName: 'x-te-motion.mp4', durationMs: 12_300, mimeType: 'video/mp4', skipped: [], engine: 'webcodecs', notice: FONT_NOTICE });
    const doc = withTelugu();
    render(<ReaderTab studio={makeStudio(doc)} doc={doc} />);
    pickTelugu();
    fireEvent.click(within(openSheet()).getByRole('button', { name: /^Print/ }));
    expect(await screen.findByText(/Print view ready/)).toHaveTextContent(FONT_NOTICE);
    expect(ex.print.mock.calls[0][0]).toBe(doc);
    expect((ex.print.mock.calls[0][2] as { lang?: string }).lang).toBe('te');

    fireEvent.click(within(openSheet()).getByRole('button', { name: 'Motion comic, Square 1:1' }));
    expect(await screen.findByText(/Downloaded x-te-motion\.mp4 — 12\.3s, 1:1\./)).toHaveTextContent(FONT_NOTICE);
    expect(ex.motion.mock.calls[0][2]).toMatchObject({ aspect: '1:1', lang: 'te' });
  });

  it('"All languages (ZIP)" exports every published edition, a folder each', async () => {
    ex.zipAll.mockResolvedValue({ fileName: 'the-saffron-thief-all-languages.zip', files: 6, failed: [], skipped: [], languages: ['en', 'te'], notice: FONT_NOTICE });
    const doc = withTelugu(['en', 'te']);
    const studio = makeStudio(doc);
    render(<ReaderTab studio={studio} doc={doc} />);
    const row = within(openSheet()).getByRole('button', { name: /^All languages \(ZIP\)/ });
    expect(row).toHaveTextContent('English and Telugu — a folder each');
    fireEvent.click(row);
    const status = await screen.findByText(/Downloaded the-saffron-thief-all-languages\.zip — English and Telugu, a folder each \(6 images\)\./);
    expect(status).toHaveTextContent(FONT_NOTICE);
    expect(ex.zipAll).toHaveBeenCalledWith(doc, studio.urlFor, expect.objectContaining({ languages: ['en', 'te'] }));
  });

  it('only published languages go in, even when the comic has more editions', () => {
    const doc = withTelugu(['en']);
    render(<ReaderTab studio={makeStudio(doc)} doc={doc} />);
    expect(within(openSheet()).queryByRole('button', { name: /^All languages/ })).toBeNull();
  });

  it('before publishing, drafts are never part of "All languages"', () => {
    const doc = makeSampleDoc((d) => {
      d.i18n = { editions: { te: { lang: 'te', lines: {}, balloons: {}, register: 'everyday' } }, glossary: [] };
    });
    render(<ReaderTab studio={makeStudio(doc)} doc={doc} />);
    expect(within(openSheet()).queryByRole('button', { name: /^All languages/ })).toBeNull();
  });

  it('too big for this device: the row says so up front and is not offered (no crashed tab)', () => {
    ex.plan = { fits: false, maxEdge: 1280 };
    ex.oneFits = true;
    const doc = withTelugu(['en', 'te']);
    render(<ReaderTab studio={makeStudio(doc)} doc={doc} />);
    const row = within(openSheet()).getByRole('button', { name: /^All languages \(ZIP\)/ });
    expect(row).toBeDisabled();
    expect(row).toHaveTextContent('Too big for one ZIP on this device — pick one language with the language switch and download its PNG pages');
    fireEvent.click(row);
    expect(ex.zipAll).not.toHaveBeenCalled();
  });

  it('too big even one language at a time: the row points to the PDF, never to a ZIP that would be refused too', () => {
    ex.plan = { fits: false, maxEdge: 1280 };
    ex.oneFits = false;
    const doc = withTelugu(['en', 'te']);
    render(<ReaderTab studio={makeStudio(doc)} doc={doc} />);
    const row = within(openSheet()).getByRole('button', { name: /^All languages \(ZIP\)/ });
    expect(row).toBeDisabled();
    expect(row).toHaveTextContent('Too big to zip on this device, even one language at a time — download each language’s PDF instead');
    expect(row).not.toHaveTextContent(/pick one language/);
  });

  it('the row is sized exactly as the exporter sizes it (same plate width)', () => {
    const doc = withTelugu(['en', 'te']);
    const studio = makeStudio(doc);
    render(<ReaderTab studio={studio} doc={doc} />);
    openSheet();
    const call = ex.planCalls.find((c) => c[1] === 2);
    expect(call).toBeDefined();
    const { slots } = collectExportSlots(doc, studio.urlFor);
    expect(call![0]).toEqual(slots);
    expect((call![2] as { plateWidth?: number }).plateWidth).toBe(plateWidthFor(slots));
  });

  it('a ZIP that has to be smaller says so before the click', () => {
    ex.plan = { fits: true, maxEdge: 1472 };
    const doc = withTelugu(['en', 'te']);
    render(<ReaderTab studio={makeStudio(doc)} doc={doc} />);
    expect(within(openSheet()).getByRole('button', { name: /^All languages \(ZIP\)/ })).toHaveTextContent('saved smaller to fit this device (up to 1,472 px)');
  });

  it('an export that fails shows its honest message as an alert', async () => {
    ex.zipAll.mockRejectedValue(new Error('This book is too big to zip in all 2 languages at once on this device. Download one language at a time instead.'));
    const doc = withTelugu(['en', 'te']);
    render(<ReaderTab studio={makeStudio(doc)} doc={doc} />);
    fireEvent.click(within(openSheet()).getByRole('button', { name: /^All languages \(ZIP\)/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Download one language at a time instead/));
  });
});

// Phone landscape (ui-findings 2026-10-29, board/read at 734×343): the board pane is ~100 px tall, so the
// tab's own action row plus the reader toolbar (two rows) left the toolbar clipped under the pane. On a
// compact-height device the actions fold into the reader's toolbar: one row, every control reachable.
describe('ReaderTab in phone landscape (compact height)', () => {
  it('folds its actions into the reader toolbar and drops the browser full-screen button', () => {
    const doc = makeSampleDoc();
    render(
      <FormFactorProvider value={formFactorFor({ w: 734, h: 343, coarse: true })}>
        <ReaderTab studio={makeStudio(doc)} doc={doc} />
      </FormFactorProvider>
    );
    expect(screen.queryByRole('toolbar', { name: 'Reader actions' })).toBeNull();
    const toolbar = screen.getByTestId('reader-toolbar');
    expect(within(toolbar).getByRole('button', { name: 'Read full screen' })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: 'Share & export' })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: 'Reader look' })).toBeInTheDocument();
    expect(within(toolbar).queryByRole('button', { name: 'Full screen' })).toBeNull();
  });

  it('keeps the action row above the reader at regular heights', () => {
    const doc = makeSampleDoc();
    render(
      <FormFactorProvider value={formFactorFor({ w: 1024, h: 768, coarse: true })}>
        <ReaderTab studio={makeStudio(doc)} doc={doc} />
      </FormFactorProvider>
    );
    expect(screen.getByRole('toolbar', { name: 'Reader actions' })).toBeInTheDocument();
    expect(within(screen.getByTestId('reader-toolbar')).queryByRole('button', { name: 'Read full screen' })).toBeNull();
  });
});
