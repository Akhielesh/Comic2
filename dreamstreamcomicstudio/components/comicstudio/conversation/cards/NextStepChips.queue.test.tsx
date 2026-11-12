// Suggestion chips with the live queue (agent-editor plan §3 A1): the latest reply keeps its chips while the director
// works on the next message; a text chip tapped then goes to Up next instead of doing nothing, and an action chip
// waits for the turn to be free.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Msg } from '../../../../shared/comic/doc';
import { ConversationPane } from '../ConversationPane';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from '../testing/fixtures';
import { chipDisabled, type ChipModel } from './NextStepChips';

beforeEach(showDollarPrices);
afterEach(resetUsageStatus);

const conversation: Msg[] = [
  { id: 'u1', role: 'user', text: 'A heist comic', at: 1 },
  {
    id: 'a1',
    role: 'assistant',
    text: 'Here is the plan.',
    at: 2,
    nextSteps: [
      { label: 'Make it funnier', say: 'Make it funnier' },
      { label: 'Make the cover', action: { type: 'render_cover', quotedUsd: 0.07 }, usd: 0.07 },
      { label: 'Read it', client: { type: 'open_reader' }, usd: 0 }
    ]
  },
  // The creator's next message: the director is working on it now.
  { id: 'u2', role: 'user', text: 'Add a rooftop chase', at: 3 }
];

const chips = () => within(screen.getByRole('group', { name: 'Next steps' }));

describe('NextStepChips — the live queue', () => {
  it('while the director works, the last reply keeps its chips: a text chip queues, an action chip waits, a client chip stays live', () => {
    const studio = makeFakeStudio({ doc: makeSampleDoc({ conversation }), messageBusy: true, busy: true, turnLocked: true, queue: [] });
    render(<ConversationPane studio={studio} />);
    const text = chips().getByRole('button', { name: 'Make it funnier' });
    expect(text).toBeEnabled();
    expect(text).toHaveAttribute('title', 'Adds to Up next. The director reads it when it finishes this step');
    // The tap runs the step (runNextStep → send(), which queues it while the turn is locked).
    fireEvent.click(text);
    expect(studio.runNextStep).toHaveBeenCalledWith({ label: 'Make it funnier', say: 'Make it funnier' });
    expect(chips().getByRole('button', { name: /Make the cover/ })).toBeDisabled();
    expect(chips().getByRole('button', { name: /Read it/ })).toBeEnabled();
  });

  it('without the queue the chips stay hidden while the director works (today’s behaviour)', () => {
    const studio = makeFakeStudio({ doc: makeSampleDoc({ conversation }), messageBusy: true, busy: true });
    render(<ConversationPane studio={studio} />);
    expect(screen.queryByRole('group', { name: 'Next steps' })).toBeNull();
  });

  it('a legacy text suggestion is sent (queued) while busy, not dropped', () => {
    const legacy: Msg[] = [
      { id: 'a1', role: 'assistant', text: 'Hi', at: 1, suggestions: ['Show me 3 styles'] },
      { id: 'u2', role: 'user', text: 'and a title', at: 2 }
    ];
    const studio = makeFakeStudio({ doc: makeSampleDoc({ conversation: legacy }), messageBusy: true, busy: true, turnLocked: true, queue: [] });
    render(<ConversationPane studio={studio} />);
    fireEvent.click(chips().getByRole('button', { name: 'Show me 3 styles' }));
    expect(studio.send).toHaveBeenCalledWith('Show me 3 styles');
  });

  it('chipDisabled: text chips wait without the queue and queue with it; actions wait for the lock', () => {
    const text: ChipModel = { step: { label: 'Make it funnier' } };
    const action: ChipModel = { step: { label: 'Make the cover', action: { type: 'render_cover' } } };
    const client: ChipModel = { step: { label: 'Read it', client: { type: 'open_reader' } } };
    const base = { pending: false, textPending: false, messageBusy: true, turnLocked: true };
    expect(chipDisabled(text, { ...base, queueMode: false })).toBe(true);
    expect(chipDisabled(text, { ...base, queueMode: true })).toBe(false);
    expect(chipDisabled(action, { ...base, queueMode: false })).toBe(false);
    expect(chipDisabled(action, { ...base, queueMode: true })).toBe(true);
    expect(chipDisabled(action, { ...base, queueMode: true, turnLocked: false, messageBusy: false })).toBe(false);
    expect(chipDisabled(client, { ...base, queueMode: true })).toBe(false);
    expect(chipDisabled(text, { ...base, queueMode: true, pending: true })).toBe(true);
  });
});
