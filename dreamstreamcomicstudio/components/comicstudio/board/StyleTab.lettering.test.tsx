// Style › Lettering (declutter DX-0): the lettering styles are the section. No price word where nothing costs and no
// paragraph above the grid (each style's description is in its hint); a comic lettered into the art says so instead of
// offering styles that would change nothing; a pick is one free, undoable patch that a run of arrow presses folds into
// one undo entry.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { IN_ART_LETTERING_NOTE } from '../../../shared/comic/pro/types';
import { presetOps } from '../lettering/styleOps';
import { LETTERING_STYLE_UNDO } from '../lettering/PresetGallery';
import { StyleTab } from './StyleTab';
import { SAMPLE_NOW, makeSampleDoc, makeStudio } from './__fixtures__/sampleDoc';

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(SAMPLE_NOW);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('offline');
    })
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const openLettering = (doc = makeSampleDoc()) => {
  const studio = makeStudio(doc);
  render(<StyleTab studio={studio} doc={studio.doc!} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Lettering' }));
  return { studio, section: screen.getByRole('region', { name: 'Lettering style' }) };
};

describe('StyleTab › Lettering', () => {
  it('shows the styles and nothing else: no “Free”, no paragraph', () => {
    const { section } = openLettering();
    expect(within(section).getByRole('radiogroup', { name: 'Lettering style' })).toBeInTheDocument();
    expect(within(section).queryByText(/free/i)).toBeNull();
    expect(within(section).queryByText(/instant/i)).toBeNull();
    expect(within(section).queryByText(/How balloons, captions and sound effects look/)).toBeNull();
    // The only visible words are the title and the style names.
    expect(section.querySelectorAll('p')).toHaveLength(0);
  });

  it('a comic lettered into the art says so and offers no styles', () => {
    const { section } = openLettering(makeSampleDoc((d) => (d.format.lettering = 'in_art')));
    expect(within(section).getByText(IN_ART_LETTERING_NOTE)).toBeInTheDocument();
    expect(within(section).queryByRole('radiogroup')).toBeNull();
  });

  it('a tap patches the style once, labelled, coalescing an arrow run into one undo entry', () => {
    const { studio, section } = openLettering();
    fireEvent.click(within(section).getByRole('radio', { name: /Manga/ }));
    expect(studio.patch).toHaveBeenCalledTimes(1);
    // The same undo entry as a pick in the page editor (one shared constant), so the two fold together.
    expect(studio.patch).toHaveBeenCalledWith(presetOps('manga'), LETTERING_STYLE_UNDO);
    expect(LETTERING_STYLE_UNDO).toEqual({ label: 'Change lettering style', coalesce: 'lettering-style' });
    expect(studio.act).not.toHaveBeenCalled();
  });
});
