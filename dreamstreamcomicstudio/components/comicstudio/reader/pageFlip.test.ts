// The page flip's helper: the classes and the 0.45 s are index.css's own (the Classic reader's original swing), RTL
// mirrors the swing, and a swing restarts, lands and cleans up without any per-frame work.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLIP_MS, FLIP_NEXT, FLIP_PREV, flipClass, playFlip } from './pageFlip';

const css = fs.readFileSync(path.resolve(__dirname, '../../../index.css'), 'utf8');

describe('the original swing, from index.css', () => {
  it('reuses the Page Flip classes: 0.45 s on the same curve, from the left spine forward and the right going back', () => {
    const rule = (cls: string) => new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    expect(rule(FLIP_NEXT)).toMatch(/animation:\s*pageFlipNext 0\.45s cubic-bezier\(0\.22, 1, 0\.36, 1\) both/);
    expect(rule(FLIP_NEXT)).toMatch(/transform-origin:\s*left center/);
    expect(rule(FLIP_PREV)).toMatch(/animation:\s*pageFlipPrev 0\.45s cubic-bezier\(0\.22, 1, 0\.36, 1\) both/);
    expect(rule(FLIP_PREV)).toMatch(/transform-origin:\s*right center/);
    expect(FLIP_MS).toBe(450);
    // The keyframes swing in from perspective(1600px) rotateY(∓28deg) scale(0.96) at 0.35 opacity.
    expect(css).toMatch(/@keyframes pageFlipNext \{\s*0%\s*\{ transform: perspective\(1600px\) rotateY\(-28deg\) scale\(0\.96\); opacity: 0\.35; \}/);
    expect(css).toMatch(/@keyframes pageFlipPrev \{\s*0%\s*\{ transform: perspective\(1600px\) rotateY\(28deg\) scale\(0\.96\); opacity: 0\.35; \}/);
    // The OS reduced-motion setting switches it off.
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.animate-page-flip-next, \.animate-page-flip-prev \{ animation: none; \}/);
  });

  it('mirrors the swing in right-to-left books', () => {
    expect(flipClass(1, false)).toBe(FLIP_NEXT);
    expect(flipClass(-1, false)).toBe(FLIP_PREV);
    expect(flipClass(1, true)).toBe(FLIP_PREV);
    expect(flipClass(-1, true)).toBe(FLIP_NEXT);
  });
});

describe('playFlip', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('puts the class on, lands on animationend and takes the class and the origin off', () => {
    const el = document.createElement('div');
    const done = vi.fn();
    playFlip(el, FLIP_NEXT, { origin: '320px 50%', done });
    expect(el.classList.contains(FLIP_NEXT)).toBe(true);
    expect(el.style.transformOrigin).toBe('320px 50%');
    el.dispatchEvent(new Event('animationend'));
    expect(done).toHaveBeenCalledTimes(1);
    expect(el.classList.contains(FLIP_NEXT)).toBe(false);
    expect(el.style.transformOrigin).toBe('');
    vi.advanceTimersByTime(FLIP_MS * 2);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('lands on its own when no animation runs (the OS turned motion off), and a stop lands at once without done', () => {
    const el = document.createElement('div');
    const done = vi.fn();
    playFlip(el, FLIP_PREV, { done });
    vi.advanceTimersByTime(FLIP_MS + 200);
    expect(done).toHaveBeenCalledTimes(1);
    expect(el.className).toBe('');
    const again = vi.fn();
    const stop = playFlip(el, FLIP_PREV, { done: again });
    stop();
    vi.advanceTimersByTime(FLIP_MS + 200);
    expect(again).not.toHaveBeenCalled();
    expect(el.className).toBe('');
  });

  it('restarts a swing still running (a second quick turn) and ignores a child’s animationend', () => {
    const el = document.createElement('div');
    const child = document.createElement('span');
    el.appendChild(child);
    playFlip(el, FLIP_NEXT);
    playFlip(el, FLIP_PREV);
    expect([...el.classList]).toEqual([FLIP_PREV]);
    child.dispatchEvent(new Event('animationend', { bubbles: true }));
    expect([...el.classList]).toEqual([FLIP_PREV]);
  });
});
