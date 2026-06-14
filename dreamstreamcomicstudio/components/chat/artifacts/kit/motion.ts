import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from './Chart';

// Shared motion primitives for the calm-studio cards. Tasteful, dependency-free, and
// always reduced-motion aware (they snap straight to the final value when the user
// prefers reduced motion).

/**
 * Smoothly count a number from its previous value to `target` (easeOutCubic). Used
 * for hero prices / temperatures / stats so a value glides into place instead of
 * snapping — and re-animates when the value changes (e.g. a °C↔°F morph). On first
 * mount it eases up from `mountFrom` (default 0) for a gentle reveal.
 */
export const useCountUp = (
  target: number,
  { duration = 650, mountFrom = 0 }: { duration?: number; mountFrom?: number } = {}
): number => {
  const reduced = typeof window !== 'undefined' && prefersReducedMotion();
  const [val, setVal] = useState<number>(reduced ? target : mountFrom);
  const fromRef = useRef<number>(reduced ? target : mountFrom);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (reduced || typeof requestAnimationFrame !== 'function') {
      setVal(target);
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    if (from === target) return;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(from + (target - from) * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration]);

  return val;
};

/**
 * Returns true one frame after mount, so a value can transition from a start state
 * to its resting state via CSS (e.g. a gauge growing from width 0). Reduced-motion
 * users get `true` immediately. Re-arms when any `deps` change.
 */
export const useMountFlag = (deps: unknown[] = []): boolean => {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (prefersReducedMotion()) {
      setOn(true);
      return;
    }
    setOn(false);
    const raf = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return on;
};
