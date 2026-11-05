// The legacy share link (/share/<token>) when the owner requires sign-in: "Sign In" must reach the sign-in
// page AND come back to the same link afterwards (App's ?next= hand-back). It used to call
// onNavigate('login'), a view App does not know, so the button did nothing.
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { safeNext } from '../services/safeNext';

vi.mock('../services/apiClient', () => ({ get: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('./ComicReader', () => ({ ComicReader: () => <div data-testid="comic-reader" /> }));

import { get } from '../services/apiClient';
import { SharedViewer, signInHref } from './SharedViewer';

const ORIGIN = 'https://dreamstreamstudio.ai';
const TOKEN = 'Kq3dEf6hIj9kLm2nPx';

describe('SharedViewer: Sign in on a login-only share link', () => {
  const realLocation = window.location;
  let assign: Mock;

  beforeEach(() => {
    assign = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, assign } });
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    cleanup();
    vi.clearAllMocks();
  });

  it('goes to sign-in on this site and asks to come back to /share/<token> (?next=)', async () => {
    vi.mocked(get).mockRejectedValue({ status: 401, message: 'Sign in to view this comic' });
    const onNavigate = vi.fn();
    render(<SharedViewer shareToken={TOKEN} onNavigate={onNavigate} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /sign in/i }));

    expect(assign).toHaveBeenCalledTimes(1);
    const href = assign.mock.calls[0][0] as string;
    // Same-origin and relative: never an absolute address someone could swap.
    expect(href.startsWith('/?next=')).toBe(true);
    const dest = new URL(href, ORIGIN);
    expect(dest.pathname).toBe('/');
    expect(dest.searchParams.get('next')).toBe(`/share/${TOKEN}`);
    // App follows it only through safeNext, which keeps it as is.
    expect(safeNext(dest.searchParams.get('next'), ORIGIN, false)).toBe(`/share/${TOKEN}`);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('a login-required flag on another status reads the same way', async () => {
    vi.mocked(get).mockRejectedValue({ status: 403, message: 'nope', details: { loginRequired: true } });
    render(<SharedViewer shareToken={TOKEN} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onOpenFaq={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /sign in/i }));
    expect(assign).toHaveBeenCalledWith(signInHref(TOKEN));
    expect(signInHref(TOKEN)).toBe(`/?next=${encodeURIComponent(`/share/${TOKEN}`)}`);
  });
});
