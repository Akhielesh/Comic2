import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuickStart } from './QuickStart';

/** Quick start says the path and who pays on the verb, before anything starts (feature doc §4.2, B3). */
describe('QuickStart — the path line on each card', () => {
  const props = {
    title: '', onTitle: vi.fn(), placeholder: 'Your meeting', busy: null, disabled: false, maxViewers: 200,
    defaultsLine: '720p', onStart: vi.fn(), onOpenAdvanced: vi.fn(), error: null,
  };

  it('Instant meeting: direct and free; Go live: through our servers, free for you, replay 24 h', () => {
    render(<QuickStart {...props} />);
    const meeting = screen.getByRole('button', { name: /Instant meeting/ });
    const live = screen.getByRole('button', { name: /Go live now/ });
    const mLine = meeting.querySelector('.qc-cost')!;
    expect(mLine.textContent).toBe('Direct between you and your guests — free.');
    expect(mLine.getAttribute('title')).toMatch(/an encrypted relay carries it for them/);
    expect(mLine.className).not.toMatch(/servers/);
    const gLine = live.querySelector('.qc-cost')!;
    expect(gLine.textContent).toBe('Through our servers · free for you · replay kept 24 h.');
    expect(gLine.getAttribute('title')).toMatch(/You aren’t charged/);
    expect(gLine.className).toMatch(/servers/);
    // The line sits between what it is and the call to action.
    const order = [...live.children].map((c) => c.className.split(' ')[0]);
    expect(order.indexOf('qc-cost')).toBeLessThan(order.indexOf('qc-cta'));
  });
});
