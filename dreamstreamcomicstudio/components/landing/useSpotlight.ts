/**
 * useSpotlight — Atlas hooks/useSpotlight.ts on the ds-* names (components/landing/landing.css).
 *
 * Feeds the mouse position to every `.ds-spotlight` / `.ds-spotlight-grid` inside `ref` (and `ref` itself
 * when it is one) as `--ds-spot-x` / `--ds-spot-y`, in px from each element's top-left corner, so a soft
 * light follows the pointer and the edges of neighbouring cards catch it. It only writes two custom
 * properties (no layout, no React state), batches to one write per animation frame, reads every rect
 * before writing any, ignores touch and pen, and does nothing under reduced motion.
 */
import { useEffect, type RefObject } from 'react';

export const SPOTLIGHT_SELECTOR = '.ds-spotlight, .ds-spotlight-grid';
/** Set on the group while a mouse is over it: the CSS fades the light in. */
export const SPOTLIGHT_ACTIVE_ATTRIBUTE = 'data-spotlight';

export const spotlightAllowed = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return !(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return true;
  }
};

export function useSpotlight(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!root || typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;

    let targets: HTMLElement[] = [];
    let frame = 0;
    let active = false;
    let x = 0;
    let y = 0;

    const collect = () => {
      const inner = Array.from(root.querySelectorAll<HTMLElement>(SPOTLIGHT_SELECTOR));
      return root.matches(SPOTLIGHT_SELECTOR) ? [root, ...inner] : inner;
    };

    const paint = () => {
      frame = 0;
      const rects = targets.map((target) => target.getBoundingClientRect());
      targets.forEach((target, i) => {
        target.style.setProperty('--ds-spot-x', `${Math.round(x - rects[i].left)}px`);
        target.style.setProperty('--ds-spot-y', `${Math.round(y - rects[i].top)}px`);
      });
    };

    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(paint);
    };

    const deactivate = () => {
      if (!active) return;
      active = false;
      root.removeAttribute(SPOTLIGHT_ACTIVE_ATTRIBUTE);
      window.removeEventListener('scroll', schedule, true);
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      x = event.clientX;
      y = event.clientY;
      if (active) {
        schedule();
        return;
      }
      if (!spotlightAllowed()) return;
      active = true;
      targets = collect();
      // Place the light before it fades in, so it never flashes at a stale spot.
      paint();
      root.setAttribute(SPOTLIGHT_ACTIVE_ATTRIBUTE, 'on');
      // The page can scroll under a still pointer: keep the light under it.
      window.addEventListener('scroll', schedule, { capture: true, passive: true });
    };

    root.addEventListener('pointermove', onMove, { passive: true });
    root.addEventListener('pointerleave', deactivate);
    return () => {
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerleave', deactivate);
      window.removeEventListener('scroll', schedule, true);
      if (frame) window.cancelAnimationFrame(frame);
      root.removeAttribute(SPOTLIGHT_ACTIVE_ATTRIBUTE);
    };
  }, [ref]);
}
