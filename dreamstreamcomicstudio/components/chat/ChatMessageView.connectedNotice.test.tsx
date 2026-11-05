// @vitest-environment jsdom
// Wave note 3: a turn connected-account privacy did not send renders as a calm info notice — the
// server's copy, role="status", Atlas tone recipes (no raw red), and its two 44 px ways forward —
// never as the red error bubble with "Try again".
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatMessageView } from './ChatMessageView';
import type { ChatTurn } from '../../services/chatStorage';
import { PRIMARY_BTN, TONE_SURFACE, TONE_TEXT } from './studioDesign';
import { connectedDataFreeModelMessage, CONNECTED_DATA_BUDGET_SENTENCE } from '../../server/src/ai/privacy/connectorData';

const FREE_MODEL_COPY = connectedDataFreeModelMessage(true);
const BUDGET_COPY = `You've used all of your included usage for now. ${CONNECTED_DATA_BUDGET_SENTENCE}`;

const noticeTurn = (kind: 'standard-model' | 'budget', content: string): ChatTurn => ({
  id: 'turn-1',
  role: 'assistant',
  content,
  createdAt: 1,
  notice: { kind }
});

const renderTurn = (turn: ChatTurn, props: Partial<React.ComponentProps<typeof ChatMessageView>> = {}) =>
  render(<ChatMessageView turn={turn} isLast onRegenerate={() => {}} onBranch={() => {}} {...props} />);

describe('ChatMessageView: the calm connected-data notice', () => {
  it('free-model refusal: role="status" with the server copy, "Use a standard model" and "New chat"', () => {
    const onNoticeAction = vi.fn();
    renderTurn(noticeTurn('standard-model', FREE_MODEL_COPY), { onNoticeAction });
    const card = screen.getByRole('status');
    expect(card.textContent).toContain(FREE_MODEL_COPY);
    expect(card.textContent).toContain('Not sent: this chat needs a standard model');

    const buttons = within(card).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Use a standard model', 'New chat']);
    fireEvent.click(within(card).getByRole('button', { name: 'Use a standard model' }));
    fireEvent.click(within(card).getByRole('button', { name: 'New chat' }));
    expect(onNoticeAction.mock.calls).toEqual([['standard-model'], ['new-chat']]);
  });

  it('usage refusal: "New chat" first, then "API keys" (the two ways forward its copy names)', () => {
    const onNoticeAction = vi.fn();
    renderTurn(noticeTurn('budget', BUDGET_COPY), { onNoticeAction });
    const card = screen.getByRole('status');
    expect(card.textContent).toContain(CONNECTED_DATA_BUDGET_SENTENCE);
    expect(within(card).getAllByRole('button').map((b) => b.textContent)).toEqual(['New chat', 'API keys']);
    expect(within(card).queryByRole('button', { name: 'Use a standard model' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'API keys' }));
    expect(onNoticeAction).toHaveBeenCalledWith('api-keys');
  });

  it('both actions are 44 px targets on touch screens, keyboard-focusable, primary on the accent', () => {
    renderTurn(noticeTurn('standard-model', FREE_MODEL_COPY), { onNoticeAction: () => {} });
    const [primary, secondary] = within(screen.getByRole('status')).getAllByRole('button');
    for (const b of [primary, secondary]) {
      expect(b.className).toContain('coarse:min-h-11');
      expect(b.className).toContain('focus-visible:outline');
      expect(b.getAttribute('type')).toBe('button');
    }
    for (const c of PRIMARY_BTN.split(' ')) expect(primary.className).toContain(c);
  });

  it('calm info tone from the Atlas recipes: no red, no warning triangle, no error chrome', () => {
    const { container } = renderTurn(noticeTurn('standard-model', FREE_MODEL_COPY), { onNoticeAction: () => {} });
    const card = screen.getByRole('status');
    for (const c of TONE_SURFACE.info.split(' ')) expect(card.className).toContain(c);
    expect(card.querySelector('svg')?.getAttribute('class')).toContain(TONE_TEXT.info);
    expect(container.innerHTML).not.toMatch(/(bg|text|border)-red-|#D97757/i);
    expect(container.querySelector('.lucide-triangle-alert, .lucide-alert-triangle')).toBeNull();
    // Not an answer and not an error: no retry, no regenerate, no copy/branch bar, no feedback.
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    expect(screen.queryByTitle('Regenerate answer')).toBeNull();
    expect(screen.queryByTitle('Copy answer')).toBeNull();
    expect(screen.queryByText(/couldn.t complete/i)).toBeNull();
  });

  it('while a generation runs, "Use a standard model" (which sends again) waits; "New chat" does not', () => {
    renderTurn(noticeTurn('standard-model', FREE_MODEL_COPY), { onNoticeAction: () => {}, busy: true, isLast: false });
    const card = screen.getByRole('status');
    expect((within(card).getByRole('button', { name: 'Use a standard model' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(card).getByRole('button', { name: 'New chat' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('control: a real error turn still renders as before (red bubble, "Try again")', () => {
    renderTurn({ id: 'turn-2', role: 'assistant', content: "**Couldn't complete that.** Timeout.", createdAt: 1, error: true });
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
