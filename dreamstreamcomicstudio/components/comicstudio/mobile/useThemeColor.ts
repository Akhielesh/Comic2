// useThemeColor() (mobile.md §9.1): while the studio or reader is mounted, the browser chrome
// (Android status bar, Safari's tab bar tint, the installed-PWA title bar) matches the studio canvas
// instead of the landing page's brand blue. It follows the app's own `dark` class (services/theme.ts),
// not only the OS scheme, and restores the previous colours on unmount.

import { useEffect } from 'react';

const readCanvas = (): string => {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--ds-canvas').trim();
    return v || '';
  } catch {
    return '';
  }
};

/**
 * @param color  explicit colour (e.g. the reader's dark room); default: the current `--ds-canvas`.
 * @param enabled  mount-time switch.
 */
export function useThemeColor(color?: string, enabled = true): void {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    let metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
    let created: HTMLMetaElement | null = null;
    if (!metas.length) {
      created = document.createElement('meta');
      created.name = 'theme-color';
      document.head.appendChild(created);
      metas = [created];
    }
    const previous = metas.map((m) => m.getAttribute('content'));
    const apply = () => {
      const value = color || readCanvas();
      if (!value) return;
      for (const m of metas) m.setAttribute('content', value);
    };
    apply();
    // The app toggles `dark` on <html>; re-read the canvas when it flips.
    let observer: MutationObserver | null = null;
    if (!color && typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(apply);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    }
    return () => {
      observer?.disconnect();
      if (created) {
        created.remove();
        return;
      }
      metas.forEach((m, i) => {
        const prev = previous[i];
        if (prev === null) m.removeAttribute('content');
        else m.setAttribute('content', prev);
      });
    };
  }, [color, enabled]);
}

export default useThemeColor;
