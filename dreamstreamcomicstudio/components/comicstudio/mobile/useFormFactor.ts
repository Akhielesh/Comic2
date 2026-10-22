// useFormFactor() (contract §13.3; owner P1-SHELL). Wave 0 (P0-C) stub: width/height from the
// window, re-read on resize (rAF-throttled), coarse/hover/reduced-motion from matchMedia.
// SSR/jsdom-safe. P1-SHELL replaces it with one shared useSyncExternalStore store,
// viewport segments, saveData and deviceMemory.

import { useEffect, useState } from 'react';
import { SINGLE_SEGMENT, classifyViewport, type FormFactor } from './formFactor';

const matches = (query: string, fallback: boolean): boolean => {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : fallback;
  } catch {
    return fallback;
  }
};

/** A snapshot of the current window (desktop defaults outside a browser). */
export const readFormFactor = (): FormFactor => {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const h = typeof window !== 'undefined' ? window.innerHeight : 768;
  const coarse = matches('(pointer: coarse)', false);
  return {
    width: w,
    height: h,
    ...classifyViewport({ w, h, coarse }),
    coarse,
    anyFine: matches('(any-pointer: fine)', true),
    hover: matches('(hover: hover)', true),
    segments: SINGLE_SEGMENT,
    reducedMotion: matches('(prefers-reduced-motion: reduce)', false),
    saveData: false,
    lowMemory: false
  };
};

export function useFormFactor(): FormFactor {
  const [ff, setFf] = useState<FormFactor>(readFormFactor);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const next = readFormFactor();
        setFf((cur) =>
          cur.width === next.width && cur.height === next.height && cur.coarse === next.coarse && cur.reducedMotion === next.reducedMotion ? cur : next
        );
      });
    };
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);
  return ff;
}

export default useFormFactor;
