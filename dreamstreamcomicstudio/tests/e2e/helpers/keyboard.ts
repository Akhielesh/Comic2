// On-screen keyboard emulation (P1-QA; mobile.md §10.4 studio.keyboard.spec.ts).
//
// Android Chrome with `interactive-widget=resizes-content` shrinks the LAYOUT viewport when the
// keyboard opens → emulated with page.setViewportSize({h: h − 336}).
// iOS Safari keeps innerHeight and shrinks only the VISUAL viewport → emulated by an init script that
// replaces `window.visualViewport` with a controllable stand-in (height = innerHeight − 336, fires
// `resize`), which is exactly what useKeyboardInset reads. Install it before navigation.

import type { Page } from '@playwright/test';
import type { ComicDevice } from '../devices';

export const KEYBOARD_HEIGHT = 336;

/** iOS: install the controllable visualViewport BEFORE page.goto. Harmless on other projects. */
export async function installVisualViewportStub(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Listener = (e: Event) => void;
    const listeners = new Map<string, Set<Listener>>();
    const state = { kb: 0 };
    const fake = {
      get width() {
        return window.innerWidth;
      },
      get height() {
        return Math.max(0, window.innerHeight - state.kb);
      },
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
      onresize: null as Listener | null,
      onscroll: null as Listener | null,
      addEventListener(type: string, fn: Listener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener(type: string, fn: Listener) {
        listeners.get(type)?.delete(fn);
      },
      dispatchEvent(e: Event) {
        listeners.get(e.type)?.forEach((fn) => fn(e));
        const handler = e.type === 'resize' ? fake.onresize : e.type === 'scroll' ? fake.onscroll : null;
        handler?.(e);
        return true;
      }
    };
    try {
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
    } catch {
      /* engine refuses: the spec falls back to resizing */
    }
    (window as unknown as { __qaKeyboard?: (h: number) => void }).__qaKeyboard = (h: number) => {
      state.kb = h;
      fake.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));
    };
  });
}

export type KeyboardMode = 'ios-visual-viewport' | 'android-resize';

export const keyboardModeFor = (d: ComicDevice): KeyboardMode => (d.os === 'ios' ? 'ios-visual-viewport' : 'android-resize');

/** Open the on-screen keyboard (focus the field first). Returns the visible bottom edge in CSS px. */
export async function openKeyboard(page: Page, d: ComicDevice, height = KEYBOARD_HEIGHT): Promise<{ mode: KeyboardMode; visibleBottom: number }> {
  const mode = keyboardModeFor(d);
  if (mode === 'android-resize') {
    await page.setViewportSize({ width: d.viewport.width, height: d.viewport.height - height });
  } else {
    const ok = await page.evaluate((h) => {
      const fn = (window as unknown as { __qaKeyboard?: (h: number) => void }).__qaKeyboard;
      if (!fn) return false;
      fn(h);
      return true;
    }, height);
    if (!ok) throw new Error('installVisualViewportStub(page) must run before navigation on iOS projects');
  }
  await page.waitForTimeout(250);
  const visibleBottom = await page.evaluate(() => (window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : window.innerHeight));
  return { mode, visibleBottom };
}

export async function closeKeyboard(page: Page, d: ComicDevice): Promise<void> {
  if (keyboardModeFor(d) === 'android-resize') await page.setViewportSize(d.viewport);
  else await page.evaluate(() => (window as unknown as { __qaKeyboard?: (h: number) => void }).__qaKeyboard?.(0));
  await page.waitForTimeout(200);
}
