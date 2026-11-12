// Fresh-only entrance (PROGRAM3 SETTLE-UI MO-2; styles.md M3 with C17, the server-clock rule; bug B24: every stored
// message replayed its entrance on every mount). A message rises in only when its server `at` is newer than the
// newest `at` present when the pane first rendered this doc, or when it streams in now; history renders static.

import React from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Msg } from '../../../shared/comic/doc';
import type { PendingUserMessage } from '../studioReducer';
import { ConversationPane } from './ConversationPane';
import { __resetEntrances } from './MessageItem';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from './testing/fixtures';

beforeEach(() => {
  showDollarPrices();
  __resetEntrances();
});
afterEach(resetUsageStatus);

/** Every node that would play an entrance animation (the motion classes, and the legacy studio reveal). */
const ANIMATED = '.ds-rise-in, .ds-stagger, .studio-reveal';
const BASE_AT = 1_760_000_000_000;

const stored = (n: number): Msg[] =>
  Array.from({ length: n }, (_, i) =>
    i % 2 === 0
      ? { id: `u${i}`, role: 'user', text: `Note ${i}`, at: BASE_AT + i }
      : { id: `a${i}`, role: 'assistant', text: `Reply ${i}`, at: BASE_AT + i, cards: [{ type: 'notice', id: `n${i}`, tone: 'info', text: `Card ${i}` }] }
  );

describe('fresh-only entrance', () => {
  it('20 stored messages give 0 animated nodes; a new one gives 1', () => {
    const conversation = stored(20);
    const studio = makeFakeStudio({ doc: makeSampleDoc({ conversation }) });
    const { container, rerender } = render(<ConversationPane studio={studio} />);
    expect(container.querySelectorAll('[data-role]')).toHaveLength(20);
    expect(container.querySelectorAll(ANIMATED)).toHaveLength(0);
    const next: Msg = { id: 'a20', role: 'assistant', text: 'Here is page 4.', at: BASE_AT + 20, cards: [{ type: 'notice', id: 'n20', tone: 'success', text: 'Drawn.' }] };
    rerender(<ConversationPane studio={{ ...studio, doc: makeSampleDoc({ conversation: [...conversation, next] }) }} />);
    const animated = container.querySelectorAll(ANIMATED);
    expect(animated).toHaveLength(1);
    // The fresh reply's blocks (its words, then its cards) arrive one after another: the column staggers.
    expect(animated[0].classList.contains('ds-stagger')).toBe(true);
    expect(animated[0].closest('[data-role="assistant"]')!.textContent).toContain('Here is page 4.');
  });

  it('the server clock decides, not this device’s: a message stamped far in the "past" by a skewed clock still counts as new', () => {
    // The stored messages carry server times; this device thinks it is a day later. Only `at` against `at` counts.
    const conversation = stored(4);
    const studio = makeFakeStudio({ doc: makeSampleDoc({ conversation }) });
    const { container, rerender } = render(<ConversationPane studio={studio} />);
    const next: Msg = { id: 'u4', role: 'user', text: 'From my phone', at: BASE_AT + 4 };
    rerender(<ConversationPane studio={{ ...studio, doc: makeSampleDoc({ conversation: [...conversation, next] }) }} />);
    const animated = [...container.querySelectorAll(ANIMATED)];
    expect(animated).toHaveLength(1);
    expect(animated[0].classList.contains('ds-rise-in')).toBe(true);
    expect(animated[0].textContent).toContain('From my phone');
  });

  it('a remount never replays: the messages that rose in last time are history now', () => {
    const conversation = stored(4);
    const studio = makeFakeStudio({ doc: makeSampleDoc({ conversation }) });
    const first = render(<ConversationPane studio={studio} />);
    const grown = makeSampleDoc({ conversation: [...conversation, { id: 'a4', role: 'assistant', text: 'New', at: BASE_AT + 10 }] });
    first.rerender(<ConversationPane studio={{ ...studio, doc: grown }} />);
    expect(first.container.querySelectorAll(ANIMATED)).toHaveLength(1);
    first.unmount();
    const again = render(<ConversationPane studio={{ ...studio, doc: grown }} />);
    expect(again.container.querySelectorAll(ANIMATED)).toHaveLength(0);
  });

  it('the bubble just sent rises once: its committed copy arrives without a second entrance', () => {
    const conversation = stored(2);
    const studio = makeFakeStudio({ doc: makeSampleDoc({ conversation }) });
    const { container, rerender } = render(<ConversationPane studio={studio} />);
    const pending: PendingUserMessage = { id: 'pm_1', text: 'Make it rain', attachments: [], at: Date.now(), status: 'sending' };
    rerender(<ConversationPane studio={{ ...studio, pendingMessage: pending, messageBusy: true }} />);
    const sending = [...container.querySelectorAll(ANIMATED)];
    expect(sending).toHaveLength(1);
    expect(sending[0].textContent).toContain('Make it rain');
    const committed = makeSampleDoc({ conversation: [...conversation, { id: 'u2', role: 'user', text: 'Make it rain', at: BASE_AT + 2 }] });
    rerender(<ConversationPane studio={{ ...studio, doc: committed, pendingMessage: null, messageBusy: true }} />);
    expect(container.querySelectorAll(ANIMATED)).toHaveLength(0);
  });

  it('a reply that streams in rises as it starts, and not again when the server commits it', () => {
    const conversation = stored(2);
    const studio = makeFakeStudio({ doc: makeSampleDoc({ conversation }) });
    const { container, rerender } = render(<ConversationPane studio={studio} />);
    rerender(<ConversationPane studio={{ ...studio, drafts: { a2: 'Drawing page' }, messageBusy: true }} />);
    expect(container.querySelectorAll(ANIMATED)).toHaveLength(1);
    const committed = makeSampleDoc({ conversation: [...conversation, { id: 'a2', role: 'assistant', text: 'Drawing page 3 now.', at: BASE_AT + 2 }] });
    rerender(<ConversationPane studio={{ ...studio, doc: committed, drafts: {} }} />);
    expect(container.querySelectorAll(ANIMATED)).toHaveLength(0);
  });
});
