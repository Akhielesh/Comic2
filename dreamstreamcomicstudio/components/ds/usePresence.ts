/**
 * usePresence — Atlas hooks/usePresence.ts: keeps a disclosure's body mounted while it animates in and out.
 * - `mounted`: render the body at all. True as soon as `open` turns true, and for `exitMs` after it turns
 *   false, so a closing panel can play its exit instead of vanishing.
 * - `shown`: the body's open styling. It turns true a frame after mounting, so the opening transition starts
 *   from the closed state rather than jumping.
 * Opening content is in the DOM at once (screen readers and tests see it immediately); only the visual
 * transition waits a frame. `instant` (reduced motion) skips both waits.
 */
import { useEffect, useState } from 'react';

/** index.css --ds-motion-exit: how long anything takes to leave (Collapse.test.tsx pins the two together). */
export const PRESENCE_EXIT_MS = 160;

function nextFrame(callback: () => void): () => void {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    let inner = 0;
    const id = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(callback);
    });
    return () => {
      window.cancelAnimationFrame(id);
      window.cancelAnimationFrame(inner);
    };
  }
  const timer = setTimeout(callback, 0);
  return () => clearTimeout(timer);
}

export function usePresence(open: boolean, exitMs = PRESENCE_EXIT_MS, instant = false): { mounted: boolean; shown: boolean } {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      if (instant) {
        setShown(true);
        return;
      }
      return nextFrame(() => setShown(true));
    }
    setShown(false);
    if (instant || exitMs <= 0) {
      setMounted(false);
      return;
    }
    const timer = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(timer);
  }, [open, exitMs, instant]);

  return { mounted: open || (mounted && !instant), shown: open && (shown || instant) };
}
