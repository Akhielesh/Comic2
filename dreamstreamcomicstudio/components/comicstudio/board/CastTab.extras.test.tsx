// CastTab copy for extras (A2 fix notes 6-7): an extra is described in words until it has a sheet, and a ready
// sheet is attached on every page it appears on, so the placeholder note and the optional sheet button say so. An
// extra Object's is not (prompts.ts castReferences skips an extra object on pages), so its card says that instead,
// in the tab's own word ("Object", never "prop"), and its optional button is a reference sheet.

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
    // "prop" is a word the Cast tab never uses (it says Object): it is not on a person's card at all.
    expect(vendor.textContent).not.toMatch(/\bprop/i);
    const draw = within(vendor).getByRole('button', { name: /Draw a sheet anyway/ });
    expect(draw).toHaveAttribute('title', 'Optional — a ready sheet is attached on every page this extra appears on');
    // A lead keeps its own note.
    expect(within(screen.getByRole('article', { name: 'Arjun' })).queryByText(/Extras are described/)).toBeNull();
  });

  it('an Object extra says its sheet is not attached to pages, in the tab’s own word, and never sells it as page use', () => {
    const doc = makeSampleDoc();
    doc.cast = doc.cast.map((c) => (c.name === 'Vendor' ? { ...c, name: 'Saffron tin', kind: 'object' as const } : c));
    render(<CastTab studio={makeStudio(doc)} doc={doc} />);
    const tin = screen.getByRole('article', { name: 'Saffron tin' });
    expect(within(tin).getByText('Object')).toBeInTheDocument();
    expect(within(tin).getByText('Objects are described in words on pages; a sheet isn’t attached to pages (set it to Support for that).')).toBeInTheDocument();
    expect(within(tin).queryByText(/attached on every page/)).toBeNull();
    expect(within(tin).queryByRole('button', { name: /Draw a sheet anyway/ })).toBeNull();
    const draw = within(tin).getByRole('button', { name: /Draw a reference sheet/ });
    expect(draw.getAttribute('title')).toMatch(/for your reference: an extra object’s sheet isn’t attached to pages/);
    expect(tin.textContent).not.toMatch(/\bprop/i);
  });
});
