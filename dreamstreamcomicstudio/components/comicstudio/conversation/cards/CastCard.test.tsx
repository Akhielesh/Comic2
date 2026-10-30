// CastCard wording for extras: "Described in text" until the extra has a ready sheet; a ready sheet is attached on
// every page the extra appears on (prompts.ts castReferences), so the card says so.

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
  it('an extra without a ready sheet is described in text, whatever its sheet is doing', () => {
    for (const status of ['none', 'queued', 'rendering', 'failed', 'stale'] as const) {
      expect(sheetStatus(extra({ ...emptyRender(), status }))).toEqual({ text: 'Described in text', tone: 'none' });
    }
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
});
