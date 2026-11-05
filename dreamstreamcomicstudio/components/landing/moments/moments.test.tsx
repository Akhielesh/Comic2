// @vitest-environment jsdom
// The home page's motion moments (bridge §8 contract): the finished frame first and under reduced motion
// (no entrance class, nothing waiting on script), then the loop once mounted, which holds still (timers
// and CSS loops, through data-inview) while the tab is hidden.
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasMoment, ChatMoment, ComicMoment, StreamMoment } from './homeMoments';

const realMatchMedia = window.matchMedia;
const setReducedMotion = (reduce: boolean) => {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion: reduce'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
};
const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
};

/** Advance fake time in small acts: each step's timer is scheduled by an effect after the previous one commits. */
const advance = (ms: number, step = 40) => {
  for (let t = 0; t < ms; t += step) act(() => vi.advanceTimersByTime(Math.min(step, ms - t)));
};

const ENTRANCES = /\bds-(?:draw|pop|blur-in|scale-in|stagger|fade-in)\b/;
const classesIn = (root: Element) => Array.from(root.querySelectorAll('[class]')).map((el) => el.getAttribute('class') ?? '').join(' ');

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.matchMedia = realMatchMedia;
  setHidden(false);
});

describe('motion moments under reduced motion: one finished, still frame', () => {
  beforeEach(() => setReducedMotion(true));

  it('Comic Studio: the drawn page, the balloon and the full caption, no entrance', () => {
    const { container } = render(<ComicMoment />);
    expect(container.textContent).toContain('Someone’s still up.');
    expect(container.textContent).toContain('Meanwhile, at the lighthouse…');
    expect(container.textContent).toContain('Page ready');
    expect(classesIn(container)).not.toMatch(ENTRANCES);
    expect(container.querySelector('[data-inview]')).toBeNull();
  });

  it('Stream Studio: the live event with its LIVE badge (the word, not only the colour)', () => {
    const { container } = render(<StreamMoment />);
    expect(container.textContent).toContain('LIVE');
    expect(container.textContent).toContain('128 watching');
    expect(container.textContent).toContain('Hi from Lisbon!');
    expect(container.querySelector('.ds-logo-mark--loading')).toBeNull();
    expect(classesIn(container)).not.toMatch(ENTRANCES);
  });

  it('Chat Studio: the question, the answer and the forecast card, an empty composer', () => {
    const { container } = render(<ChatMoment />);
    expect(container.textContent).toContain('Plan three days in Kyoto next week');
    expect(container.textContent).toContain('Pack a light jacket');
    expect(container.textContent).toContain('Kyoto · next 3 days');
    expect(container.textContent).toContain('Ask anything');
    expect(container.querySelector('.ds-caret')).toBeNull();
    expect(classesIn(container)).not.toMatch(ENTRANCES);
  });

  it('Atlas Studio: the query, its three results from three sources and a preview', () => {
    const { container } = render(<AtlasMoment />);
    expect(container.textContent).toContain('acme invoice 4821');
    expect(container.textContent).toContain('3 results · 3 sources');
    for (const source of ['Gmail', 'Dropbox', 'Google Drive']) expect(container.textContent).toContain(source);
    expect(container.textContent).toContain('Preview · Invoice #4821');
    expect(classesIn(container)).not.toMatch(ENTRANCES);
  });
});

describe('motion moments with motion on', () => {
  beforeEach(() => setReducedMotion(false));

  it('first paint is the finished frame; mounted off screen, it starts from the first step and plays in order', () => {
    // jsdom lays nothing out: every rect is 0 × 0 at the top, which reads as off screen.
    const { container } = render(<ComicMoment />);
    // After the mount effect: the drawing step, so no balloon yet, panels drawing in.
    expect(container.textContent).not.toContain('Someone’s still up.');
    expect(container.querySelector('.ds-draw')).not.toBeNull();
    advance(1500);
    expect(container.textContent).toContain('Someone’s still up.');
    expect(container.querySelector('.ds-pop')).not.toBeNull();
    advance(650);
    // Caption: typing, one character at a time, with a caret.
    advance(200);
    const caption = container.querySelector('text:not([text-anchor])')?.textContent ?? '';
    expect(caption.length).toBeGreaterThan(0);
    expect(caption.length).toBeLessThan('Meanwhile, at the lighthouse…'.length + 1);
    expect(container.querySelector('.ds-home-blink')).not.toBeNull();
    advance(5000);
    expect(container.textContent).toContain('Meanwhile, at the lighthouse…');
  });

  it('holds still while the tab is hidden: data-inview="false" and no step advances', () => {
    const { container } = render(<ChatMoment />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute('data-inview')).toBe('true');
    act(() => setHidden(true));
    expect(root.getAttribute('data-inview')).toBe('false');
    const before = container.textContent;
    advance(10_000);
    expect(container.textContent).toBe(before);
    act(() => setHidden(false));
    expect(root.getAttribute('data-inview')).toBe('true');
    advance(3000);
    expect(container.textContent).not.toBe(before);
  });

  it('Stream Studio walks its three uses, one per loop, and broadcasts the mark only while animating', () => {
    const { container } = render(<StreamMoment />);
    expect(container.querySelector('.ds-logo-mark--loading')).not.toBeNull();
    expect(container.textContent).toContain('LIVE');
    advance(1500 + 3200 + 450 + 300);
    expect(container.textContent).toContain('Nursery · Quiet');
    expect(container.textContent).toContain('Never recorded');
    advance(1500 + 3200 + 450 + 300);
    expect(container.textContent).toContain('Calling Grandma…');
    advance(1500 + 200);
    expect(container.textContent).toContain('Connected');
  });
});
