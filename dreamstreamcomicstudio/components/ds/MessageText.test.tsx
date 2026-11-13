/**
 * MessageText (SPEC-overflow §3.4, §7.1): one element when the message fits; a clamped body and a "Show more" toggle
 * as its next sibling when it does not; the live role on the body only; measured while collapsed; "Show less" stays;
 * new text starts collapsed; no timers. jsdom has no layout, so scrollHeight / clientHeight are stubbed per case.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LINE_CLAMP, MessageText } from './MessageText';
import { WRAP_TEXT } from './recipes';

let overflowing = false;
beforeEach(() => {
  overflowing = false;
  // Clamped and too long: scrollHeight > clientHeight; otherwise they match.
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => (overflowing ? 120 : 60));
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 60);
});
afterEach(() => vi.restoreAllMocks());

const LONG = 'https://api.example-provider.dev/v1/images/generations/very-long-path-segment?model=google/gemini-3-pro-image-preview';
const body = () => document.querySelector<HTMLElement>('[data-slot="message"]')!;

describe('MessageText', () => {
  it('the body is the message slot with the long-word rule; lines picks the clamp', () => {
    render(<MessageText lines={3}>{LONG}</MessageText>);
    const classes = body().className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining([...WRAP_TEXT.split(' '), 'line-clamp-3']));
    expect(LINE_CLAMP).toEqual({ 2: 'line-clamp-2', 3: 'line-clamp-3', 4: 'line-clamp-4', 6: 'line-clamp-6' });
  });

  it('a message that fits renders exactly one element and no button', () => {
    const { container } = render(<MessageText>Short and sweet.</MessageText>);
    expect(container.children).toHaveLength(1);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a clamped message gets "Show more" as the body\'s next sibling; the role lands on the body only', () => {
    overflowing = true;
    render(
      <MessageText role="status" id="m1">
        {LONG}
      </MessageText>
    );
    const toggle = screen.getByRole('button', { name: 'Show more' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'm1');
    expect(body().id).toBe('m1');
    expect(body().nextElementSibling).toBe(toggle);
    expect(body().contains(toggle)).toBe(false);
    expect(body()).toHaveAttribute('role', 'status');
    expect(toggle.closest('[role="status"]')).toBeNull();
  });

  it('Show more expands; "Show less" stays even when the expanded body no longer overflows', () => {
    overflowing = true;
    render(<MessageText>{LONG}</MessageText>);
    overflowing = false; // once unclamped, the body is as tall as its text: a measure now would say "fits"
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    const less = screen.getByRole('button', { name: 'Show less' });
    expect(less).toHaveAttribute('aria-expanded', 'true');
    expect(body().className).not.toMatch(/line-clamp-/);
    // A re-render while expanded measures nothing: the toggle stays.
    act(() => undefined);
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
  });

  it('new text in a box that keeps its height is measured again in the layout effect (no ResizeObserver callback)', () => {
    const { rerender } = render(<MessageText>Short.</MessageText>);
    expect(screen.queryByRole('button')).toBeNull();
    overflowing = true;
    rerender(<MessageText>{LONG}</MessageText>);
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
  });

  it('new text while expanded starts collapsed again', () => {
    overflowing = true;
    const { rerender } = render(<MessageText>{LONG}</MessageText>);
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    rerender(<MessageText>{`${LONG} (again)`}</MessageText>);
    expect(screen.getByRole('button', { name: 'Show more' })).toHaveAttribute('aria-expanded', 'false');
    expect(body().className).toMatch(/line-clamp-3/);
  });

  it('starts no timers: mount, toggle and new text', () => {
    vi.useFakeTimers();
    try {
      overflowing = true;
      const { rerender } = render(<MessageText>{LONG}</MessageText>);
      expect(vi.getTimerCount()).toBe(0);
      fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
      rerender(<MessageText>{`${LONG}!`}</MessageText>);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
