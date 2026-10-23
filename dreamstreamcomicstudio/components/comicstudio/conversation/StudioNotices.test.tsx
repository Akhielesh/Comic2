import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { StudioNotice } from '../types';
import { ConversationPane } from './ConversationPane';
import { NOTICE_MS, SAVED_NOTE_MS, SavedByEditorNote, StudioErrorBanner, StudioNoticeToast, errorPresentation } from './StudioNotices';
import { makeFakeStudio, resetUsageStatus, showDollarPrices, showUsagePrices } from './testing/fixtures';

beforeEach(showDollarPrices);
afterEach(() => {
  resetUsageStatus();
  vi.useRealTimers();
});

const notice = (extra: Partial<StudioNotice> = {}): StudioNotice => ({ id: 'n1', kind: 'undo', text: 'Undid: move a balloon.', action: 'redo', at: 1, ...extra });

describe('StudioErrorBanner — tailored by the server code', () => {
  it('maps codes to a calm presentation (resync only where it can help)', () => {
    expect(errorPresentation('COOLDOWN')).toMatchObject({ tone: 'pause', resync: false });
    expect(errorPresentation('CONTENT_POLICY')).toMatchObject({ tone: 'care', resync: false, hint: expect.stringMatching(/rewording/) });
    expect(errorPresentation('LIMIT')).toMatchObject({ tone: 'info', resync: false });
    expect(errorPresentation('BUSY').hint).toMatch(/moment/);
    expect(errorPresentation(null)).toMatchObject({ tone: 'problem', resync: true });
    expect(errorPresentation('SOMETHING_NEW')).toMatchObject({ tone: 'problem', resync: true });
  });

  it('a safety break reads as a pause: no Resync, reading and editing still work', () => {
    const studio = makeFakeStudio({ error: 'New drawings are paused for a few minutes.', errorCode: 'COOLDOWN' });
    render(<StudioErrorBanner studio={studio} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-tone', 'pause');
    expect(alert).toHaveTextContent('A short break: New drawings are paused for a few minutes.');
    expect(alert).toHaveTextContent('Reading and editing still work.');
    expect(screen.queryByRole('button', { name: /Resync/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(studio.clearError).toHaveBeenCalled();
  });

  it('a content-rules refusal offers a reword hint; a generic problem offers Resync', () => {
    const { rerender } = render(<StudioErrorBanner studio={makeFakeStudio({ error: 'That goes past this comic’s rating.', errorCode: 'CONTENT_POLICY' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Try rewording it/);
    const studio = makeFakeStudio({ error: 'Connection lost — resyncing.' });
    rerender(<StudioErrorBanner studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: /Resync/ }));
    expect(studio.clearError).toHaveBeenCalled();
    expect(studio.refresh).toHaveBeenCalled();
  });
});

describe('StudioNoticeToast — undo / redo / info notices', () => {
  it('shows the notice with its follow-up; Redo runs studio.redo and clears it', () => {
    const studio = makeFakeStudio({ notice: notice(), clearNotice: vi.fn() });
    render(<StudioNoticeToast studio={studio} />);
    expect(screen.getByRole('status')).toHaveTextContent('Undid: move a balloon.');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(studio.redo).toHaveBeenCalled();
    expect(studio.clearNotice).toHaveBeenCalled();
  });

  it('a redo notice offers Undo; an info notice has no follow-up but can be dismissed', () => {
    const studio = makeFakeStudio({ notice: notice({ kind: 'redo', text: 'Redid: move a balloon.', action: 'undo' }), clearNotice: vi.fn() });
    const { rerender } = render(<StudioNoticeToast studio={studio} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(studio.undo).toHaveBeenCalled();
    const info = makeFakeStudio({ notice: notice({ kind: 'info', text: 'Nothing to undo yet.', action: undefined }), clearNotice: vi.fn() });
    rerender(<StudioNoticeToast studio={info} />);
    expect(screen.queryByRole('button', { name: /Undo|Redo/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(info.clearNotice).toHaveBeenCalled();
  });

  it('fades on its own after a few seconds (a UI timer — nothing calls the server)', () => {
    vi.useFakeTimers();
    const clearNotice = vi.fn();
    render(<StudioNoticeToast studio={makeFakeStudio({ notice: notice(), clearNotice })} />);
    act(() => vi.advanceTimersByTime(NOTICE_MS - 10));
    expect(clearNotice).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(20));
    expect(clearNotice).toHaveBeenCalledTimes(1);
  });

  it('the conversation pane renders the notice (typed "undo" and chip undo are never invisible)', () => {
    render(<ConversationPane studio={makeFakeStudio({ notice: notice({ kind: 'info', text: 'That image is still drawing — undo it once the drawing finishes.', action: undefined }), clearNotice: vi.fn() })} />);
    expect(screen.getByText('That image is still drawing — undo it once the drawing finishes.')).toBeInTheDocument();
  });
});

describe('SavedByEditorNote — "Free — done by the editor, no AI cost"', () => {
  it('appears after a turn that saved something, in dollars for admins / own key', () => {
    const studio = makeFakeStudio({ lastSavedUsd: null });
    const { rerender } = render(<SavedByEditorNote studio={studio} />);
    expect(screen.queryByText(/done by the editor/)).toBeNull();
    rerender(<SavedByEditorNote studio={{ ...studio, lastSavedUsd: 0.07 }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Free — done by the editor, no AI cost · saved ≈$0.07');
    // Hidden while the studio works again.
    rerender(<SavedByEditorNote studio={{ ...studio, lastSavedUsd: 0.07, busy: true }} />);
    expect(screen.queryByText(/done by the editor/)).toBeNull();
  });

  it('speaks in usage terms for a governed user, and goes after a few seconds or on dismiss', () => {
    vi.useFakeTimers();
    showUsagePrices(1);
    const studio = makeFakeStudio({ lastSavedUsd: null });
    const { rerender } = render(<SavedByEditorNote studio={studio} />);
    rerender(<SavedByEditorNote studio={{ ...studio, lastSavedUsd: 0.5 }} />);
    const line = screen.getByRole('status');
    expect(line.textContent).not.toMatch(/\$/);
    expect(line).toHaveTextContent(/saved ≈[\d.]+% of your usage/);
    act(() => vi.advanceTimersByTime(SAVED_NOTE_MS + 10));
    expect(screen.queryByText(/done by the editor/)).toBeNull();
    // A later turn that saves again shows it again; Dismiss hides it.
    rerender(<SavedByEditorNote studio={{ ...studio, lastSavedUsd: 0.2 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/done by the editor/)).toBeNull();
  });
});
