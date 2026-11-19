// PresetTile / PresetGrid `hint` (declutter DX-0): the explanation of a choice lives off the tile. It is the tile's
// native title (a hover hint on a mouse) and, always, its accessible description (a hidden span the button points at
// with aria-describedby), so a screen reader announces it on focus and it never adds to the tile's name. No hint: the
// tile renders exactly as before (no title, no description).

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PresetGrid } from './PresetGrid';
import { PresetTile } from './PresetTile';

describe('PresetTile hint', () => {
  it('gives the tile a title and an accessible description, and leaves its name alone', () => {
    render(<PresetTile label="Noir" hint="Hard-boiled captions in a typewriter face." art={<span />} selected={false} onSelect={vi.fn()} />);
    const tile = screen.getByRole('radio', { name: 'Noir' });
    expect(tile).toHaveAttribute('title', 'Hard-boiled captions in a typewriter face.');
    expect(tile).toHaveAccessibleDescription('Hard-boiled captions in a typewriter face.');
    // The description is in the DOM (announced on focus), never visible text on the tile.
    const id = tile.getAttribute('aria-describedby')!;
    const desc = document.getElementById(id)!;
    expect(desc.textContent).toBe('Hard-boiled captions in a typewriter face.');
    expect(desc).not.toBeVisible();
  });

  it('two tiles never share a description id', () => {
    render(
      <>
        <PresetTile label="A" hint="First" art={<span />} selected={false} onSelect={vi.fn()} />
        <PresetTile label="B" hint="Second" art={<span />} selected={false} onSelect={vi.fn()} />
      </>
    );
    expect(screen.getByRole('radio', { name: 'A' })).toHaveAccessibleDescription('First');
    expect(screen.getByRole('radio', { name: 'B' })).toHaveAccessibleDescription('Second');
  });

  it('no hint: no title and no description, as before', () => {
    render(<PresetTile label="Ink" description="Bold lines" art={<span />} selected onSelect={vi.fn()} />);
    const tile = screen.getByRole('radio', { name: /Ink/ });
    expect(tile).not.toHaveAttribute('title');
    expect(tile).not.toHaveAttribute('aria-describedby');
    expect(screen.getByText('Bold lines')).toBeVisible();
  });

  it('PresetGrid passes each option’s hint to its tile', () => {
    render(
      <PresetGrid
        label="Lettering style"
        value="a"
        onChange={vi.fn()}
        options={[
          { value: 'a', label: 'Classic', hint: 'Bold uppercase.', art: <span /> },
          { value: 'b', label: 'Manga', art: <span /> }
        ]}
      />
    );
    expect(screen.getByRole('radio', { name: 'Classic' })).toHaveAccessibleDescription('Bold uppercase.');
    expect(screen.getByRole('radio', { name: 'Classic' })).toHaveAttribute('title', 'Bold uppercase.');
    expect(screen.getByRole('radio', { name: 'Manga' })).not.toHaveAttribute('aria-describedby');
  });
});

describe('PresetTile check corner', () => {
  const check = (name: string) => screen.getByRole('radio', { name }).querySelector('[data-slot="preset-check"]')!;

  it('the chosen check sits top right by default and top left when the art asks for it', () => {
    render(
      <>
        <PresetTile label="Right" art={<span />} selected onSelect={vi.fn()} />
        <PresetTile label="Left" art={<span />} selected checkSide="left" onSelect={vi.fn()} />
      </>
    );
    expect(check('Right').className).toMatch(/(^|\s)right-3(\s|$)/);
    expect(check('Right').className).not.toMatch(/(^|\s)left-3(\s|$)/);
    expect(check('Left').className).toMatch(/(^|\s)left-3(\s|$)/);
    expect(check('Left').className).not.toMatch(/(^|\s)right-3(\s|$)/);
  });

  it('PresetGrid passes each option’s checkSide to its tile', () => {
    render(
      <PresetGrid
        label="Lettering style"
        value="a"
        onChange={vi.fn()}
        options={[
          { value: 'a', label: 'Classic', checkSide: 'left', art: <span /> },
          { value: 'b', label: 'Manga', art: <span /> }
        ]}
      />
    );
    expect(check('Classic').className).toMatch(/(^|\s)left-3(\s|$)/);
  });
});
