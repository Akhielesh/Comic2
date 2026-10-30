// CastTab copy for extras (A2 fix notes 6-7): an extra is described in words until it has a sheet, and a ready
// sheet is attached on every page it appears on, so the placeholder note and the optional sheet button say so.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CastTab } from './CastTab';
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

describe('CastTab extras copy', () => {
  it('says an extra is described in words until it has a sheet, and that a ready sheet rides on its pages', () => {
    const doc = makeSampleDoc();
    render(<CastTab studio={makeStudio(doc)} doc={doc} />);
    const vendor = screen.getByRole('article', { name: 'Vendor' });
    expect(within(vendor).getByText('Extras are described in words until they have a sheet; a ready sheet is attached on every page they appear on.')).toBeInTheDocument();
    expect(within(vendor).queryByText(/no sheet needed/)).toBeNull();
    const draw = within(vendor).getByRole('button', { name: /Draw a sheet anyway/ });
    expect(draw).toHaveAttribute('title', 'Optional — a ready sheet is attached on every page this extra appears on');
    // A lead keeps its own note.
    expect(within(screen.getByRole('article', { name: 'Arjun' })).queryByText(/Extras are described/)).toBeNull();
  });
});
