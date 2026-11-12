// @vitest-environment jsdom
// ComicPageSpecimen: a real comic page drawn from the library's procedural art, for every look, with the studio's
// own lettering — and art content only (aria-hidden, data-comic-art), with no hex in its source and no comic face as
// a class.
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { STYLE_PRESETS } from '../../shared/comic/stylePresets';
import { luminance } from '../comicstudio/library/procedural/textures';
import { ComicPageSpecimen, SPECIMEN_LINES, SPECIMEN_LOOKS, specimenInks, specimenPreset, type SpecimenLayout } from './ComicPageSpecimen';

afterEach(cleanup);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAYOUTS: SpecimenLayout[] = ['opening', 'chase'];

/** '#rrggbb' as the rgb() jsdom normalizes inline colours to. */
const rgb = (hex: string) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

describe('ComicPageSpecimen', () => {
  it('draws a page for every style preset, and Ligne claire for an unknown look', () => {
    for (const preset of STYLE_PRESETS) {
      const { container, unmount } = render(<ComicPageSpecimen look={preset.id} />);
      const page = container.firstElementChild as HTMLElement;
      expect(page).toHaveAttribute('data-specimen-look', preset.id);
      expect(page.querySelectorAll('[data-preset-thumb]').length, preset.id).toBe(3);
      unmount();
    }
    const { container } = render(<ComicPageSpecimen look="no-such-look" />);
    expect(container.firstElementChild).toHaveAttribute('data-specimen-look', 'ligne-claire');
  });

  it('is art: aria-hidden and data-comic-art on the root, three bordered panels per layout', () => {
    for (const layout of LAYOUTS) {
      const { container, unmount } = render(<ComicPageSpecimen look="manga-screentone" layout={layout} />);
      const page = container.firstElementChild as HTMLElement;
      expect(page).toHaveAttribute('aria-hidden');
      expect(page).toHaveAttribute('data-comic-art');
      expect(page).toHaveAttribute('data-specimen-layout', layout);
      expect(page.querySelectorAll('[data-specimen-panel]')).toHaveLength(3);
      unmount();
    }
  });

  it('the paper and the panel ink are the look’s lightest and darkest palette colours', () => {
    for (const id of SPECIMEN_LOOKS) {
      const preset = specimenPreset(id);
      const sorted = [...preset.palette].sort((a, b) => luminance(a) - luminance(b));
      const { paper, ink } = specimenInks(preset);
      expect(paper, id).toBe(sorted[sorted.length - 1]);
      expect(ink, id).toBe(sorted[0]);
      const { container, unmount } = render(<ComicPageSpecimen look={id} />);
      const page = container.firstElementChild as HTMLElement;
      expect(page.style.backgroundColor, id).toBe(rgb(paper));
      for (const panel of page.querySelectorAll<HTMLElement>('[data-specimen-panel]')) expect(panel.style.borderColor, id).toBe(rgb(ink));
      unmount();
    }
  });

  it('letters exactly SPECIMEN_LINES, with the studio’s balloons (a caption box, speech and a burst)', () => {
    for (const layout of LAYOUTS) {
      const { container, unmount } = render(<ComicPageSpecimen look="ligne-claire" layout={layout} />);
      const drawn = [...container.querySelectorAll('[data-specimen-line]')];
      expect(drawn.map((g) => g.getAttribute('data-specimen-line'))).toEqual(SPECIMEN_LINES[layout].map((l) => l.kind));
      expect(drawn.map((g) => [...g.querySelectorAll('tspan')].map((t) => t.textContent))).toEqual(SPECIMEN_LINES[layout].map((l) => [...l.text]));
      for (const g of drawn) {
        const kind = g.getAttribute('data-specimen-line');
        if (kind === 'caption') expect(g.querySelector('rect')).not.toBeNull();
        else expect(g.querySelectorAll('path').length, kind!).toBeGreaterThanOrEqual(2);
      }
      unmount();
    }
    expect(SPECIMEN_LINES.opening.map((l) => l.text.join(' '))).toEqual(['DUSK, BY THE OLD CANAL.', 'BISCUIT — THE BOAT!', 'WOOF!']);
    expect(SPECIMEN_LINES.chase.map((l) => l.text.join(' '))).toEqual(['WAIT FOR US!', 'THE RAIN WAS COMING.']);
  });

  it('the six looks of the band are real presets, in order', () => {
    expect(SPECIMEN_LOOKS.map((id) => specimenPreset(id).id)).toEqual([...SPECIMEN_LOOKS]);
    expect(SPECIMEN_LOOKS.map((id) => specimenPreset(id).name)).toEqual(['Ligne claire', 'Manga', 'Noir ink', 'Storybook watercolor', 'Indie riso', 'Retro pop']);
  });

  it('its source spells no hex colour and no comic face as a class (colours are palette data; faces are inline art)', () => {
    const source = readFileSync(path.join(HERE, 'ComicPageSpecimen.tsx'), 'utf8');
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(source).not.toMatch(/font-display|font-comic/);
  });
});
