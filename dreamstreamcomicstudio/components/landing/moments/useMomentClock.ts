/**
 * The clock behind every home-page motion moment (bridge §8, Atlas HeroSearchDemo's contract):
 *
 * - The first render, and every render under reduced motion, is the FINISHED frame (the `hold` step):
 *   nothing on the page waits for script to become visible.
 * - After mount the moment plays its steps in order, typing a step's `type` text one character at a time,
 *   then loops. A moment mounted off screen starts from its first step; one already on screen starts on
 *   the finished frame and plays from the next loop, so it never blanks in front of the reader.
 * - It runs only while it is on screen and the tab is visible: the timers stop, and `inview` ("false")
 *   goes on the moment's root so the CSS loops inside it (caret, shimmer, live dot, the marks' loading
 *   loop, the sound meter) hold still too (styles/ds-motion.css, studio-marks.css, landing.css).
 * - `cycle` changes every loop: key the entrance classes on it so they replay.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useReducedMotion } from '../../ds/useReducedMotion';

export interface MomentStep {
  readonly id: string;
  /** How long the step holds once its text (if any) is typed. */
  readonly ms: number;
  /** Text typed during this step, one character at a time. */
  readonly type?: string;
}

export const TYPE_MS = 48;

const onScreenNow = (el: Element | null): boolean => {
  if (!el || typeof window === 'undefined') return true;
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < (window.innerHeight || document.documentElement.clientHeight);
};

export interface MomentClock {
  ref: RefObject<HTMLDivElement | null>;
  /** False on the first render and under reduced motion: render the finished frame, add no entrance classes. */
  animated: boolean;
  step: string;
  cycle: number;
  /** For the root's data-inview. */
  inview: 'true' | 'false' | undefined;
  /** The step has started (always true when not animated). */
  reached: (id: string) => boolean;
  /** The text of a typing step as far as it has been typed. */
  typed: (id: string) => string;
  /** That step is typing right now (show a caret). */
  typing: (id: string) => boolean;
}

export function useMomentClock(steps: readonly MomentStep[], holdId: string): MomentClock {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const indexOf = useCallback((id: string) => steps.findIndex((s) => s.id === id), [steps]);
  const holdIndex = Math.max(0, indexOf(holdId));

  const [animated, setAnimated] = useState(false);
  const [index, setIndex] = useState(holdIndex);
  const [chars, setChars] = useState(0);
  const [cycle, setCycle] = useState(0);
  const [onScreen, setOnScreen] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);

  useEffect(() => {
    if (reduced) {
      setAnimated(false);
      setIndex(holdIndex);
      setChars(0);
      return;
    }
    setIndex(onScreenNow(ref.current) ? holdIndex : 0);
    setChars(0);
    setAnimated(true);
  }, [reduced, holdIndex]);

  useEffect(() => {
    if (!animated) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setOnScreen(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setOnScreen(!!entry?.isIntersecting), { threshold: 0.2 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [animated]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const sync = () => setPageVisible(document.visibilityState !== 'hidden');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  const active = animated && onScreen && pageVisible;

  useEffect(() => {
    if (!active) return;
    const step = steps[index];
    if (!step) return;
    const length = step.type?.length ?? 0;
    const timer =
      chars < length
        ? window.setTimeout(() => setChars((n) => n + 1), TYPE_MS + (chars % 3) * 16)
        : window.setTimeout(() => {
            setChars(0);
            if (index + 1 < steps.length) setIndex(index + 1);
            else {
              setIndex(0);
              setCycle((c) => c + 1);
            }
          }, step.ms);
    return () => window.clearTimeout(timer);
  }, [active, chars, index, steps]);

  const reached = useCallback((id: string) => !animated || index >= indexOf(id), [animated, index, indexOf]);
  const typed = useCallback(
    (id: string) => {
      const i = indexOf(id);
      const text = steps[i]?.type ?? '';
      if (!animated || index > i) return text;
      return index === i ? text.slice(0, chars) : '';
    },
    [animated, chars, index, indexOf, steps]
  );
  const typing = useCallback(
    (id: string) => {
      const i = indexOf(id);
      return animated && index === i && chars < (steps[i]?.type?.length ?? 0);
    },
    [animated, chars, index, indexOf, steps]
  );

  return {
    ref,
    animated,
    step: steps[index]?.id ?? holdId,
    cycle,
    inview: animated ? (active ? 'true' : 'false') : undefined,
    reached,
    typed,
    typing
  };
}
