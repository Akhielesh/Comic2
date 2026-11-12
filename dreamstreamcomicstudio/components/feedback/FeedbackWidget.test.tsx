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
});
