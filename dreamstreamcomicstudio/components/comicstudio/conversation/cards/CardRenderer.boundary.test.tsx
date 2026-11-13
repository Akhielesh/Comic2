// A live card that threw still settles to its one line (PROGRAM3 SETTLE-UI). CardRenderer keys its error boundary on
// live/settled, so the boundary starts over when the chat moves past the card: the settled row never mounts the live
// component, so it cannot throw the same way, and the creator reads what the card was instead of "This card couldn't
// be shown" for ever. Fails without the key (the boundary stays failed).

import React from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card } from '../../../../shared/comic/doc';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from '../testing/fixtures';
import { CardRenderer } from './CardRenderer';

// The live notice component fails on a malformed stored card (here: always). The module's other exports stay real.
vi.mock('./NoticeCard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./NoticeCard')>()),
  NoticeCard: () => {
    throw new Error('a malformed stored notice');
  }
}));

let quiet: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  showDollarPrices();
  // React and the boundary log the throw; the test only reads what the creator sees.
  quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  quiet.mockRestore();
  resetUsageStatus();
});

describe('a live card that failed to render', () => {
  it('reads its settled line once the chat moves past it, not the failure for ever', () => {
    const notice: Card = { type: 'notice', id: 'n_bad', tone: 'info', text: 'Page 3 holds too much text.' };
    const doc = makeSampleDoc({
      conversation: [
        { id: 'm1', role: 'assistant', text: '', at: 1, cards: [notice] },
        { id: 'u1', role: 'user', text: 'make the cover brighter', at: 2 }
      ]
    });
    const studio = makeFakeStudio({ doc });
    const { container, rerender } = render(<CardRenderer card={notice} studio={studio} message={doc.conversation[0]} settle={{ state: 'live' }} />);
    expect(container.textContent).toBe('This card couldn’t be shown. The board has the latest state.');
    rerender(<CardRenderer card={notice} studio={studio} message={doc.conversation[0]} settle={{ state: 'settled', outcome: 'passed' }} />);
    expect(container.textContent).not.toMatch(/couldn’t be shown/);
    expect(container.querySelector('[data-settled="notice"]')!.textContent).toBe('Page 3 holds too much text.');
  });
});
