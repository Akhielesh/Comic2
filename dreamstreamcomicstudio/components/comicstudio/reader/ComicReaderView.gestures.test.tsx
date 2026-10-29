import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { fakeUrlFor, makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { ComicReaderView } from './ComicReaderView';

// Safe gestures in the v4 reader (mobile-reading hotfix, F2): every pinch on the stage turned the page (two pointers,
// one swipe candidate), and touch-action: pan-y blocked zooming at all. Now a second pointer cancels the swipe until
// every finger is up (either lift order), the stage allows pinch-zoom, and while the page is zoomed in drags pan
// (touch-action: manipulation) and neither swipes nor taps turn a page.

const drawnDoc = (mutate?: (d: ComicDoc) => void) =>
  makeSampleDoc((d) => {
    d.cover.render = { status: 'ready', history: [], asset: { path: 'u/cover.png', source: 'generated', at: 0, w: 1000, h: 1500 } };
    d.pages.forEach((p, i) => {
      if (!p.render.asset) p.render = { ...p.render, status: 'ready', asset: { path: `u/p${i + 1}.png`, source: 'generated', at: 0 } };
    });
    mutate?.(d);
  });

const shownKeys = () => screen.getAllByTestId('reader-page').map((el) => el.getAttribute('data-key'));
const stage = () => screen.getByTestId('reader-stage');

const realVV = Object.getOwnPropertyDescriptor(window, 'visualViewport');
let vvListeners: Array<() => void> = [];
const setZoom = (scale: number) => {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: {
      scale,
      offsetLeft: 0,
      offsetTop: 0,
      width: 360,
      height: 740,
      addEventListener: (_: string, cb: () => void) => vvListeners.push(cb),
      removeEventListener: (_: string, cb: () => void) => (vvListeners = vvListeners.filter((x) => x !== cb))
    }
  });
  act(() => vvListeners.forEach((cb) => cb()));
};

beforeEach(() => {
  vvListeners = [];
  setZoom(1);
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => {
  if (realVV) Object.defineProperty(window, 'visualViewport', realVV);
  else delete (window as unknown as Record<string, unknown>).visualViewport;
});

const down = (id: number, x: number, y = 300, isPrimary = id === 1) => fireEvent.pointerDown(stage(), { pointerId: id, clientX: x, clientY: y, pointerType: 'touch', isPrimary });
const up = (id: number, x: number, y = 300) => fireEvent.pointerUp(stage(), { pointerId: id, clientX: x, clientY: y, pointerType: 'touch' });

/** Opens on page 1 (one view after the cover), so a turn either way shows. */
const open = () => {
  render(<ComicReaderView doc={drawnDoc()} urlFor={fakeUrlFor} initialMode="page" />);
  fireEvent.keyDown(screen.getByTestId('comic-reader'), { key: 'ArrowRight' });
  expect(shownKeys()).toEqual(['pg_1']);
};

describe('a pinch never turns a page', () => {
  it('second finger down cancels the swipe; the first finger lifting with a long drag does not turn', () => {
    open();
    down(1, 140);
    down(2, 220);
    up(2, 320);
    up(1, 20);
    expect(shownKeys()).toEqual(['pg_1']);
  });

  it('either lift order, and the next ordinary swipe still turns', () => {
    open();
    down(1, 140);
    down(2, 220);
    up(1, 20);
    up(2, 360);
    expect(shownKeys()).toEqual(['pg_1']);
    down(1, 300);
    up(1, 150, 305);
    expect(shownKeys()).toEqual(['pg_2']);
  });

  it('a cancelled pointer (the browser took the pinch) leaves no stale state behind', () => {
    open();
    down(1, 140);
    down(2, 220);
    fireEvent.pointerCancel(stage(), { pointerId: 1, pointerType: 'touch' });
    fireEvent.pointerCancel(stage(), { pointerId: 2, pointerType: 'touch' });
    down(3, 100, 300, true);
    up(3, 260);
    expect(shownKeys()).toEqual(['cover']);
  });
});

describe('zoom', () => {
  it('the stage lets the browser pinch-zoom at 1x (pan-y pinch-zoom), and pans every way once zoomed (manipulation)', () => {
    open();
    expect(stage().style.touchAction).toBe('pan-y pinch-zoom');
    setZoom(2.2);
    expect(stage().style.touchAction).toBe('manipulation');
    setZoom(1);
    expect(stage().style.touchAction).toBe('pan-y pinch-zoom');
  });

  it('zoomed in: a sideways drag pans (no turn) and a tap on the outer third does not turn either', () => {
    open();
    setZoom(2);
    down(1, 300);
    up(1, 100);
    expect(shownKeys()).toEqual(['pg_1']);
    // The invisible outer-third tap zone (jsdom has no layout, so tap it directly).
    fireEvent.click(stage().querySelector('[data-zone="next"]')!);
    expect(shownKeys()).toEqual(['pg_1']);
    setZoom(1);
    down(1, 300);
    up(1, 100);
    expect(shownKeys()).toEqual(['pg_2']);
  });
});
