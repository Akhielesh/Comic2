// Tapping an option settles its card at once (PROGRAM3 SETTLE-UI; settle.md §5.1): the creator's answer is this tab's
// sending message, and shared/comic/settle.ts reads a sending message that answers a card as "picked" — so the row
// reads "You picked …" the moment the tap lands, before the server has the message, and the chips are gone (a second
// tap can never start a second turn). The harness sends the way useStudio does: the pending bubble appears in the same
// tick and the reply never arrives.

import React, { useMemo, useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Card, Msg } from '../../../../shared/comic/doc';
import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities';
import type { PendingUserMessage } from '../../studioReducer';
import type { MessageSendOptions } from '../../useStudio';
import { ConversationPane } from '../ConversationPane';
import { __resetEntrances } from '../MessageItem';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from '../testing/fixtures';

beforeEach(() => {
  showDollarPrices();
  __resetEntrances();
});
afterEach(resetUsageStatus);

const ADMIN = { ...DEFAULT_CAPS, admin: true };
const CONTROLS = 'button, input, select, textarea, [role="button"]';

const look = (extra: Partial<Extract<Card, { type: 'options' }>> = {}): Card => ({
  type: 'options',
  id: 'q_look',
  question: 'Which look should the heist have?',
  choices: [
    { id: 'c1', label: 'Noir ink' },
    { id: 'c2', label: 'Crayon' },
    { id: 'c3', label: 'Ligne claire' }
  ],
  ...extra
});

const conversation = (card: Card): Msg[] => [
  { id: 'u1', role: 'user', text: 'A heist on the rooftops', at: 1 },
  { id: 'a1', role: 'assistant', text: 'One question first.', at: 2, cards: [card] }
];

/** ConversationPane over a fake controller whose send() shows the pending bubble at once and never hears back. */
const Harness: React.FC<{ card: Card; admin?: boolean; sent: Array<{ text: string; opts?: MessageSendOptions }> }> = ({ card, admin = true, sent }) => {
  const [pending, setPending] = useState<PendingUserMessage | null>(null);
  const doc = useMemo(() => makeSampleDoc({ conversation: conversation(card) }), [card]);
  const studio = useMemo(
    () =>
      makeFakeStudio({
        doc,
        caps: admin ? ADMIN : DEFAULT_CAPS,
        pendingMessage: pending,
        messageBusy: !!pending,
        send: (async (text: string, opts?: MessageSendOptions) => {
          sent.push({ text, opts });
          setPending({ id: 'pm_1', text, attachments: [], at: 3, status: 'sending', ...(opts?.card ? { card: opts.card } : {}) });
          return new Promise(() => undefined);
        }) as never
      }),
    [doc, pending, admin, sent]
  );
  return <ConversationPane studio={studio} />;
};

const slot = (container: HTMLElement, id: string) => container.querySelector(`[data-card-slot="${id}"]`) as HTMLElement;

describe('OptionsCard settles at once', () => {
  it('a tap reads "You picked …" before the server answers, and the chips are gone', () => {
    const sent: Array<{ text: string; opts?: MessageSendOptions }> = [];
    const { container } = render(<Harness card={look()} sent={sent} />);
    fireEvent.click(within(slot(container, 'q_look')).getByRole('button', { name: /Noir ink/ }));
    expect(sent).toEqual([{ text: 'Noir ink', opts: { card: { id: 'q_look', choiceIds: ['c1'] } } }]);
    const row = slot(container, 'q_look');
    expect(row.textContent).toBe('You picked Noir ink');
    expect(row.querySelectorAll(CONTROLS)).toHaveLength(0);
    expect(row.querySelector('[data-settle-tone="done"]')).not.toBeNull();
  });

  it('a multi-select answer reads every pick, and a typed answer reads its words', () => {
    const multi: Array<{ text: string }> = [];
    const r1 = render(<Harness card={look({ multi: true })} sent={multi} />);
    const card = slot(r1.container, 'q_look');
    fireEvent.click(within(card).getByRole('button', { name: /Noir ink/ }));
    fireEvent.click(within(card).getByRole('button', { name: /Crayon/ }));
    fireEvent.click(within(card).getByRole('button', { name: /Done/ }));
    expect(slot(r1.container, 'q_look').textContent).toBe('You picked Noir ink and Crayon');
    r1.unmount();

    const typed: Array<{ text: string }> = [];
    const r2 = render(<Harness card={look({ allowCustom: true })} sent={typed} />);
    fireEvent.change(screen.getByLabelText('Your own answer'), { target: { value: 'a quiet rooftop at dawn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(slot(r2.container, 'q_look').textContent).toBe('You answered “a quiet rooftop at dawn”');
    expect(slot(r2.container, 'q_look').querySelectorAll(CONTROLS)).toHaveLength(0);
  });

  it('any other message the creator sends moves past the question: it reads "Not answered — you moved on"', () => {
    const sent: Array<{ text: string }> = [];
    const { container } = render(<Harness card={look()} sent={sent} />);
    fireEvent.change(screen.getByLabelText('Message the Comic Director'), { target: { value: 'Actually, make it a western' } });
    fireEvent.keyDown(screen.getByLabelText('Message the Comic Director'), { key: 'Enter' });
    expect(sent.map((s) => s.text)).toEqual(['Actually, make it a western']);
    expect(slot(container, 'q_look').textContent).toBe('Not answered — you moved on');
  });

  it('a non-admin’s tap settles the card the same way (R00 SF-1, settled cards for everyone)', () => {
    const sent: Array<{ text: string }> = [];
    const { container } = render(<Harness card={look()} admin={false} sent={sent} />);
    fireEvent.click(within(slot(container, 'q_look')).getByRole('button', { name: /Noir ink/ }));
    const row = slot(container, 'q_look');
    expect(row.querySelector('[data-settled]')).not.toBeNull();
    expect(row.textContent).toBe('You picked Noir ink');
    expect(row.querySelectorAll(CONTROLS)).toHaveLength(0);
  });
});
