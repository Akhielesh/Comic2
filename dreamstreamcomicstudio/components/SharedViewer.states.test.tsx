// @vitest-environment jsdom
// The legacy share link's Atlas state views (DS-3, redesign M3): loading, sign in, not active and couldn't open,
// each in calm words on the canvas. A link that is gone, expired or not shared with you says which; only an
// unexpected failure offers "Try again" (an alert, redesign §8), and only a reader's press asks again (never a
// timer). The raw client or server text never reaches the card.
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/apiClient', () => ({ get: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('./ComicReader', () => ({ ComicReader: () => <div data-testid="comic-reader" /> }));

import { get } from '../services/apiClient';
import { SharedViewer, SharedViewerStateView, sharedViewerNoticeFor } from './SharedViewer';

const TOKEN = 'Kq3dEf6hIj9kLm2nPx';
const LEGACY = /border-black|shadow-comic|font-comic|(?<![\w-])font-display|brand-(?:yellow|blue|red|black)|text-white|bg-slate-900|text-red-\d/;
const mount = (onNavigate = vi.fn()) => {
  render(<SharedViewer shareToken={TOKEN} onNavigate={onNavigate} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} />);
  return onNavigate;
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('sharedViewerNoticeFor: what a failed link check means for the reader', () => {
  it.each([
    [{ status: 401 }, { status: 'login_required' }],
    [{ status: 403, details: { loginRequired: true } }, { status: 'login_required' }],
    [{ status: 404, message: 'Share not found or revoked' }, { status: 'not_active', reason: 'gone' }],
    [{ status: 410, message: 'Share link has expired' }, { status: 'not_active', reason: 'expired' }],
    [{ status: 403, message: 'You do not have access to this comic' }, { status: 'not_active', reason: 'no_access' }],
    [{ status: 409, message: 'This comic is shared from Comic Studio.' }, { status: 'not_active', reason: 'studio' }],
    [{ status: 500, message: 'Internal error' }, { status: 'error', message: 'Internal error' }],
    [{ status: 0, message: '  ' }, { status: 'error', message: undefined }],
    [undefined, { status: 'error', message: undefined }]
  ])('%j → %j', (err, expected) => {
    expect(sharedViewerNoticeFor(err)).toEqual(expected);
  });
});

describe('SharedViewer state views', () => {
  it('while the link is checked: one busy main with a calm status, on the canvas', () => {
    vi.mocked(get).mockReturnValue(new Promise(() => undefined));
    mount();
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Opening the shared comic…');
    expect(main.className).toContain('bg-[var(--ds-canvas)]');
    expect(main.outerHTML).not.toMatch(LEGACY);
  });

  it('a link that is turned off says so and offers the way home, not a retry', async () => {
    vi.mocked(get).mockRejectedValue({ status: 404, message: 'Share not found or revoked' });
    const onNavigate = mount();
    expect(await screen.findByRole('heading', { level: 1, name: 'This link isn’t active' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Go home' }));
    expect(onNavigate).toHaveBeenCalledWith('home');
    expect(screen.getByRole('main').outerHTML).not.toMatch(LEGACY);
  });

  it('an expired link and a link shared with other people each say which', async () => {
    vi.mocked(get).mockRejectedValueOnce({ status: 410 });
    mount();
    expect(await screen.findByRole('heading', { name: 'This link has expired' })).toBeInTheDocument();
    cleanup();
    vi.mocked(get).mockRejectedValueOnce({ status: 403, message: 'You do not have access to this comic' });
    mount();
    expect(await screen.findByRole('heading', { name: 'This comic isn’t shared with you' })).toBeInTheDocument();
    // 403 reaches only a signed-in reader: the words say so, and offer nothing the page has no button for.
    const card = screen.getByRole('status');
    expect(card).toHaveTextContent('You’re signed in with an account it wasn’t shared with. Ask the creator to share it with this account.');
    expect(card.textContent).not.toMatch(/sign in with/i);
    expect(screen.getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['Go home']);
  });

  it('an unexpected failure offers Try again, and only that press asks for the link again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.mocked(get).mockRejectedValueOnce({ status: 500, message: 'Internal error' });
      mount();
      expect(await screen.findByRole('heading', { name: 'Couldn’t open this comic' })).toBeInTheDocument();
      // A load failure is an alert; the raw server text goes to the console, not onto the card.
      const alert = screen.getByRole('alert');
      expect(alert).toHaveAttribute('data-shared-state', 'error');
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.getByRole('main').textContent).not.toContain('Internal error');
      expect(warn).toHaveBeenCalledWith(expect.any(String), 'Internal error');
      warn.mockRestore();
      // Nothing retries on its own.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(get).toHaveBeenCalledTimes(1);
      vi.mocked(get).mockResolvedValueOnce({ project: { id: 'p1' }, share: { allowDownload: false } });
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByTestId('comic-reader')).toBeInTheDocument();
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('SharedViewerStateView never prints an error’s raw message, and only the failure is an alert', () => {
    const { unmount } = render(<SharedViewerStateView notice={{ status: 'error', message: 'Failed to fetch' }} onRetry={vi.fn()} />);
    expect(screen.getByRole('alert')).not.toHaveTextContent('Failed to fetch');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    unmount();
    for (const notice of [{ status: 'loading' }, { status: 'login_required' }, { status: 'not_active', reason: 'gone' }] as const) {
      const view = render(<SharedViewerStateView notice={notice} />);
      expect(screen.getByRole('status')).toHaveAttribute('data-shared-state', notice.status);
      expect(screen.queryByRole('alert')).toBeNull();
      view.unmount();
    }
  });

  it('SharedViewerStateView sets its title at the level asked (h2 where several states share a page)', () => {
    render(<SharedViewerStateView notice={{ status: 'login_required' }} onSignIn={vi.fn()} headingLevel={2} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Sign in to read this comic' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });
});
