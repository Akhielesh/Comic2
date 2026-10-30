// CastCard wording for extras: "Described in text" until the extra has a ready sheet; a ready sheet is attached on
// every page the extra appears on (prompts.ts castReferences), so the card says so — except for a prop, whose sheet
// never rides on a page. A sheet still queued or drawing shows its progress.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { emptyRender, type Character } from '../../../../shared/comic/doc';
import { CastCard, castStatusLine, sheetStatus } from './CastCard';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from '../testing/fixtures';

beforeEach(showDollarPrices);
afterEach(resetUsageStatus);

const extra = (sheet: Character['sheet'], over: Partial<Character> = {}): Character => ({
  id: 'c_guard',
  name: 'Guard',
  tier: 'extra',
  look: { summary: 'Market guard in a khaki cap' },
  refs: [],
  sheet,
  ...over
});
const ready = { ...emptyRender(), status: 'ready' as const, asset: { path: 'u/p/sheets/guard.webp', source: 'generated' as const, at: 1 } };

describe('CastCard extras', () => {
  it('an extra without a ready sheet is described in text; a sheet being drawn for it shows its progress', () => {
    for (const status of ['none', 'failed', 'stale'] as const) {
      expect(sheetStatus(extra({ ...emptyRender(), status }))).toEqual({ text: 'Described in text', tone: 'none' });
    }
    // After "Draw a sheet anyway" the card is busy until the sheet lands (same words as a lead's sheet).
    expect(sheetStatus(extra({ ...emptyRender(), status: 'queued' }))).toEqual({ text: 'Queued', tone: 'busy' });
    expect(sheetStatus(extra({ ...emptyRender(), status: 'rendering' }))).toEqual({ text: 'Drawing sheet…', tone: 'busy' });
    expect(castStatusLine(extra({ ...emptyRender(), status: 'rendering' }))).toBe('Extra · Drawing sheet…');
  });

  it('a prop extra with a ready sheet only says the sheet is ready: a prop sheet is never attached on a page', () => {
    const prop = extra(ready, { id: 'c_kite', name: 'Red kite', kind: 'object' });
    expect(sheetStatus(prop)).toEqual({ text: 'Sheet ready', tone: 'ok' });
    expect(castStatusLine(prop)).toBe('Prop · Sheet ready');
    expect(castStatusLine(prop)).not.toContain('used on pages');
    // Without a sheet a prop is described in text like any extra.
    expect(sheetStatus({ ...prop, sheet: emptyRender() })).toEqual({ text: 'Described in text', tone: 'none' });
  });

  it('an extra with a ready sheet says the sheet is used on its pages', () => {
    expect(sheetStatus(extra(ready))).toEqual({ text: 'Sheet ready · used on pages', tone: 'ok' });
    expect(castStatusLine(extra(ready))).toBe('Extra · Sheet ready · used on pages');
    // Leads and supports keep their wording.
    expect(sheetStatus(extra(ready, { tier: 'lead' }))).toEqual({ text: 'Sheet ready', tone: 'ok' });
  });

  it('renders both extras in one card, the ready one with the ok tone', () => {
    const doc = makeSampleDoc();
    doc.cast = [...doc.cast, extra(ready, { id: 'c_cat', name: 'Cat', kind: 'animal' })];
    const studio = makeFakeStudio({ doc });
    render(<CastCard card={{ type: 'cast', id: 'card_c', characterIds: ['c_vendor', 'c_cat'] }} studio={studio} />);
    expect(screen.getByText('Extra · Described in text')).toBeInTheDocument();
    const line = screen.getByText(/Sheet ready · used on pages$/);
    expect(line.parentElement!.querySelector('svg.lucide-check')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^Cat.*Sheet ready · used on pages\. Open the cast$/ })).toBeInTheDocument();
  });

  it('an extra whose paid sheet is drawing shows the busy dot', () => {
    const doc = makeSampleDoc();
    doc.cast = [...doc.cast, extra({ ...emptyRender(), status: 'rendering' }, { id: 'c_boy', name: 'Boy' })];
    const studio = makeFakeStudio({ doc });
    render(<CastCard card={{ type: 'cast', id: 'card_b', characterIds: ['c_boy'] }} studio={studio} />);
    const line = screen.getByText('Extra · Drawing sheet…');
    expect(line.parentElement!.querySelector('.animate-pulse')).not.toBeNull();
    // An extra never gets the "Draw sheets" button from this card (its sheet is optional and already drawing).
    expect(screen.queryByRole('button', { name: /^Draw / })).toBeNull();
  });
});
