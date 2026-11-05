// W1.9: the slide deck card. It previews every slide from the DeckSpec, downloads a real .pptx through
// services/platformExport (exportPptx, then downloadPlatformFile), shows friendlyExportError when the export fails,
// blocks the download while content overlaps, and never shows '$' to a governed person.
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

const exporter = vi.hoisted(() => ({ exportPptx: vi.fn(), downloadPlatformFile: vi.fn() }));
vi.mock('../../../services/platformExport', () => exporter);

import { DeckDraftCard, deckPreviewTheme } from './DeckDraftCard';
import { deckDraftDemo } from '../ComponentGallery';
import { GALLERY_DEMOS } from '../ComponentGallery';
import type { DeckDraftArtifact } from '../../../apiTypes';
import { ExportError } from '../../comicstudio/export/errors';
import { checkDeckSpec, deckOverlaps } from '../../../packages/platform-core/src/models/deck/index';

const file = { blob: new Blob(['x']), fileName: 'deck.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 1 };

beforeEach(() => {
  exporter.exportPptx.mockReset().mockResolvedValue(file);
  exporter.downloadPlatformFile.mockReset();
});

describe('DeckDraftCard', () => {
  it('downloads through exportPptx(deck) then downloadPlatformFile(file)', async () => {
    render(<DeckDraftCard data={deckDraftDemo} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download \.pptx/i }));
    });
    expect(exporter.exportPptx).toHaveBeenCalledTimes(1);
    expect(exporter.exportPptx.mock.calls[0][0]).toBe(deckDraftDemo.deck);
    expect(exporter.exportPptx.mock.calls[0][1]).toEqual({ fileName: deckDraftDemo.deck.title });
    expect(exporter.downloadPlatformFile).toHaveBeenCalledWith(file);
    expect(screen.getByText(/Downloaded\./)).toBeTruthy();
  });

  it('shows the friendly export error when the export fails', async () => {
    exporter.exportPptx.mockRejectedValueOnce(new ExportError('This deck would be 41 MB, over the 40 MB limit. Try fewer pages or smaller pictures.', 'too_big'));
    render(<DeckDraftCard data={deckDraftDemo} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download \.pptx/i }));
    });
    expect(screen.getByRole('alert').textContent).toBe('This deck would be 41 MB, over the 40 MB limit. Try fewer pages or smaller pictures.');
    expect(exporter.downloadPlatformFile).not.toHaveBeenCalled();
    exporter.exportPptx.mockRejectedValueOnce(new Error('chunk failed'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /download \.pptx/i }));
    });
    expect(screen.getByRole('alert').textContent).toBe('Something went wrong: chunk failed');
  });

  it('blocks the download while content overlaps, and outlines the overlapping elements', async () => {
    const overlapping = GALLERY_DEMOS.find((d) => d.title.startsWith('Slide deck — overlap'))!;
    const data = (overlapping.node as React.ReactElement<{ data: DeckDraftArtifact }>).props.data;
    const { container } = render(<DeckDraftCard data={data} />);
    const button = screen.getByRole('button', { name: /download \.pptx/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(exporter.exportPptx).not.toHaveBeenCalled();
    expect(screen.getByText(/1 pair of elements overlap/)).toBeTruthy();
    const outlined = [...container.querySelectorAll<HTMLElement>('[data-element]')].filter((el) => el.style.outline.includes('dashed'));
    expect(outlined.map((el) => el.dataset.element).sort()).toEqual(['b2', 'c2']);
    // The demo's overlap list is what the model's own check reports for that deck.
    expect(deckOverlaps(data.deck).map((o) => ({ slideId: o.slideId, pairs: o.pairs.map((p) => [p.a, p.b]) }))).toEqual([{ slideId: 's2', pairs: [['b2', 'c2']] }]);
  });

  it('previews each slide and switches the large preview from the slide strip', () => {
    render(<DeckDraftCard data={deckDraftDemo} />);
    expect(screen.getByRole('img', { name: 'Slide 1 of 3: Season one' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show slide 3: Budget' }));
    expect(screen.getByRole('img', { name: 'Slide 3 of 3: Budget' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Selected slide' })).getByText('Fit-out')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show slide 2: What we shipped' }));
    expect(screen.getByRole('img', { name: /bar chart: RSVPs by week/ })).toBeTruthy();
    expect(screen.getByText(/Lead with the RSVP numbers/)).toBeTruthy();
  });

  it('the usage line names no amount (the chat turn already counted it), so nobody sees $ or "Free"', () => {
    for (const governed of [true, false, undefined]) {
      const view = render(<DeckDraftCard data={{ ...deckDraftDemo, governed: governed as boolean }} />);
      const text = view.container.textContent || '';
      expect(text, String(governed)).toContain("Included in this chat's usage — no extra model call. The file is built on your device.");
      expect(text, String(governed)).not.toContain('$');
      expect(text, String(governed)).not.toMatch(/\bFree\b/);
      view.unmount();
    }
  });

  it('the gallery deck is a valid, overlap-free DeckSpec and the preview uses the renderer’s colours', () => {
    expect(checkDeckSpec(deckDraftDemo.deck).ok).toBe(true);
    expect(deckOverlaps(deckDraftDemo.deck)).toEqual([]);
    expect(deckPreviewTheme({ theme: { preset: 'dark' } })).toMatchObject({ background: '#1A1915', text: '#F5F4EF' });
    expect(deckPreviewTheme({ theme: { preset: 'light', background: '#102030' } }).background).toBe('#102030');
  });
});
