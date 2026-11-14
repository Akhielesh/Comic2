import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CharacterDetail } from './CharacterDetail';
import { CastTab } from './CastTab';
import { asset, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';

afterEach(() => vi.restoreAllMocks());

describe('Character inspection', () => {
  it('opens the full sheet from the cast, switches references without editing, and restores opener focus', async () => {
    const studio = makeStudio();
    render(<CastTab studio={studio} doc={studio.doc!} />);
    const opener = screen.getByRole('button', { name: 'Open Maya portrait and details' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Maya' });
    expect(within(dialog).getByRole('img', { name: 'Maya — model sheet' })).toHaveAttribute('src', 'https://cdn.test/u/proj/sheets/maya-v2.png');
    expect(within(dialog).getByText('scar on left eyebrow')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reference photo 1' }));
    expect(within(dialog).getByRole('img', { name: 'Maya — reference photo 1' })).toHaveAttribute('src', 'https://cdn.test/u/proj/refs/maya.jpg');
    expect(studio.patch).not.toHaveBeenCalled();
    expect(studio.act).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(opener).toHaveFocus();
  });

  it('browses the whole cast with buttons and keyboard, preserves each portrait choice, and restores the original opener', async () => {
    const studio = makeStudio();
    render(<CastTab studio={studio} doc={studio.doc!} />);
    const opener = screen.getByRole('button', { name: 'Open Maya portrait and details' });
    opener.focus(); fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Reference photo 1' }));
    expect(screen.getByRole('button', { name: 'Previous character' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next character' }));
    const arjun = screen.getByRole('dialog', { name: 'Arjun' });
    expect(within(arjun).getByText(/No portrait yet/)).toBeInTheDocument();
    expect(within(arjun).queryByRole('img', { name: /Maya/ })).toBeNull();
    const characters = within(arjun).getByRole('group', { name: 'Characters' });
    fireEvent.keyDown(within(characters).getByRole('button', { name: 'Arjun' }), { key: 'Home' });
    expect(screen.getByRole('dialog', { name: 'Maya' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Maya — reference photo 1' })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Characters' })).getByRole('button', { name: 'Maya' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('group', { name: 'Characters' }), { key: 'End' });
    expect(screen.getByRole('button', { name: 'Next character' })).toBeDisabled();
    expect(studio.patch).not.toHaveBeenCalled(); expect(studio.act).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('inspects a character without art and returns to the existing name editor', async () => {
    const studio = makeStudio();
    render(<CastTab studio={studio} doc={studio.doc!} />);
    const card = screen.getByRole('article', { name: 'Arjun' });
    fireEvent.click(within(card).getByRole('button', { name: 'View character' }));
    expect(screen.getByRole('dialog', { name: 'Arjun' })).toHaveTextContent('No portrait yet');
    fireEvent.click(screen.getByRole('button', { name: 'Edit character' }));
    expect(studio.setTab).toHaveBeenCalledWith('cast');
    await waitFor(() => expect(within(card).getByLabelText('Name')).toHaveFocus());
    expect(studio.patch).not.toHaveBeenCalled();
  });

  it('selects a saved sheet through the existing free restore and Undo pipeline', () => {
    const doc = makeSampleDoc((d) => { d.pages = []; });
    const studio = makeStudio(doc);
    render(<CharacterDetail studio={studio} characterId="ch_maya" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Saved sheets (2)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Older version' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use v1 · Free' }));
    expect(studio.patch).toHaveBeenCalledWith([{ op: 'render_use', target: { kind: 'sheet', id: 'ch_maya' }, path: 'u/proj/sheets/maya-v1.png', at: expect.any(Number) }], expect.objectContaining({ label: 'Use version' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(studio.patch).toHaveBeenLastCalledWith([{ op: 'render_use', target: { kind: 'sheet', id: 'ch_maya' }, path: 'u/proj/sheets/maya-v2.png', at: expect.any(Number) }], expect.anything());
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('never requests blocked art and still allows inspecting a safe reference', () => {
    const doc = makeSampleDoc((d) => { d.cast[0].sheet.asset = asset('u/proj/blocked.png', { safety: { assessed: 'X', at: 1 } as never }); });
    const studio = makeStudio(doc);
    render(<CharacterDetail studio={studio} characterId="ch_maya" onClose={() => {}} />);
    expect(screen.queryByRole('img', { name: 'Maya — model sheet' })).toBeNull();
    expect(studio.urlFor).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reference photo 1' }));
    expect(screen.getByRole('img', { name: 'Maya — reference photo 1' })).toBeInTheDocument();
  });
});
