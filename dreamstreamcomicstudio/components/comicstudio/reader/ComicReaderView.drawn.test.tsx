// One "drawn" definition (PROGRAM3 B25, declutter F7): the inline reader and the board's Pages badge agree on
// how many pages are drawn — drawn AND current — and the reader names the out-of-date ones apart (they still
// read: they have art). Its progress bar moves by transform only (reader.md §5.3).
import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { fakeUrlFor, makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { pageProgress } from '../board/boardModel';
import { pageImageCache } from '../immersive/pageImageCache';
import { ComicReaderView, drawnCount, drawnLabel } from './ComicReaderView';
import { readerItems } from './readerModel';

const pdfMock = vi.hoisted(() => ({ exportComicPdf: vi.fn() }));
vi.mock('../export/pdfExport', () => pdfMock);

const art = (n: number) => ({ path: `u/p${n}.png`, source: 'generated' as const, at: 0, w: 1000, h: 1500 });

/** Pages 1–3 drawn and current, page 4 drawn but out of date (its script changed), the rest not drawn. */
const halfDrawn = (): ComicDoc =>
  makeSampleDoc((d) => {
    d.cover.render = { status: 'ready', history: [], asset: { path: 'u/cover.png', source: 'generated', at: 0, w: 1000, h: 1500 } };
    d.pages.forEach((p, i) => {
      const n = i + 1;
      p.render = n <= 3 ? { status: 'ready', history: [], asset: art(n) } : n === 4 ? { status: 'stale', history: [], asset: art(n) } : { status: 'none', history: [] };
    });
  });

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(8), { status: 200 })));
  let n = 0;
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:test/${(n += 1)}`;
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
  (HTMLImageElement.prototype as unknown as { decode: () => Promise<void> }).decode = () => Promise.resolve();
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
  pageImageCache.clear();
});

describe('the reader and the board agree on "drawn"', () => {
  it('the reader says what the Pages badge says (3, not the 4 pages it can show), plus the out-of-date one', () => {
    const doc = halfDrawn();
    const board = pageProgress(doc);
    expect(board).toEqual({ ready: 3, total: doc.pages.length });
    // The reader still shows the out-of-date page (it has art): 4 readable pages.
    expect(readerItems(doc).filter((i) => i.kind === 'page')).toHaveLength(4);
    render(<ComicReaderView doc={doc} urlFor={fakeUrlFor} initialMode="page" />);
    const chip = screen.getByTestId('reader-drawn');
    expect(chip.textContent).toBe(`3 of ${doc.pages.length} pages drawn · 1 out of date`);
    expect(chip.textContent).toContain(`${board.ready} of ${board.total}`);
  });

  it('drawnCount / drawnLabel: one formula, singular and plural, no "out of date" when there is none', () => {
    const doc = halfDrawn();
    expect(drawnCount(doc)).toEqual({ ready: 3, total: doc.pages.length, outOfDate: 1 });
    expect(drawnLabel({ ready: 0, total: 1, outOfDate: 0 })).toBe('0 of 1 page drawn');
    expect(drawnLabel({ ready: 5, total: 6, outOfDate: 0 })).toBe('5 of 6 pages drawn');
  });

  it('a fully drawn, current comic shows no drawn chip', () => {
    const doc = makeSampleDoc((d) => d.pages.forEach((p, i) => (p.render = { status: 'ready', history: [], asset: art(i + 1) })));
    render(<ComicReaderView doc={doc} urlFor={fakeUrlFor} initialMode="page" />);
    expect(screen.queryByTestId('reader-drawn')).toBeNull();
  });
});

describe('the inline progress bar', () => {
  it('scales from the reading edge (transform) and never animates width', () => {
    const doc = halfDrawn();
    render(<ComicReaderView doc={doc} urlFor={fakeUrlFor} initialMode="page" initialPage={2} />);
    const bar = screen.getByTestId('reader-progress');
    expect(bar.style.width).toBe('');
    expect(bar.style.transform).toMatch(/^scaleX\(0?\.\d+\)$/);
    expect(bar.style.transformOrigin).toBe('left');
    expect(bar.className).not.toMatch(/transition-\[width\]/);
  });
});
