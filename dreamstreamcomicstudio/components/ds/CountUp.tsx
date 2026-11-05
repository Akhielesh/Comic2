/**
 * CountUp — Atlas components/public/CountUp.tsx: a number that counts up from zero the first time it scrolls
 * into view (40 % visible), easing out over 1.1 s. The first render and reduced-motion users get the final
 * value straight away, with no JavaScript animation at all, so the figure is never wrong or missing, only
 * animated. Where IntersectionObserver is missing, or the value is not above zero, it is simply the value.
 * Columnar digits (`tabular-nums`) so the width does not wobble while it counts.
 */
import React, { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { prefersReducedMotion } from './useReducedMotion';

export const COUNT_UP_MS = 1100;

export interface CountUpProps {
  value: number;
  /** How the number is written (default: the locale's grouping, `toLocaleString()`). */
  format?: (n: number) => string;
  className?: string;
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export function CountUp({ value, format, className }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(value);

  useEffect(() => {
    const node = ref.current;
    if (!node || prefersReducedMotion() || !(value > 0) || typeof IntersectionObserver === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      setDisplay(value);
      return;
    }
    let frame = 0;
    let started = false;
    setDisplay(0);
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || started) return;
        started = true;
        observer.disconnect();
        const start = performance.now();
        const tick = (now: number) => {
          const progress = Math.min(1, (now - start) / COUNT_UP_MS);
          setDisplay(Math.round(value * easeOutCubic(progress)));
          if (progress < 1) frame = window.requestAnimationFrame(tick);
        };
        frame = window.requestAnimationFrame(tick);
      },
      { threshold: 0.4 }
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [value]);

  return (
    <span ref={ref} data-slot="count-up" className={cn('tabular-nums', className)}>
      {format ? format(display) : display.toLocaleString()}
    </span>
  );
}
