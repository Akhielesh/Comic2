// Rate a reply inside the real conversation (docs/features/reply-ratings.md): a rating, and a thumbs-down note being
// written, stay as they are while new messages land, and across the pane being mounted again in the same page. The
// feedback API is faked: nothing leaves the test.
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ submitFeedback: vi.fn(), post: vi.fn() }));
vi.mock('../../../services/feedback', () => ({ submitFeedback: api.submitFeedback }));
vi.mock('../../../services/apiClient', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../services/apiClient')>()), post: api.post }));

import type { Msg } from '../../../shared/comic/doc';
import { ConversationPane } from './ConversationPane';
import { __resetReplyRatings } from './replyRatingMemory';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from './testing/fixtures';

const msg = (id: string, role: Msg['role'], text: string, extra: Partial<Msg> = {}): Msg => ({ id, role, text, at: 1, ...extra });
const start: Msg[] = [msg('u1', 'user', 'A heist comic'), msg('a1', 'assistant', 'Got it: Maya leads the heist.')];
// Six more entries: one "redraw everything" switch posts about this many (its notice, progress and outcomes).
const later: Msg[] = [
  msg('n1', 'assistant', 'Switching the drawing model.'),
  msg('p1', 'assistant', 'Drawing the sheets.', { runAt: 2 }),
  msg('p2', 'assistant', 'Sheets drawn.', { runAt: 2 }),
  msg('p3', 'assistant', 'Drawing pages 1–4.', { runAt: 2 }),
  msg('p4', 'assistant', 'Pages 1–4 drawn.', { runAt: 2 }),
  msg('p5', 'assistant', 'Cover drawn.', { runAt: 2 })
];
const pane = (conversation: Msg[]) => <ConversationPane studio={makeFakeStudio({ doc: makeSampleDoc({ conversation }) })} />;
const replyRow = () => [...document.querySelectorAll<HTMLElement>('[data-role="assistant"]')].find((r) => r.textContent?.includes('Maya leads'))!;
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => {
  showDollarPrices();
  __resetReplyRatings();
  api.submitFeedback.mockReset().mockResolvedValue({ ok: true, persisted: true });
  api.post.mockReset().mockResolvedValue({ ok: true, withdrawn: true });
});
afterEach(resetUsageStatus);

describe('ConversationPane — a rating stays put', () => {
  it('"Thanks" and Undo are still there after six more messages, and the reply is never rated twice', async () => {
    const { rerender } = render(pane(start));
    fireEvent.click(within(replyRow()).getByRole('button', { name: 'Good reply' }));
    await flush();
    expect(within(replyRow()).getByRole('status')).toHaveTextContent('Thanks');
    rerender(pane([...start, ...later]));
    await flush();
    // The rated reply now sits in the offscreen-rendering wrapper, and still reads as rated.
    expect(replyRow().closest('.cv-auto')).not.toBeNull();
    expect(within(replyRow()).getByRole('status')).toHaveTextContent('Thanks');
    expect(within(replyRow()).getByRole('button', { name: 'Undo rating' })).toBeInTheDocument();
    expect(within(replyRow()).getByRole('button', { name: 'Good reply' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(replyRow()).getByRole('button', { name: 'Good reply' }));
    await flush();
    expect(api.submitFeedback).toHaveBeenCalledTimes(1);
  });

  it('a thumbs-down note being written stays open with its words while messages land, and nothing is sent', async () => {
    const { rerender } = render(pane(start));
    fireEvent.click(within(replyRow()).getByRole('button', { name: 'Could be better' }));
    fireEvent.change(within(replyRow()).getByLabelText('What could be better? (optional)'), { target: { value: 'It forgot the twist.' } });
    rerender(pane([...start, ...later]));
    await flush();
    expect(within(replyRow()).getByLabelText('What could be better? (optional)')).toHaveValue('It forgot the twist.');
    expect(api.submitFeedback).not.toHaveBeenCalled();
  });

  it('the pane mounted again in the same page shows the same rating, with its Undo', async () => {
    const first = render(pane(start));
    fireEvent.click(within(replyRow()).getByRole('button', { name: 'Good reply' }));
    await flush();
    first.unmount();
    render(pane(start));
    expect(within(replyRow()).getByRole('status')).toHaveTextContent('Thanks');
    fireEvent.click(within(replyRow()).getByRole('button', { name: 'Undo rating' }));
    await flush();
    expect(api.post).toHaveBeenCalledWith('/api/telemetry/feedback/withdraw', { targetType: 'comic_reply', targetId: 'a1' });
    expect(within(replyRow()).getByRole('button', { name: 'Good reply' })).toHaveAttribute('aria-pressed', 'false');
    expect(api.submitFeedback).toHaveBeenCalledTimes(1);
  });

  it('leaving the comic with the note open records the thumbs-down once; coming back shows it rated', async () => {
    const first = render(pane(start));
    fireEvent.click(within(replyRow()).getByRole('button', { name: 'Could be better' }));
    first.unmount();
    await flush();
    expect(api.submitFeedback).toHaveBeenCalledTimes(1);
    expect(api.submitFeedback.mock.calls[0][0]).toMatchObject({ targetId: 'a1', vote: 'dislike' });
    render(pane(start));
    expect(within(replyRow()).getByRole('status')).toHaveTextContent('Thanks');
    expect(within(replyRow()).getByRole('button', { name: 'Could be better' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText('What could be better? (optional)')).toBeNull();
    await flush();
    expect(api.submitFeedback).toHaveBeenCalledTimes(1);
  });
});
