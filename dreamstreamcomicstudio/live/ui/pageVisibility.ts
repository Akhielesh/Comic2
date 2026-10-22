/**
 * Push, not poll (ADR 0007 C2): screens that show server data refresh when the page
 * comes back into view or regains focus, or when the room pushes something new —
 * never on a timer, and never while hidden.
 */
import { useEffect, useRef, useState } from 'react';

export const isPageVisible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** True while this tab is on screen. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(isPageVisible);
  useEffect(() => {
    const on = () => setVisible(isPageVisible());
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

/**
 * Calls `cb` whenever the page comes back: the tab becomes visible again, the window
 * regains focus, or the device comes back online. A burst of those (focus + visible
 * fire together) counts once.
 */
export function useOnPageReturn(cb: () => void): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    let last = 0;
    const fire = () => {
      if (!isPageVisible()) return;
      const now = Date.now();
      if (now - last < 1000) return;
      last = now;
      ref.current();
    };
    document.addEventListener('visibilitychange', fire);
    window.addEventListener('focus', fire);
    window.addEventListener('online', fire);
    return () => {
      document.removeEventListener('visibilitychange', fire);
      window.removeEventListener('focus', fire);
      window.removeEventListener('online', fire);
    };
  }, []);
}
