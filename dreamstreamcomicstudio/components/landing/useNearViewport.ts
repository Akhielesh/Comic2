/**
 * True once `ref`'s element comes within `margin` of the viewport (and stays true). Where
 * IntersectionObserver is missing it is true at once, so nothing waits on an observer that never fires.
 * The home page uses it to fetch a below-the-fold demo only when the reader is about to see it.
 */
import { useEffect, useState, type RefObject } from 'react';

export function useNearViewport(ref: RefObject<Element | null>, margin = '320px 0px'): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: margin }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near, ref, margin]);
  return near;
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

/** Run `task` once the page is idle after first paint (or after `timeout` ms at the latest). Returns a cancel. */
export function whenIdle(task: () => void, timeout = 2500): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const w = window as IdleWindow;
  if (typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(task, { timeout });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(task, Math.min(timeout, 1200));
  return () => window.clearTimeout(id);
}
