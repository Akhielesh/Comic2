// Rate a reply (docs/features/reply-ratings.md): quiet ink thumbs, a note shared only when ticked, a "Thanks" that Undo
// really takes back, keyboard and screen-reader paths. The feedback API is faked: nothing leaves the test.
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ submitFeedback: vi.fn(), post: vi.fn() }));
vi.mock('../../../services/feedback', () => ({ submitFeedback: api.submitFeedback }));
vi.mock('../../../services/apiClient', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../services/apiClient')>()), post: api.post }));

import { ReplyRating } from './ReplyRating';
import { __resetReplyRatings } from './replyRatingMemory';

const MSG = { id: 'msg_7', cards: [{ type: 'plan', id: 'c1' }] as never, nextSteps: [] };
const up = () => screen.getByRole('button', { name: 'Good reply' });
const down = () => screen.getByRole('button', { name: 'Could be better' });
const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});
const frame = () => act(async () => {
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
});

beforeEach(() => {
  __resetReplyRatings();
  api.submitFeedback.mockReset().mockResolvedValue({ ok: true, persisted: true });
  api.post.mockReset().mockResolvedValue({ ok: true, withdrawn: true });
});
afterEach(() => vi.useRealTimers());

describe('ReplyRating', () => {
  it('two quiet ink thumbs in a named group, nothing pressed, no colour', () => {
    render(<ReplyRating msg={MSG} comicId="proj_1" always />);
    expect(screen.getByRole('group', { name: 'Rate this reply' })).toBeInTheDocument();
    for (const b of [up(), down()]) {
      expect(b).toHaveAttribute('aria-pressed', 'false');
      expect(b.className).toContain('text-[var(--ds-muted)]');
      // Ink only: no status, hue, accent or spark colour (the primitive's invalid edge is not a state these reach).
      expect(b.className.replace(/aria-\[invalid=true\]:\S+/g, '')).not.toMatch(/--ds-(success|danger|warning|hue|accent|spark)/);
    }
  });

  it('thumbs up is sent at once, once, and reads "Thanks" with an Undo', async () => {
    render(<ReplyRating msg={MSG} comicId="proj_1" always />);
    fireEvent.click(up());
    await flush();
    expect(api.submitFeedback).toHaveBeenCalledTimes(1);
    expect(api.submitFeedback.mock.calls[0][0]).toMatchObject({ targetType: 'comic_reply', targetId: 'msg_7', vote: 'like', source: 'comic_studio', sessionId: 'proj_1' });
    expect(screen.getByRole('status')).toHaveTextContent('Thanks');
    expect(up()).toHaveAttribute('aria-pressed', 'true');
    expect(up()).toHaveAttribute('aria-disabled', 'true');
    // The chosen thumb stays full ink and filled; the other one dims.
    expect(up().className).toContain('aria-disabled:opacity-100');
    expect(up().querySelector('svg')).toHaveAttribute('fill', 'currentColor');
    expect(down().className).toContain('aria-disabled:opacity-50');
    // A second press while rated sends nothing more.
    fireEvent.click(up());
    fireEvent.click(down());
    await flush();
    expect(api.submitFeedback).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Undo rating' })).toBeInTheDocument();
  });

  it('Undo really takes the rating back (withdraw) and the thumbs are ready again', async () => {
    render(<ReplyRating msg={MSG} comicId="proj_1" always />);
    fireEvent.click(up());
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Undo rating' }));
    await flush();
    expect(api.post).toHaveBeenCalledWith('/api/telemetry/feedback/withdraw', { targetType: 'comic_reply', targetId: 'msg_7' });
    expect(up()).toHaveAttribute('aria-pressed', 'false');
    expect(up()).not.toHaveAttribute('aria-disabled');
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(screen.queryByRole('button', { name: 'Undo rating' })).toBeNull();
  });

  it('an Undo that fails says so and keeps the rating; Try again finishes it', async () => {
    api.post.mockResolvedValueOnce({ ok: true, withdrawn: false });
    render(<ReplyRating msg={MSG} comicId="proj_1" always />);
    fireEvent.click(up());
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Undo rating' }));
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent('Couldn’t undo.');
    expect(up()).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(up()).toHaveAttribute('aria-pressed', 'false');
  });

  it('thumbs down opens an optional note (focused); unticked, only the rating is sent', async () => {
    render(<ReplyRating msg={MSG} comicId="proj_1" always />);
    fireEvent.click(down());
    expect(api.submitFeedback).not.toHaveBeenCalled();
    expect(down()).toHaveAttribute('aria-pressed', 'true');
    const field = screen.getByLabelText('What could be better? (optional)');
    expect(field).toHaveFocus();
    expect(screen.getByRole('checkbox', { name: 'Share this note with DreamStream' })).not.toBeChecked();
    expect(screen.getByText('Left unticked, only your thumbs-down is sent.')).toBeInTheDocument();
    fireEvent.change(field, { target: { value: 'It forgot the twist I asked for.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await flush();
    expect(api.submitFeedback).toHaveBeenCalledTimes(1);
    const sent = api.submitFeedback.mock.calls[0][0];
    expect(sent).toMatchObject({ vote: 'dislike', targetId: 'msg_7' });
    expect(sent).not.toHaveProperty('comment');
    expect(JSON.stringify(sent)).not.toContain('twist');
    expect(screen.getByRole('status')).toHaveTextContent('Thanks');
  });

  it('ticked, the note goes with the thumbs-down', async () => {
    render(<ReplyRating msg={MSG} comicId="proj_1" always />);
    fireEvent.click(down());
    fireEvent.change(screen.getByLabelText('What could be better? (optional)'), { target: { value: ' It forgot the twist. ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Share this note with DreamStream' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await flush();
    expect(api.submitFeedback.mock.calls[0][0]).toMatchObject({ vote: 'dislike', comment: 'It forgot the twist.' });
  });

  it('Escape (or Cancel) closes the note and sends nothing; focus goes back to the thumb', async () => {
    render(<ReplyRating msg={MSG} comicId="proj_1" always />);
    fireEvent.click(down());
    fireEvent.keyDown(screen.getByLabelText('What could be better? (optional)'), { key: 'Escape' });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });
    expect(screen.queryByLabelText('What could be better? (optional)')).toBeNull();
    expect(down()).toHaveAttribute('aria-pressed', 'false');
    expect(down()).toHaveFocus();
    fireEvent.click(down());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('What could be better? (optional)')).toBeNull();
    await flush();
    expect(api.submitFeedback).not.toHaveBeenCalled();
  });

  it('leaving with the note open records the thumbs-down once (a ticked note with it), as general chat does', async () => {
    const { unmount } = render(<ReplyRating msg={MSG} comicId="proj_1" always />);
    fireEvent.click(down());
    fireEvent.change(screen.getByLabelText('What could be better? (optional)'), { target: { value: 'Too wordy' } });
    unmount();
    await flush();
    expect(api.submitFeedback).toHaveBeenCalledTimes(1);
    expect(api.submitFeedback.mock.calls[0][0]).toMatchObject({ vote: 'dislike' });
    expect(api.submitFeedback.mock.calls[0][0]).not.toHaveProperty('comment');
    // A ticked note goes with it.
    const again = render(<ReplyRating msg={{ ...MSG, id: 'msg_8' }} comicId="proj_1" always />);
    fireEvent.click(down());
    fireEvent.change(screen.getByLabelText('What could be better? (optional)'), { target: { value: 'Too wordy' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Share this note with DreamStream' }));
    again.unmount();
    await flush();
    expect(api.submitFeedback).toHaveBeenCalledTimes(2);
    expect(api.submitFeedback.mock.calls[1][0]).toMatchObject({ targetId: 'msg_8', vote: 'dislike', comment: 'Too wordy' });
  });

  it('a row mounted again keeps its open note, its words and its box, sends nothing and does not take focus', async () => {
    const first = render(<ReplyRating msg={MSG} comicId="proj_1" always />);
    fireEvent.click(down());
    fireEvent.change(screen.getByLabelText('What could be better? (optional)'), { target: { value: 'Too wordy' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Share this note with DreamStream' }));
    // The same commit takes the old row away and puts the new one in (a layout swap).
    first.rerender(<ReplyRating key="again" msg={MSG} comicId="proj_1" always />);
    await flush();
    expect(api.submitFeedback).not.toHaveBeenCalled();
    expect(screen.getByLabelText('What could be better? (optional)')).toHaveValue('Too wordy');
    expect(screen.getByLabelText('What could be better? (optional)')).not.toHaveFocus();
    expect(screen.getByRole('checkbox', { name: 'Share this note with DreamStream' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await flush();
    expect(api.submitFeedback).toHaveBeenCalledTimes(1);
    expect(api.submitFeedback.mock.calls[0][0]).toMatchObject({ vote: 'dislike', comment: 'Too wordy' });
  });

  it('a rating is kept per comic and per reply: the same reply id in another comic starts unrated', async () => {
    const { unmount } = render(<ReplyRating msg={MSG} comicId="proj_1" always />);
    fireEvent.click(up());
    await flush();
    unmount();
    render(<ReplyRating msg={MSG} comicId="proj_2" always />);
    expect(up()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('a send that lands after its row went away still counts: the row back reads "Thanks", never a second send', async () => {
    let land!: (v: { ok: boolean; persisted: boolean }) => void;
    api.submitFeedback.mockReturnValueOnce(new Promise((r) => { land = r; }));
    const first = render(<ReplyRating msg={MSG} comicId="proj_1" always />);
    fireEvent.click(up());
    first.unmount();
    await act(async () => land({ ok: true, persisted: true }));
    render(<ReplyRating msg={MSG} comicId="proj_1" always />);
    expect(screen.getByRole('status')).toHaveTextContent('Thanks');
    fireEvent.click(up());
    await flush();
    expect(api.submitFeedback).toHaveBeenCalledTimes(1);
  });

  it('a rating that could not be saved says so; Try again sends the same row once more', async () => {
    api.submitFeedback.mockResolvedValueOnce({ ok: true, persisted: false });
    render(<ReplyRating msg={MSG} comicId="proj_1" always />);
    fireEvent.click(up());
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent('Couldn’t send.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(api.submitFeedback).toHaveBeenCalledTimes(2);
    expect(api.submitFeedback.mock.calls[1][0]).toEqual(api.submitFeedback.mock.calls[0][0]);
    expect(screen.getByRole('status')).toHaveTextContent('Thanks');
  });

  it('keyboard: Undo keeps focus while it runs, and a failed Undo leaves focus on Try again', async () => {
    let settle!: (v: { ok: boolean; withdrawn: boolean }) => void;
    api.post.mockReturnValueOnce(new Promise((r) => { settle = r; }));
    render(<ReplyRating msg={MSG} comicId="proj_1" always />);
    fireEvent.click(up());
    await flush();
    const undoBtn = screen.getByRole('button', { name: 'Undo rating' });
    undoBtn.focus();
    fireEvent.click(undoBtn);
    // Under way: the same button, focused and busy; a second press sends nothing.
    expect(screen.getByRole('status')).toHaveTextContent('Undoing…');
    expect(undoBtn).toHaveFocus();
    expect(undoBtn).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(undoBtn);
    await act(async () => settle({ ok: true, withdrawn: false }));
    await frame();
    expect(screen.getByRole('status')).toHaveTextContent('Couldn’t undo.');
    const tryAgain = screen.getByRole('button', { name: 'Try again' });
    expect(tryAgain).toHaveFocus();
    expect(api.post).toHaveBeenCalledTimes(1);
    // Try again works from the keyboard and lands focus back on the thumb.
    fireEvent.click(tryAgain);
    await flush();
    await frame();
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(up()).toHaveFocus();
  });

  it('keyboard: Try again after "Couldn’t send." keeps focus, which then sits on Undo', async () => {
    api.submitFeedback.mockResolvedValueOnce({ ok: true, persisted: false });
    render(<ReplyRating msg={MSG} comicId="proj_1" always />);
    fireEvent.click(up());
    await flush();
    const tryAgain = screen.getByRole('button', { name: 'Try again' });
    tryAgain.focus();
    fireEvent.click(tryAgain);
    expect(screen.getByRole('status')).toHaveTextContent('Sending…');
    expect(tryAgain).toHaveFocus();
    expect(tryAgain).toHaveAttribute('aria-disabled', 'true');
    await flush();
    await frame();
    expect(screen.getByRole('status')).toHaveTextContent('Thanks');
    expect(screen.getByRole('button', { name: 'Undo rating' })).toHaveFocus();
  });

  it('an older reply hides its thumbs until hover or focus on a hover pointer; a rating in progress always shows', async () => {
    const { container } = render(<ReplyRating msg={MSG} comicId="proj_1" />);
    const root = container.querySelector('[data-reply-rating]')!;
    expect(root.className).toContain('can-hover:opacity-0');
    expect(root.className).toContain('can-hover:group-focus-within/reply:opacity-100');
    fireEvent.click(up());
    await flush();
    expect(root.className).not.toContain('can-hover:opacity-0');
  });
});
