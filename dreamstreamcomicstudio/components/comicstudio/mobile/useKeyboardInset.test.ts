// useKeyboardInset (mobile.md §3.9, §10.1): the composer stays above the iOS keyboard (visualViewport
// shrinks, innerHeight stays) without double-offsetting Android (the layout resizes, kb ≈ 0).

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { KB_OPEN_THRESHOLD, RESIZED_KB_PX, computeKeyboardInset, isEditable, keyboardOpen, recomputeKeyboardInset, useKeyboardInset } from './useKeyboardInset';

class FakeVisualViewport extends EventTarget {
  height: number;
  offsetTop = 0;
  scale = 1;
  width = 393;
  constructor(h: number) {
    super();
    this.height = h;
  }
}

describe('computeKeyboardInset (pure)', () => {
  it('iOS: innerHeight stays 852, the visual viewport shrinks to 516 → kb 336', () => {
    expect(computeKeyboardInset({ innerHeight: 852, vvHeight: 516, vvOffsetTop: 0 })).toEqual({ kb: 336, appH: 516 });
  });
  it('Android (resizes-content): both shrink → kb 0, no double offset', () => {
    expect(computeKeyboardInset({ innerHeight: 516, vvHeight: 516 })).toEqual({ kb: 0, appH: 516 });
  });
  it('a panned visual viewport subtracts its offset', () => {
    expect(computeKeyboardInset({ innerHeight: 852, vvHeight: 516, vvOffsetTop: 40 }).kb).toBe(296);
  });
  it('a pinch-zoomed page is not a keyboard', () => {
    expect(computeKeyboardInset({ innerHeight: 852, vvHeight: 300, vvScale: 2 }).kb).toBe(0);
  });
  it('the QuickType bar alone stays under the open threshold', () => {
    expect(computeKeyboardInset({ innerHeight: 852, vvHeight: 800 }).kb).toBeLessThan(KB_OPEN_THRESHOLD);
  });
  it('keyboardOpen: an iOS overlap, or an Android resize while a text field is focused (never a pinch zoom)', () => {
    expect(keyboardOpen({ kb: 336, editableFocused: false, baselineH: 852, visibleH: 516 })).toBe(true);
    expect(keyboardOpen({ kb: 0, editableFocused: true, baselineH: 852, visibleH: 516 })).toBe(true);
    expect(keyboardOpen({ kb: 0, editableFocused: false, baselineH: 852, visibleH: 516 })).toBe(false);
    expect(keyboardOpen({ kb: 0, editableFocused: true, baselineH: 852, visibleH: 852 - RESIZED_KB_PX })).toBe(false);
    expect(keyboardOpen({ kb: 0, editableFocused: true, baselineH: 852, visibleH: 400, zoomed: true })).toBe(false);
  });
  it('isEditable: text inputs, textareas and contenteditable — not buttons, checkboxes or read-only fields', () => {
    const make = (html: string) => {
      const d = document.createElement('div');
      d.innerHTML = html;
      return d.firstElementChild;
    };
    expect(isEditable(make('<textarea></textarea>'))).toBe(true);
    expect(isEditable(make('<input type="email">'))).toBe(true);
    expect(isEditable(make('<input type="checkbox">'))).toBe(false);
    expect(isEditable(make('<input readonly>'))).toBe(false);
    expect(isEditable(make('<button></button>'))).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});

describe('useKeyboardInset (stubbed visualViewport)', () => {
  let vv: FakeVisualViewport;
  const root = document.documentElement;

  beforeEach(() => {
    vv = new FakeVisualViewport(852);
    vi.stubGlobal('visualViewport', vv);
    vi.stubGlobal('innerHeight', 852);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('iOS keyboard: writes --kb / --app-h and html.kb-open; restores on unmount', () => {
    const { result, unmount } = renderHook(() => useKeyboardInset());
    expect(root.style.getPropertyValue('--kb')).toBe('0px');
    expect(root.classList.contains('kb-open')).toBe(false);

    act(() => {
      vv.height = 516;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toEqual({ kb: 336, appH: 516, open: true });
    expect(root.style.getPropertyValue('--kb')).toBe('336px');
    expect(root.style.getPropertyValue('--app-h')).toBe('516px');
    expect(root.classList.contains('kb-open')).toBe(true);

    unmount();
    expect(root.style.getPropertyValue('--kb')).toBe('');
    expect(root.classList.contains('kb-open')).toBe(false);
  });

  it('Android resize: kb stays 0 (no double offset), --app-h follows, and a focused field marks the keyboard open', () => {
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    onTestFinished(() => field.remove());
    const { result } = renderHook(() => useKeyboardInset());
    act(() => {
      field.focus();
      vi.stubGlobal('innerHeight', 516);
      vv.height = 516;
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toEqual({ kb: 0, appH: 516, open: true });
    expect(root.style.getPropertyValue('--kb')).toBe('0px');
    expect(root.classList.contains('kb-open')).toBe(true);
    // The field blurs and the layout grows back: closed again.
    act(() => {
      field.blur();
      vi.stubGlobal('innerHeight', 852);
      vv.height = 852;
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current.open).toBe(false);
    expect(root.classList.contains('kb-open')).toBe(false);
  });

  it('a window simply resized without a focused field is not a keyboard', () => {
    const { result } = renderHook(() => useKeyboardInset());
    act(() => {
      vi.stubGlobal('innerHeight', 516);
      vv.height = 516;
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toEqual({ kb: 0, appH: 516, open: false });
  });

  it('undoes Safari’s document pan while the keyboard is up (the header stays put)', () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    const scroller = document.scrollingElement || document.documentElement;
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 120 });
    renderHook(() => useKeyboardInset());
    act(() => {
      vv.height = 516;
      vv.dispatchEvent(new Event('scroll'));
    });
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 0 });
  });

  it('is ref-counted: consumers share one store; a disabled consumer attaches nothing', () => {
    const a = renderHook(() => useKeyboardInset());
    const b = renderHook(() => useKeyboardInset(false));
    act(() => {
      vv.height = 500;
      recomputeKeyboardInset();
    });
    expect(a.result.current.kb).toBe(352);
    // A disabled consumer does not subscribe: it reads the shared value on its own renders only.
    b.rerender();
    expect(b.result.current.kb).toBe(352);
    a.unmount();
    expect(root.style.getPropertyValue('--kb')).toBe('');
    b.unmount();
  });
});
