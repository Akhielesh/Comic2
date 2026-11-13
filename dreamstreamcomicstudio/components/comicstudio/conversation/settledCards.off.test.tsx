// The kill switch for settled cards (R00 SF-1). SETTLED_CARDS is a code constant ('all' since R00), so turning it off is
// one commit; this pins what that commit gives back: with the stage at 'off' the pane builds no settle index and every
// old card is live again, an admin's included. Until R00 a non-admin viewer was this control; now everyone settles, so
// the stage itself is set to 'off' here (settledCardsOn keeps its real code, only its default stage changes).

import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetRef, Msg } from '../../../shared/comic/doc';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { makeQaDoc } from '../testing/qaFixtures';
import { ConversationPane } from './ConversationPane';
import { __resetEntrances } from './MessageItem';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from './testing/fixtures';

vi.mock('../../../shared/comic/settle', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../shared/comic/settle')>();
  return {
    ...real,
    SETTLED_CARDS: 'off',
    settledCardsOn: (admin: boolean | null | undefined) => real.settledCardsOn(admin, 'off')
  };
});

beforeEach(() => {
  showDollarPrices();
  __resetEntrances();
});
afterEach(resetUsageStatus);

const ADMIN = { ...DEFAULT_CAPS, admin: true };
const slot = (container: HTMLElement, id: string) => container.querySelector(`[data-card-slot="${id}"]`) as HTMLElement | null;

describe("SETTLED_CARDS = 'off' (the kill switch)", () => {
  it.each([
    ['an admin', ADMIN],
    ['anyone else', DEFAULT_CAPS]
  ])('%s sees the heist question live again: its tiles and Done, enabled', (_who, caps) => {
    const { container } = render(<ConversationPane studio={makeFakeStudio({ doc: makeQaDoc('heist-12p'), caps })} />);
    const o1 = slot(container, 'o1')!;
    expect(o1.querySelector('[data-settled]')).toBeNull();
    expect(o1.querySelectorAll('button:not([disabled]), input:not([disabled]), [role="radio"], [role="checkbox"]').length).toBeGreaterThanOrEqual(5);
  });

  it('every user bubble offers Assign again (no "latest" rule)', () => {
    const photo = (n: number): AssetRef => ({ path: `u/x/inbox/photo_${n}.webp`, source: 'upload', at: 1 });
    const conversation: Msg[] = [
      { id: 'u1', role: 'user', text: 'Here is Maya', at: 1, attachments: [photo(1)] },
      { id: 'a1', role: 'assistant', text: 'Got it.', at: 2 },
      { id: 'u2', role: 'user', text: 'And her partner', at: 3, attachments: [photo(2)] }
    ];
    render(<ConversationPane studio={makeFakeStudio({ doc: makeSampleDoc({ conversation }), caps: ADMIN })} />);
    expect(screen.getAllByRole('button', { name: /Unassigned · Assign/ })).toHaveLength(2);
  });
});
