/**
 * The gliding pill under a segmented control or tab list (Atlas PanelTabs): one absolutely positioned
 * element measured from the selected item (offsetLeft / offsetWidth inside the `relative` track), so
 * no animation library is needed. The first placement never animates (`ready` turns on a frame later);
 * moves between items glide on SEGMENTED_PILL's panel time and spring, and jump under reduced motion
 * (the recipe's `motion-reduce:transition-none`). A ResizeObserver keeps it on the item when labels
 * wrap, fonts load or the control appears from a hidden panel.
 */
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface PillRect {
  left: number;
  width: number;
}

export function useGlidingPill(track: RefObject<HTMLElement | null>, selectedSelector: string, itemSelector: string, key: unknown): { rect: PillRect | null; ready: boolean } {
  const [rect, setRect] = useState<PillRect | null>(null);
  const [ready, setReady] = useState(false);

  useIsomorphicLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const measure = () => {
      const selected = el.querySelector<HTMLElement>(selectedSelector);
      if (!selected || !selected.offsetWidth) {
        setRect(null);
        return;
      }
      setRect((cur) => (cur && cur.left === selected.offsetLeft && cur.width === selected.offsetWidth ? cur : { left: selected.offsetLeft, width: selected.offsetWidth }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    el.querySelectorAll(itemSelector).forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, [track, selectedSelector, itemSelector, key]);

  useEffect(() => {
    if (!rect || ready) return;
    if (typeof window.requestAnimationFrame !== 'function') {
      setReady(true);
      return;
    }
    const frame = window.requestAnimationFrame(() => setReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, [rect, ready]);

  return { rect, ready };
}
