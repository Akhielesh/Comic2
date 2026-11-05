// @vitest-environment jsdom
// The emailed-link landing on the Atlas design system: the page title is the only display-face text, each
// status names itself in words (the tile's hue only backs the icon), and every status keeps its one action.
// The confirm step's copy and the live region are covered in hooks/useAuthLinkCallback.test.tsx.
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthCallbackPage } from './AuthCallbackPage';
import { FONT_DISPLAY } from './chat/studioDesign';

afterEach(cleanup);

describe('AuthCallbackPage — Atlas restyle', () => {
  it('names each status in its title, and only the title takes the display face', () => {
    const { container, rerender } = render(<AuthCallbackPage status="verifying" onContinue={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Verifying your link' })).toBeInTheDocument();
    expect(container.querySelectorAll(`.${FONT_DISPLAY}`)).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).className.split(/\s+/)).toContain(FONT_DISPLAY);
    rerender(<AuthCallbackPage status="success" flowType="magiclink" onContinue={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'You’re signed in' })).toHaveFocus();
    rerender(<AuthCallbackPage status="success" flowType="recovery" onContinue={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Recovery verified' })).toBeInTheDocument();
    rerender(<AuthCallbackPage status="error" onContinue={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'This link didn’t work' })).toHaveFocus();
    expect(screen.getByText('This link is invalid or expired. Request a new one and try again.')).toBeInTheDocument();
  });

  it('keeps one action per result: Continue after success, Back to sign in after an error; nothing to press while verifying', () => {
    const onContinue = vi.fn();
    const { rerender } = render(<AuthCallbackPage status="verifying" onContinue={onContinue} />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<AuthCallbackPage status="success" onContinue={onContinue} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    rerender(<AuthCallbackPage status="error" onContinue={onContinue} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(onContinue).toHaveBeenCalledTimes(2);
  });

  it('carries no raw status hue and no comic chrome', () => {
    for (const status of ['confirm', 'verifying', 'success', 'error'] as const) {
      const { container, unmount } = render(<AuthCallbackPage status={status} onContinue={vi.fn()} onConfirm={vi.fn()} onDecline={vi.fn()} />);
      expect(container.innerHTML, status).not.toMatch(/text-(red|green|amber|emerald)-\d|border-black|shadow-comic|font-comic/);
      unmount();
    }
  });
});
