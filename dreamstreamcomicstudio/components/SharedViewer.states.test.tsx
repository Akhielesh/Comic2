// @vitest-environment jsdom
// The legacy share link's Atlas state views (DS-3, redesign M3): loading, sign in, not active and couldn't open,
// each in calm words on the canvas. A link that is gone, expired or not shared with you says which; only an
// unexpected failure offers "Try again", and only a reader's press asks again (never a timer).
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
  });

  it('an unexpected failure offers Try again, and only that press asks for the link again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(get).mockRejectedValueOnce({ status: 500, message: 'Internal error' });
      mount();
      expect(await screen.findByRole('heading', { name: 'We couldn’t open this comic' })).toBeInTheDocument();
      expect(screen.getByText('Internal error')).toBeInTheDocument();
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

  it('SharedViewerStateView sets its title at the level asked (h2 where several states share a page)', () => {
    render(<SharedViewerStateView notice={{ status: 'login_required' }} onSignIn={vi.fn()} headingLevel={2} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Sign in to read this comic' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });
});
