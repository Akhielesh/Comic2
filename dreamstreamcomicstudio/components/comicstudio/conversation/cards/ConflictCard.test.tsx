// The conflict card (agent-editor plan §3 A3.1, D3): both versions side by side, Keep mine / Use the director's /
// Show me, never silent about what it cannot do. Synthetic fixtures only.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_CAPS, type StudioCaps } from '../../../../shared/comic/capabilities';
import type { ConflictCard as ConflictCardData, ConflictItem, Msg } from '../../../../shared/comic/doc';
import { AssistantMessage } from '../MessageItem';
import { makeFakeStudio, makeSampleDoc } from '../testing/fixtures';
import { CardRenderer } from './CardRenderer';
import { BUSY_NOTE, ConflictCard, OFF_NOTE, TOO_BIG_NOTE, conflictHeading, moreText } from './ConflictCard';

const ON: StudioCaps = { ...DEFAULT_CAPS, liveAgent: { queue: false, steer: false, conflicts: true } };

const item = (id: string, over: Partial<ConflictItem> = {}): ConflictItem => ({
  id,
  where: { pageId: 'pg_2', panelId: 'pg_2_p2', lineId: 'pg_2_l1', label: 'page 2 · panel 2 · line 1' },
  mine: 'We have to go',
  theirs: 'Run!',
  proposed: [{ op: 'line', pageId: 'pg_2', panelId: 'pg_2_p2', id: 'pg_2_l1', patch: { text: 'Run!' } }],
  ...over
});

const card = (items: ConflictItem[], more?: number): ConflictCardData => ({ type: 'conflict', id: 'card_cf', items, ...(more ? { more } : {}) });

const setup = (data: ConflictCardData, caps: StudioCaps = ON, over: Record<string, unknown> = {}) => {
  const studio = makeFakeStudio({ caps, ...over });
  const view = render(<ConflictCard card={data} studio={studio} />);
  return { studio, view };
};

describe('ConflictCard', () => {
  it('shows both versions and answers with resolve_conflict: Keep mine, Use the director’s', async () => {
    const { studio } = setup(card([item('cf_1')]));
    expect(screen.getByText('We both changed page 2 · panel 2 · line 1.')).toBeTruthy();
    expect(screen.getByText('Yours')).toBeTruthy();
    expect(screen.getByText('We have to go')).toBeTruthy();
    expect(screen.getByText('Run!')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(studio.act).toHaveBeenCalledWith({ type: 'resolve_conflict', cardId: 'card_cf', itemIds: ['cf_1'], choice: 'mine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use the director’s' }));
    await waitFor(() => expect(studio.act).toHaveBeenCalledWith({ type: 'resolve_conflict', cardId: 'card_cf', itemIds: ['cf_1'], choice: 'theirs' }));
  });

  it('Show me opens the page with that balloon selected', () => {
    const { studio } = setup(card([item('cf_1')]));
    fireEvent.click(screen.getByRole('button', { name: 'Show me page 2 · panel 2 · line 1' }));
    expect(studio.openPage).toHaveBeenCalledWith('pg_2');
    expect(studio.setSelection).toHaveBeenCalledWith({ pageId: 'pg_2', lineIds: ['pg_2_l1'], surface: 'page_editor' });
  });

  it('a too-big item says so in plain words and offers no "Use the director’s"', () => {
    setup(card([item('cf_1', { proposed: [], tooBig: true })]));
    expect(screen.getByText(TOO_BIG_NOTE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use the director’s' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeTruthy();
  });

  it('counts the collisions past the cap: "…and N more I left alone"', () => {
    setup(card([item('cf_1')], 3));
    expect(screen.getByText('…and 3 more I left alone')).toBeTruthy();
    expect(moreText(0)).toBeNull();
  });

  it('an answered item shows the outcome and no buttons', () => {
    setup(card([item('cf_1', { resolved: 'theirs' }), item('cf_2', { resolved: 'mine', where: { label: 'page 3 · panel 1 · line 1' } })]));
    expect(screen.getByText("Used the director's")).toBeTruthy();
    expect(screen.getByText('Kept yours')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep mine' })).toBeNull();
    expect(screen.getByText('Answered. Your choice is on the page.')).toBeTruthy();
  });

  it('several open items: per-item answers plus "Keep all mine" / "Use all the director’s" (the applicable ones only)', async () => {
    const { studio } = setup(card([item('cf_1'), item('cf_2', { tooBig: true, proposed: [], where: { pageId: 'pg_2', label: 'page 2 · panel 1' } })]));
    expect(screen.getByText('We both changed 2 things on page 2.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep all mine' }));
    await waitFor(() => expect(studio.act).toHaveBeenCalledWith({ type: 'resolve_conflict', cardId: 'card_cf', itemIds: ['cf_1', 'cf_2'], choice: 'mine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use all the director’s' }));
    await waitFor(() => expect(studio.act).toHaveBeenCalledWith({ type: 'resolve_conflict', cardId: 'card_cf', itemIds: ['cf_1'], choice: 'theirs' }));
  });

  it('with the conflict guard off the card stays readable, says why there are no answers, and still shows the page', () => {
    const { studio } = setup(card([item('cf_1')]), DEFAULT_CAPS);
    expect(screen.getByText(OFF_NOTE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep mine' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Show me/ }));
    expect(studio.openPage).toHaveBeenCalledWith('pg_2');
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('while the director works the answers wait, and say so', () => {
    setup(card([item('cf_1')]), ON, { messageBusy: true });
    expect((screen.getByRole('button', { name: 'Keep mine' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(BUSY_NOTE)).toBeTruthy();
  });

  it('headings name one place, one page, or the count', () => {
    expect(conflictHeading([item('a')])).toBe('We both changed page 2 · panel 2 · line 1.');
    expect(conflictHeading([item('a'), item('b', { where: { label: 'page 5 · panel 1' } })])).toBe('We both changed 2 things while I was working.');
  });
});

describe('the conflict card in a director reply', () => {
  it('renders through CardRenderer and keeps the reply from being silent', () => {
    const data = card([item('cf_1')]);
    const msg: Msg = { id: 'msg_cf', role: 'assistant', text: '', at: 1, cards: [data] };
    const studio = makeFakeStudio({ caps: ON, doc: makeSampleDoc({ conversation: [msg] }) });
    const { container } = render(<AssistantMessage msg={msg} studio={studio} />);
    expect(container.textContent).not.toMatch(/This card couldn’t be shown/);
    expect(screen.queryByText('Done — the board shows the latest.')).toBeNull();
    const section = screen.getByRole('region', { name: 'Conflict' });
    expect(within(section).getByText('We have to go')).toBeTruthy();
    // And directly through the renderer.
    const direct = render(<CardRenderer card={data} studio={studio} />);
    expect(direct.container.textContent).toContain('We both changed page 2 · panel 2 · line 1.');
  });
});
