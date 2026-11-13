// @vitest-environment jsdom
// The project's image lightbox on Atlas (DS-3): a labelled modal dialog whose every control has a name, that
// steps with ← / → and closes on Escape, and marks the picture on show in the strip (aria-current), not by
// colour alone.
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIALOG_TITLE, Z } from '../chat/studioDesign';
import { MasterGalleryModal, type MasterGalleryItem } from './MasterGalleryModal';

afterEach(cleanup);

const ITEMS: MasterGalleryItem[] = [
  { imageId: 'a', url: 'data:image/png;base64,AA==', tag: 'P1', label: 'Panel 1', category: 'PANEL', usedIn: ['Page 1'] },
  { imageId: 'b', url: 'data:image/png;base64,AA==', tag: 'P2', label: 'Panel 2', category: 'PANEL' },
  { imageId: 'c', url: 'data:image/png;base64,AA==', tag: 'C1', label: 'Cover', category: 'COVER' }
];

describe('MasterGalleryModal', () => {
  it('is a modal dialog titled with DIALOG_TITLE, on the sheet layer, with every control named', () => {
    render(<MasterGalleryModal items={ITEMS} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'P1 · Panel 1' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const title = within(dialog).getByRole('heading', { level: 2 });
    for (const cls of DIALOG_TITLE.split(' ')) expect(title.className.split(/\s+/)).toContain(cls);
    expect(screen.getByTestId('master-gallery').className).toContain(Z.sheet);
    for (const name of ['Close the gallery', 'Previous image', 'Next image', 'Show P1', 'Show P2', 'Show C1']) {
      expect(within(dialog).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close the gallery' }));
    expect(dialog.innerHTML).not.toMatch(/border-black|shadow-comic|font-comic|(?<![\w-])font-display|brand-(?:yellow|blue|red)/);
  });

  it('steps with the arrow keys and the buttons, and marks the picture on show', () => {
    render(<MasterGalleryModal items={ITEMS} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Show P1' })).toHaveAttribute('aria-current', 'true');
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByRole('dialog', { name: 'P2 · Panel 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show P2' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Show P1' })).not.toHaveAttribute('aria-current');
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(screen.getByRole('dialog', { name: 'C1 · Cover' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(screen.getByRole('dialog', { name: 'P1 · Panel 1' })).toBeInTheDocument();
  });

  it('Escape and the scrim close it; a click inside does not', () => {
    const onClose = vi.fn();
    render(<MasterGalleryModal items={ITEMS} onClose={onClose} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('master-gallery'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('with no pictures it says so calmly and offers no stepping', () => {
    render(<MasterGalleryModal items={[]} onClose={vi.fn()} />);
    expect(screen.getByText('No images available.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next image' })).toBeNull();
  });
});
