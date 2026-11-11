/**
 * PF-1: the cast board's card downloads await the on-demand loader (services/legacyPdfLoader.ts) instead
 * of the window globals index.html used to provide; a PNG never pulls jsPDF, and a failed load is a calm
 * status line above the board.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loadHtml2CanvasMock, loadJsPdfMock, loadLegacyPdfMock, html2canvasMock, jsPdfInstances } = vi.hoisted(() => ({
  loadHtml2CanvasMock: vi.fn(),
  loadJsPdfMock: vi.fn(),
  loadLegacyPdfMock: vi.fn(),
  html2canvasMock: vi.fn(),
  jsPdfInstances: [] as Array<{ args: unknown[]; save: ReturnType<typeof vi.fn>; addPage: ReturnType<typeof vi.fn> }>
}));

vi.mock('../../services/legacyPdfLoader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/legacyPdfLoader')>()),
  loadHtml2Canvas: loadHtml2CanvasMock,
  loadJsPdf: loadJsPdfMock,
  loadLegacyPdf: loadLegacyPdfMock
}));

vi.mock('../../services/geminiService', () => ({
  extractWorldDetails: vi.fn(async () => ({ characters: [], items: [], locations: [] })),
  checkConsistency: vi.fn(async () => ({}))
}));
vi.mock('../../services/imageService', () => ({ generateImage: vi.fn() }));
vi.mock('../../services/db', () => ({ getImageUrl: vi.fn(async () => undefined), saveImage: vi.fn(async () => 'img-1') }));
vi.mock('../../services/characterLibrary', () => ({ saveCharacterToLibrary: vi.fn(async () => {}) }));

import { LEGACY_PDF_MESSAGES, LegacyPdfLoadError } from '../../services/legacyPdfLoader';
import { ReferenceBuilder } from './ReferenceBuilder';

class FakeJsPdf {
  args: unknown[];
  internal = { pageSize: { getWidth: () => 148, getHeight: () => 210 } };
  addImage = vi.fn();
  addPage = vi.fn();
  save = vi.fn();
  output = vi.fn();
  constructor(...args: unknown[]) {
    this.args = args;
    jsPdfInstances.push(this);
  }
}

const characters = [
  { id: 'c1', name: 'SALTY CAT', bio: 'Tabby cat captain', description: 'Ginger tabby with a milky eye.', referenceImageIds: [] },
  { id: 'c2', name: 'PIP', bio: 'Mouse first mate', description: 'Grey mouse in a red scarf.', referenceImageIds: [] }
];

const renderBoard = () =>
  render(
    <ReferenceBuilder
      scenes={[{ id: 1, rawText: 'SALTY and PIP enter the tunnel.', synopsis: 'They enter.', characters: ['SALTY CAT', 'PIP'], setting: 'Tunnel' }]}
      script={'SALTY and PIP enter the tunnel.'}
      currentStyle={'comic style'}
      projectId={'project-1'}
      initialCharacters={characters}
      initialItems={[]}
      initialLocations={[]}
      agentSettings={{ confirmPolicy: 'big_spends', outputTargets: ['comic'], autoPageCount: true }}
      onDataUpdate={() => {}}
      onConfirm={() => {}}
    />
  );

const cardButton = (cardId: string, name: RegExp) => {
  const card = document.getElementById(`card-${cardId}`)!;
  return [...card.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''))!;
};

let clickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const m of [loadHtml2CanvasMock, loadJsPdfMock, loadLegacyPdfMock, html2canvasMock]) m.mockReset();
  jsPdfInstances.length = 0;
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 600;
  vi.spyOn(canvas, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA');
  html2canvasMock.mockResolvedValue(canvas);
  loadHtml2CanvasMock.mockResolvedValue(html2canvasMock);
  loadJsPdfMock.mockResolvedValue(FakeJsPdf);
  loadLegacyPdfMock.mockResolvedValue({ jsPDF: FakeJsPdf, html2canvas: html2canvasMock });
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReferenceBuilder card downloads on the on-demand loader', () => {
  it('rendering the board loads nothing', async () => {
    renderBoard();
    await screen.findByDisplayValue('SALTY CAT');
    expect(loadHtml2CanvasMock).not.toHaveBeenCalled();
    expect(loadJsPdfMock).not.toHaveBeenCalled();
    expect(loadLegacyPdfMock).not.toHaveBeenCalled();
  });

  it('a card PDF awaits both tools, captures the card and saves an A5 PDF', async () => {
    renderBoard();
    await screen.findByDisplayValue('SALTY CAT');
    fireEvent.click(cardButton('c1', /^PDF$/));
    await waitFor(() => expect(jsPdfInstances[0]?.save).toHaveBeenCalledWith('SALTY_CAT_card.pdf'));
    expect(loadHtml2CanvasMock).toHaveBeenCalledTimes(1);
    expect(loadJsPdfMock).toHaveBeenCalledTimes(1);
    expect(html2canvasMock).toHaveBeenCalledWith(document.getElementById('card-c1'), expect.objectContaining({ scale: 2 }));
    expect(jsPdfInstances[0].args).toEqual(['p', 'mm', 'a5']);
    // The busy state clears after a successful download too, not only after a failure.
    await waitFor(() => expect(cardButton('c1', /^PDF$/)).toBeEnabled());
    expect(cardButton('c2', /^Img$/)).toBeEnabled();
  });

  it('while the tools load, the pressed card button is aria-busy and every export waits, without the spinner widening the cell', async () => {
    let release!: (fn: unknown) => void;
    loadHtml2CanvasMock.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    renderBoard();
    await screen.findByDisplayValue('SALTY CAT');
    fireEvent.click(cardButton('c1', /^PDF$/));
    await waitFor(() => expect(cardButton('c1', /^PDF$/)).toHaveAttribute('aria-busy', 'true'));
    const busy = cardButton('c1', /^PDF$/);
    expect(busy).toBeDisabled();
    // Same 14 px icon as at rest: the legacy Button's 24 px spinner would push "PDF" over its neighbour at 320 px.
    expect(busy.querySelector('.animate-spin')).toBeNull();
    expect(busy.querySelector('span > svg')).not.toBeNull();
    expect(cardButton('c1', /^Img$/)).toHaveAttribute('aria-busy', 'false');
    expect(cardButton('c1', /^Img$/)).toBeDisabled();
    expect(cardButton('c2', /^PDF$/)).toBeDisabled();

    release(html2canvasMock);
    await waitFor(() => expect(jsPdfInstances[0]?.save).toHaveBeenCalledWith('SALTY_CAT_card.pdf'));
    await waitFor(() => expect(cardButton('c1', /^PDF$/)).toBeEnabled());
    expect(cardButton('c1', /^PDF$/)).toHaveAttribute('aria-busy', 'false');
  });

  it('a card PNG needs html2canvas only: jsPDF is never fetched', async () => {
    renderBoard();
    await screen.findByDisplayValue('SALTY CAT');
    fireEvent.click(cardButton('c2', /^Img$/));
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    expect(loadHtml2CanvasMock).toHaveBeenCalledTimes(1);
    expect(loadJsPdfMock).not.toHaveBeenCalled();
    expect(jsPdfInstances).toHaveLength(0);
  });

  it('the selected cards download as one PDF through the loader', async () => {
    renderBoard();
    await screen.findByDisplayValue('SALTY CAT');
    fireEvent.click(document.querySelector('#card-c1 [data-export-ignore="true"]')!);
    fireEvent.click(document.querySelector('#card-c2 [data-export-ignore="true"]')!);
    fireEvent.click(screen.getByRole('button', { name: /Download 2/ }));
    await waitFor(() => expect(jsPdfInstances[0]?.save).toHaveBeenCalledWith('DreamStream_Collection.pdf'));
    expect(loadLegacyPdfMock).toHaveBeenCalledTimes(1);
    expect(html2canvasMock).toHaveBeenCalledTimes(2);
    expect(jsPdfInstances[0].addPage).toHaveBeenCalledTimes(1);
    // The busy state clears: the collection button and every card button work again.
    await waitFor(() => expect(screen.getByRole('button', { name: /Download 2/ })).toBeEnabled());
    expect(cardButton('c1', /^PDF$/)).toBeEnabled();
  });

  it('a failed load is a calm status line above the board, and nothing is downloaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadHtml2CanvasMock.mockRejectedValueOnce(new LegacyPdfLoadError('timeout', 'html2canvas'));
    renderBoard();
    await screen.findByDisplayValue('SALTY CAT');
    fireEvent.click(cardButton('c1', /^PDF$/));
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(LEGACY_PDF_MESSAGES.timeout);
    expect(notice.className).not.toMatch(/red/);
    expect(jsPdfInstances).toHaveLength(0);
    expect(clickSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(cardButton('c1', /^PDF$/)).toBeEnabled());
    warn.mockRestore();
  });
});
