// The free card check on a cast card (P5-TRUTH item 7): a contradiction, a change over time or a mood in the face shows
// as a warning note, for the viewers CARD_LINT_STAGE admits (admins first). It never changes, blocks or spends anything.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { cardLintOn } from '../../../shared/comic/world/lookLint';
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

/** The sample comic with Arjun's card saying two things about his skin, and a mood in his face. */
const doc = () => {
  const d = makeSampleDoc();
  d.cast = d.cast.map((c) =>
    c.name === 'Arjun' ? { ...c, look: { ...c.look, summary: 'Green-skinned cop with a neat beard', skin: 'warm brown', face: 'stern scowl' } } : c
  );
  return d;
};

describe('CastTab card check', () => {
  it('an admin sees the contradiction and the mood on the card that has them, and nothing on a clean card', () => {
    const d = doc();
    const studio = makeStudio(d, { caps: { ...DEFAULT_CAPS, admin: true } });
    render(<CastTab studio={studio} doc={d} />);
    const arjun = screen.getByRole('article', { name: 'Arjun' });
    const note = within(arjun).getByRole('note', { name: 'Card check for Arjun' });
    expect(note).toHaveTextContent('Summary says green, skin says warm brown: pick one, so every page draws the same Arjun.');
    expect(note).toHaveTextContent('Face holds a mood ("stern", "scowl")');
    expect(within(note).getAllByRole('listitem').map((li) => li.getAttribute('data-rule'))).toEqual(['contradiction', 'mood']);
    expect(within(screen.getByRole('article', { name: 'Vendor' })).queryByRole('note')).toBeNull();
    // A warning only: no button, nothing spent, no price.
    expect(within(note).queryByRole('button')).toBeNull();
    expect(note.textContent).not.toMatch(/[$¢]/);
    expect(studio.patch).not.toHaveBeenCalled();
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('a non-admin sees no card check while the stage is admins', () => {
    const d = doc();
    render(<CastTab studio={makeStudio(d, { caps: { ...DEFAULT_CAPS, admin: false } })} doc={d} />);
    expect(screen.queryByTestId('card-check')).toBeNull();
  });

  it('the stage reads off, admins or all', () => {
    expect(cardLintOn(true)).toBe(true);
    expect(cardLintOn(false)).toBe(false);
    expect(cardLintOn(undefined)).toBe(false);
    expect(cardLintOn(false, 'all')).toBe(true);
    expect(cardLintOn(true, 'off')).toBe(false);
  });
});
