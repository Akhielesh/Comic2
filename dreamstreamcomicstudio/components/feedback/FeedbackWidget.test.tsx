/**
 * The feedback pill and panel on Atlas (DS-2): the raised pill above the safe area, the overlay panel over the
 * scrim with a plain title, the DS fields and the ink primary; Escape closes it; no legacy kit class.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/feedback', () => ({
  FEEDBACK_CATEGORIES: ['Comic Studio', 'Chat Studio'],
  submitFeedback: vi.fn(async () => undefined)
}));

import { submitFeedback } from '../../services/feedback';
import { OVERLAY, SCRIM, Z } from '../chat/studioDesign';
import { expectClasses } from '../ds/ds.testkit';
import { FEEDBACK_LAUNCHER, FeedbackWidget } from './FeedbackWidget';

const classesIn = (root: Element): string[] => [root, ...root.querySelectorAll('*')].flatMap((el) => (el.getAttribute('class') ?? '').split(/\s+/)).filter(Boolean);
const LEGACY = /^(?:[\w-]+:)*(?:border-black|shadow-comic|font-comic|font-display|(?:bg|text|border)-brand-[\w/]+|(?:bg|text|border)-slate-\d+|(?:text|bg)-green-\d+|bg-black|text-white|shadow-\[\d)/;

describe('FeedbackWidget', () => {
  it('the pill is the raised Atlas pill on the chrome layer, above the bottom safe area', () => {
    const { container } = render(<FeedbackWidget />);
    const pill = screen.getByRole('button', { name: 'Send feedback' });
    expectClasses(pill, FEEDBACK_LAUNCHER, Z.chrome);
    expect(FEEDBACK_LAUNCHER).toContain('bottom-[calc(1rem+var(--sa-bottom-eff,0px))]');
    expect(classesIn(container).filter((c) => LEGACY.test(c))).toEqual([]);
  });

  it('opens a titled panel over the scrim; Escape closes it', () => {
    const { container } = render(<FeedbackWidget />);
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    const panel = screen.getByRole('dialog', { name: 'Send feedback' });
    expectClasses(panel, OVERLAY);
    expectClasses(panel.parentElement!, SCRIM, Z.scrim);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    expect(classesIn(container).filter((c) => LEGACY.test(c))).toEqual([]);
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send feedback' })).toBeInTheDocument();
    // Focus goes back to the pill, not to <body>.
    expect(screen.getByRole('button', { name: 'Send feedback' })).toHaveFocus();
  });

  it('Close and a click on the scrim hand focus back to the pill too; it never steals focus on mount', () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    render(<FeedbackWidget />);
    expect(outside).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send feedback' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send feedback' })).toHaveFocus();
    outside.remove();
  });

  it('the panel enters with the 280 ms overlay scale-in, not the page entrance', () => {
    render(<FeedbackWidget />);
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    const panel = screen.getByRole('dialog', { name: 'Send feedback' });
    expect(panel.classList.contains('ds-scale-in')).toBe(true);
    expect(panel.classList.contains('ds-rise-in')).toBe(false);
  });

  it('sends what the person chose with the DS fields, then thanks them', async () => {
    render(<FeedbackWidget />);
    fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    const send = screen.getByRole('button', { name: 'Send feedback' });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Happy' }));
    expect(screen.getByRole('button', { name: 'Happy' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByRole('combobox', { name: "What's it about?" }), { target: { value: 'Chat Studio' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Tell us more' }), { target: { value: '  Love the reader  ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
    });
    expect(submitFeedback).toHaveBeenCalledWith(expect.objectContaining({ sentiment: 'positive', category: 'Chat Studio', comment: 'Love the reader' }));
    expect(screen.getByRole('status')).toHaveTextContent('Thanks — we hear you.');
  });

  it('leaving the page cancels its delayed steps: no timer is left behind after unmount', () => {
    vi.useFakeTimers();
    try {
      const set = vi.spyOn(globalThis, 'setTimeout');
      const clear = vi.spyOn(globalThis, 'clearTimeout');
      const { unmount } = render(<FeedbackWidget />);
      fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      // The close schedules the reset that runs after the 200 ms close animation.
      const at = set.mock.calls.findIndex((call) => call[1] === 200);
      expect(at).toBeGreaterThanOrEqual(0);
      const resetTimer = set.mock.results[at].value;
      expect(clear).not.toHaveBeenCalledWith(resetTimer);
      unmount();
      expect(clear).toHaveBeenCalledWith(resetTimer);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('a panel that stays on the page is still clean when it is reopened after the close animation', () => {
    vi.useFakeTimers();
    try {
      render(<FeedbackWidget />);
      fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
      fireEvent.click(screen.getByRole('button', { name: 'Happy' }));
      expect(screen.getByRole('button', { name: 'Happy' })).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      act(() => {
        vi.advanceTimersByTime(200);
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
      expect(screen.getByRole('button', { name: 'Happy' })).toHaveAttribute('aria-pressed', 'false');
    } finally {
      vi.useRealTimers();
    }
  });
});
