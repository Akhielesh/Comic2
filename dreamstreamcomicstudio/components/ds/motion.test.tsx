/**
 * The motion and live-state primitives ported from Atlas (bridge D7; docs/design/design-system.md "Motion
 * classes and hooks"): useInViewPause / InViewPause (one shared IntersectionObserver that marks its hosts
 * data-inview), LiveDot (a decorative .ds-live-dot whose ping holds while off screen), CountUp (the final value
 * at once under reduced motion, a 1.1 s count otherwise) and Collapse (a grid-rows height disclosure that is
 * instant under reduced motion). Every one of their CSS classes lives in styles/ds-motion.css
 * (tests/config/dsMotion.test.ts); this file covers their behaviour.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Collapse, COLLAPSE_CLOSED, COLLAPSE_OPEN, CountUp, COUNT_UP_MS, InViewPause, LiveDot, PRESENCE_EXIT_MS, useInViewPause } from './index';
import * as ds from './index';
import * as reveal from './useImageReveal';

type ObserverCallback = (entries: Array<Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>>) => void;
const observers: Array<{ callback: ObserverCallback; targets: Set<Element>; options?: IntersectionObserverInit }> = [];

class IntersectionObserverMock {
  private readonly record: { callback: ObserverCallback; targets: Set<Element>; options?: IntersectionObserverInit };
  constructor(callback: ObserverCallback, options?: IntersectionObserverInit) {
    this.record = { callback, targets: new Set(), options };
    observers.push(this.record);
  }
  observe(target: Element) {
    this.record.targets.add(target);
  }
  unobserve(target: Element) {
    this.record.targets.delete(target);
  }
  disconnect() {
    this.record.targets.clear();
  }
}

/** Reports an intersection change for `target`, as the browser would after a scroll. */
function report(target: Element, isIntersecting: boolean) {
  act(() => {
    for (const o of observers) if (o.targets.has(target)) o.callback([{ target, isIntersecting }]);
  });
}

let visibility: DocumentVisibilityState = 'visible';
const setVisibility = (next: DocumentVisibilityState) => {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

let reducedMotion = false;
const mediaListeners = new Set<() => void>();

beforeEach(() => {
  observers.length = 0;
  visibility = 'visible';
  reducedMotion = false;
  vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() {
      return q === '(prefers-reduced-motion: reduce)' && reducedMotion;
    },
    media: q,
    addEventListener: (_: string, fn: () => void) => mediaListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => mediaListeners.delete(fn)
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  mediaListeners.clear();
});

describe('useInViewPause and InViewPause', () => {
  it('leaves the loops running until measured, then marks the host in or out of view', () => {
    render(<InViewPause as="section" data-testid="host" className="x" />);
    const host = screen.getByTestId('host');
    expect(host.tagName).toBe('SECTION');
    expect(host).toHaveClass('x');
    expect(host).not.toHaveAttribute('data-inview');
    report(host, false);
    expect(host).toHaveAttribute('data-inview', 'false');
    report(host, true);
    expect(host).toHaveAttribute('data-inview', 'true');
    // It starts a loop a little before it scrolls in.
    expect(observers[0].options).toEqual({ rootMargin: '96px 0px' });
  });

  it('holds every host while the tab is hidden, then returns to what the observer last said', () => {
    render(<InViewPause data-testid="host" />);
    const host = screen.getByTestId('host');
    report(host, true);
    setVisibility('hidden');
    expect(host).toHaveAttribute('data-inview', 'false');
    setVisibility('visible');
    expect(host).toHaveAttribute('data-inview', 'true');
  });

  it('shares ONE observer between hosts and stops listening once the last host unmounts', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const { unmount } = render(
      <>
        <LiveDot />
        <LiveDot />
        <InViewPause />
      </>
    );
    expect(observers).toHaveLength(1);
    expect(observers[0].targets.size).toBe(3);
    unmount();
    expect(observers[0].targets.size).toBe(0);
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('does nothing without IntersectionObserver (the loops simply run)', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const Probe = () => {
      const ref = React.useRef<HTMLDivElement>(null);
      useInViewPause(ref);
      return <div ref={ref} data-testid="probe" />;
    };
    render(<Probe />);
    expect(screen.getByTestId('probe')).not.toHaveAttribute('data-inview');
  });
});

describe('LiveDot', () => {
  it('is a decorative .ds-live-dot that keeps its own classes; settle pings three times and rests', () => {
    const { container, rerender } = render(<LiveDot className="text-[var(--ds-success)]" />);
    const dot = container.querySelector('span')!;
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(dot).toHaveClass('ds-live-dot', 'text-[var(--ds-success)]');
    expect(dot).not.toHaveClass('ds-live-dot-settle');
    rerender(<LiveDot settle />);
    expect(container.querySelector('span')).toHaveClass('ds-live-dot', 'ds-live-dot-settle');
  });

  it('holds its ping while scrolled out of view', () => {
    const { container } = render(<LiveDot />);
    const dot = container.querySelector('.ds-live-dot')!;
    report(dot, false);
    expect(dot).toHaveAttribute('data-inview', 'false');
  });
});

describe('CountUp', () => {
  it('under reduced motion: the final value at once, no observer and no animation frame', () => {
    reducedMotion = true;
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    render(<CountUp value={12480} />);
    expect(screen.getByText((12480).toLocaleString())).toHaveClass('tabular-nums');
    expect(observers).toHaveLength(0);
    expect(raf).not.toHaveBeenCalled();
  });

  it('counts from zero to the value once it scrolls into view, easing out over 1.1 s', () => {
    let now = 0;
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const { container } = render(<CountUp value={1000} format={(n) => `${n} pages`} />);
    const el = container.querySelector('[data-slot="count-up"]')!;
    expect(el.textContent).toBe('0 pages');
    expect(observers[0].options).toEqual({ threshold: 0.4 });
    report(el, true);
    const step = (t: number) => act(() => {
      now = t;
      frames.shift()!(t);
    });
    step(0);
    expect(el.textContent).toBe('0 pages');
    step(COUNT_UP_MS / 2);
    const mid = Number(el.textContent!.split(' ')[0]);
    expect(mid).toBeGreaterThan(500); // ease-out: past half way at half time
    expect(mid).toBeLessThan(1000);
    step(COUNT_UP_MS);
    expect(el.textContent).toBe('1000 pages');
    expect(frames).toHaveLength(0); // done: no more frames requested
  });

  it('shows the value straight away when it is not above zero or the browser has no observer', () => {
    render(<CountUp value={0} />);
    expect(screen.getByText('0')).toBeInTheDocument();
    cleanup();
    vi.stubGlobal('IntersectionObserver', undefined);
    render(<CountUp value={42} />);
    expect(screen.getByText('42')).toBeInTheDocument();
  });
});

describe('Collapse', () => {
  it('mounts nothing while closed; opens on the grid-rows recipe; stays for the exit, hidden from assistive tech, then unmounts', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <Collapse open={false} id="more">
        <p>Details</p>
      </Collapse>
    );
    expect(container.firstChild).toBeNull();
    rerender(
      <Collapse open id="more">
        <p>Details</p>
      </Collapse>
    );
    const body = container.querySelector('#more')!;
    // In the DOM at once (screen readers and tests see it), the open styling a frame later.
    expect(screen.getByText('Details')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(50);
    });
    for (const c of COLLAPSE_OPEN.split(' ')) expect(body).toHaveClass(c);
    expect(body).toHaveClass('motion-reduce:transition-none');
    expect(body).not.toHaveAttribute('aria-hidden');
    rerender(
      <Collapse open={false} id="more">
        <p>Details</p>
      </Collapse>
    );
    expect(container.querySelector('#more')).toHaveAttribute('aria-hidden', 'true');
    for (const c of COLLAPSE_CLOSED.split(' ')) expect(container.querySelector('#more')).toHaveClass(c);
    act(() => {
      vi.advanceTimersByTime(PRESENCE_EXIT_MS - 1);
    });
    expect(container.querySelector('#more')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector('#more')).toBeNull();
  });

  it('under reduced motion it opens and closes at once: no frame wait, no exit wait', () => {
    reducedMotion = true;
    const { container, rerender } = render(
      <Collapse open id="more">
        <p>Details</p>
      </Collapse>
    );
    expect(container.querySelector('#more')).toHaveAttribute('data-state', 'open');
    rerender(
      <Collapse open={false} id="more">
        <p>Details</p>
      </Collapse>
    );
    expect(container.querySelector('#more')).toBeNull();
  });

  it('exits on --ds-motion-exit: the recipe reads the token and the unmount waits exactly that long', () => {
    const css = readFileSync(path.join(process.cwd(), 'index.css'), 'utf8');
    expect(css).toMatch(/--ds-motion-exit:\s*160ms;/);
    expect(PRESENCE_EXIT_MS).toBe(160);
    expect(COLLAPSE_CLOSED).toContain('duration-[var(--ds-motion-exit)]');
  });
});

describe('the decode gate through the components/ds barrel', () => {
  it('useImageReveal and its helpers come through components/ds (MO-1 #1)', () => {
    const names = [
      'useImageReveal',
      'decodeImage',
      'allowFilterEffects',
      'canPlayEntrances',
      'isCoarsePointer',
      'isLowPowerDevice',
      'motionEase',
      'motionMs',
      'parseMotionMs',
      'playEntrance',
      'readRevealEnvironment',
      'revealTokenFallbacks',
      'REVEAL_DECODE_TIMEOUT_MS',
      'REVEAL_FILTER_MAX_WIDTH_PX'
    ] as const;
    for (const k of names) {
      expect((reveal as Record<string, unknown>)[k], k).toBeDefined();
      expect((ds as Record<string, unknown>)[k], k).toBe((reveal as Record<string, unknown>)[k]);
    }
  });
});
